import type { Env } from '../types';
import { supabaseAdminFetch } from './supabase-admin';

export type DailyQuota = {
  chatRemaining: number;
  imageRemaining: number;
  resetsAt?: string;
};

export type SpendResult =
  | { ok: true; quota: DailyQuota }
  | { ok: false; reason: 'unconfigured' | 'chat_limit' | 'image_limit' | 'remote_error' };

function parseQuota(payload: unknown): DailyQuota | null {
  if (!payload || typeof payload !== 'object') return null;
  const value = payload as Record<string, unknown>;
  const chatRemaining = Number(value.chatRemaining);
  const imageRemaining = Number(value.imageRemaining);
  if (!Number.isFinite(chatRemaining) || !Number.isFinite(imageRemaining)) return null;
  return {
    chatRemaining: Math.max(0, chatRemaining),
    imageRemaining: Math.max(0, imageRemaining),
    resetsAt: typeof value.resetsAt === 'string' ? value.resetsAt : undefined,
  };
}

export async function spendDailyQuota(
  env: Env,
  userId: string,
  mode: 'chat' | 'image',
  referenceId: string,
): Promise<SpendResult> {
  const request = supabaseAdminFetch(env, 'rpc/use_daily_quota', {
    method: 'POST',
    body: JSON.stringify({ p_user_id: userId, p_mode: mode, p_reference_id: referenceId }),
  });
  if (!request) return { ok: false, reason: 'unconfigured' };
  const response = await request;
  if (!response.ok) {
    const text = await response.text();
    if (text.includes('daily_chat_limit')) return { ok: false, reason: 'chat_limit' };
    if (text.includes('daily_image_limit')) return { ok: false, reason: 'image_limit' };
    console.error(JSON.stringify({ event: 'daily_quota_spend_failed', status: response.status, detail: text.slice(0, 300) }));
    return { ok: false, reason: 'remote_error' };
  }
  const quota = parseQuota(await response.json());
  return quota ? { ok: true, quota } : { ok: false, reason: 'remote_error' };
}

export async function refundDailyQuota(
  env: Env,
  userId: string,
  referenceId: string,
): Promise<boolean> {
  const request = supabaseAdminFetch(env, 'rpc/refund_daily_quota', {
    method: 'POST',
    body: JSON.stringify({ p_user_id: userId, p_reference_id: referenceId }),
  });
  if (!request) return false;
  const response = await request;
  if (!response.ok) {
    console.error(JSON.stringify({ event: 'daily_quota_refund_failed', status: response.status }));
    return false;
  }
  return true;
}
