import { handleAgentPlan } from './ai/agent-v2';
import { attachmentContext, firstImageAttachment, normalizeAttachments } from './ai/attachments';
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

function attachmentValidationError(error: unknown): string | null {
  const code = error instanceof Error ? error.message : '';
  const messages: Record<string, string> = {
    ATTACHMENTS_INVALID: 'ساختار فایل‌های ضمیمه معتبر نیست.',
    ATTACHMENTS_TOO_MANY: 'حداکثر ۴ فایل را می‌توان هم‌زمان ارسال کرد.',
    ATTACHMENT_INVALID: 'یکی از فایل‌های ضمیمه معتبر نیست.',
    ATTACHMENT_INVALID_DATA: 'داده یکی از فایل‌های ضمیمه قابل خواندن نیست.',
    ATTACHMENT_UNSUPPORTED: 'نوع یکی از فایل‌های ضمیمه پشتیبانی نمی‌شود.',
    ATTACHMENT_TOO_LARGE: 'حجم هر فایل باید حداکثر ۶ مگابایت باشد.',
    ATTACHMENTS_TOO_LARGE: 'مجموع حجم فایل‌های ضمیمه باید حداکثر ۱۲ مگابایت باشد.',
  };
  return messages[code] ?? null;
}

function attachmentRuntimeError(error: unknown): string | null {
  const code = error instanceof Error ? error.message : '';
  if (code === 'ATTACHMENT_CONVERSION_UNAVAILABLE') return 'پردازش فایل روی سرور در حال حاضر فعال نیست.';
  if (code === 'ATTACHMENT_CONVERSION_FAILED') return 'محتوای فایل ضمیمه قابل استخراج نبود. فایل دیگری امتحان کنید.';
  return attachmentValidationError(error);
}

async function guestActorKey(request: Request): Promise<string> {
  const source = request.headers.get('cf-connecting-ip') || 'anonymous';
  const bytes = new TextEncoder().encode(source);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `guest:${hex.slice(0, 32)}`;
}

async function detectLocalAgentSideEffectFailure(request: Request): Promise<{ tool: 'write_file' | 'run_command'; detail: string } | null> {
  try {
    const payload = await request.clone().json() as Record<string, unknown>;
    const observations = Array.isArray(payload.observations) ? payload.observations : [];
    const last = observations.length > 0 ? observations[observations.length - 1] : undefined;
    if (!last || typeof last !== 'object') return null;

    const item = last as Record<string, unknown>;
    if (item.role !== 'tool' || (item.name !== 'write_file' && item.name !== 'run_command')) return null;
    const content = String(item.content ?? '').trim();
    if (!content.toUpperCase().startsWith('ERROR:')) return null;

    return {
      tool: item.name,
      detail: sanitizeText(content.replace(/^ERROR:\s*/i, ''), 1200),
    };
  } catch {
    return null;
  }
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
      return json(env, { ok: true, service: 'farsiai-api', version: '0.4.7' });
    }

    if (request.method === 'POST' && url.pathname === '/v1/agent/plan') {
      // Local tool failures are intentionally returned to Codex Pro as observations.
      // The planner can diagnose and recover instead of stopping after the first error.
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

      let attachments;
      try {
        attachments = normalizeAttachments(payload.attachments);
      } catch (error) {
        return json(env, { ok: false, error: attachmentValidationError(error) || 'فایل ضمیمه معتبر نیست.' }, 400);
      }

      const mode = payload.mode;
      const message = sanitizeText(payload.message, 6000);
      if (mode === 'image' && !message) {
        return json(env, { ok: false, error: 'برای ساخت یا ویرایش تصویر، توضیح درخواست لازم است.' }, 400);
      }
      if (mode === 'chat' && !message && attachments.length === 0) {
        return json(env, { ok: false, error: 'پیام یا فایل ضمیمه لازم است.' }, 400);
      }

      const effectiveMessage = message || 'فایل‌های ضمیمه‌شده را بررسی کن و نکات مهم را توضیح بده.';
      const imageAction = payload.imageAction === 'edit' ? 'edit' : 'generate';
      const explicitReference = typeof payload.referenceImage === 'string' ? payload.referenceImage : undefined;
      const attachedReference = firstImageAttachment(attachments)?.dataUrl;
      const referenceImage = mode === 'image' && imageAction === 'edit'
        ? explicitReference || attachedReference
        : undefined;
      if (mode === 'image' && imageAction === 'edit' && !referenceImage) {
        return json(env, { ok: false, error: 'برای ویرایش تصویر باید روی یک تصویر ریپلای کنید یا یک تصویر ضمیمه کنید.' }, 400);
      }

      const referencePrompt = imageAction === 'edit' && typeof payload.referencePrompt === 'string'
        ? sanitizeText(payload.referencePrompt, 3000)
        : undefined;

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
            effectiveMessage,
            mode,
          );
          if (persistedId) {
            conversationId = persistedId;
            const attachmentNames = attachments.length
              ? `\n[ضمیمه: ${attachments.map((item) => item.name).join('، ')}]`
              : '';
            await saveMessage(env, persistedId, auth.user.id, 'user', `${effectiveMessage}${attachmentNames}`);
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
        imageAction: mode === 'image' ? imageAction : undefined,
        attachments: attachments.length,
        authenticated: auth.kind === 'user',
      }));

      if (mode === 'image') {
        const result = await runImage(env, effectiveMessage, referenceImage, referencePrompt);

        if (auth.kind === 'user' && conversationId) {
          try {
            await saveMessage(
              env,
              conversationId,
              auth.user.id,
              'assistant',
              result.edited ? 'ویرایش تصویر آماده شد.' : 'تصویر آماده شد.',
              result.image,
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
        console.log(JSON.stringify({ event: 'ai_success', requestId, mode, provider: result.provider }));
        return json(env, {
          ok: true,
          mode: 'image',
          image: result.image,
          revisedPrompt: result.prompt,
          edited: result.edited,
          provider: result.provider,
          quota,
          conversationId,
        });
      }

      const convertedAttachments = attachments.length ? await attachmentContext(env, attachments) : '';
      const text = await runChat(env, effectiveMessage, validHistory(payload.history), convertedAttachments);

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

      const attachmentError = attachmentRuntimeError(error);
      console.error(JSON.stringify({
        event: 'ai_error',
        requestId,
        message: error instanceof Error ? error.message : 'unknown_error',
      }));
      if (attachmentError) {
        return json(env, { ok: false, error: attachmentError }, 422);
      }
      return json(
        env,
        { ok: false, error: 'سرویس هوش مصنوعی موقتاً در دسترس نیست. لطفاً دوباره تلاش کنید.' },
        500,
      );
    }
  },
};
