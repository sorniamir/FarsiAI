import { runChat } from './ai/chat';
import { runImage } from './ai/image';
import { corsHeaders, json } from './lib/http';
import { sanitizeText } from './lib/language';
import type { AiRequest, ConversationMessage, Env } from './types';

function validHistory(value: unknown): ConversationMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is ConversationMessage =>
        !!item &&
        typeof item === 'object' &&
        (item.role === 'user' || item.role === 'assistant') &&
        typeof item.content === 'string',
    )
    .slice(-10)
    .map((item) => ({ role: item.role, content: sanitizeText(item.content, 3000) }));
}

async function stableActorKey(request: Request): Promise<string> {
  const authorization = request.headers.get('authorization')?.trim();
  const source = authorization || request.headers.get('cf-connecting-ip') || 'anonymous';
  const bytes = new TextEncoder().encode(source);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${authorization ? 'auth' : 'guest'}:${hex.slice(0, 32)}`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const requestId = request.headers.get('cf-ray') || crypto.randomUUID();

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return json(env, { ok: true, service: 'farsiai-api', version: '0.3.0' });
    }

    if (request.method !== 'POST' || url.pathname !== '/v1/ai') {
      return json(env, { ok: false, error: 'Not found' }, 404);
    }

    try {
      const payload = (await request.json()) as Partial<AiRequest>;
      const message = sanitizeText(payload.message, 6000);
      const mode = payload.mode === 'image' ? 'image' : 'chat';

      if (!message) return json(env, { ok: false, error: 'پیام خالی است.' }, 400);

      const actorKey = await stableActorKey(request);
      const limiter = mode === 'image' ? env.IMAGE_RATE_LIMITER : env.API_RATE_LIMITER;
      const { success } = await limiter.limit({ key: `${actorKey}:${mode}` });

      if (!success) {
        console.warn(JSON.stringify({ event: 'rate_limited', requestId, mode, actor: actorKey.split(':')[0] }));
        return json(env, { ok: false, error: 'تعداد درخواست‌ها زیاد شده. کمی بعد دوباره تلاش کنید.' }, 429);
      }

      console.log(JSON.stringify({ event: 'ai_request', requestId, mode, authenticated: actorKey.startsWith('auth:') }));

      if (mode === 'image') {
        const result = await runImage(env, message);
        console.log(JSON.stringify({ event: 'ai_success', requestId, mode }));
        return json(env, { ok: true, mode: 'image', image: result.image, revisedPrompt: result.prompt });
      }

      const text = await runChat(env, message, validHistory(payload.history));
      console.log(JSON.stringify({ event: 'ai_success', requestId, mode }));
      return json(env, { ok: true, mode: 'chat', text });
    } catch (error) {
      console.error(JSON.stringify({
        event: 'ai_error',
        requestId,
        message: error instanceof Error ? error.message : 'unknown_error',
      }));
      return json(
        env,
        { ok: false, error: 'سرویس هوش مصنوعی موقتاً در دسترس نیست. لطفاً دوباره تلاش کنید.' },
        500,
      );
    }
  },
};
