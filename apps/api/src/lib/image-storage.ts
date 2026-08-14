import type { Env } from '../types';
import { supabaseStorageAdminFetch } from './supabase-admin';

export const GENERATED_IMAGE_BUCKET = 'generated-images';
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const STORAGE_MARKER_PREFIX = `storage:${GENERATED_IMAGE_BUCKET}/`;

type ParsedImage = {
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  extension: 'png' | 'jpg' | 'webp';
  bytes: Uint8Array;
};

function decodeBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    if (!binary.length || binary.length > MAX_IMAGE_BYTES) return null;
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

export function parseGeneratedImageDataUrl(dataUrl: string): ParsedImage | null {
  const match = dataUrl.match(/^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) return null;

  const rawMime = match[1].toLowerCase();
  const mimeType: ParsedImage['mimeType'] = rawMime === 'image/png'
    ? 'image/png'
    : rawMime === 'image/webp'
      ? 'image/webp'
      : 'image/jpeg';
  const extension: ParsedImage['extension'] = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
  const bytes = decodeBase64(match[2]);
  if (!bytes || bytes.byteLength > MAX_IMAGE_BYTES) return null;

  return { mimeType, extension, bytes };
}

function storagePath(userId: string, extension: ParsedImage['extension']): string {
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${userId}/${year}/${month}/${crypto.randomUUID()}.${extension}`;
}

function encodeStoragePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/**
 * Stores a generated image outside Postgres and returns a compact marker for messages.image_url.
 * The immediate AI response still carries the data URL, so a storage outage never destroys the
 * image the user just generated. If storage fails, callers should persist the message without
 * image_url rather than falling back to multi-megabyte Base64 in Postgres.
 */
export async function persistGeneratedImage(
  env: Env,
  userId: string,
  imageDataUrl: string,
): Promise<string | null> {
  const parsed = parseGeneratedImageDataUrl(imageDataUrl);
  if (!parsed) {
    console.warn(JSON.stringify({ event: 'generated_image_storage_rejected', reason: 'invalid_data_url' }));
    return null;
  }

  const path = storagePath(userId, parsed.extension);
  const blobBuffer = parsed.bytes.buffer.slice(
    parsed.bytes.byteOffset,
    parsed.bytes.byteOffset + parsed.bytes.byteLength,
  ) as ArrayBuffer;
  const response = await supabaseStorageAdminFetch(env, `object/${GENERATED_IMAGE_BUCKET}/${encodeStoragePath(path)}`, {
    method: 'POST',
    headers: {
      'content-type': parsed.mimeType,
      'cache-control': '3600',
      'x-upsert': 'false',
    },
    body: new Blob([blobBuffer], { type: parsed.mimeType }),
  });

  if (!response?.ok) {
    const detail = response ? (await response.text()).slice(0, 400) : 'storage_unconfigured';
    console.error(JSON.stringify({ event: 'generated_image_storage_failed', status: response?.status ?? 0, detail }));
    return null;
  }

  return `${STORAGE_MARKER_PREFIX}${path}`;
}

export function parseStoredImageMarker(value?: string | null): { bucket: string; path: string } | null {
  if (!value?.startsWith('storage:')) return null;
  const payload = value.slice('storage:'.length);
  const slash = payload.indexOf('/');
  if (slash <= 0 || slash >= payload.length - 1) return null;
  const bucket = payload.slice(0, slash);
  const path = payload.slice(slash + 1);
  if (!bucket || !path || path.includes('..')) return null;
  return { bucket, path };
}
