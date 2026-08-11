import type { Env } from '../types';

const MODEL = '@cf/meta/m2m100-1.2b';

function extractTranslation(result: any): string {
  return String(
    result?.translated_text ??
      result?.translation ??
      result?.response ??
      result?.result?.translated_text ??
      '',
  ).trim();
}

export async function translate(
  env: Env,
  text: string,
  sourceLang: 'fa' | 'en',
  targetLang: 'fa' | 'en',
): Promise<string> {
  if (!text.trim() || sourceLang === targetLang) return text;
  const result = await env.AI.run(MODEL, { text, source_lang: sourceLang, target_lang: targetLang });
  return extractTranslation(result) || text;
}
