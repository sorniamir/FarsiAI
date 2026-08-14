import Storage from 'expo-sqlite/kv-store';
import { supabase } from '../lib/supabase';
import type { AiMode } from '../api';
import type { DailyQuota } from '../types';
import { getAccountPlan } from './account';

const GUEST_KEY = 'farsiai-guest-daily-quota-v2';
export const DEFAULT_DAILY_QUOTA: DailyQuota = { chatRemaining: 10, imageRemaining: 4 };
export const DEFAULT_GUEST_QUOTA: DailyQuota = { chatRemaining: 5, imageRemaining: 2 };
export const PREMIUM_UNLIMITED_QUOTA: DailyQuota = { chatRemaining: 999999, imageRemaining: 999999, unlimited: true };

type StoredGuestQuota = DailyQuota & { date: string };

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

export function getGuestQuota(): DailyQuota {
  try {
    const stored = JSON.parse(Storage.getItemSync(GUEST_KEY) ?? 'null') as StoredGuestQuota | null;
    if (stored?.date === utcDay()) {
      return {
        chatRemaining: Math.max(0, Number(stored.chatRemaining) || 0),
        imageRemaining: Math.max(0, Number(stored.imageRemaining) || 0),
      };
    }
  } catch {
    // Reset corrupt local state below. The Worker remains authoritative after a request.
  }
  const fresh = { ...DEFAULT_GUEST_QUOTA, date: utcDay() };
  try { Storage.setItemSync(GUEST_KEY, JSON.stringify(fresh)); } catch { /* best effort only */ }
  return DEFAULT_GUEST_QUOTA;
}

export function consumeGuestQuota(mode: AiMode): DailyQuota | null {
  const current = getGuestQuota();
  if (mode === 'chat' && current.chatRemaining <= 0) return null;
  if (mode === 'image' && current.imageRemaining <= 0) return null;
  const next = {
    chatRemaining: current.chatRemaining - (mode === 'chat' ? 1 : 0),
    imageRemaining: current.imageRemaining - (mode === 'image' ? 1 : 0),
  };
  try { Storage.setItemSync(GUEST_KEY, JSON.stringify({ ...next, date: utcDay() })); } catch { /* server quota still protects usage */ }
  return next;
}

export async function getAuthenticatedQuota(): Promise<DailyQuota> {
  if (!supabase) return DEFAULT_DAILY_QUOTA;

  const plan = await getAccountPlan();
  if (plan === 'pro' || plan === 'admin') return PREMIUM_UNLIMITED_QUOTA;

  const { data, error } = await supabase
    .from('daily_usage')
    .select('chat_used,image_used')
    .eq('usage_date', utcDay())
    .maybeSingle();
  if (error || !data) return DEFAULT_DAILY_QUOTA;
  return {
    chatRemaining: Math.max(0, 10 - Number(data.chat_used ?? 0)),
    imageRemaining: Math.max(0, 4 - Number(data.image_used ?? 0)),
  };
}
