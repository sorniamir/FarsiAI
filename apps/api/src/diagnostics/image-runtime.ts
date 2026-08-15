import { refundGuestDailyQuota, spendGuestDailyQuota } from '../lib/credits';
import type { Env } from '../types';

const FLUX = '@cf/black-forest-labs/flux-1-schnell';
const SDXL = '@cf/bytedance/stable-diffusion-xl-lightning';
const DREAMSHAPER = '@cf/lykon/dreamshaper-8-lcm';

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? 'unknown');
  return message.replace(/[\r\n]+/g, ' ').slice(0, 500);
}

async function streamBytes(value: unknown): Promise<number> {
  const response = new Response(value as BodyInit);
  return (await response.arrayBuffer()).byteLength;
}

function imageLength(payload: any): number {
  const direct = payload?.output_image?.data ?? payload?.outputImage?.data;
  if (typeof direct === 'string') return direct.length;
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  for (const candidate of candidates) {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    for (const part of parts) {
      const data = part?.inlineData?.data ?? part?.inline_data?.data;
      if (typeof data === 'string') return data.length;
    }
  }
  return 0;
}

export async function handleImageRuntimeDiagnostic(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (!url.hostname.startsWith('agent-fix-image-production-v063-')) {
    return Response.json({ ok: false, error: 'Not found' }, { status: 404 });
  }

  const prompt = 'A single red apple centered on a clean white studio background, photorealistic product photo';
  const result: Record<string, unknown> = {
    ok: true,
    host: url.hostname,
    bindings: {
      ai: !!env.AI,
      gemini: !!env.GEMINI_API_KEY,
      supabase: !!env.SUPABASE_URL && !!(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY),
      nanoBananaModel: env.NANO_BANANA_MODEL || null,
    },
  };

  const referenceId = `diag-${crypto.randomUUID()}`;
  try {
    const quota = await spendGuestDailyQuota(env, 'diag:image-runtime-v063', 'image', referenceId);
    result.quota = quota;
    try { await refundGuestDailyQuota(env, 'diag:image-runtime-v063', referenceId); } catch {}
  } catch (error) {
    result.quota = { threw: true, error: safeError(error) };
  }

  if (env.GEMINI_API_KEY) {
    const model = env.NANO_BANANA_MODEL?.trim() || 'gemini-3.1-flash-image';
    try {
      const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': env.GEMINI_API_KEY,
        },
        body: JSON.stringify({ model, input: [{ type: 'text', text: prompt }] }),
        signal: AbortSignal.timeout(60000),
      });
      const text = await response.text();
      let payload: any = null;
      try { payload = JSON.parse(text); } catch {}
      result.gemini = {
        model,
        status: response.status,
        ok: response.ok,
        imageLength: imageLength(payload),
        detail: response.ok ? undefined : text.slice(0, 500),
      };
    } catch (error) {
      result.gemini = { threw: true, error: safeError(error) };
    }
  } else {
    result.gemini = { configured: false };
  }

  try {
    const response = await env.AI.run(FLUX, { prompt, steps: 4, seed: 12345 });
    const base64 = response?.image ?? response?.result?.image;
    result.flux = {
      ok: typeof base64 === 'string' && base64.length > 0,
      type: typeof response,
      keys: response && typeof response === 'object' ? Object.keys(response).slice(0, 20) : [],
      imageLength: typeof base64 === 'string' ? base64.length : 0,
    };
  } catch (error) {
    result.flux = { threw: true, error: safeError(error) };
  }

  for (const [key, model] of [['sdxl', SDXL], ['dreamshaper', DREAMSHAPER]] as const) {
    try {
      const response = await env.AI.run(model, {
        prompt,
        num_steps: 4,
        guidance: 7.5,
        seed: 12345,
      });
      result[key] = { ok: true, bytes: await streamBytes(response) };
    } catch (error) {
      result[key] = { threw: true, error: safeError(error) };
    }
  }

  return Response.json(result, {
    headers: {
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}
