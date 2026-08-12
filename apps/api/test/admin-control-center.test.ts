import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index';
import { handleAdminRequest } from '../src/admin';
import { renderAdminPanel } from '../src/admin-ui';
import { spendDailyQuota } from '../src/lib/credits';
import { resolveAuth } from '../src/lib/supabase-auth';
import type { Env } from '../src/types';

function baseEnv(): Env {
  return {
    AI: { run: async () => ({}) },
    API_RATE_LIMITER: { limit: async () => ({ success: true }) },
    IMAGE_RATE_LIMITER: { limit: async () => ({ success: true }) },
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_public-test',
    SUPABASE_SECRET_KEY: 'sb_secret_server-only-test',
    ADMIN_EMAILS: 'owner@example.com',
  };
}

test('admin page exposes only public Supabase config', async () => {
  const response = renderAdminPanel(baseEnv());
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /FarsiAI Control Center/);
  assert.match(html, /sb_publishable_public-test/);
  assert.doesNotMatch(html, /sb_secret_server-only-test/);
});

test('worker serves the admin panel with hardened browser headers', async () => {
  const response = await worker.fetch(new Request('https://api.example/admin'), baseEnv());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.match(response.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  assert.match(await response.text(), /Admin Control Center/);
});

test('admin API rejects unauthenticated callers', async () => {
  const response = await handleAdminRequest(new Request('https://api.example/v1/admin/me'), baseEnv());
  assert.equal(response.status, 401);
});

test('pro plan bypasses daily chat and image quotas', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    assert.match(url, /rest\/v1\/profiles\?select=plan/);
    return Response.json([{ plan: 'pro' }]);
  };
  try {
    const result = await spendDailyQuota(baseEnv(), '11111111-1111-4111-8111-111111111111', 'chat', 'req-1');
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.quota.unlimited, true);
      assert.ok(result.quota.chatRemaining > 10);
      assert.ok(result.quota.imageRemaining > 4);
    }
  } finally {
    globalThis.fetch = original;
  }
});

test('auth propagates immediate server-side ban metadata', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    id: '11111111-1111-4111-8111-111111111111',
    email: 'member@example.com',
    app_metadata: { farsiai_banned: true },
  });
  try {
    const result = await resolveAuth(new Request('https://api.example/v1/ai', {
      headers: { authorization: 'Bearer user-token' },
    }), baseEnv());
    assert.equal(result.kind, 'user');
    if (result.kind === 'user') assert.equal(result.user.banned, true);
  } finally {
    globalThis.fetch = original;
  }
});

test('a banned account is stopped before chat or image usage executes', async () => {
  const original = globalThis.fetch;
  let aiCalls = 0;
  const env = baseEnv();
  env.AI = { run: async () => { aiCalls += 1; return { response: 'should-not-run' }; } };
  globalThis.fetch = async () => Response.json({
    id: '11111111-1111-4111-8111-111111111111',
    email: 'member@example.com',
    app_metadata: { farsiai_banned: true },
  });
  try {
    const response = await worker.fetch(new Request('https://api.example/v1/ai', {
      method: 'POST',
      headers: { authorization: 'Bearer user-token', 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'chat', message: 'سلام' }),
    }), env);
    assert.equal(response.status, 403);
    assert.equal(aiCalls, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('a banned account is stopped before Codex planning executes', async () => {
  const original = globalThis.fetch;
  let aiCalls = 0;
  const env = baseEnv();
  env.AI = { run: async () => { aiCalls += 1; return {}; } };
  globalThis.fetch = async () => Response.json({
    id: '11111111-1111-4111-8111-111111111111',
    email: 'member@example.com',
    app_metadata: { farsiai_banned: true },
  });
  try {
    const response = await worker.fetch(new Request('https://api.example/v2/codex/turn', {
      method: 'POST',
      headers: {
        authorization: 'Bearer user-token',
        'content-type': 'application/json',
        'x-farsiai-codex-protocol': 'farsiai.codex.desktop.v2',
      },
      body: JSON.stringify({}),
    }), env);
    assert.equal(response.status, 403);
    const payload = await response.json() as { code?: string };
    assert.equal(payload.code, 'CODEX_ACCOUNT_BANNED');
    assert.equal(aiCalls, 0);
  } finally {
    globalThis.fetch = original;
  }
});
