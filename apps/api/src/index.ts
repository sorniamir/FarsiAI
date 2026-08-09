import { runChat } from './ai/chat';
import { runImage } from './ai/image';
import { refundCredits, spendCredits } from './lib/credits';
import { corsHeaders, json } from './lib/http';
import { sanitizeText } from './lib/language';
import { resolveAuth } from './lib/supabase-auth';
import type { AiRequest, ConversationMessage, Env } from './types';

const CREDIT_COST = {
  chat: 1,
  image: 20,
} as const;

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
    let charged: { userId: string; amount: number; mode: 'chat' | 'image' } | null = null;

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

      const auth = await resolveAuth(request, env);
      if (auth.kind === 'invalid') {
        return json(env, { ok: false, error: 'نشست کاربری معتبر نیست. دوباره وارد حساب شوید.' }, 401);
      }
      if (auth.kind === 'unconfigured') {
        return json(env, { ok: false, error: 'اتصال حساب کاربری به سرور هنوز کامل نشده است.' }, 503);
      }

      let creditsRemaining: number | undefined;
      if (auth.kind === 'user') {
        const amount = CREDIT_COST[mode];
        const spend = await spendCredits(env, auth.user.id, amount, `ai_${mode}`, requestId);

        if (!spend.ok) {
          if (spend.reason === 'insufficient') {
            return json(env, { ok: false, error: 'اعتبار کافی برای این درخواست ندارید.' }, 402);
          }
          if (spend.reason === 'unconfigured') {
            return json(env, { ok: false, error: 'سیستم اعتبار سرور هنوز تنظیم نشده است.' }, 503);
          }
          return json(env, { ok: false, error: 'بررسی اعتبار موقتاً در دسترس نیست.' }, 503);
        }

        creditsRemaining = spend.balance;
        charged = { userId: auth.user.id, amount, mode };
      }

      console.log(JSON.stringify({
        event: 'ai_request',
        requestId,
        mode,
        authenticated: auth.kind === 'user',
      }));

      if (mode === 'image') {
        const result = await runImage(env, message);
        charged = null;
        console.log(JSON.stringify({ event: 'ai_success', requestId, mode }));
        return json(env, {
          ok: true,
          mode: 'image',
          image: result.image,
          revisedPrompt: result.prompt,
          creditsRemaining,
        });
      }

      const text = await runChat(env, message, validHistory(payload.history));
      charged = null;
      console.log(JSON.stringify({ event: 'ai_success', requestId, mode }));
      return json(env, { ok: true, mode: 'chat', text, creditsRemaining });
    } catch (error) {
      if (charged) {
        try {
          await refundCredits(
            env,
            charged.userId,
            charged.amount,
            `ai_refund_${charged.mode}`,
            requestId,
          );
        } catch (refundError) {
          console.error(JSON.stringify({
            event: 'credit_refund_exception',
            requestId,
            message: refundError instanceof Error ? refundError.message : 'unknown_refund_error',
          }));
        }
      }

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
