import { supabase } from '../lib/supabase';

export type AccountPlan = 'free' | 'pro' | 'admin';

function normalizePlan(value: unknown): AccountPlan {
  return value === 'pro' || value === 'admin' ? value : 'free';
}

export async function getAccountPlan(): Promise<AccountPlan> {
  if (!supabase) return 'free';
  const { data, error } = await supabase
    .from('profiles')
    .select('plan')
    .maybeSingle();

  if (error || !data) return 'free';
  return normalizePlan(data.plan);
}

export async function getCreditBalance(): Promise<number | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('credit_wallets')
    .select('balance')
    .single();

  if (error || !data) return null;
  const balance = Number(data.balance);
  return Number.isFinite(balance) ? balance : null;
}
