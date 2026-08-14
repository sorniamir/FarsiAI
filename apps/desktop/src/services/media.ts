import { supabase } from '../lib/supabase';

const STORAGE_PREFIX = 'storage:';
const SIGNED_URL_TTL_SECONDS = 60 * 60;

type StoredMarker = { raw: string; bucket: string; path: string };
type SignedRow = { path?: unknown; signedUrl?: unknown; signedURL?: unknown };

function parseMarker(value: string): StoredMarker | null {
  if (!value.startsWith(STORAGE_PREFIX)) return null;
  const payload = value.slice(STORAGE_PREFIX.length);
  const slash = payload.indexOf('/');
  if (slash <= 0 || slash >= payload.length - 1) return null;
  const bucket = payload.slice(0, slash);
  const path = payload.slice(slash + 1);
  if (!bucket || !path || path.includes('..')) return null;
  return { raw: value, bucket, path };
}

export async function resolveStoredImageUrls(values: Array<string | undefined>): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  const markers = values
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map(parseMarker)
    .filter((item): item is StoredMarker => !!item);

  for (const value of values) {
    if (typeof value === 'string' && value && !value.startsWith(STORAGE_PREFIX)) resolved.set(value, value);
  }

  if (!supabase || markers.length === 0) return resolved;

  const grouped = new Map<string, StoredMarker[]>();
  for (const marker of markers) {
    const bucket = grouped.get(marker.bucket) ?? [];
    bucket.push(marker);
    grouped.set(marker.bucket, bucket);
  }

  for (const [bucket, bucketMarkers] of grouped) {
    const unique = Array.from(new Map(bucketMarkers.map((marker) => [marker.path, marker])).values());
    const { data, error } = await supabase.storage
      .from(bucket)
      .createSignedUrls(unique.map((marker) => marker.path), SIGNED_URL_TTL_SECONDS);
    if (error || !data) continue;

    const rows = data as SignedRow[];
    rows.forEach((row, index) => {
      const fallback = unique[index];
      const path = typeof row.path === 'string' ? row.path : fallback?.path;
      const signedUrl = typeof row.signedUrl === 'string'
        ? row.signedUrl
        : typeof row.signedURL === 'string'
          ? row.signedURL
          : undefined;
      if (!path || !signedUrl) return;
      for (const marker of bucketMarkers) {
        if (marker.path === path) resolved.set(marker.raw, signedUrl);
      }
    });
  }

  return resolved;
}

export async function resolveStoredImageUrl(value?: string): Promise<string | undefined> {
  if (!value) return undefined;
  const urls = await resolveStoredImageUrls([value]);
  return urls.get(value);
}
