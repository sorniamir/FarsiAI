import { json } from '../lib/http';
import { sanitizeText } from '../lib/language';
import type { Env } from '../types';

const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo';
const MAX_BASE64_LENGTH = 10_500_000;
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

function normalizedMimeType(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase().split(';', 1)[0].trim() : '';
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

  const actor = request.headers.get('cf-connecting-ip') || 'anonymous';
  const limited = await env.API_RATE_LIMITER.limit({ key: `voice:${actor}` });
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

    console.log(JSON.stringify({ event: 'voice_transcription_success', requestId, model: WHISPER_MODEL, characters: text.length }));
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
