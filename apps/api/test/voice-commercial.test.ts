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

  it('keeps guest transcription available through Workers Whisper when Gemini is not configured', async () => {
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
    assert.equal(payload.model, '@cf/openai/whisper-large-v3-turbo');
    assert.equal(limiter.mock.callCount(), 1);
    assert.equal(limiter.mock.calls[0].arguments[0].key, 'voice:guest:203.0.113.88');
  });

  it('uses Gemini audio transcription first when the server key is configured', async () => {
    const limiter = mock.fn(async () => ({ success: true }));
    const aiRun = mock.fn(async () => ({ text: 'workers should not run' }));
    const env = { ...envWith(aiRun, limiter), GEMINI_API_KEY: 'test-gemini-key' };
    globalThis.fetch = mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/v1beta/models/gemini-3.1-flash-lite:generateContent')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as any;
        assert.equal(body.contents[0].parts[1].inlineData.mimeType, 'audio/webm');
        assert.equal(body.contents[0].parts[1].inlineData.data, 'A'.repeat(64));
        return Response.json({ candidates: [{ content: { parts: [{ text: 'سلام از جمینای' }] } }] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const response = await handleVoiceTranscription(transcriptionRequest(), env);
    assert.equal(response.status, 200);
    const payload = await response.json() as any;
    assert.equal(payload.text, 'سلام از جمینای');
    assert.equal(payload.model, 'gemini-3.1-flash-lite');
    assert.equal(aiRun.mock.callCount(), 0);
  });

  it('falls back to Workers Whisper when Gemini transcription is unavailable', async () => {
    const aiRun = mock.fn(async (model: string) => {
      assert.equal(model, '@cf/openai/whisper-large-v3-turbo');
      return { text: 'متن از ویسپر' };
    });
    const env = { ...envWith(aiRun), GEMINI_API_KEY: 'test-gemini-key' };
    globalThis.fetch = mock.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('generativelanguage.googleapis.com')) return new Response('unavailable', { status: 503 });
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const response = await handleVoiceTranscription(transcriptionRequest(), env);
    assert.equal(response.status, 200);
    const payload = await response.json() as any;
    assert.equal(payload.text, 'متن از ویسپر');
    assert.equal(payload.model, '@cf/openai/whisper-large-v3-turbo');
    assert.equal(aiRun.mock.callCount(), 1);
  });

  it('blocks a banned authenticated account before invoking speech providers', async () => {
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

  it('uses authenticated user identity for Gemini TTS and returns valid WAV bytes', async () => {
    const limiter = mock.fn(async () => ({ success: true }));
    const pcm = btoa(String.fromCharCode(1, 0, 2, 0, 3, 0, 4, 0));
    const aiRun = mock.fn(async () => { throw new Error('Workers TTS must not run'); });
    const env = { ...envWith(aiRun, limiter), GEMINI_API_KEY: 'test-gemini-key' };

    globalThis.fetch = mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/auth/v1/user')) {
        return Response.json({ id: 'voice-user-1', email: 'voice@example.com', app_metadata: {} });
      }
      if (url.includes('/v1beta/models/gemini-3.1-flash-tts-preview:generateContent')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as any;
        assert.deepEqual(body.generationConfig.responseModalities, ['AUDIO']);
        assert.equal(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');
        return Response.json({
          candidates: [{ content: { parts: [{ inlineData: { data: pcm, mimeType: 'audio/L16;codec=pcm;rate=24000' } }] } }],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const response = await handleVoiceSynthesis(
      synthesisRequest({ authorization: 'Bearer voice-token' }),
      env,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'audio/wav');
    assert.equal(response.headers.get('x-farsiai-voice-model'), 'gemini-3.1-flash-tts-preview');
    assert.equal(limiter.mock.calls[0].arguments[0].key, 'voice-tts:user:voice-user-1');
    assert.equal(aiRun.mock.callCount(), 0);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.equal(String.fromCharCode(...bytes.slice(0, 4)), 'RIFF');
    assert.equal(String.fromCharCode(...bytes.slice(8, 12)), 'WAVE');
  });

  it('falls back to Gemini 2.5 TTS when the primary Gemini TTS model is unavailable', async () => {
    const pcm = btoa(String.fromCharCode(5, 0, 6, 0));
    const aiRun = mock.fn(async () => { throw new Error('Workers TTS must not run'); });
    const env = { ...envWith(aiRun), GEMINI_API_KEY: 'test-gemini-key' };
    globalThis.fetch = mock.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('gemini-3.1-flash-tts-preview:generateContent')) return new Response('primary unavailable', { status: 503 });
      if (url.includes('gemini-2.5-flash-preview-tts:generateContent')) {
        return Response.json({
          candidates: [{ content: { parts: [{ inlineData: { data: pcm, mimeType: 'audio/L16;codec=pcm;rate=24000' } }] } }],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const response = await handleVoiceSynthesis(synthesisRequest(), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-farsiai-voice-model'), 'gemini-2.5-flash-preview-tts');
    assert.equal(aiRun.mock.callCount(), 0);
  });

  it('returns an explicit configuration error when no Persian TTS provider key is configured', async () => {
    const response = await handleVoiceSynthesis(synthesisRequest(), envWith(mock.fn(async () => ({}))));
    assert.equal(response.status, 502);
    const payload = await response.json() as any;
    assert.equal(payload.code, 'VOICE_TTS_UNCONFIGURED');
    assert.match(payload.error, /کلید سرویس صدای فارسی/);
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
