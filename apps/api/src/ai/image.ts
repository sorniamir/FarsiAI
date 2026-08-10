import { containsPersian } from '../lib/language';
import type { Env } from '../types';
import { translate } from './translate';

const IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';
const IMAGE_EDIT_MODEL = '@cf/runwayml/stable-diffusion-v1-5-img2img';

function base64Payload(dataUrl?: string): string | undefined {
  if (!dataUrl) return undefined;
  const match = dataUrl.match(/^data:image\/(?:png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!match || match[1].length > 8_000_000) return undefined;
  return match[1];
}

export async function runImage(
  env: Env,
  userPrompt: string,
  referenceImage?: string,
  referencePrompt?: string,
): Promise<{ image: string; prompt: string; edited: boolean }> {
  const prompt = containsPersian(userPrompt)
    ? await translate(env, userPrompt, 'fa', 'en')
    : userPrompt;

  const imageB64 = base64Payload(referenceImage);
  if (imageB64) {
    const editPrompt = [
      referencePrompt ? `Original image: ${referencePrompt}.` : '',
      `Requested edit: ${prompt}.`,
      'Preserve the original subject, identity, composition, and visual continuity unless the request explicitly changes them. High quality and visually polished.',
    ].filter(Boolean).join(' ');
    const edited = await env.AI.run(IMAGE_EDIT_MODEL, {
      prompt: editPrompt,
      image_b64: imageB64,
      strength: 0.55,
      guidance: 7.5,
      num_steps: 20,
      seed: Math.floor(Math.random() * 999999999) + 1,
    });
    const response = new Response(edited as BodyInit);
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    if (!binary) throw new Error('Empty edited image response');
    return { image: `data:image/png;base64,${btoa(binary)}`, prompt: editPrompt, edited: true };
  }

  const result = await env.AI.run(IMAGE_MODEL, {
    prompt: `${prompt}. High quality, coherent composition, detailed, visually polished.`,
    seed: Math.floor(Math.random() * 999999999) + 1,
  });

  const base64 = String(result?.image ?? result?.result?.image ?? '').trim();
  if (!base64) throw new Error('Empty image response');
  return { image: `data:image/jpeg;base64,${base64}`, prompt, edited: false };
}
