import { containsPersian } from '../lib/language';
import type { Env } from '../types';
import { translate } from './translate';

const IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';
const IMAGE_EDIT_MODEL = '@cf/runwayml/stable-diffusion-v1-5-img2img';
const DEFAULT_NANO_BANANA_MODEL = 'gemini-3.1-flash-lite-image';
const MAX_PROVIDER_PROMPT = 1900;

function parseImageDataUrl(dataUrl?: string): { mimeType: string; base64: string } | undefined {
  if (!dataUrl) return undefined;
  const match = dataUrl.match(/^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/=]+)$/i);
  if (!match || match[2].length > 8_500_000) return undefined;
  return { mimeType: match[1].toLowerCase(), base64: match[2] };
}

function compactPrompt(value: string, limit = MAX_PROVIDER_PROMPT): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, limit);
}

function randomSeed(): number {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return (value[0] % 999_999_999) + 1;
}

function imagePrompt(prompt: string, referencePrompt?: string): string {
  if (!referencePrompt) {
    return compactPrompt(`${prompt}. High quality, coherent composition, detailed, visually polished.`);
  }
  return compactPrompt([
    `Original image context: ${compactPrompt(referencePrompt, 650)}.`,
    `Requested edit: ${compactPrompt(prompt, 950)}.`,
    'Preserve the original subject, identity, composition, and visual continuity unless the request explicitly changes them. High quality and visually polished.',
  ].join(' '));
}

function extractGeminiImage(payload: any): { data: string; mimeType: string } | null {
  const steps = Array.isArray(payload?.steps) ? payload.steps : [];
  for (const step of steps) {
    if (step?.type !== 'model_output') continue;
    const content = Array.isArray(step?.content) ? step.content : [];
    for (const item of content) {
      if (item?.type !== 'image') continue;
      const data = typeof item?.data === 'string' ? item.data.trim() : '';
      if (!data) continue;
      const mimeType = typeof item?.mime_type === 'string' ? item.mime_type : 'image/png';
      return { data, mimeType };
    }
  }
  return null;
}

async function runNanoBanana(
  env: Env,
  prompt: string,
  referenceImage?: string,
): Promise<{ image: string; provider: string } | null> {
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) return null;

  const model = env.NANO_BANANA_MODEL?.trim() || DEFAULT_NANO_BANANA_MODEL;
  const reference = parseImageDataUrl(referenceImage);
  const input: Array<Record<string, unknown>> = [{ type: 'text', text: prompt }];
  if (reference) {
    input.push({
      type: 'image',
      mime_type: reference.mimeType,
      data: reference.base64,
    });
  }

  try {
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey,
        'api-revision': '2026-05-20',
      },
      body: JSON.stringify({
        model,
        input,
        response_format: {
          type: 'image',
          mime_type: 'image/png',
          aspect_ratio: '1:1',
          image_size: '1K',
        },
      }),
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 800);
      console.warn(JSON.stringify({ event: 'nano_banana_failed', status: response.status, detail }));
      return null;
    }

    const payload = await response.json();
    const image = extractGeminiImage(payload);
    if (!image) {
      console.warn(JSON.stringify({ event: 'nano_banana_empty_image' }));
      return null;
    }

    return {
      image: `data:${image.mimeType};base64,${image.data}`,
      provider: model,
    };
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'nano_banana_exception',
      message: error instanceof Error ? error.message : 'unknown_nano_banana_error',
    }));
    return null;
  }
}

async function bytesToDataUrl(value: unknown, mimeType: string): Promise<string> {
  const response = new Response(value as BodyInit);
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  if (!binary) throw new Error('Empty image response');
  return `data:${mimeType};base64,${btoa(binary)}`;
}

export async function runImage(
  env: Env,
  userPrompt: string,
  referenceImage?: string,
  referencePrompt?: string,
): Promise<{ image: string; prompt: string; edited: boolean; provider: string }> {
  const translatedPrompt = containsPersian(userPrompt)
    ? await translate(env, userPrompt, 'fa', 'en')
    : userPrompt;
  const prompt = compactPrompt(translatedPrompt, 1500);
  if (!prompt) throw new Error('Empty image prompt');

  const reference = parseImageDataUrl(referenceImage);
  const finalPrompt = imagePrompt(prompt, reference ? referencePrompt : undefined);

  const nanoBanana = await runNanoBanana(env, finalPrompt, referenceImage);
  if (nanoBanana) {
    return {
      image: nanoBanana.image,
      prompt: finalPrompt,
      edited: !!reference,
      provider: nanoBanana.provider,
    };
  }

  if (reference) {
    const edited = await env.AI.run(IMAGE_EDIT_MODEL, {
      prompt: finalPrompt,
      image_b64: reference.base64,
      strength: 0.55,
      guidance: 7.5,
      num_steps: 20,
      seed: randomSeed(),
    });
    return {
      image: await bytesToDataUrl(edited, 'image/png'),
      prompt: finalPrompt,
      edited: true,
      provider: IMAGE_EDIT_MODEL,
    };
  }

  const result = await env.AI.run(IMAGE_MODEL, {
    prompt: finalPrompt,
    seed: randomSeed(),
  });

  const base64 = String(result?.image ?? result?.result?.image ?? '').trim();
  if (!base64) throw new Error('Empty image response');
  return {
    image: `data:image/jpeg;base64,${base64}`,
    prompt,
    edited: false,
    provider: IMAGE_MODEL,
  };
}
