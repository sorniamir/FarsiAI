import { containsPersian } from '../lib/language';
import type { Env } from '../types';
import { translate } from './translate';

const IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';
const IMAGE_FALLBACK_MODEL = '@cf/bytedance/stable-diffusion-xl-lightning';
const IMAGE_EDIT_MODEL = '@cf/runwayml/stable-diffusion-v1-5-img2img';
const DEFAULT_NANO_BANANA_MODEL = 'gemini-3.1-flash-image';
const MAX_PROVIDER_PROMPT = 1900;
const MAX_PROVIDER_IMAGE_BASE64 = 16_000_000;
const GEMINI_TIMEOUT_MS = 55_000;

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
    return compactPrompt(`${prompt}. High quality, coherent composition, detailed, visually polished, professional finish.`);
  }
  return compactPrompt([
    `Original image context: ${compactPrompt(referencePrompt, 650)}.`,
    `Requested edit: ${compactPrompt(prompt, 950)}.`,
    'Preserve the original subject identity, pose, composition, proportions, layout and visual continuity unless the request explicitly changes them. Keep untouched details unchanged. High quality and professionally finished.',
  ].join(' '));
}

function normalizeProviderImage(data: unknown, mimeType: unknown): { data: string; mimeType: string } | null {
  const clean = typeof data === 'string' ? data.replace(/\s+/g, '').trim() : '';
  if (!clean || clean.length > MAX_PROVIDER_IMAGE_BASE64 || !/^[A-Za-z0-9+/=]+$/.test(clean)) return null;
  const mime = typeof mimeType === 'string' ? mimeType.toLowerCase() : 'image/png';
  if (!/^image\/(?:png|jpe?g|webp)$/.test(mime)) return null;
  return { data: clean, mimeType: mime };
}

function extractGeminiImage(payload: any): { data: string; mimeType: string } | null {
  const direct = payload?.output_image ?? payload?.outputImage;
  const normalizedDirect = normalizeProviderImage(direct?.data, direct?.mime_type ?? direct?.mimeType);
  if (normalizedDirect) return normalizedDirect;

  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  for (const candidate of candidates) {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    for (const part of parts) {
      const inline = part?.inlineData ?? part?.inline_data;
      const normalized = normalizeProviderImage(inline?.data, inline?.mimeType ?? inline?.mime_type);
      if (normalized) return normalized;
    }
  }

  const output = Array.isArray(payload?.output) ? payload.output : [];
  for (const item of output) {
    const normalized = normalizeProviderImage(item?.data, item?.mime_type ?? item?.mimeType);
    if ((item?.type === 'image' || item?.type === 'output_image') && normalized) return normalized;
  }

  const steps = Array.isArray(payload?.steps) ? payload.steps : [];
  for (const step of steps) {
    if (step?.type !== 'model_output') continue;
    const content = Array.isArray(step?.content) ? step.content : [];
    for (const item of content) {
      if (item?.type !== 'image') continue;
      const normalized = normalizeProviderImage(item?.data, item?.mime_type ?? item?.mimeType);
      if (normalized) return normalized;
    }
  }
  return null;
}

async function geminiGenerateContent(
  apiKey: string,
  model: string,
  prompt: string,
  reference: { mimeType: string; base64: string } | undefined,
  signal: AbortSignal,
): Promise<{ data: string; mimeType: string } | null> {
  const parts: Array<Record<string, unknown>> = [{ text: prompt }];
  if (reference) {
    parts.push({ inlineData: { mimeType: reference.mimeType, data: reference.base64 } });
  }

  const response = await fetch(`https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    signal,
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        responseFormat: {
          image: {
            aspectRatio: '1:1',
            imageSize: '1K',
          },
        },
      },
    }),
  });

  if (!response.ok) {
    const detail = compactPrompt(await response.text(), 500);
    console.warn(JSON.stringify({ event: 'nano_banana_generate_content_failed', status: response.status, model, detail }));
    return null;
  }
  return extractGeminiImage(await response.json());
}

async function geminiInteractions(
  apiKey: string,
  model: string,
  prompt: string,
  reference: { mimeType: string; base64: string } | undefined,
  signal: AbortSignal,
): Promise<{ data: string; mimeType: string } | null> {
  const input: Array<Record<string, unknown>> = [{ type: 'text', text: prompt }];
  if (reference) {
    input.push({ type: 'image', mime_type: reference.mimeType, data: reference.base64 });
  }

  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    signal,
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
    const detail = compactPrompt(await response.text(), 500);
    console.warn(JSON.stringify({ event: 'nano_banana_interactions_failed', status: response.status, model, detail }));
    return null;
  }
  return extractGeminiImage(await response.json());
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('gemini-image-timeout'), GEMINI_TIMEOUT_MS);
  try {
    const image = await geminiGenerateContent(apiKey, model, prompt, reference, controller.signal)
      ?? await geminiInteractions(apiKey, model, prompt, reference, controller.signal);
    if (!image) {
      console.warn(JSON.stringify({ event: 'nano_banana_empty_or_invalid_image', model }));
      return null;
    }
    return {
      image: `data:${image.mimeType};base64,${image.data}`,
      provider: model,
    };
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'nano_banana_exception',
      model,
      message: error instanceof Error ? error.message : 'unknown_nano_banana_error',
    }));
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function bestEffortWorkersPrompt(env: Env, userPrompt: string): Promise<string> {
  if (!containsPersian(userPrompt)) return compactPrompt(userPrompt, 1500);
  try {
    const translated = await translate(env, userPrompt, 'fa', 'en');
    return compactPrompt(translated || userPrompt, 1500);
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'image_translation_fallback',
      message: error instanceof Error ? error.message : 'unknown_translation_error',
    }));
    return compactPrompt(userPrompt, 1500);
  }
}

async function bytesToDataUrl(value: unknown, mimeType: string): Promise<string> {
  const response = new Response(value as BodyInit);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 12 * 1024 * 1024) throw new Error('Invalid image response size');
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

export async function runImage(
  env: Env,
  userPrompt: string,
  referenceImage?: string,
  referencePrompt?: string,
): Promise<{ image: string; prompt: string; edited: boolean; provider: string }> {
  const directPrompt = compactPrompt(userPrompt, 1500);
  if (!directPrompt) throw new Error('Empty image prompt');

  const reference = parseImageDataUrl(referenceImage);
  const directFinalPrompt = imagePrompt(directPrompt, reference ? referencePrompt : undefined);

  const nanoBanana = await runNanoBanana(env, directFinalPrompt, referenceImage);
  if (nanoBanana) {
    return {
      image: nanoBanana.image,
      prompt: directFinalPrompt,
      edited: !!reference,
      provider: nanoBanana.provider,
    };
  }

  const workersPrompt = await bestEffortWorkersPrompt(env, userPrompt);
  const finalPrompt = imagePrompt(workersPrompt, reference ? referencePrompt : undefined);

  if (reference) {
    const edited = await env.AI.run(IMAGE_EDIT_MODEL, {
      prompt: finalPrompt,
      image_b64: reference.base64,
      strength: 0.45,
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

  try {
    const result = await env.AI.run(IMAGE_MODEL, {
      prompt: finalPrompt,
      steps: 8,
      seed: randomSeed(),
    });
    const base64 = String(result?.image ?? result?.result?.image ?? '').replace(/\s+/g, '').trim();
    if (!base64 || base64.length > MAX_PROVIDER_IMAGE_BASE64 || !/^[A-Za-z0-9+/=]+$/.test(base64)) {
      throw new Error('Empty or invalid FLUX image response');
    }
    return {
      image: `data:image/jpeg;base64,${base64}`,
      prompt: finalPrompt,
      edited: false,
      provider: IMAGE_MODEL,
    };
  } catch (primaryError) {
    console.warn(JSON.stringify({
      event: 'workers_image_primary_failed',
      model: IMAGE_MODEL,
      message: primaryError instanceof Error ? primaryError.message : 'unknown_primary_image_error',
    }));
    const fallback = await env.AI.run(IMAGE_FALLBACK_MODEL, {
      prompt: finalPrompt,
      num_steps: 4,
      guidance: 7.5,
      seed: randomSeed(),
    });
    return {
      image: await bytesToDataUrl(fallback, 'image/png'),
      prompt: finalPrompt,
      edited: false,
      provider: IMAGE_FALLBACK_MODEL,
    };
  }
}
