const PERSIAN_RE = /[\u0600-\u06FF]/;

export function containsPersian(text: string): boolean {
  return PERSIAN_RE.test(text);
}

export function sanitizeText(value: unknown, max = 8000): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\u0000/g, '').trim().slice(0, max);
}
