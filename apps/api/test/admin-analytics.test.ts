import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAdminRequest } from '../src/admin';
import { renderAdminPanel } from '../src/admin-ui';
import type { Env } from '../src/types';

const ownerId = '11111111-1111-4111-8111-111111111111';
const memberId = '22222222-2222-4222-8222-222222222222';

function env(): Env {
  return {
    AI: { run: async () => ({}) },
    API_RATE_LIMITER: { limit: async () => ({ success: true }) },
    IMAGE_RATE_LIMITER: { limit: async () => ({ success: true }) },
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    SUPABASE_SECRET_KEY: 'sb_secret_test',
    ADMIN_EMAILS: 'owner@example.com',
  };
}

function adminRequest(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('authorization', 'Bearer owner-token');
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return new Request('https://api.example/v1/admin/' + path, { ...init, headers });
}

test('admin panel exposes analytics, audit timeline, and CSV export controls', async () => {
  const html = await renderAdminPanel(env()).text();
  assert.match(html, /Audit Timeline/);
  assert.match(html, /مصرف AI/);
  assert.match(html, /رشد کاربران/);
  assert.match(html, /Export Usage CSV/);
  assert.match(html, /data-export="users"/);
  assert.match(html, /data-export="audit"/);
  assert.match(html, /\/v1\/admin\/export/);
});

test('analytics endpoint returns real daily usage, growth, credit flow and plan mix', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: ownerId, email: 'owner@example.com', app_metadata: {} });
    if (url.includes('/auth/v1/admin/users?page=1&per_page=200')) return Response.json({ users: [
      { id: ownerId, email: 'owner@example.com', created_at: new Date().toISOString(), last_sign_in_at: new Date().toISOString(), app_metadata: {} },
      { id: memberId, email: 'member@example.com', created_at: new Date().toISOString(), last_sign_in_at: new Date().toISOString(), app_metadata: {} },
    ] });
    if (url.includes('/rest/v1/profiles?select=id,display_name,avatar_url,plan')) return Response.json([
      { id: ownerId, display_name: 'Owner', plan: 'admin' },
      { id: memberId, display_name: 'Member', plan: 'pro' },
    ]);
    if (url.includes('/rest/v1/daily_usage?select=user_id,usage_date,chat_used,image_used') && url.includes('usage_date=gte.')) return Response.json([
      { user_id: ownerId, usage_date: new Date().toISOString().slice(0, 10), chat_used: 8, image_used: 2 },
      { user_id: memberId, usage_date: new Date().toISOString().slice(0, 10), chat_used: 5, image_used: 3 },
    ]);
    if (url.includes('/rest/v1/credit_ledger?select=user_id,delta,reason,created_at')) return Response.json([
      { user_id: memberId, delta: -40, reason: 'chat', created_at: new Date().toISOString() },
      { user_id: memberId, delta: 100, reason: 'admin_credit_adjust', created_at: new Date().toISOString() },
    ]);
    throw new Error('Unexpected analytics fetch: ' + url);
  };
  try {
    const response = await handleAdminRequest(adminRequest('analytics?days=30'), env());
    assert.equal(response.status, 200);
    const payload = await response.json() as any;
    assert.equal(payload.analytics.totals.chat, 13);
    assert.equal(payload.analytics.totals.image, 5);
    assert.equal(payload.analytics.totals.creditSpent, 40);
    assert.equal(payload.analytics.totals.creditGranted, 100);
    assert.equal(payload.analytics.plans.premium, 2);
    assert.equal(payload.analytics.plans.admin, 1);
    assert.equal(payload.analytics.activity.active24h, 2);
    assert.equal(payload.analytics.series.length, 30);
  } finally {
    globalThis.fetch = original;
  }
});

test('audit endpoint supports filters and enriches actor and target identities', async () => {
  const original = globalThis.fetch;
  const event = { id: 'evt-1', actor_user_id: ownerId, target_user_id: memberId, action: 'user.banned', details: { reason: 'abuse' }, created_at: new Date().toISOString() };
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: ownerId, email: 'owner@example.com', app_metadata: {} });
    if (url.includes('/rest/v1/admin_audit_log?select=id,actor_user_id,target_user_id,action,details,created_at')) {
      assert.match(url, /action=eq\.user\.banned/);
      return Response.json([event]);
    }
    if (url.includes('/rest/v1/admin_audit_log?select=id&action=eq.user.banned')) return new Response('[]', { status: 200, headers: { 'content-range': '0-0/1' } });
    if (url.includes('/auth/v1/admin/users?page=1&per_page=200')) return Response.json({ users: [
      { id: ownerId, email: 'owner@example.com', app_metadata: {} },
      { id: memberId, email: 'member@example.com', app_metadata: {} },
    ] });
    throw new Error('Unexpected audit fetch: ' + url + ' ' + String(init?.method || 'GET'));
  };
  try {
    const response = await handleAdminRequest(adminRequest('audit?action=user.banned&page=1&perPage=40'), env());
    assert.equal(response.status, 200);
    const payload = await response.json() as any;
    assert.equal(payload.total, 1);
    assert.equal(payload.events[0].actor.email, 'owner@example.com');
    assert.equal(payload.events[0].target.email, 'member@example.com');
    assert.equal(payload.events[0].action, 'user.banned');
  } finally {
    globalThis.fetch = original;
  }
});

test('owner workflow can promote, add credit, ban, and records every mutation in audit', async () => {
  const original = globalThis.fetch;
  let plan = 'free';
  let balance = 100;
  let banned = false;
  const audits: any[] = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = String(init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: ownerId, email: 'owner@example.com', app_metadata: {} });
    if (url.includes('/rest/v1/profiles?select=plan&id=eq.' + memberId)) return Response.json([{ plan }]);
    if (url.includes('/rest/v1/profiles?on_conflict=id') && method === 'POST') { plan = body.plan; return Response.json([{ id: memberId, plan }]); }
    if (url.includes('/rest/v1/credit_wallets?select=user_id,balance') && url.includes(memberId)) return Response.json([{ user_id: memberId, balance }]);
    if (url.includes('/rest/v1/credit_wallets?user_id=eq.' + memberId) && method === 'PATCH') { balance = body.balance; return Response.json([{ user_id: memberId, balance }]); }
    if (url.endsWith('/rest/v1/credit_ledger') && method === 'POST') return Response.json([body]);
    if (url.includes('/auth/v1/admin/users/' + memberId) && method === 'GET') return Response.json({ id: memberId, email: 'member@example.com', app_metadata: { farsiai_banned: banned } });
    if (url.includes('/auth/v1/admin/users/' + memberId) && method === 'PUT') { banned = body.app_metadata?.farsiai_banned === true; return Response.json({ id: memberId, email: 'member@example.com', app_metadata: body.app_metadata }); }
    if (url.endsWith('/rest/v1/admin_audit_log') && method === 'POST') { audits.push(body); return new Response('', { status: 201 }); }
    throw new Error('Unexpected workflow fetch: ' + method + ' ' + url);
  };
  try {
    const e = env();
    const promote = await handleAdminRequest(adminRequest('users/' + memberId + '/plan', { method: 'POST', body: JSON.stringify({ plan: 'pro' }) }), e);
    assert.equal(promote.status, 200);
    assert.equal(plan, 'pro');
    const credit = await handleAdminRequest(adminRequest('users/' + memberId + '/credits', { method: 'POST', body: JSON.stringify({ mode: 'add', amount: 5000 }) }), e);
    assert.equal(credit.status, 200);
    assert.equal(balance, 5100);
    const ban = await handleAdminRequest(adminRequest('users/' + memberId + '/ban', { method: 'POST', body: JSON.stringify({ reason: 'integration test' }) }), e);
    assert.equal(ban.status, 200);
    assert.equal(banned, true);
    assert.deepEqual(audits.map((entry) => entry.action), ['user.plan.changed', 'user.credits.changed', 'user.banned']);
    assert.equal(audits.every((entry) => entry.actor_user_id === ownerId && entry.target_user_id === memberId), true);
  } finally {
    globalThis.fetch = original;
  }
});

test('CSV export is admin-only and emits UTF-8 users data', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: ownerId, email: 'owner@example.com', app_metadata: {} });
    if (url.includes('/auth/v1/admin/users?page=1&per_page=200')) return Response.json({ users: [{ id: memberId, email: 'member@example.com', created_at: new Date().toISOString(), app_metadata: {} }] });
    if (url.includes('/rest/v1/profiles?select=id,display_name,avatar_url,plan')) return Response.json([{ id: memberId, display_name: 'عضو تست', plan: 'pro' }]);
    if (url.includes('/rest/v1/credit_wallets?select=user_id,balance')) return Response.json([{ user_id: memberId, balance: 42 }]);
    if (url.includes('/rest/v1/daily_usage?select=user_id,usage_date,chat_used,image_used')) return Response.json([{ user_id: memberId, usage_date: new Date().toISOString().slice(0, 10), chat_used: 3, image_used: 1 }]);
    throw new Error('Unexpected CSV fetch: ' + url);
  };
  try {
    const response = await handleAdminRequest(adminRequest('export?type=users'), env());
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /text\/csv/);
    assert.match(response.headers.get('content-disposition') || '', /farsiai-users/);
    const body = await response.text();
    assert.match(body, /member@example\.com/);
    assert.match(body, /عضو تست/);
    assert.match(body, /pro/);
  } finally {
    globalThis.fetch = original;
  }
});
