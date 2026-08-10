import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import worker from '../src/index';
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

function agentRequest(body: unknown): Request {
  return new Request('https://api.example.com/v1/agent/plan', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer user-access-token',
      'cf-ray': 'codex-write-regression',
    },
    body: JSON.stringify(body),
  });
}

function guestRequest(body: unknown): Request {
  return new Request('https://api.example.com/v1/ai', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': '203.0.113.42',
    },
    body: JSON.stringify(body),
  });
}

function installAuthenticatedUserFetch() {
  globalThis.fetch = mock.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: 'user-1', email: 'user@example.com' });
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

describe('Desktop v0.4.3 regressions', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restoreAll();
  });

  it('rejects a fake textual Codex completion until a real write_file tool call is returned', async () => {
    installAuthenticatedUserFetch();

    let call = 0;
    const aiRun = mock.fn(async (_model: string, input: any) => {
      assert.equal(input.tool_choice, 'required');
      assert.equal(input.tools.length, 1);
      assert.equal(input.tools[0].name, 'write_file');
      call += 1;
      if (call === 1) return { response: 'فایل ساخته شد.' };
      return {
        tool_calls: [
          {
            name: 'write_file',
            arguments: { path: 'hello.txt', content: 'سلام من FarsiAI هستم' },
          },
        ],
      };
    });

    const env = createEnv({
      AI: { run: aiRun },
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    });

    const response = await worker.fetch(
      agentRequest({
        task: 'یک فایل hello.txt بساز و داخلش بنویس سلام من FarsiAI هستم',
        workspace: 'approved-workspace',
        observations: [],
      }),
      env,
    );

    assert.equal(response.status, 200);
    const payload = await response.json() as any;
    assert.equal(payload.ok, true);
    assert.equal(payload.type, 'tool');
    assert.equal(payload.tool.name, 'write_file');
    assert.equal(payload.tool.arguments.path, 'hello.txt');
    assert.equal(aiRun.mock.callCount(), 2);
  });

  it('rejects the wrong tool for a create-file task and strips the virtual workspace prefix', async () => {
    installAuthenticatedUserFetch();

    let call = 0;
    const aiRun = mock.fn(async (_model: string, input: any) => {
      assert.equal(input.tool_choice, 'required');
      assert.deepEqual(input.tools.map((tool: any) => tool.name), ['write_file']);
      call += 1;
      if (call === 1) {
        return {
          tool_calls: [
            { name: 'list_directory', arguments: { path: '.' } },
          ],
        };
      }
      return {
        tool_calls: [
          {
            name: 'write_file',
            arguments: { path: 'approved-workspace/hello.txt', content: 'real-write' },
          },
        ],
      };
    });

    const env = createEnv({
      AI: { run: aiRun },
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    });

    const response = await worker.fetch(
      agentRequest({
        task: 'فایل hello.txt بساز و داخلش real-write بنویس',
        workspace: 'approved-workspace',
        observations: [],
      }),
      env,
    );

    assert.equal(response.status, 200);
    const payload = await response.json() as any;
    assert.equal(payload.ok, true);
    assert.equal(payload.type, 'tool');
    assert.equal(payload.tool.name, 'write_file');
    assert.equal(payload.tool.arguments.path, 'hello.txt');
    assert.equal(payload.tool.arguments.content, 'real-write');
    assert.equal(aiRun.mock.callCount(), 2);
  });

  it('keeps Guest Chat available when the production guest quota RPC is missing', async () => {
    globalThis.fetch = mock.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/rpc/use_guest_daily_quota')) {
        return Response.json({ code: 'PGRST202', message: 'Could not find the function public.use_guest_daily_quota' }, { status: 404 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const env = createEnv({
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_SECRET_KEY: 'sb_secret_test',
    });

    const response = await worker.fetch(
      guestRequest({ mode: 'chat', message: 'ping', history: [] }),
      env,
    );

    assert.equal(response.status, 200);
    const payload = await response.json() as any;
    assert.equal(payload.ok, true);
    assert.equal(payload.mode, 'chat');
    assert.equal(payload.quota.chatRemaining, 4);
    assert.equal(payload.quota.imageRemaining, 2);
  });
});
