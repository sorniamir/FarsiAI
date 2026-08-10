import type { ApiAttachment } from '../services/api';

export const MAX_ATTACHMENTS = 4;
export const MAX_ATTACHMENT_BYTES = 6 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 12 * 1024 * 1024;

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

function fileId(): string {
  return `${Date.now()}-${crypto.randomUUID()}`;
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`خواندن فایل «${file.name}» ناموفق بود.`));
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error(`داده فایل «${file.name}» معتبر نیست.`));
    reader.readAsDataURL(file);
  });
}

export async function prepareAttachments(
  files: File[],
  existing: ApiAttachment[],
): Promise<{ accepted: ApiAttachment[]; errors: string[] }> {
  const accepted: ApiAttachment[] = [];
  const errors: string[] = [];
  let totalSize = existing.reduce((sum, item) => sum + item.size, 0);

  for (const file of files) {
    if (existing.length + accepted.length >= MAX_ATTACHMENTS) {
      errors.push('حداکثر ۴ فایل را می‌توان هم‌زمان ارسال کرد.');
      break;
    }
    const mimeType = file.type.toLowerCase();
    if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
      errors.push(`فرمت فایل «${file.name}» پشتیبانی نمی‌شود.`);
      continue;
    }
    if (file.size <= 0 || file.size > MAX_ATTACHMENT_BYTES) {
      errors.push(`حجم فایل «${file.name}» باید حداکثر ۶ مگابایت باشد.`);
      continue;
    }
    if (totalSize + file.size > MAX_TOTAL_ATTACHMENT_BYTES) {
      errors.push('مجموع حجم فایل‌های ضمیمه باید حداکثر ۱۲ مگابایت باشد.');
      break;
    }

    const dataUrl = await readDataUrl(file);
    accepted.push({
      id: fileId(),
      name: file.name.replace(/[\\/\u0000-\u001f]+/g, '_').slice(0, 180),
      mimeType,
      size: file.size,
      dataUrl,
      previewUrl: mimeType.startsWith('image/') ? dataUrl : undefined,
    });
    totalSize += file.size;
  }

  return { accepted, errors };
}
