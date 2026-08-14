import { corsHeaders, json } from '../lib/http';
import { sanitizeText } from '../lib/language';
import { resolveAuth } from '../lib/supabase-auth';
import type { Env } from '../types';

const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo';
const CLOUDFLARE_TTS_MODEL = 'google/gemini-3.1-flash-tts';
const DEFAULT_TTS_MODEL = 'gemini-3.1-flash-tts-preview';
const FALLBACK_TTS_MODEL = 'gemini-2.5-flash-preview-tts';
const DEFAULT_TTS_VOICE = 'Kore';
const MAX_BASE64_LENGTH = 10_500_000;
const MAX_GENERATED_AUDIO_BASE64 = 14_000_000;
const MAX_TTS_TEXT_LENGTH = 4000;
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

function audioBlock(value: unknown, model: string): GeneratedAudio | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const data = typeof item.data === 'string' ? item.data.trim() : '';
  if (!data || data.length > MAX_GENERATED_AUDIO_BASE64 || !/^[A-Za-z0-9+/\s]+={0,2}$/.test(data)) return null;
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
    const data = (dataUrl?.[2] ?? raw).trim();
    if (!data || data.length > MAX_GENERATED_AUDIO_BASE64 || !/^[A-Za-z0-9+/\s]+={0,2}$/.test(data)) return null;
    return {
      data,
      mimeType: dataUrl?.[1] ?? 'audio/wav',
      model,
    };
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

async function cloudflareGeminiTts(env: Env, text: string): Promise<GeneratedAudio | null> {
  try {
    const result = await env.AI.run(CLOUDFLARE_TTS_MODEL, {
      text,
      voice: env.GEMINI_TTS_VOICE?.trim() || DEFAULT_TTS_VOICE,
      temperature: 0.25,
    });
    return extractGeneratedAudio(result, CLOUDFLARE_TTS_MODEL);
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'cloudflare_gemini_tts_failed',
      model: CLOUDFLARE_TTS_MODEL,
      message: error instanceof Error ? error.message : 'unknown_cloudflare_tts_error',
    }));
    return null;
  }
}

async function geminiInteractionTts(env: Env, text: string): Promise<GeneratedAudio | null> {
  const model = env.GEMINI_TTS_MODEL?.trim() || DEFAULT_TTS_MODEL;
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': env.GEMINI_API_KEY!,
      'api-revision': '2026-05-20',
    },
    body: JSON.stringify({
      model,
      input: `Generate speech only. Speak naturally in fluent Persian (fa-IR), warm and clear, at a conversational pace. Do not add or remove words.\n\nTranscript:\n${text}`,
      response_format: { type: 'audio' },
      generation_config: {
        speech_config: [{ voice: env.GEMINI_TTS_VOICE?.trim() || DEFAULT_TTS_VOICE }],
      },
    }),
  });
  if (!response.ok) {
    console.warn(JSON.stringify({ event: 'gemini_tts_interaction_failed', status: response.status, model }));
    return null;
  }
  return extractGeneratedAudio(await response.json(), model);
}

async function geminiGenerateContentTts(env: Env, text: string): Promise<GeneratedAudio | null> {
  const model = FALLBACK_TTS_MODEL;
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': env.GEMINI_API_KEY!,
    },
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
    console.warn(JSON.stringify({ event: 'gemini_tts_generate_content_failed', status: response.status, model }));
    return null;
  }
  return extractGeneratedAudio(await response.json(), model);
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

  try {
    const result = await env.AI.run(WHISPER_MODEL, {
      audio,
      task: 'transcribe',
      language: typeof payload.language === 'string' && payload.language.trim() ? payload.language.trim().slice(0, 12) : 'fa',
      vad_filter: true,
      initial_prompt: 'گفت‌وگوی طبیعی فارسی با علائم نگارشی صحیح.',
    });
    const text = transcriptionText(result);
    if (!text) {
      return json(env, { ok: false, error: 'گفتار واضحی در صدای ضبط‌شده تشخیص داده نشد؛ کمی نزدیک‌تر به میکروفن صحبت کنید.', code: 'VOICE_NO_SPEECH', requestId }, 422);
    }

    console.log(JSON.stringify({ event: 'voice_transcription_success', requestId, model: WHISPER_MODEL, characters: text.length, authenticated: access.authenticated }));
    return json(env, { ok: true, text, model: WHISPER_MODEL, requestId });
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
    const audio = await cloudflareGeminiTts(env, text)
      ?? (env.GEMINI_API_KEY ? await geminiInteractionTts(env, text) : null)
      ?? (env.GEMINI_API_KEY ? await geminiGenerateContentTts(env, text) : null);
    if (!audio) {
      return json(env, { ok: false, error: 'ساخت پاسخ صوتی موقتاً ناموفق بود؛ دوباره تلاش کنید.', code: 'VOICE_TTS_FAILED', requestId }, 502);
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
