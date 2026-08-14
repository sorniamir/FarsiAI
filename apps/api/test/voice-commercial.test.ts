import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { handleVoiceSynthesis, handleVoiceTranscription } from '../src/ai/voice';
import type { Env } from '../src/types';

const originalFetch = globalThis.fetch;

function envWith(run: Env['AI']['run'], limiter = mock.fn(async () => ({ success: true }))): Env {
  return {
    AI: { run },
    API_RATE_LIMITER: { limit: limiter },
    IMAGE_RATE_LIMITER: { limit: mock.fn(async () => ({ success: true })) },
    ALLOWED_ORIGIN: '*',
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
  };
}

function transcriptionRequest(headers: Record<string, string> = {}): Request {
  return new Request('https://api.example.com/v1/voice/transcribe', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': '203.0.113.88',
      ...headers,
    },
    body: JSON.stringify({
      audio: 'A'.repeat(64),
      mimeType: 'audio/webm',
      language: 'fa',
    }),
  });
}

function synthesisRequest(headers: Record<string, string> = {}): Request {
  return new Request('https://api.example.com/v1/voice/synthesize', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': '203.0.113.88',
      ...headers,
    },
    body: JSON.stringify({ text: 'سلام، این یک تست صدای فارسی است.' }),
  });
}

describe('commercial voice hardening', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restoreAll();
  });

  it('keeps guest transcription available but rate-limits it under an explicit guest actor key', async () => {
    const limiter = mock.fn(async () => ({ success: true }));
    const aiRun = mock.fn(async (model: string, input: any) => {
      assert.equal(model, '@cf/openai/whisper-large-v3-turbo');
      assert.equal(input.initial_prompt, 'گفت‌وگوی طبیعی فارسی با علائم نگارشی صحیح.');
      return { text: 'سلام دنیا' };
    });
    const response = await handleVoiceTranscription(transcriptionRequest(), envWith(aiRun, limiter));
    assert.equal(response.status, 200);
    const payload = await response.json() as any;
    assert.equal(payload.ok, true);
    assert.equal(payload.text, 'سلام دنیا');
    assert.equal(limiter.mock.callCount(), 1);
    assert.equal(limiter.mock.calls[0].arguments[0].key, 'voice:guest:203.0.113.88');
  });

  it('blocks a banned authenticated account before invoking the speech model', async () => {
    globalThis.fetch = mock.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/auth/v1/user')) {
        return Response.json({
          id: 'banned-voice-user',
          email: 'banned@example.com',
          app_metadata: { farsiai_banned: true },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const limiter = mock.fn(async () => ({ success: true }));
    const aiRun = mock.fn(async () => ({ text: 'must not run' }));
    const response = await handleVoiceTranscription(
      transcriptionRequest({ authorization: 'Bearer banned-token' }),
      envWith(aiRun, limiter),
    );
    assert.equal(response.status, 403);
    const payload = await response.json() as any;
    assert.equal(payload.code, 'VOICE_ACCOUNT_BANNED');
    assert.match(payload.error, /مسدود/);
    assert.equal(aiRun.mock.callCount(), 0);
    assert.equal(limiter.mock.callCount(), 0);
  });

  it('uses authenticated user identity for TTS rate limiting and returns valid WAV bytes', async () => {
    globalThis.fetch = mock.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/auth/v1/user')) {
        return Response.json({ id: 'voice-user-1', email: 'voice@example.com', app_metadata: {} });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const limiter = mock.fn(async () => ({ success: true }));
    const pcm = btoa(String.fromCharCode(1, 0, 2, 0, 3, 0, 4, 0));
    const aiRun = mock.fn(async (model: string) => {
      assert.equal(model, 'google/gemini-3.1-flash-tts');
      return { output_audio: { data: pcm, mime_type: 'audio/L16;codec=pcm;rate=24000' } };
    });
    const response = await handleVoiceSynthesis(
      synthesisRequest({ authorization: 'Bearer voice-token' }),
      envWith(aiRun, limiter),
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'audio/wav');
    assert.equal(limiter.mock.calls[0].arguments[0].key, 'voice-tts:user:voice-user-1');
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.equal(String.fromCharCode(...bytes.slice(0, 4)), 'RIFF');
    assert.equal(String.fromCharCode(...bytes.slice(8, 12)), 'WAVE');
  });

  it('returns readable Persian errors instead of mojibake', async () => {
    const request = new Request('https://api.example.com/v1/voice/transcribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{invalid-json',
    });
    const response = await handleVoiceTranscription(request, envWith(mock.fn(async () => ({}))));
    assert.equal(response.status, 400);
    const payload = await response.json() as any;
    assert.equal(payload.error, 'داده صوتی معتبر نیست.');
    assert.equal(/[ØÙ]/.test(payload.error), false);
  });
});
