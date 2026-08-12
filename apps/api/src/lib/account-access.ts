import type { Env } from '../types';
import { supabaseAdminFetch } from './supabase-admin';

export type AccountPlan = 'free' | 'pro' | 'admin';

export type AccountAccess = {
  plan: AccountPlan;
  unlimited: boolean;
};

function normalizePlan(value: unknown): AccountPlan {
  return value === 'pro' || value === 'admin' ? value : 'free';
}

export async function getAccountAccess(env: Env, userId: string): Promise<AccountAccess> {
  const request = supabaseAdminFetch(env, `profiles?select=plan&id=eq.${encodeURIComponent(userId)}&limit=1`);
  if (!request) return { plan: 'free', unlimited: false };

  try {
    const response = await request;
    if (!response.ok) return { plan: 'free', unlimited: false };
    const rows = await response.json() as Array<{ plan?: unknown }>;
    const plan = normalizePlan(rows[0]?.plan);
    return { plan, unlimited: plan === 'pro' || plan === 'admin' };
  } catch {
    return { plan: 'free', unlimited: false };
  }
}
