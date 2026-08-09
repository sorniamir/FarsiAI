import type { Env } from '../types';

export type SpendResult =
  | { ok: true; balance: number }
  | { ok: false; reason: 'unconfigured' | 'insufficient' | 'remote_error' };

function serviceConfig(env: Env): { url: string; key: string } | null {
  const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!env.SUPABASE_URL || !key) return null;
  return {
    url: env.SUPABASE_URL.replace(/\/$/, ''),
    key,
  };
}

async function callRpc(
  env: Env,
  name: 'spend_credits' | 'refund_credits',
  body: Record<string, unknown>,
): Promise<Response | null> {
  const config = serviceConfig(env);
  if (!config) return null;

  return fetch(`${config.url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: config.key,
      'content-type': 'application/json',
      accept: 'application/json',
    },
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
