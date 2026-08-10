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

type GuestFallbackState = {
  day: string;
  chatUsed: number;
  imageUsed: number;
  references: Map<string, 'chat' | 'image'>;
  refunded: Set<string>;
};

const guestFallbackUsage = new Map<string, GuestFallbackState>();
let guestQuotaRemoteUnavailable = false;

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function nextUtcReset(day: string): string {
  return new Date(`${day}T00:00:00.000Z`).getTime() + 86_400_000 > 0
    ? new Date(new Date(`${day}T00:00:00.000Z`).getTime() + 86_400_000).toISOString()
    : new Date(Date.now() + 86_400_000).toISOString();
}

function fallbackState(actorKey: string): GuestFallbackState {
  const day = utcDay();
  const existing = guestFallbackUsage.get(actorKey);
  if (existing?.day === day) return existing;

  const fresh: GuestFallbackState = {
    day,
    chatUsed: 0,
    imageUsed: 0,
    references: new Map(),
    refunded: new Set(),
  };
  guestFallbackUsage.set(actorKey, fresh);
  return fresh;
}

function fallbackQuota(state: GuestFallbackState): DailyQuota {
  return {
    chatRemaining: Math.max(0, 5 - state.chatUsed),
    imageRemaining: Math.max(0, 2 - state.imageUsed),
    resetsAt: nextUtcReset(state.day),
  };
}

function spendGuestFallbackQuota(
  actorKey: string,
  mode: 'chat' | 'image',
  referenceId: string,
): SpendResult {
  const state = fallbackState(actorKey);
  const existing = state.references.get(referenceId);
  if (existing) return { ok: true, quota: fallbackQuota(state) };

  if (mode === 'chat' && state.chatUsed >= 5) return { ok: false, reason: 'chat_limit' };
  if (mode === 'image' && state.imageUsed >= 2) return { ok: false, reason: 'image_limit' };

  state.references.set(referenceId, mode);
  if (mode === 'chat') state.chatUsed += 1;
  else state.imageUsed += 1;
  return { ok: true, quota: fallbackQuota(state) };
}

function refundGuestFallbackQuota(actorKey: string, referenceId: string): boolean {
  const state = fallbackState(actorKey);
  if (state.refunded.has(referenceId)) return true;
  const mode = state.references.get(referenceId);
  if (!mode) return true;

  if (mode === 'chat') state.chatUsed = Math.max(0, state.chatUsed - 1);
  else state.imageUsed = Math.max(0, state.imageUsed - 1);
  state.refunded.add(referenceId);
  return true;
}

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

async function callQuotaRpc(
  env: Env,
  path: string,
  body: Record<string, unknown>,
): Promise<SpendResult> {
  const request = supabaseAdminFetch(env, path, {
    method: 'POST',
    body: JSON.stringify(body),
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

export async function spendDailyQuota(
  env: Env,
  userId: string,
  mode: 'chat' | 'image',
  referenceId: string,
): Promise<SpendResult> {
  return callQuotaRpc(env, 'rpc/use_daily_quota', {
    p_user_id: userId,
    p_mode: mode,
    p_reference_id: referenceId,
  });
}

export async function spendGuestDailyQuota(
  env: Env,
  actorKey: string,
  mode: 'chat' | 'image',
  referenceId: string,
): Promise<SpendResult> {
  if (!guestQuotaRemoteUnavailable) {
    const remote = await callQuotaRpc(env, 'rpc/use_guest_daily_quota', {
      p_actor_key: actorKey,
      p_mode: mode,
      p_reference_id: referenceId,
    });

    if (remote.ok || remote.reason === 'chat_limit' || remote.reason === 'image_limit') return remote;
    guestQuotaRemoteUnavailable = true;
    console.warn(JSON.stringify({ event: 'guest_quota_fallback_enabled', reason: remote.reason }));
  }

  return spendGuestFallbackQuota(actorKey, mode, referenceId);
}

async function callRefundRpc(
  env: Env,
  path: string,
  body: Record<string, unknown>,
): Promise<boolean> {
  const request = supabaseAdminFetch(env, path, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!request) return false;
  const response = await request;
  if (!response.ok) {
    console.error(JSON.stringify({ event: 'daily_quota_refund_failed', status: response.status, path }));
    return false;
  }
  return true;
}

export async function refundDailyQuota(
  env: Env,
  userId: string,
  referenceId: string,
): Promise<boolean> {
  return callRefundRpc(env, 'rpc/refund_daily_quota', {
    p_user_id: userId,
    p_reference_id: referenceId,
  });
}

export async function refundGuestDailyQuota(
  env: Env,
  actorKey: string,
  referenceId: string,
): Promise<boolean> {
  if (!guestQuotaRemoteUnavailable) {
    const remote = await callRefundRpc(env, 'rpc/refund_guest_daily_quota', {
      p_actor_key: actorKey,
      p_reference_id: referenceId,
    });
    if (remote) return true;
    guestQuotaRemoteUnavailable = true;
  }
  return refundGuestFallbackQuota(actorKey, referenceId);
}
