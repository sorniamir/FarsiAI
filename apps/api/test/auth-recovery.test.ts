import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import worker from '../src/index';
import { renderPasswordRecovery } from '../src/auth-recovery-ui';
import type { Env } from '../src/types';

function env(overrides: Partial<Env> = {}): Env {
  return {
    AI: { run: async () => ({}) },
    API_RATE_LIMITER: { limit: async () => ({ success: true }) },
    IMAGE_RATE_LIMITER: { limit: async () => ({ success: true }) },
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_browser_test',
    SUPABASE_SECRET_KEY: 'sb_secret_must_never_render',
    ...overrides,
  };
}

describe('password recovery UI', () => {
  it('renders a no-store, non-frameable recovery page without exposing server secrets', async () => {
    const response = renderPasswordRecovery(env());
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control') ?? '', /no-store/);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.match(html, /sb_publishable_browser_test/);
    assert.doesNotMatch(html, /sb_secret_must_never_render/);
    assert.match(html, /type!=='recovery'/);
    assert.match(html, /authorization':'Bearer '/);
  });

  it('exposes the recovery route and fails closed when public auth config is missing', async () => {
    const configured = await worker.fetch(new Request('https://api.example.com/auth/recovery'), env());
    assert.equal(configured.status, 200);
    assert.match(await configured.text(), /ACCOUNT SECURITY/);

    const unconfigured = await worker.fetch(
      new Request('https://api.example.com/auth/recovery'),
      env({ SUPABASE_URL: undefined, SUPABASE_PUBLISHABLE_KEY: undefined }),
    );
    assert.equal(unconfigured.status, 503);
    assert.match(await unconfigured.text(), /سرویس بازیابی حساب/);
  });
});
