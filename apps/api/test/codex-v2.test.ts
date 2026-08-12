import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { handleCodexTurn } from '../src/ai/codex-v2';
import type { Env } from '../src/types';

const originalFetch = globalThis.fetch;

function authenticate() {
  globalThis.fetch = mock.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: 'codex-v2-user', email: 'codex@example.com' });
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

function envWith(run: Env['AI']['run']): Env {
  return {
    AI: { run },
    API_RATE_LIMITER: { limit: mock.fn(async () => ({ success: true })) },
    IMAGE_RATE_LIMITER: { limit: mock.fn(async () => ({ success: true })) },
    ALLOWED_ORIGIN: '*',
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
  };
}

function body(observations: unknown[] = []) {
  return {
    task: 'فایل package.json را بررسی کن و فقط در صورت نیاز قدم بعدی را پیشنهاد بده.',
    workspace: { boundary: 'approved-workspace', label: 'Codex v2 test workspace' },
    observations,
    client: { kind: 'desktop', version: '0.5.1', locale: 'fa-IR' },
    capabilities: {
      protocol: 'farsiai.codex.desktop.v2',
      tools: [{ name: 'read_file', permission: 'automatic' }],
      safeCommands: [],
      approvedApplications: [],
      permissionMode: 'guarded',
      boundary: 'session-workspace-grant',
      supports: ['structured_evidence'],
    },
  };
}

function request(payload: unknown): Request {
  return new Request('https://api.example.com/v2/codex/turn', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer test-access-token',
      'x-farsiai-codex-protocol': 'farsiai.codex.desktop.v2',
      'cf-ray': 'codex-v2-test',
    },
    body: JSON.stringify(payload),
  });
}

describe('Codex Studio v2 free-plan planner', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restoreAll();
  });

  it('uses live-tested GPT-OSS 120B first and parses Responses API function calls', async () => {
    authenticate();
    const aiRun = mock.fn(async (model: string, input: any) => {
      assert.equal(model, '@cf/openai/gpt-oss-120b');
      assert.equal(input.tool_choice, 'required');
      assert.equal(input.tools[0].name, 'read_file');
      return {
        output: [{
          type: 'function_call',
          call_id: 'fc-read-package',
          name: 'read_file',
          arguments: '{"path":"package.json"}',
        }],
      };
    });

    const response = await handleCodexTurn(request(body()), envWith(aiRun));
    assert.equal(response.status, 200);
    const payload = await response.json() as any;
    assert.equal(payload.ok, true);
    assert.equal(payload.type, 'tool');
    assert.equal(payload.model, '@cf/openai/gpt-oss-120b');
    assert.equal(payload.tool.name, 'read_file');
    assert.equal(payload.tool.callId, 'fc-read-package');
    assert.equal(payload.tool.arguments.path, 'package.json');
    assert.equal(aiRun.mock.callCount(), 1);
  });

  it('falls back to live-tested Gemma after both primary compatibility attempts fail', async () => {
    authenticate();
    let calls = 0;
    const aiRun = mock.fn(async (model: string) => {
      calls += 1;
      if (model === '@cf/openai/gpt-oss-120b') throw new Error('temporary primary outage');
      assert.equal(model, '@cf/google/gemma-4-26b-a4b-it');
      return { tool_calls: [{ id: 'fallback-call', name: 'read_file', arguments: { path: 'package.json' } }] };
    });

    const response = await handleCodexTurn(request(body()), envWith(aiRun));
    assert.equal(response.status, 200);
    const payload = await response.json() as any;
    assert.equal(payload.ok, true);
    assert.equal(payload.type, 'tool');
    assert.equal(payload.model, '@cf/google/gemma-4-26b-a4b-it');
    assert.equal(payload.tool.name, 'read_file');
    assert.equal(calls, 3, 'primary should receive standard + compatibility attempts before the verified fallback');
  });

  it('parses a Responses API final message after verified local evidence', async () => {
    authenticate();
    const aiRun = mock.fn(async (model: string) => {
      assert.equal(model, '@cf/openai/gpt-oss-120b');
      return {
        output: [{
          type: 'message',
          content: [{ type: 'output_text', text: 'فایل بررسی شد و در این مرحله تغییر دیگری لازم نیست.' }],
        }],
      };
    });

    const observations = [{
      role: 'tool',
      callId: 'fc-read-package',
      name: 'read_file',
      status: 'success',
      content: '{"name":"farsiai"}',
      evidence: { verified: true, afterSha256: 'abc123' },
    }];
    const response = await handleCodexTurn(request(body(observations)), envWith(aiRun));
    assert.equal(response.status, 200);
    const payload = await response.json() as any;
    assert.equal(payload.ok, true);
    assert.equal(payload.type, 'final');
    assert.match(payload.message, /فایل بررسی شد/);
    assert.equal(payload.model, '@cf/openai/gpt-oss-120b');
  });
});
