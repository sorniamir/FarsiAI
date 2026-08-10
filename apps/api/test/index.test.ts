import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import worker from '../src/index';
import { normalizeAssistantText } from '../src/ai/chat';
import { spendDailyQuota } from '../src/lib/credits';
import type { Env } from '../src/types';

const originalFetch = globalThis.fetch;

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    AI: { run: mock.fn(async () => ({ response: 'pong' })) },
    API_RATE_LIMITER: { limit: mock.fn(async () => ({ success: true })) },
    IMAGE_RATE_LIMITER: { limit: mock.fn(async () => ({ success: true })) },
    ALLOWED_ORIGIN: 'https://app.example.com',
    ...overrides,
  };
}

function aiRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://api.example.com/v1/ai', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('FarsiAI Worker', () => {
  beforeEach(() => {
    mock.method(console, 'log', () => undefined);
    mock.method(console, 'warn', () => undefined);
    mock.method(console, 'error', () => undefined);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restoreAll();
  });

  it('reports a versioned health response', async () => {
    const response = await worker.fetch(new Request('https://api.example.com/health'), createEnv());

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, service: 'farsiai-api', version: '0.3.3' });
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://app.example.com');
  });

  it('rejects malformed JSON and unsupported modes as client errors', async () => {
    const env = createEnv();
    const malformed = await worker.fetch(aiRequest('{'), env);
    const unsupported = await worker.fetch(aiRequest({ mode: 'video', message: 'hello' }), env);

    assert.equal(malformed.status, 400);
    assert.equal(unsupported.status, 400);
    assert.equal(env.API_RATE_LIMITER.limit.mock.callCount(), 0);
    assert.equal(env.AI.run.mock.callCount(), 0);
  });

  it('serves a guest chat request through the configured limiter and AI binding', async () => {
    const env = createEnv();
    const response = await worker.fetch(
      aiRequest({ mode: 'chat', message: 'ping', history: [] }, { 'cf-connecting-ip': '203.0.113.8' }),
      env,
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, mode: 'chat', text: 'pong' });
    assert.equal(env.API_RATE_LIMITER.limit.mock.callCount(), 1);
    assert.equal(env.AI.run.mock.callCount(), 1);
    assert.equal(env.AI.run.mock.calls[0].arguments[0], '@cf/qwen/qwen3-30b-a3b-fp8');
  });

  it('sends Persian directly to the chat model without translation', async () => {
    let call = 0;
    const env = createEnv({
      AI: {
        run: mock.fn(async () => ({
          response: call++ === 0
            ? 'چشم‌ها ما به نور آبی حساس‌تر هستند.'
            : 'چشم‌های ما به نور آبی حساس‌ترند.',
        })),
      },
    });

    const response = await worker.fetch(
      aiRequest({
        mode: 'chat',
        message: 'چرا آسمان آبی است؟',
        history: [{ role: 'assistant', content: 'قبلاً درباره نور صحبت کردیم.' }],
      }),
      env,
    );

    assert.equal(response.status, 200);
    assert.equal((await response.json() as { text: string }).text, 'چشم‌های ما به نور آبی حساس‌ترند.');
    assert.equal(env.AI.run.mock.callCount(), 2);
    const [model, input] = env.AI.run.mock.calls[0].arguments as [string, { messages: Array<{ role: string; content: string }> }];
    assert.equal(model, '@cf/qwen/qwen3-30b-a3b-fp8');
    assert.equal(input.messages.at(-1)?.content, 'چرا آسمان آبی است؟');
    assert.ok(input.messages.some((item) => item.content === 'قبلاً درباره نور صحبت کردیم.'));

    const [, reviewInput] = env.AI.run.mock.calls[1].arguments as [string, { messages: Array<{ role: string; content: string }> }];
    assert.match(reviewInput.messages.at(-1)?.content ?? '', /چشم‌ها ما/);
    assert.match(reviewInput.messages.at(-1)?.content ?? '', /چرا آسمان آبی است/);
  });

  it('returns the original Persian answer if the language review is unavailable', async () => {
    let call = 0;
    const env = createEnv({
      AI: {
        run: mock.fn(async () => {
          if (call++ === 0) return { response: 'پاسخ فارسی اولیه.' };
          throw new Error('review unavailable');
        }),
      },
    });

    const response = await worker.fetch(aiRequest({ mode: 'chat', message: 'یک پاسخ فارسی بده.' }), env);

    assert.equal(response.status, 200);
    assert.equal((await response.json() as { text: string }).text, 'پاسخ فارسی اولیه.');
    assert.equal(env.AI.run.mock.callCount(), 2);
  });

  it('removes hidden reasoning and raw Markdown from assistant text', () => {
    const raw = '<think>internal reasoning</think>\n\n**پاسخ روشن**\n* مورد اول\nمتن _ساده_ و `دقیق`.';

    assert.equal(normalizeAssistantText(raw), 'پاسخ روشن\n• مورد اول\nمتن ساده و دقیق.');
  });

  it('stops rate-limited requests before invoking Workers AI', async () => {
    const env = createEnv({
      API_RATE_LIMITER: { limit: mock.fn(async () => ({ success: false })) },
    });
    const response = await worker.fetch(aiRequest({ mode: 'chat', message: 'ping' }), env);

    assert.equal(response.status, 429);
    assert.equal(env.AI.run.mock.callCount(), 0);
  });

  it('refunds an authenticated charge when Workers AI fails', async () => {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    const mockFetch = mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      calls.push({ url, body });

      if (url.endsWith('/auth/v1/user')) return Response.json({ id: 'user-1', email: 'user@example.com' });
      if (url.endsWith('/rpc/use_daily_quota')) return Response.json({ chatRemaining: 9, imageRemaining: 4 });
      if (url.endsWith('/conversations?select=id')) {
        return Response.json([{ id: '11111111-1111-1111-1111-111111111111' }], { status: 201 });
      }
      if (url.endsWith('/messages')) return new Response(null, { status: 201 });
      if (url.includes('/conversations?id=eq.')) return new Response(null, { status: 204 });
      if (url.endsWith('/rpc/refund_daily_quota')) return Response.json({ chatRemaining: 10, imageRemaining: 4 });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    globalThis.fetch = mockFetch;

    const env = createEnv({
      AI: { run: mock.fn(async () => { throw new Error('AI unavailable'); }) },
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
      SUPABASE_SECRET_KEY: 'sb_secret_test',
    });
    const response = await worker.fetch(
      aiRequest(
        { mode: 'chat', message: 'ping' },
        { authorization: 'Bearer user-access-token', 'cf-ray': 'test-ray' },
      ),
      env,
    );

    assert.equal(response.status, 500);
    assert.ok(calls.some(({ url }) => url.endsWith('/rpc/use_daily_quota')));
    assert.deepEqual(calls.find(({ url }) => url.endsWith('/rpc/refund_daily_quota')), {
      url: 'https://project.supabase.co/rest/v1/rpc/refund_daily_quota',
      body: {
        p_user_id: 'user-1',
        p_reference_id: 'test-ray',
      },
    });
  });
});

describe('Supabase admin authentication', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restoreAll();
  });

  it('adds a bearer header for a legacy service-role JWT', async () => {
    const mockFetch = mock.fn(async () => Response.json({ chatRemaining: 9, imageRemaining: 4 }));
    globalThis.fetch = mockFetch;

    const result = await spendDailyQuota(
      createEnv({
        SUPABASE_URL: 'https://project.supabase.co/',
        SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role-jwt',
      }),
      'user-1',
      'chat',
      'request-1',
    );

    assert.deepEqual(result, { ok: true, quota: { chatRemaining: 9, imageRemaining: 4, resetsAt: undefined } });
    const [, init] = mockFetch.mock.calls[0].arguments as [string, RequestInit];
    const headers = new Headers(init.headers);
    assert.equal(headers.get('apikey'), 'legacy-service-role-jwt');
    assert.equal(headers.get('authorization'), 'Bearer legacy-service-role-jwt');
  });

  it('uses only apikey for a modern Supabase secret key', async () => {
    const mockFetch = mock.fn(async () => Response.json({ chatRemaining: 9, imageRemaining: 4 }));
    globalThis.fetch = mockFetch;

    await spendDailyQuota(
      createEnv({
        SUPABASE_URL: 'https://project.supabase.co',
        SUPABASE_SECRET_KEY: 'sb_secret_test',
      }),
      'user-1',
      'chat',
      'request-1',
    );

    const [, init] = mockFetch.mock.calls[0].arguments as [string, RequestInit];
    const headers = new Headers(init.headers);
    assert.equal(headers.get('apikey'), 'sb_secret_test');
    assert.equal(headers.has('authorization'), false);
  });

  it('maps exhausted daily chat quota to a client-safe limit result', async () => {
    globalThis.fetch = mock.fn(async () => Response.json(
      { code: 'P0001', message: 'daily_chat_limit' },
      { status: 400 },
    ));

    const result = await spendDailyQuota(
      createEnv({
        SUPABASE_URL: 'https://project.supabase.co',
        SUPABASE_SECRET_KEY: 'sb_secret_test',
      }),
      'user-1',
      'chat',
      'request-limit',
    );

    assert.deepEqual(result, { ok: false, reason: 'chat_limit' });
  });
});

