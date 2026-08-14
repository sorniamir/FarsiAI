import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { parseGeneratedImageDataUrl, persistGeneratedImage } from '../src/lib/image-storage';
import type { Env } from '../src/types';

const originalFetch = globalThis.fetch;

function env(key = 'sb_secret_storage_test'): Env {
  return {
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_SECRET_KEY: key,
  } as Env;
}

describe('generated image object storage', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restoreAll();
  });

  it('parses supported image data URLs without keeping the Base64 wrapper', () => {
    const parsed = parseGeneratedImageDataUrl('data:image/png;base64,YWJj');
    assert.ok(parsed);
    assert.equal(parsed.mimeType, 'image/png');
    assert.equal(parsed.extension, 'png');
    assert.deepEqual(Array.from(parsed.bytes), [97, 98, 99]);
    assert.equal(parseGeneratedImageDataUrl('data:image/svg+xml;base64,YWJj'), null);
    assert.equal(parseGeneratedImageDataUrl('https://example.com/image.png'), null);
  });

  it('uploads to a private user-scoped object path with a server secret key', async () => {
    const userId = '11111111-2222-4333-8444-555555555555';
    globalThis.fetch = mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      assert.match(url, new RegExp(`/storage/v1/object/generated-images/${userId}/\\d{4}/\\d{2}/.+\\.png$`));
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('apikey'), 'sb_secret_storage_test');
      assert.equal(headers.get('authorization'), null);
      assert.equal(headers.get('content-type'), 'image/png');
      assert.equal(init?.method, 'POST');
      assert.ok(init?.body instanceof Blob);
      assert.equal((init?.body as Blob).size, 3);
      return Response.json({ Key: 'ok' });
    });

    const marker = await persistGeneratedImage(env(), userId, 'data:image/png;base64,YWJj');
    assert.match(marker ?? '', new RegExp(`^storage:generated-images/${userId}/\\d{4}/\\d{2}/.+\\.png$`));
  });

  it('returns null instead of falling back to a large Postgres value when storage fails', async () => {
    globalThis.fetch = mock.fn(async () => new Response('storage unavailable', { status: 503 }));
    const marker = await persistGeneratedImage(
      env(),
      '11111111-2222-4333-8444-555555555555',
      'data:image/jpeg;base64,YWJj',
    );
    assert.equal(marker, null);
  });

  it('keeps legacy service-role bearer behavior for older projects', async () => {
    const legacyKey = 'legacy.jwt.service.role';
    globalThis.fetch = mock.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('apikey'), legacyKey);
      assert.equal(headers.get('authorization'), `Bearer ${legacyKey}`);
      return Response.json({ Key: 'ok' });
    });

    const marker = await persistGeneratedImage(
      env(legacyKey),
      '11111111-2222-4333-8444-555555555555',
      'data:image/webp;base64,YWJj',
    );
    assert.match(marker ?? '', /\.webp$/);
  });
});
