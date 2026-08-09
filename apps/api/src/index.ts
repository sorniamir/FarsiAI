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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return json(env, { ok: true, service: 'farsiai-api', version: '0.1.0' });
    }

    if (request.method !== 'POST' || url.pathname !== '/v1/ai') {
      return json(env, { ok: false, error: 'Not found' }, 404);
    }

    try {
      const payload = (await request.json()) as Partial<AiRequest>;
      const message = sanitizeText(payload.message, 6000);
      const mode = payload.mode === 'image' ? 'image' : 'chat';

      if (!message) return json(env, { ok: false, error: 'پیام خالی است.' }, 400);

      if (mode === 'image') {
        const result = await runImage(env, message);
        return json(env, { ok: true, mode: 'image', image: result.image, revisedPrompt: result.prompt });
      }

      const text = await runChat(env, message, validHistory(payload.history));
      return json(env, { ok: true, mode: 'chat', text });
    } catch (error) {
      console.error('AI request failed', error);
      return json(
        env,
        { ok: false, error: 'سرویس هوش مصنوعی موقتاً در دسترس نیست. لطفاً دوباره تلاش کنید.' },
        500,
      );
    }
  },
};
