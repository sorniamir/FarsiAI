import type { Env } from '../types';
import { supabaseAdminFetch } from './supabase-admin';

export type SpendResult =
  | { ok: true; balance: number }
  | { ok: false; reason: 'unconfigured' | 'insufficient' | 'remote_error' };

async function callRpc(
  env: Env,
  name: 'spend_credits' | 'refund_credits',
  body: Record<string, unknown>,
): Promise<Response | null> {
  return supabaseAdminFetch(env, `rpc/${name}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function spendCredits(
  env: Env,
  userId: string,
  amount: number,
  reason: string,
  referenceId: string,
): Promise<SpendResult> {
  const response = await callRpc(env, 'spend_credits', {
    p_user_id: userId,
    p_amount: amount,
    p_reason: reason,
    p_reference_id: referenceId,
  });

  if (!response) return { ok: false, reason: 'unconfigured' };

  if (!response.ok) {
    const text = await response.text();
    if (text.includes('insufficient_credits')) return { ok: false, reason: 'insufficient' };
    console.error(JSON.stringify({ event: 'credit_spend_failed', status: response.status }));
    return { ok: false, reason: 'remote_error' };
  }

  const payload = (await response.json()) as unknown;
  const balance = typeof payload === 'number' ? payload : Number(payload);
  if (!Number.isFinite(balance)) return { ok: false, reason: 'remote_error' };

  return { ok: true, balance };
}

export async function refundCredits(
  env: Env,
  userId: string,
  amount: number,
  reason: string,
  referenceId: string,
): Promise<boolean> {
  const response = await callRpc(env, 'refund_credits', {
    p_user_id: userId,
    p_amount: amount,
    p_reason: reason,
    p_reference_id: referenceId,
  });

  if (!response) return false;
  if (!response.ok) {
    console.error(JSON.stringify({ event: 'credit_refund_failed', status: response.status }));
    return false;
  }

  return true;
}
