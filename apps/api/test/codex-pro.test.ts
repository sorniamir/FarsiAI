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

function request(body: unknown): Request {
  return new Request('https://api.example.com/v1/agent/plan', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer user-access-token',
      'cf-ray': 'codex-pro-test',
    },
    body: JSON.stringify(body),
  });
}

function authenticate() {
  globalThis.fetch = mock.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: 'user-1', email: 'user@example.com' });
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

describe('Codex Pro orchestration', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restoreAll();
  });

  it('uses Kimi K2.7 Code first and permits inspection before editing a real project', async () => {
    authenticate();
    const aiRun = mock.fn(async (model: string, input: any) => {
      assert.equal(model, '@cf/moonshotai/kimi-k2.7-code');
      assert.equal(input.tool_choice, 'required');
      assert.ok(input.tools.some((tool: any) => tool.name === 'list_directory'));
      assert.ok(input.tools.some((tool: any) => tool.name === 'read_file'));
      assert.ok(input.tools.some((tool: any) => tool.name === 'write_file'));
      return { tool_calls: [{ name: 'list_directory', arguments: { path: '.' } }] };
    });

    const env = createEnv({
      AI: { run: aiRun },
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    });

    const response = await worker.fetch(request({
      task: 'این پروژه را بررسی کن، باگ لاگین را پیدا کن و حرفه‌ای رفعش کن',
      workspace: 'approved-workspace',
      observations: [],
    }), env);

    assert.equal(response.status, 200);
    const payload = await response.json() as any;
    assert.equal(payload.ok, true);
    assert.equal(payload.type, 'tool');
    assert.equal(payload.tool.name, 'list_directory');
    assert.equal(payload.model, '@cf/moonshotai/kimi-k2.7-code');
  });

  it('treats a non-zero command exit as failure and lets the model continue repairing', async () => {
    authenticate();
    const aiRun = mock.fn(async (_model: string, input: any) => {
      const serialized = JSON.stringify(input.messages);
      assert.match(serialized, /status=\\?"failure/);
      assert.match(serialized, /exit=1/);
      return { tool_calls: [{ name: 'read_file', arguments: { path: 'src/app.ts' } }] };
    });

    const env = createEnv({
      AI: { run: aiRun },
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    });

    const response = await worker.fetch(request({
      task: 'باگ را رفع کن و بعد npm test را اجرا کن تا سبز شود',
      workspace: 'approved-workspace',
      observations: [
        { role: 'tool', name: 'write_file', content: 'WRITE_OK_BACKUP_CREATED' },
        { role: 'tool', name: 'run_command', content: 'exit=1\nstdout:\n2 tests failed\nstderr:\nAssertionError' },
      ],
    }), env);

    assert.equal(response.status, 200);
    const payload = await response.json() as any;
    assert.equal(payload.ok, true);
    assert.equal(payload.type, 'tool');
    assert.equal(payload.tool.name, 'read_file');
    assert.equal(aiRun.mock.callCount(), 1);
  });

  it('does not auto-complete a complex task merely because one write and one command succeeded', async () => {
    authenticate();
    const aiRun = mock.fn(async () => ({ response: 'تغییرات انجام شد و تست مربوطه با موفقیت اجرا شد.' }));
    const env = createEnv({
      AI: { run: aiRun },
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    });

    const response = await worker.fetch(request({
      task: 'باگ بخش احراز هویت را بررسی و رفع کن و تست مناسب را اجرا کن',
      workspace: 'approved-workspace',
      observations: [
        { role: 'tool', name: 'read_file', content: 'export function login() {}' },
        { role: 'tool', name: 'write_file', content: 'WRITE_OK_BACKUP_CREATED' },
        { role: 'tool', name: 'run_command', content: 'exit=0\nstdout:\nPASS\nstderr:\n' },
      ],
    }), env);

    assert.equal(response.status, 200);
    const payload = await response.json() as any;
    assert.equal(payload.ok, true);
    assert.equal(payload.type, 'final');
    assert.match(payload.message, /تست/);
    assert.equal(aiRun.mock.callCount(), 1, 'complex completion must be decided by the model after seeing real tool output');
  });

  it('falls back from Kimi directly to GLM-5.2 before the lightweight model', async () => {
    authenticate();
    let call = 0;
    const aiRun = mock.fn(async (model: string) => {
      call += 1;
      if (call === 1) {
        assert.equal(model, '@cf/moonshotai/kimi-k2.7-code');
        throw new Error('temporary Kimi outage');
      }
      assert.equal(model, '@cf/zai-org/glm-5.2');
      return { tool_calls: [{ name: 'run_command', arguments: { command: 'git', args: ['status', '--short'] } }] };
    });

    const env = createEnv({
      AI: { run: aiRun },
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    });

    const response = await worker.fetch(request({
      task: 'وضعیت پروژه را بررسی کن و مشکلات را پیدا کن',
      workspace: 'approved-workspace',
      observations: [],
    }), env);

    assert.equal(response.status, 200);
    const payload = await response.json() as any;
    assert.equal(payload.type, 'tool');
    assert.equal(payload.model, '@cf/zai-org/glm-5.2');
    assert.equal(aiRun.mock.callCount(), 2);
  });
});
