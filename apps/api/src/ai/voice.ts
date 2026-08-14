import { corsHeaders, json } from '../lib/http';
import { sanitizeText } from '../lib/language';
import { resolveAuth } from '../lib/supabase-auth';
import type { Env } from '../types';

const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo';
const WHISPER_FALLBACK_MODEL = '@cf/openai/whisper';
const DEFAULT_STT_MODEL = 'gemini-3.1-flash-lite';
const DEFAULT_TTS_MODEL = 'gemini-3.1-flash-tts-preview';
const FALLBACK_TTS_MODEL = 'gemini-2.5-flash-preview-tts';
const DEFAULT_TTS_VOICE = 'Kore';
const MAX_BASE64_LENGTH = 10_500_000;
const MAX_GENERATED_AUDIO_BASE64 = 14_000_000;
const MAX_TTS_TEXT_LENGTH = 4000;
const GEMINI_VOICE_TIMEOUT_MS = 60_000;
const SUPPORTED_AUDIO_TYPES = new Set([
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
]);

type VoicePayload = {
  audio?: unknown;
  mimeType?: unknown;
  language?: unknown;
};

type TtsPayload = {
  text?: unknown;
  language?: unknown;
};

type GeneratedAudio = {
  data: string;
  mimeType: string;
  model: string;
};

type VoiceAccess =
  | { ok: true; actorKey: string; authenticated: boolean }
  | { ok: false; response: Response };

function normalizedMimeType(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase().split(';', 1)[0].trim() : '';
}

async function resolveVoiceAccess(request: Request, env: Env, requestId: string): Promise<VoiceAccess> {
  const auth = await resolveAuth(request, env);
  if (auth.kind === 'invalid') {
    return { ok: false, response: json(env, { ok: false, error: 'نشست کاربری معتبر نیست. دوباره وارد حساب شوید.', code: 'VOICE_AUTH_INVALID', requestId }, 401) };
  }
  if (auth.kind === 'unconfigured') {
    return { ok: false, response: json(env, { ok: false, error: 'اتصال حساب کاربری به سرور هنوز کامل نشده است.', code: 'VOICE_AUTH_UNCONFIGURED', requestId }, 503) };
  }
  if (auth.kind === 'user') {
    if (auth.user.banned) {
      return { ok: false, response: json(env, { ok: false, error: 'این حساب توسط مدیریت FarsiAI مسدود شده است.', code: 'VOICE_ACCOUNT_BANNED', requestId }, 403) };
    }
    return { ok: true, actorKey: `user:${auth.user.id}`, authenticated: true };
  }
  const guestIp = request.headers.get('cf-connecting-ip') || 'anonymous';
  return { ok: true, actorKey: `guest:${guestIp}`, authenticated: false };
}

function transcriptionText(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const payload = result as Record<string, unknown>;
  if (typeof payload.text === 'string') return sanitizeText(payload.text, 6000);
  if (payload.result && typeof payload.result === 'object') {
    const nested = payload.result as Record<string, unknown>;
    if (typeof nested.text === 'string') return sanitizeText(nested.text, 6000);
  }
  return '';
}

function extractGeminiText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const payload = value as Record<string, unknown>;
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const content = (candidate as Record<string, unknown>).content;
    if (!content || typeof content !== 'object') continue;
    const parts = Array.isArray((content as Record<string, unknown>).parts)
      ? (content as Record<string, unknown>).parts as unknown[]
      : [];
    const text = parts
      .map((part) => part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string'
        ? String((part as Record<string, unknown>).text)
        : '')
      .join('\n')
      .trim();
    if (text) return sanitizeText(text, 6000);
  }
  return '';
}

function audioBlock(value: unknown, model: string): GeneratedAudio | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const data = typeof item.data === 'string' ? item.data.replace(/\s+/g, '').trim() : '';
  if (!data || data.length > MAX_GENERATED_AUDIO_BASE64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
  const mimeType = typeof item.mime_type === 'string'
    ? item.mime_type
    : typeof item.mimeType === 'string'
      ? item.mimeType
      : 'audio/L16;codec=pcm;rate=24000';
  return { data, mimeType, model };
}

function extractGeneratedAudio(value: unknown, model: string): GeneratedAudio | null {
  if (!value || typeof value !== 'object') return null;
  const payload = value as Record<string, unknown>;
  if (typeof payload.audio === 'string' && payload.audio.trim()) {
    const raw = payload.audio.trim();
    const dataUrl = raw.match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.+)$/s);
    const data = (dataUrl?.[2] ?? raw).replace(/\s+/g, '').trim();
    if (!data || data.length > MAX_GENERATED_AUDIO_BASE64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
    return { data, mimeType: dataUrl?.[1] ?? 'audio/wav', model };
  }
  const direct = audioBlock(payload.output_audio ?? payload.outputAudio, model);
  if (direct) return direct;

  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const content = (candidate as Record<string, unknown>).content;
    if (!content || typeof content !== 'object') continue;
    const parts = Array.isArray((content as Record<string, unknown>).parts)
      ? (content as Record<string, unknown>).parts as unknown[]
      : [];
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      const record = part as Record<string, unknown>;
      const found = audioBlock(record.inlineData ?? record.inline_data ?? record.audio, model);
      if (found) return found;
    }
  }

  const outputs = Array.isArray(payload.outputs) ? payload.outputs : [];
  for (const output of outputs) {
    if (!output || typeof output !== 'object') continue;
    const record = output as Record<string, unknown>;
    const found = audioBlock(record.audio ?? record.output_audio ?? record.outputAudio, model);
    if (found) return found;
  }
  return null;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function pcmToWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const wav = new Uint8Array(44 + pcm.length);
  const view = new DataView(wav.buffer);
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) wav[offset + index] = value.charCodeAt(index);
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, pcm.length, true);
  wav.set(pcm, 44);
  return wav;
}

function audioAsWav(audio: GeneratedAudio): Uint8Array {
  const bytes = decodeBase64(audio.data);
  if (bytes.length >= 12
    && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.slice(8, 12)) === 'WAVE') return bytes;
  if (/audio\/(?:wav|wave|x-wav)/i.test(audio.mimeType)) return bytes;
  const rate = Number(audio.mimeType.match(/rate=(\d+)/i)?.[1] ?? 24000);
  return pcmToWav(bytes, Number.isFinite(rate) && rate >= 8000 && rate <= 96000 ? rate : 24000);
}

async function geminiTranscribe(env: Env, audio: string, mimeType: string, language: string): Promise<{ text: string; model: string } | null> {
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) return null;
  const model = DEFAULT_STT_MODEL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('gemini-stt-timeout'), GEMINI_VOICE_TIMEOUT_MS);
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ parts: [
          { text: `Transcribe the supplied audio verbatim. Return only the transcript, with normal punctuation. The expected language is ${language || 'fa'}. Do not answer or summarize the speech.` },
          { inlineData: { mimeType, data: audio } },
        ] }],
        generationConfig: { temperature: 0 },
      }),
    });
    if (!response.ok) {
      console.warn(JSON.stringify({ event: 'gemini_stt_failed', status: response.status, model }));
      return null;
    }
    const text = extractGeminiText(await response.json());
    return text ? { text, model } : null;
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'gemini_stt_exception',
      model,
      message: error instanceof Error ? error.message : 'unknown_gemini_stt_error',
    }));
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function whisperTurboTranscribe(
  env: Env,
  audio: string,
  language: string,
  relaxed: boolean,
): Promise<{ text: string; model: string } | null> {
  try {
    const input: Record<string, unknown> = {
      audio,
      task: 'transcribe',
      language,
      vad_filter: !relaxed,
      initial_prompt: 'گفت‌وگوی طبیعی فارسی با علائم نگارشی صحیح.',
    };
    if (relaxed) {
      input.vad_filter = false;
      input.no_speech_threshold = 0.95;
      input.condition_on_previous_text = false;
      input.beam_size = 5;
    }
    const result = await env.AI.run(WHISPER_MODEL, input as any);
    const text = transcriptionText(result);
    if (!text) {
      console.warn(JSON.stringify({ event: 'workers_whisper_empty', model: WHISPER_MODEL, relaxed }));
      return null;
    }
    return { text, model: WHISPER_MODEL };
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'workers_whisper_failed',
      model: WHISPER_MODEL,
      relaxed,
      message: error instanceof Error ? error.message : 'unknown_whisper_error',
    }));
    return null;
  }
}

async function legacyWhisperTranscribe(env: Env, audio: string): Promise<{ text: string; model: string } | null> {
  try {
    const bytes = Array.from(decodeBase64(audio));
    const result = await env.AI.run(WHISPER_FALLBACK_MODEL, { audio: bytes } as any);
    const text = transcriptionText(result);
    if (!text) {
      console.warn(JSON.stringify({ event: 'workers_legacy_whisper_empty', model: WHISPER_FALLBACK_MODEL }));
      return null;
    }
    return { text, model: WHISPER_FALLBACK_MODEL };
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'workers_legacy_whisper_failed',
      model: WHISPER_FALLBACK_MODEL,
      message: error instanceof Error ? error.message : 'unknown_legacy_whisper_error',
    }));
    return null;
  }
}

async function workersTranscribe(env: Env, audio: string, language: string): Promise<{ text: string; model: string } | null> {
  return await whisperTurboTranscribe(env, audio, language, false)
    ?? await whisperTurboTranscribe(env, audio, language, true)
    ?? await legacyWhisperTranscribe(env, audio);
}

async function geminiGenerateContentTts(env: Env, text: string, model: string): Promise<GeneratedAudio | null> {
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('gemini-tts-timeout'), GEMINI_VOICE_TIMEOUT_MS);
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ parts: [{ text: `با صدایی طبیعی، گرم و واضح و با سرعت مکالمه‌ای، فقط متن زیر را به فارسی بخوان و چیزی به آن اضافه یا از آن کم نکن:\n\n${text}` }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: env.GEMINI_TTS_VOICE?.trim() || DEFAULT_TTS_VOICE } },
          },
        },
      }),
    });
    if (!response.ok) {
      console.warn(JSON.stringify({ event: 'gemini_tts_failed', status: response.status, model }));
      return null;
    }
    const generated = extractGeneratedAudio(await response.json(), model);
    if (!generated) console.warn(JSON.stringify({ event: 'gemini_tts_empty_audio', model }));
    return generated;
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'gemini_tts_exception',
      model,
      message: error instanceof Error ? error.message : 'unknown_gemini_tts_error',
    }));
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function handleVoiceTranscription(request: Request, env: Env): Promise<Response> {
  const requestId = request.headers.get('cf-ray') || crypto.randomUUID();
  let payload: VoicePayload;

  try {
    payload = await request.json() as VoicePayload;
  } catch {
    return json(env, { ok: false, error: 'داده صوتی معتبر نیست.', code: 'VOICE_INVALID_JSON', requestId }, 400);
  }

  const audio = typeof payload.audio === 'string' ? payload.audio.trim() : '';
  const mimeType = normalizedMimeType(payload.mimeType);
  if (!audio || audio.length < 64) {
    return json(env, { ok: false, error: 'صدای ضبط‌شده خالی است.', code: 'VOICE_EMPTY_AUDIO', requestId }, 400);
  }
  if (audio.length > MAX_BASE64_LENGTH) {
    return json(env, { ok: false, error: 'مدت یا حجم صدای ضبط‌شده بیش از حد مجاز است.', code: 'VOICE_AUDIO_TOO_LARGE', requestId }, 413);
  }
  if (!SUPPORTED_AUDIO_TYPES.has(mimeType)) {
    return json(env, { ok: false, error: 'فرمت صدای ضبط‌شده پشتیبانی نمی‌شود.', code: 'VOICE_UNSUPPORTED_FORMAT', requestId }, 415);
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(audio)) {
    return json(env, { ok: false, error: 'ساختار صدای ضبط‌شده معتبر نیست.', code: 'VOICE_INVALID_AUDIO', requestId }, 400);
  }

  const access = await resolveVoiceAccess(request, env, requestId);
  if (!access.ok) return access.response;
  const limited = await env.API_RATE_LIMITER.limit({ key: `voice:${access.actorKey}` });
  if (!limited.success) {
    return json(env, { ok: false, error: 'تعداد درخواست‌های صوتی زیاد شده؛ چند لحظه بعد دوباره تلاش کنید.', code: 'VOICE_RATE_LIMITED', requestId }, 429);
  }

  const language = typeof payload.language === 'string' && payload.language.trim()
    ? payload.language.trim().slice(0, 12)
    : 'fa';

  try {
    // Gemini is useful when configured, while the Workers chain keeps Voice Chat functional without a Google key.
    // Desktop uploads normalized WAV when possible, which is materially more reliable than WebM/Opus for ASR.
    const transcription = await geminiTranscribe(env, audio, mimeType, language)
      ?? await workersTranscribe(env, audio, language);
    if (!transcription?.text) {
      return json(env, {
        ok: false,
        error: 'گفتار واضحی در صدای ضبط‌شده تشخیص داده نشد یا همه سرویس‌های تشخیص گفتار موقتاً پاسخ ندادند؛ دوباره تلاش کنید.',
        code: 'VOICE_NO_SPEECH',
        requestId,
      }, 422);
    }

    console.log(JSON.stringify({ event: 'voice_transcription_success', requestId, model: transcription.model, characters: transcription.text.length, authenticated: access.authenticated }));
    return json(env, { ok: true, text: transcription.text, model: transcription.model, requestId });
  } catch (error) {
    console.error(JSON.stringify({
      event: 'voice_transcription_error',
      requestId,
      message: error instanceof Error ? error.message : 'unknown_voice_error',
    }));
    return json(env, { ok: false, error: 'پردازش صدا موقتاً ناموفق بود؛ دوباره تلاش کنید.', code: 'VOICE_TRANSCRIPTION_FAILED', requestId }, 502);
  }
}

export async function handleVoiceSynthesis(request: Request, env: Env): Promise<Response> {
  const requestId = request.headers.get('cf-ray') || crypto.randomUUID();

  let payload: TtsPayload;
  try {
    payload = await request.json() as TtsPayload;
  } catch {
    return json(env, { ok: false, error: 'متن پاسخ صوتی معتبر نیست.', code: 'VOICE_TTS_INVALID_JSON', requestId }, 400);
  }
  const text = sanitizeText(payload.text, MAX_TTS_TEXT_LENGTH);
  if (!text) {
    return json(env, { ok: false, error: 'متن پاسخ صوتی خالی است.', code: 'VOICE_TTS_EMPTY_TEXT', requestId }, 400);
  }

  const access = await resolveVoiceAccess(request, env, requestId);
  if (!access.ok) return access.response;
  const limited = await env.API_RATE_LIMITER.limit({ key: `voice-tts:${access.actorKey}` });
  if (!limited.success) {
    return json(env, { ok: false, error: 'تعداد پاسخ‌های صوتی زیاد شده؛ چند لحظه بعد دوباره تلاش کنید.', code: 'VOICE_TTS_RATE_LIMITED', requestId }, 429);
  }

  try {
    const primaryModel = env.GEMINI_TTS_MODEL?.trim() || DEFAULT_TTS_MODEL;
    const audio = await geminiGenerateContentTts(env, text, primaryModel)
      ?? (primaryModel === FALLBACK_TTS_MODEL ? null : await geminiGenerateContentTts(env, text, FALLBACK_TTS_MODEL));
    if (!audio) {
      const code = env.GEMINI_API_KEY ? 'VOICE_TTS_PROVIDER_FAILED' : 'VOICE_TTS_UNCONFIGURED';
      const error = env.GEMINI_API_KEY
        ? 'ساخت پاسخ صوتی موقتاً ناموفق بود؛ دوباره تلاش کنید.'
        : 'کلید سرویس صدای فارسی روی سرور تنظیم نشده است.';
      return json(env, { ok: false, error, code, requestId }, 502);
    }
    const wav = audioAsWav(audio);
    const body = new Uint8Array(wav.byteLength);
    body.set(wav);
    console.log(JSON.stringify({ event: 'voice_synthesis_success', requestId, model: audio.model, bytes: wav.length, authenticated: access.authenticated }));
    return new Response(body.buffer, {
      status: 200,
      headers: {
        ...corsHeaders(env),
        'content-type': 'audio/wav',
        'content-length': String(wav.length),
        'x-farsiai-voice-model': audio.model,
        'x-request-id': requestId,
      },
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: 'voice_synthesis_error',
      requestId,
      message: error instanceof Error ? error.message : 'unknown_tts_error',
    }));
    return json(env, { ok: false, error: 'ساخت پاسخ صوتی موقتاً ناموفق بود؛ دوباره تلاش کنید.', code: 'VOICE_TTS_FAILED', requestId }, 502);
  }
}
