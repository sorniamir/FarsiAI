import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import worker from '../src/index';
import type { Env } from '../src/types';

const originalFetch = globalThis.fetch;

function envWithAi(ai: Env['AI']): Env {
  return {
    AI: ai,
    API_RATE_LIMITER: { limit: mock.fn(async () => ({ success: true })) },
    IMAGE_RATE_LIMITER: { limit: mock.fn(async () => ({ success: true })) },
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_SECRET_KEY: 'sb_secret_test',
  };
}

function installGuestQuotaFetch() {
  globalThis.fetch = mock.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/rpc/use_guest_daily_quota')) {
      return Response.json({ chatRemaining: 5, imageRemaining: 1 });
    }
    if (url.endsWith('/rpc/refund_guest_daily_quota')) {
      return Response.json({ chatRemaining: 5, imageRemaining: 2 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

function request(body: unknown): Request {
  return new Request('https://api.example.com/v1/ai', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.46' },
    body: JSON.stringify(body),
  });
}

describe('v0.4.6 image and attachment contract', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restoreAll();
  });

  it('ignores a stale reference image when the action is generate', async () => {
    installGuestQuotaFetch();
    const aiRun = mock.fn(async (model: string, input: Record<string, unknown>) => {
      assert.equal(model, '@cf/black-forest-labs/flux-1-schnell');
      assert.equal('image_b64' in input, false);
      return { image: 'YWJj' };
    });
    const env = envWithAi({ run: aiRun });

    const response = await worker.fetch(request({
      mode: 'image',
      message: 'create a completely new landscape',
      imageAction: 'generate',
      referenceImage: 'data:image/png;base64,AA==',
    }), env);

    assert.equal(response.status, 200);
    const payload = await response.json() as { edited: boolean; image: string };
    assert.equal(payload.edited, false);
    assert.equal(payload.image, 'data:image/jpeg;base64,YWJj');
    assert.equal(aiRun.mock.callCount(), 1);
  });

  it('edits only when an explicit edit action includes a valid reference', async () => {
    installGuestQuotaFetch();
    const aiRun = mock.fn(async (model: string, input: Record<string, unknown>) => {
      assert.equal(model, '@cf/runwayml/stable-diffusion-v1-5-img2img');
      assert.equal(input.image_b64, 'AA==');
      return new Uint8Array([1, 2, 3]);
    });
    const env = envWithAi({ run: aiRun });

    const response = await worker.fetch(request({
      mode: 'image',
      message: 'make the sky purple',
      imageAction: 'edit',
      referenceImage: 'data:image/png;base64,AA==',
      replyToMessageId: 'image-message-1',
    }), env);

    assert.equal(response.status, 200);
    assert.equal((await response.json() as { edited: boolean }).edited, true);
    assert.equal(aiRun.mock.callCount(), 1);
  });

  it('rejects edit mode when no explicit image reference exists', async () => {
    const aiRun = mock.fn(async () => ({ image: 'unused' }));
    const env = envWithAi({ run: aiRun });
    const response = await worker.fetch(request({
      mode: 'image',
      message: 'edit it',
      imageAction: 'edit',
    }), env);

    assert.equal(response.status, 400);
    assert.match((await response.json() as { error: string }).error, /ریپلای|ضمیمه/);
    assert.equal(aiRun.mock.callCount(), 0);
  });

  it('converts a text attachment and includes it as quoted chat context', async () => {
    installGuestQuotaFetch();
    const aiRun = mock.fn(async (model: string, input: Record<string, unknown>) => {
      assert.equal(model, '@cf/qwen/qwen3-30b-a3b-fp8');
      const messages = input.messages as Array<{ content: string }>;
      assert.match(messages.at(-1)?.content ?? '', /گزارش تست/);
      return { response: 'فایل بررسی شد.' };
    });
    const toMarkdown = mock.fn(async () => ({
      name: 'report.txt',
      format: 'text' as const,
      data: 'گزارش تست',
    }));
    const env = envWithAi({ run: aiRun, toMarkdown });

    const response = await worker.fetch(request({
      mode: 'chat',
      message: 'این فایل را بررسی کن',
      attachments: [{
        name: 'report.txt',
        mimeType: 'text/plain',
        dataUrl: `data:text/plain;base64,${btoa('test report')}`,
      }],
    }), env);

    assert.equal(response.status, 200);
    assert.equal(toMarkdown.mock.callCount(), 1);
    assert.equal(aiRun.mock.callCount(), 2);
  });

  it('rejects unsupported attachments before spending quota', async () => {
    const limiter = mock.fn(async () => ({ success: true }));
    const env: Env = {
      AI: { run: mock.fn(async () => ({ response: 'unused' })) },
      API_RATE_LIMITER: { limit: limiter },
      IMAGE_RATE_LIMITER: { limit: limiter },
    };

    const response = await worker.fetch(request({
      mode: 'chat',
      message: 'open this',
      attachments: [{
        name: 'archive.zip',
        mimeType: 'application/zip',
        dataUrl: 'data:application/zip;base64,AA==',
      }],
    }), env);

    assert.equal(response.status, 400);
    assert.equal(limiter.mock.callCount(), 0);
  });
});
