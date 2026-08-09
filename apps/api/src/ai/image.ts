import { containsPersian } from '../lib/language';
import type { Env } from '../types';
import { translate } from './translate';

const IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';

export async function runImage(env: Env, userPrompt: string): Promise<{ image: string; prompt: string }> {
  const prompt = containsPersian(userPrompt)
    ? await translate(env, userPrompt, 'fa', 'en')
    : userPrompt;

  const result = await env.AI.run(IMAGE_MODEL, {
    prompt: `${prompt}. High quality, coherent composition, detailed, visually polished.`,
    seed: Math.floor(Math.random() * 999999999) + 1,
  });

  const base64 = String(result?.image ?? result?.result?.image ?? '').trim();
  if (!base64) throw new Error('Empty image response');
  return { image: `data:image/jpeg;base64,${base64}`, prompt };
}
