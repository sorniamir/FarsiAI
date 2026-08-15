import type { Env } from '../types';

const LEGACY_BASE_URL = 'https://image.pollinations.ai/prompt/';
const CURRENT_BASE_URL = 'https://gen.pollinations.ai/image/';
const DEFAULT_CURRENT_MODEL = 'zimage';
const LEGACY_MODEL = 'flux';
const IMAGE_TIMEOUT_MS = 80_000;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MIN_IMAGE_BYTES = 1_000;
const MAX_LEGACY_PROMPT = 700;
const MAX_CURRENT_PROMPT = 1_400;

function compactPrompt(value: string, limit: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, limit);
}

function randomSeed(): number {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return (value[0] % 2_147_483_647) + 1;
}

function normalizeImageMime(value: string | null): string | null {
  const mime = (value || '').split(';', 1)[0].trim().toLowerCase();
  return /^image\/(?:png|jpe?g|webp)$/.test(mime) ? mime : null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function fetchImage(url: string, headers: HeadersInit, provider: string): Promise<{ image: string; provider: string } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('pollinations-image-timeout'), IMAGE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: controller.signal,
    });
    const mimeType = normalizeImageMime(response.headers.get('content-type'));
    if (!response.ok || !mimeType) {
      console.warn(JSON.stringify({
        event: 'pollinations_image_failed',
        provider,
        status: response.status,
        contentType: response.headers.get('content-type') || '',
      }));
      return null;
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length < MIN_IMAGE_BYTES || bytes.length > MAX_IMAGE_BYTES) {
      console.warn(JSON.stringify({ event: 'pollinations_image_invalid_size', provider, bytes: bytes.length }));
      return null;
    }

    console.log(JSON.stringify({ event: 'pollinations_image_success', provider, bytes: bytes.length }));
    return {
      image: `data:${mimeType};base64,${bytesToBase64(bytes)}`,
      provider,
    };
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'pollinations_image_exception',
      provider,
      message: error instanceof Error ? error.message : 'unknown_pollinations_error',
    }));
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function runPollinationsImage(env: Env, promptValue: string): Promise<{ image: string; provider: string } | null> {
  if (env.POLLINATIONS_FALLBACK_DISABLED?.trim().toLowerCase() === 'true') return null;

  const apiKey = env.POLLINATIONS_API_KEY?.trim();
  if (apiKey) {
    const model = env.POLLINATIONS_IMAGE_MODEL?.trim() || DEFAULT_CURRENT_MODEL;
    const prompt = compactPrompt(promptValue, MAX_CURRENT_PROMPT);
    if (!prompt) return null;
    const query = new URLSearchParams({
      model,
      width: '1024',
      height: '1024',
      seed: String(randomSeed()),
      safe: 'true',
    });
    return fetchImage(
      `${CURRENT_BASE_URL}${encodeURIComponent(prompt)}?${query.toString()}`,
      { authorization: `Bearer ${apiKey}`, accept: 'image/*' },
      `pollinations:${model}`,
    );
  }

  const prompt = compactPrompt(promptValue, MAX_LEGACY_PROMPT);
  if (!prompt) return null;
  const query = new URLSearchParams({
    width: '1024',
    height: '1024',
    model: LEGACY_MODEL,
    seed: String(randomSeed()),
    nologo: 'true',
    safe: 'true',
  });
  return fetchImage(
    `${LEGACY_BASE_URL}${encodeURIComponent(prompt)}?${query.toString()}`,
    { accept: 'image/*' },
    'pollinations:legacy-flux',
  );
}
