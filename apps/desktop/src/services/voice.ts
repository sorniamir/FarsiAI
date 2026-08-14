import { supabase } from '../lib/supabase';

type TranscriptionResponse =
  | { ok: true; text: string; requestId?: string }
  | { ok: false; error: string; code?: string; requestId?: string };

export type SynthesisResponse =
  | { ok: true; audio: Blob; requestId?: string; model?: string }
  | { ok: false; error: string; code?: string; requestId?: string };

const API_URL = import.meta.env.VITE_API_URL?.trim() || 'https://farsiai-api.sorniamir2005.workers.dev';
const MAX_AUDIO_BYTES = 7_500_000;
const TRANSCRIPTION_TIMEOUT_MS = 90_000;
const SYNTHESIS_TIMEOUT_MS = 90_000;

async function authenticatedHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (supabase) {
    const { data } = await supabase.auth.getSession();
    if (data.session?.access_token) headers.authorization = `Bearer ${data.session.access_token}`;
  }
  return headers;
}

function blobAsBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('خواندن فایل صوتی ناموفق بود.'));
    reader.onload = () => {
      const value = typeof reader.result === 'string' ? reader.result : '';
      const separator = value.indexOf(',');
      if (separator < 0) reject(new Error('ساختار فایل صوتی معتبر نیست.'));
      else resolve(value.slice(separator + 1));
    };
    reader.readAsDataURL(blob);
  });
}

function wavBlob(buffer: AudioBuffer): Blob {
  const sampleRate = Math.max(8000, Math.min(96000, Math.round(buffer.sampleRate || 48000)));
  const frames = buffer.length;
  const bytes = new Uint8Array(44 + frames * 2);
  const view = new DataView(bytes.buffer);
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
  };

  write(0, 'RIFF');
  view.setUint32(4, 36 + frames * 2, true);
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
  view.setUint32(40, frames * 2, true);

  const channels = Math.max(1, buffer.numberOfChannels);
  const channelData = Array.from({ length: channels }, (_, index) => buffer.getChannelData(index));
  let target = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    let mixed = 0;
    for (let channel = 0; channel < channels; channel += 1) mixed += channelData[channel][frame] || 0;
    mixed /= channels;
    const clamped = Math.max(-1, Math.min(1, mixed));
    const sample = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
    view.setInt16(target, sample, true);
    target += 2;
  }

  return new Blob([bytes], { type: 'audio/wav' });
}

async function normalizeRecordedAudio(blob: Blob): Promise<Blob> {
  const type = blob.type.toLowerCase();
  if (type.startsWith('audio/wav') || type.startsWith('audio/x-wav')) return blob;

  const AudioContextConstructor = window.AudioContext
    || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextConstructor) return blob;

  const context = new AudioContextConstructor();
  try {
    const source = await blob.arrayBuffer();
    const decoded = await context.decodeAudioData(source.slice(0));
    if (!decoded.length || decoded.duration < 0.08) return blob;
    const wav = wavBlob(decoded);
    return wav.size && wav.size <= MAX_AUDIO_BYTES ? wav : blob;
  } catch {
    // WebView2 normally decodes its own MediaRecorder output. If a codec is missing,
    // keep the original blob so the server can still try Gemini/Whisper directly.
    return blob;
  } finally {
    void context.close();
  }
}

export async function transcribeVoice(blob: Blob, signal?: AbortSignal): Promise<TranscriptionResponse> {
  if (!blob.size) return { ok: false, error: 'صدای ضبط‌شده خالی است.', code: 'VOICE_EMPTY_AUDIO' };
  if (blob.size > MAX_AUDIO_BYTES) return { ok: false, error: 'صدای ضبط‌شده بیش از حد طولانی است.', code: 'VOICE_AUDIO_TOO_LARGE' };

  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timeout = window.setTimeout(() => controller.abort(new DOMException('Voice timeout', 'TimeoutError')), TRANSCRIPTION_TIMEOUT_MS);

  try {
    const headers = await authenticatedHeaders();
    const prepared = await normalizeRecordedAudio(blob);
    if (prepared.size > MAX_AUDIO_BYTES) {
      return { ok: false, error: 'صدای ضبط‌شده بیش از حد طولانی است.', code: 'VOICE_AUDIO_TOO_LARGE' };
    }
    const audio = await blobAsBase64(prepared);
    const response = await fetch(`${API_URL}/v1/voice/transcribe`, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({ audio, mimeType: prepared.type || blob.type || 'audio/webm', language: 'fa' }),
    });
    const data = await response.json() as TranscriptionResponse;
    if (!response.ok || !data.ok) {
      return data.ok ? { ok: false, error: `پردازش صدا با خطای HTTP ${response.status} متوقف شد.` } : data;
    }
    if (!data.text.trim()) return { ok: false, error: 'گفتاری در صدای ضبط‌شده تشخیص داده نشد.', code: 'VOICE_NO_SPEECH' };
    return { ...data, text: data.text.trim() };
  } catch (error) {
    if (signal?.aborted) return { ok: false, error: 'پردازش صدا متوقف شد.', code: 'VOICE_ABORTED' };
    if (controller.signal.aborted) return { ok: false, error: 'پردازش صدا بیش از حد طول کشید؛ دوباره تلاش کنید.', code: 'VOICE_TIMEOUT' };
    return { ok: false, error: error instanceof Error ? `ارتباط پردازش صدا برقرار نشد: ${error.message}` : 'ارتباط پردازش صدا برقرار نشد.', code: 'VOICE_NETWORK_ERROR' };
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

export async function synthesizeSpeech(textValue: string, signal?: AbortSignal): Promise<SynthesisResponse> {
  const text = textValue.trim();
  if (!text) return { ok: false, error: 'متن پاسخ صوتی خالی است.', code: 'VOICE_TTS_EMPTY_TEXT' };

  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timeout = window.setTimeout(() => controller.abort(new DOMException('Voice synthesis timeout', 'TimeoutError')), SYNTHESIS_TIMEOUT_MS);

  try {
    const response = await fetch(`${API_URL}/v1/voice/synthesize`, {
      method: 'POST',
      headers: await authenticatedHeaders(),
      signal: controller.signal,
      body: JSON.stringify({ text: text.slice(0, 4000), language: 'fa' }),
    });
    const contentType = response.headers.get('content-type') || '';
    if (!response.ok || !contentType.toLowerCase().startsWith('audio/')) {
      try {
        const error = await response.json() as { error?: string; code?: string; requestId?: string };
        return {
          ok: false,
          error: error.error || `ساخت پاسخ صوتی با خطای HTTP ${response.status} متوقف شد.`,
          code: error.code,
          requestId: error.requestId,
        };
      } catch {
        return { ok: false, error: `پاسخ صوتی معتبر نبود (HTTP ${response.status}).`, code: 'VOICE_TTS_INVALID_RESPONSE' };
      }
    }
    const audio = await response.blob();
    if (!audio.size) return { ok: false, error: 'فایل پاسخ صوتی خالی است.', code: 'VOICE_TTS_EMPTY_AUDIO' };
    return {
      ok: true,
      audio,
      requestId: response.headers.get('x-request-id') || undefined,
      model: response.headers.get('x-farsiai-voice-model') || undefined,
    };
  } catch (error) {
    if (signal?.aborted) return { ok: false, error: 'پخش پاسخ صوتی متوقف شد.', code: 'VOICE_TTS_ABORTED' };
    if (controller.signal.aborted) return { ok: false, error: 'ساخت پاسخ صوتی بیش از حد طول کشید؛ دوباره تلاش کنید.', code: 'VOICE_TTS_TIMEOUT' };
    return {
      ok: false,
      error: error instanceof Error ? `ارتباط با سرویس صدای فارسی برقرار نشد: ${error.message}` : 'ارتباط با سرویس صدای فارسی برقرار نشد.',
      code: 'VOICE_TTS_NETWORK_ERROR',
    };
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}
