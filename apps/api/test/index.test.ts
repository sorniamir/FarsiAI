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

function guestQuotaEnv(overrides: Partial<Env> = {}): Env {
  return createEnv({
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_SECRET_KEY: 'sb_secret_test',
    ...overrides,
  });
}

function mockGuestQuotaFetch(quota = { chatRemaining: 4, imageRemaining: 2 }) {
  globalThis.fetch = mock.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/rpc/use_guest_daily_quota')) return Response.json(quota);
    if (url.endsWith('/rpc/refund_guest_daily_quota')) return Response.json({ chatRemaining: 5, imageRemaining: 2 });
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

function aiRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://api.example.com/v1/ai', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function agentRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://api.example.com/v1/agent/plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function voiceRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://api.example.com/v1/voice/transcribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function ttsRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://api.example.com/v1/voice/synthesize', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
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
    assert.deepEqual(await response.json(), { ok: true, service: 'farsiai-api', version: '0.4.8' });
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://app.example.com');
  });

  it('requires an authenticated user for Codex planning', async () => {
    const env = createEnv();
    const response = await worker.fetch(agentRequest({ task: 'inspect the project', workspace: 'workspace' }), env);

    assert.equal(response.status, 401);
    assert.equal(env.AI.run.mock.callCount(), 0);
  });

  it('transcribes a real Persian voice payload through Whisper', async () => {
    const aiRun = mock.fn(async (model: string, input: Record<string, unknown>) => {
      assert.equal(model, '@cf/openai/whisper-large-v3-turbo');
      assert.equal(input.language, 'fa');
      assert.equal(input.task, 'transcribe');
      assert.equal(input.vad_filter, true);
      return { text: 'سلام، وضعیت پروژه را بررسی کن.' };
    });
    const env = createEnv({ AI: { run: aiRun } });
    const audio = Buffer.from('a'.repeat(256)).toString('base64');

    const response = await worker.fetch(voiceRequest(
      { audio, mimeType: 'audio/webm;codecs=opus', language: 'fa' },
      { 'cf-connecting-ip': '203.0.113.20', 'cf-ray': 'voice-test-ray' },
    ), env);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      text: 'سلام، وضعیت پروژه را بررسی کن.',
      model: '@cf/openai/whisper-large-v3-turbo',
      requestId: 'voice-test-ray',
    });
    assert.equal(env.API_RATE_LIMITER.limit.mock.callCount(), 1);
    assert.equal(aiRun.mock.callCount(), 1);
  });

  it('rejects empty, unsupported and oversized voice payloads before AI processing', async () => {
    const env = createEnv();
    const empty = await worker.fetch(voiceRequest({ audio: '', mimeType: 'audio/webm' }), env);
    const unsupported = await worker.fetch(voiceRequest({ audio: 'A'.repeat(128), mimeType: 'video/mp4' }), env);
    const oversized = await worker.fetch(voiceRequest({ audio: 'A'.repeat(10_500_001), mimeType: 'audio/webm' }), env);

    assert.equal(empty.status, 400);
    assert.equal(unsupported.status, 415);
    assert.equal(oversized.status, 413);
    assert.equal(env.AI.run.mock.callCount(), 0);
    assert.equal(env.API_RATE_LIMITER.limit.mock.callCount(), 0);
  });

  it('generates a playable WAV response for Persian AI speech', async () => {
    const pcm = Buffer.from([0, 0, 20, 0, 40, 0, 20, 0]);
    const aiRun = mock.fn(async (model: string, input: Record<string, unknown>) => {
      assert.equal(model, 'google/gemini-3.1-flash-tts');
      assert.equal(input.text, 'پاسخ آزمایشی فارسی');
      assert.equal(input.voice, 'Kore');
      return {
        audio: `data:audio/L16;codec=pcm;rate=24000;base64,${pcm.toString('base64')}`,
        gatewayMetadata: { keySource: 'Unified' },
      };
    });
    const env = createEnv({ AI: { run: aiRun } });

    const response = await worker.fetch(ttsRequest(
      { text: 'پاسخ آزمایشی فارسی', language: 'fa' },
      { 'cf-connecting-ip': '203.0.113.21', 'cf-ray': 'tts-test-ray' },
    ), env);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'audio/wav');
    assert.equal(response.headers.get('x-request-id'), 'tts-test-ray');
    const wav = Buffer.from(await response.arrayBuffer());
    assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');
    assert.equal(wav.length, 44 + pcm.length);
    assert.equal(response.headers.get('x-farsiai-voice-model'), 'google/gemini-3.1-flash-tts');
    assert.equal(env.API_RATE_LIMITER.limit.mock.callCount(), 1);
  });

  it('reports an upstream error when the unified Persian TTS model is unavailable', async () => {
    const env = createEnv({ AI: { run: mock.fn(async () => { throw new Error('model unavailable'); }) } });
    const response = await worker.fetch(ttsRequest({ text: 'سلام' }), env);

    assert.equal(response.status, 502);
    assert.equal((await response.json() as { code: string }).code, 'VOICE_TTS_FAILED');
    assert.equal(env.API_RATE_LIMITER.limit.mock.callCount(), 1);
  });

  it('falls back to the secondary Codex model and returns a real tool call', async () => {
    globalThis.fetch = mock.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/auth/v1/user')) return Response.json({ id: 'user-1', email: 'user@example.com' });
      throw new Error(`Unexpected fetch: ${url}`);
    });

    let modelCall = 0;
    const aiRun = mock.fn(async (model: string) => {
      modelCall += 1;
      if (modelCall === 1) throw new Error('primary model temporarily unavailable');
      assert.equal(model, '@cf/zai-org/glm-5.2');
      return {
        tool_calls: [
          { name: 'read_file', arguments: { path: 'package.json' } },
        ],
      };
    });

    const env = createEnv({
      AI: { run: aiRun },
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    });

    const response = await worker.fetch(
      agentRequest(
        { task: 'package.json را بخوان', workspace: 'approved-workspace', observations: [] },
        { authorization: 'Bearer user-access-token', 'cf-ray': 'codex-test-ray' },
      ),
      env,
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      type: 'tool',
      tool: { name: 'read_file', arguments: { path: 'package.json' } },
      model: '@cf/zai-org/glm-5.2',
      requestId: 'codex-test-ray',
    });
    assert.equal(aiRun.mock.callCount(), 2);
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

  it('serves a guest chat request through quota, limiter and AI binding', async () => {
    mockGuestQuotaFetch();
    const env = guestQuotaEnv();
    const response = await worker.fetch(
      aiRequest({ mode: 'chat', message: 'ping', history: [] }, { 'cf-connecting-ip': '203.0.113.8' }),
      env,
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      mode: 'chat',
      text: 'pong',
      quota: { chatRemaining: 4, imageRemaining: 2 },
    });
    assert.equal(env.API_RATE_LIMITER.limit.mock.callCount(), 1);
    assert.equal(env.AI.run.mock.callCount(), 1);
    assert.equal(env.AI.run.mock.calls[0].arguments[0], '@cf/qwen/qwen3-30b-a3b-fp8');
  });

  it('maps exhausted guest chat quota to a safe 402 response', async () => {
    globalThis.fetch = mock.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/rpc/use_guest_daily_quota')) {
        return Response.json({ code: 'P0001', message: 'daily_chat_limit' }, { status: 400 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const env = guestQuotaEnv();
    const response = await worker.fetch(
      aiRequest({ mode: 'chat', message: 'ping' }, { 'cf-connecting-ip': '203.0.113.8' }),
      env,
    );

    assert.equal(response.status, 402);
    assert.match((await response.json() as { error: string }).error, /۵ پیام/);
    assert.equal(env.AI.run.mock.callCount(), 0);
  });

  it('sends Persian directly to the chat model without translation', async () => {
    mockGuestQuotaFetch();
    let call = 0;
    const env = guestQuotaEnv({
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

    const [reviewModel, reviewInput] = env.AI.run.mock.calls[1].arguments as [string, { messages: Array<{ role: string; content: string }> }];
    assert.equal(reviewModel, '@cf/openai/gpt-oss-120b');
    assert.match(reviewInput.messages.at(-1)?.content ?? '', /چشم‌ها ما/);
    assert.match(reviewInput.messages.at(-1)?.content ?? '', /چرا آسمان آبی است/);
  });

  it('returns the original Persian answer if the language review is unavailable', async () => {
    mockGuestQuotaFetch();
    let call = 0;
    const env = guestQuotaEnv({
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
    const raw = '<think>internal reasoning</think>\n\n**پاسخ روشن**  \n* مورد اول\nمتن _ساده_ و `دقیق`.';

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
