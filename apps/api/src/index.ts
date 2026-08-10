export { GuestQuotaDurableObject } from './guest-quota-object';

import { handleAgentPlan } from './ai/agent';
import { runChat } from './ai/chat';
import { runImage } from './ai/image';
import {
  refundDailyQuota,
  refundGuestDailyQuota,
  spendDailyQuota,
  spendGuestDailyQuota,
} from './lib/credits';
import { corsHeaders, json } from './lib/http';
import { sanitizeText } from './lib/language';
import { ensureConversation, saveMessage } from './lib/persistence';
import { resolveAuth } from './lib/supabase-auth';
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

async function guestActorKey(request: Request): Promise<string> {
  const source = request.headers.get('cf-connecting-ip') || 'anonymous';
  const bytes = new TextEncoder().encode(source);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `guest:${hex.slice(0, 32)}`;
}

type ChargedRequest =
  | { kind: 'user'; userId: string; requestId: string }
  | { kind: 'guest'; actorKey: string; requestId: string };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const requestId = request.headers.get('cf-ray') || crypto.randomUUID();
    let charged: ChargedRequest | null = null;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return json(env, { ok: true, service: 'farsiai-api', version: '0.4.1' });
    }

    if (request.method === 'POST' && url.pathname === '/v1/agent/plan') {
      return handleAgentPlan(request, env);
    }

    if (request.method !== 'POST' || url.pathname !== '/v1/ai') {
      return json(env, { ok: false, error: 'Not found' }, 404);
    }

    try {
      let payload: Partial<AiRequest>;
      try {
        payload = (await request.json()) as Partial<AiRequest>;
      } catch {
        return json(env, { ok: false, error: 'بدنه درخواست باید JSON معتبر باشد.' }, 400);
      }

      if (payload.mode !== 'chat' && payload.mode !== 'image') {
        return json(env, { ok: false, error: 'حالت درخواست باید chat یا image باشد.' }, 400);
      }

      const message = sanitizeText(payload.message, 6000);
      const mode = payload.mode;
      if (!message) return json(env, { ok: false, error: 'پیام خالی است.' }, 400);

      const auth = await resolveAuth(request, env);
      if (auth.kind === 'invalid') {
        return json(env, { ok: false, error: 'نشست کاربری معتبر نیست. دوباره وارد حساب شوید.' }, 401);
      }
      if (auth.kind === 'unconfigured') {
        return json(env, { ok: false, error: 'اتصال حساب کاربری به سرور هنوز کامل نشده است.' }, 503);
      }

      const guestKey = auth.kind === 'guest' ? await guestActorKey(request) : undefined;
      const actorKey = auth.kind === 'user' ? `user:${auth.user.id}` : guestKey!;
      const limiter = mode === 'image' ? env.IMAGE_RATE_LIMITER : env.API_RATE_LIMITER;
      const { success } = await limiter.limit({ key: `${actorKey}:${mode}` });

      if (!success) {
        console.warn(JSON.stringify({ event: 'rate_limited', requestId, mode, actor: auth.kind }));
        return json(env, { ok: false, error: 'تعداد درخواست‌ها زیاد شده. کمی بعد دوباره تلاش کنید.' }, 429);
      }

      let quota: { chatRemaining: number; imageRemaining: number; resetsAt?: string } | undefined;
      let conversationId: string | undefined;

      if (auth.kind === 'user') {
        const spend = await spendDailyQuota(env, auth.user.id, mode, requestId);
        if (!spend.ok) {
          if (spend.reason === 'chat_limit') {
            return json(env, { ok: false, error: 'سهمیه ۱۰ پیام امروز تمام شده است. فردا دوباره شارژ می‌شود.' }, 402);
          }
          if (spend.reason === 'image_limit') {
            return json(env, { ok: false, error: 'سهمیه ۴ تصویر امروز تمام شده است. فردا دوباره شارژ می‌شود.' }, 402);
          }
          if (spend.reason === 'unconfigured') {
            return json(env, { ok: false, error: 'سیستم سهمیه سرور هنوز تنظیم نشده است.' }, 503);
          }
          return json(env, { ok: false, error: 'بررسی سهمیه موقتاً در دسترس نیست.' }, 503);
        }

        quota = spend.quota;
        charged = { kind: 'user', userId: auth.user.id, requestId };

        try {
          const persistedId = await ensureConversation(
            env,
            auth.user.id,
            typeof payload.conversationId === 'string' ? payload.conversationId : undefined,
            message,
            mode,
          );
          if (persistedId) {
            conversationId = persistedId;
            await saveMessage(env, persistedId, auth.user.id, 'user', message);
          }
        } catch (persistenceError) {
          console.error(JSON.stringify({
            event: 'conversation_persist_exception',
            requestId,
            message: persistenceError instanceof Error ? persistenceError.message : 'unknown_persistence_error',
          }));
        }
      } else {
        const spend = await spendGuestDailyQuota(env, guestKey!, mode, requestId);
        if (!spend.ok) {
          if (spend.reason === 'chat_limit') {
            return json(env, { ok: false, error: 'سهمیه مهمان ۵ پیام امروز تمام شده است. برای سهمیه بیشتر وارد حساب شو.' }, 402);
          }
          if (spend.reason === 'image_limit') {
            return json(env, { ok: false, error: 'سهمیه مهمان ۲ تصویر امروز تمام شده است. برای سهمیه بیشتر وارد حساب شو.' }, 402);
          }
          if (spend.reason === 'unconfigured') {
            return json(env, { ok: false, error: 'سیستم سهمیه مهمان هنوز تنظیم نشده است.' }, 503);
          }
          return json(env, { ok: false, error: 'بررسی سهمیه مهمان موقتاً در دسترس نیست.' }, 503);
        }
        quota = spend.quota;
        charged = { kind: 'guest', actorKey: guestKey!, requestId };
      }

      console.log(JSON.stringify({
        event: 'ai_request',
        requestId,
        mode,
        authenticated: auth.kind === 'user',
      }));

      if (mode === 'image') {
        const referenceImage = typeof payload.referenceImage === 'string' ? payload.referenceImage : undefined;
        const referencePrompt = typeof payload.referencePrompt === 'string'
          ? sanitizeText(payload.referencePrompt, 3000)
          : undefined;
        const result = await runImage(env, message, referenceImage, referencePrompt);

        if (auth.kind === 'user' && conversationId) {
          try {
            await saveMessage(
              env,
              conversationId,
              auth.user.id,
              'assistant',
              `تصویر ساخته شد. Prompt: ${sanitizeText(result.prompt, 3000)}`,
            );
          } catch (persistenceError) {
            console.error(JSON.stringify({
              event: 'assistant_persist_exception',
              requestId,
              message: persistenceError instanceof Error ? persistenceError.message : 'unknown_persistence_error',
            }));
          }
        }

        charged = null;
        console.log(JSON.stringify({ event: 'ai_success', requestId, mode }));
        return json(env, {
          ok: true,
          mode: 'image',
          image: result.image,
          revisedPrompt: result.prompt,
          edited: result.edited,
          quota,
          conversationId,
        });
      }

      const text = await runChat(env, message, validHistory(payload.history));

      if (auth.kind === 'user' && conversationId) {
        try {
          await saveMessage(env, conversationId, auth.user.id, 'assistant', sanitizeText(text, 12000));
        } catch (persistenceError) {
          console.error(JSON.stringify({
            event: 'assistant_persist_exception',
            requestId,
            message: persistenceError instanceof Error ? persistenceError.message : 'unknown_persistence_error',
          }));
        }
      }

      charged = null;
      console.log(JSON.stringify({ event: 'ai_success', requestId, mode }));
      return json(env, { ok: true, mode: 'chat', text, quota, conversationId });
    } catch (error) {
      if (charged) {
        try {
          if (charged.kind === 'user') {
            await refundDailyQuota(env, charged.userId, charged.requestId);
          } else {
            await refundGuestDailyQuota(env, charged.actorKey, charged.requestId);
          }
        } catch (refundError) {
          console.error(JSON.stringify({
            event: 'quota_refund_exception',
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
