import { supabase } from '../lib/supabase';
import type { AiMode } from '../api';
import type { DailyQuota } from '../types';

const GUEST_KEY = 'farsiai-guest-daily-quota-v2';
export const DEFAULT_DAILY_QUOTA: DailyQuota = { chatRemaining: 10, imageRemaining: 4 };
export const DEFAULT_GUEST_QUOTA: DailyQuota = { chatRemaining: 5, imageRemaining: 2 };

type StoredGuestQuota = DailyQuota & { date: string };

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

export function getGuestQuota(): DailyQuota {
  try {
    const stored = JSON.parse(globalThis.localStorage?.getItem(GUEST_KEY) ?? 'null') as StoredGuestQuota | null;
    if (stored?.date === utcDay()) {
      return {
        chatRemaining: Math.max(0, Number(stored.chatRemaining) || 0),
        imageRemaining: Math.max(0, Number(stored.imageRemaining) || 0),
      };
    }
  } catch {
    // Reset corrupt local state below.
  }
  const fresh = { ...DEFAULT_GUEST_QUOTA, date: utcDay() };
  globalThis.localStorage?.setItem(GUEST_KEY, JSON.stringify(fresh));
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
  globalThis.localStorage?.setItem(GUEST_KEY, JSON.stringify({ ...next, date: utcDay() }));
  return next;
}

export async function getAuthenticatedQuota(): Promise<DailyQuota> {
  if (!supabase) return DEFAULT_DAILY_QUOTA;
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
