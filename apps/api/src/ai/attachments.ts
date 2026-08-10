import { sanitizeText } from '../lib/language';
import type { AiAttachment, AiMarkdownResult, Env } from '../types';

const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 6 * 1024 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const MAX_CONTEXT_CHARS = 18_000;
const EDITABLE_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const SUPPORTED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/xml',
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/svg+xml',
  'image/webp',
  'text/csv',
  'text/html',
  'text/plain',
]);

function safeName(value: unknown, index: number): string {
  const normalized = sanitizeText(value, 180).replace(/[\\/\u0000-\u001f]+/g, '_').trim();
  return normalized || `attachment-${index + 1}`;
}

function parseDataUrl(value: string): { mimeType: string; bytes: Uint8Array } | null {
  const match = value.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) return null;

  try {
    const binary = atob(match[2]);
    if (binary.length > MAX_ATTACHMENT_BYTES) return null;
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return { mimeType: match[1].toLowerCase(), bytes };
  } catch {
    return null;
  }
}

export function normalizeAttachments(value: unknown): AiAttachment[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('ATTACHMENTS_INVALID');
  if (value.length > MAX_ATTACHMENTS) throw new Error('ATTACHMENTS_TOO_MANY');

  let totalBytes = 0;
  const attachments: AiAttachment[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const raw = value[index];
    if (!raw || typeof raw !== 'object') throw new Error('ATTACHMENT_INVALID');
    const item = raw as Record<string, unknown>;
    const dataUrl = typeof item.dataUrl === 'string' ? item.dataUrl : '';
    const parsed = parseDataUrl(dataUrl);
    if (!parsed) throw new Error('ATTACHMENT_INVALID_DATA');

    const declaredMime = typeof item.mimeType === 'string' ? item.mimeType.toLowerCase().trim() : parsed.mimeType;
    const mimeType = declaredMime || parsed.mimeType;
    if (mimeType !== parsed.mimeType || !SUPPORTED_MIME_TYPES.has(mimeType)) {
      throw new Error('ATTACHMENT_UNSUPPORTED');
    }

    const actualSize = parsed.bytes.byteLength;
    if (actualSize <= 0 || actualSize > MAX_ATTACHMENT_BYTES) throw new Error('ATTACHMENT_TOO_LARGE');
    totalBytes += actualSize;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('ATTACHMENTS_TOO_LARGE');

    attachments.push({
      name: safeName(item.name, index),
      mimeType,
      dataUrl,
      size: actualSize,
    });
  }

  return attachments;
}

export function isEditableImageMime(mimeType: string): boolean {
  return EDITABLE_IMAGE_MIME_TYPES.has(mimeType.toLowerCase());
}

export function firstImageAttachment(attachments: AiAttachment[]): AiAttachment | undefined {
  return attachments.find((item) => isEditableImageMime(item.mimeType));
}

export async function attachmentContext(env: Env, attachments: AiAttachment[]): Promise<string> {
  if (attachments.length === 0) return '';
  if (typeof env.AI.toMarkdown !== 'function') throw new Error('ATTACHMENT_CONVERSION_UNAVAILABLE');

  const documents = attachments.map((attachment) => {
    const parsed = parseDataUrl(attachment.dataUrl);
    if (!parsed) throw new Error('ATTACHMENT_INVALID_DATA');
    const buffer = new ArrayBuffer(parsed.bytes.byteLength);
    new Uint8Array(buffer).set(parsed.bytes);
    return {
      name: attachment.name,
      blob: new Blob([buffer], { type: attachment.mimeType }),
    };
  });

  const converted = await env.AI.toMarkdown(documents, {
    conversionOptions: {
      output: { format: 'text' },
    },
  });

  const rows: AiMarkdownResult[] = Array.isArray(converted) ? converted : [converted];
  const usable = rows
    .map((row, index) => {
      if (row.format === 'error' || !row.data?.trim()) return '';
      const name = sanitizeText(row.name || attachments[index]?.name || `attachment-${index + 1}`, 180);
      const content = sanitizeText(row.data, 8_000);
      return content ? `فایل «${name}»:\n${content}` : '';
    })
    .filter(Boolean);

  if (usable.length === 0) throw new Error('ATTACHMENT_CONVERSION_FAILED');
  return sanitizeText(usable.join('\n\n'), MAX_CONTEXT_CHARS);
}
