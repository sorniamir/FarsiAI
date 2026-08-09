import { supabase } from '../lib/supabase';

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
