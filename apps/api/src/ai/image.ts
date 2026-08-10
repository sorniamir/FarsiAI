import { containsPersian } from '../lib/language';
import type { Env } from '../types';
import { translate } from './translate';

const IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';
const IMAGE_EDIT_MODEL = '@cf/runwayml/stable-diffusion-v1-5-img2img';
const DEFAULT_NANO_BANANA_MODEL = 'gemini-3.1-flash-lite-image';

function parseImageDataUrl(dataUrl?: string): { mimeType: string; base64: string } | undefined {
  if (!dataUrl) return undefined;
  const match = dataUrl.match(/^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/=]+)$/i);
  if (!match || match[2].length > 8_500_000) return undefined;
  return { mimeType: match[1].toLowerCase(), base64: match[2] };
}

function randomSeed(): number {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return (value[0] % 999_999_999) + 1;
}

function imagePrompt(prompt: string, referencePrompt?: string): string {
  if (!referencePrompt) return `${prompt}. High quality, coherent composition, detailed, visually polished.`;
  return [
    `Original image context: ${referencePrompt}.`,
    `Requested edit: ${prompt}.`,
    'Preserve the original subject, identity, composition, and visual continuity unless the request explicitly changes them. High quality and visually polished.',
  ].join(' ');
}

function extractGeminiImage(payload: any): { data: string; mimeType: string } | null {
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  for (const candidate of candidates) {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    for (const part of parts) {
      const inline = part?.inlineData ?? part?.inline_data;
      const data = typeof inline?.data === 'string' ? inline.data.trim() : '';
      if (!data) continue;
      const mimeType = typeof inline?.mimeType === 'string'
        ? inline.mimeType
        : typeof inline?.mime_type === 'string'
          ? inline.mime_type
          : 'image/png';
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
  const parts: Array<Record<string, unknown>> = [{ text: prompt }];
  if (reference) {
    parts.unshift({
      inline_data: {
        mime_type: reference.mimeType,
        data: reference.base64,
      },
    });
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            responseFormat: {
              image: {
                aspectRatio: '1:1',
                imageSize: '1K',
              },
            },
          },
        }),
      },
    );

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
  const prompt = containsPersian(userPrompt)
    ? await translate(env, userPrompt, 'fa', 'en')
    : userPrompt;

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
