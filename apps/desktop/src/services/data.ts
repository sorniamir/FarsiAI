import { supabase } from '../lib/supabase';
import type { DailyQuota } from './api';

export type AccountSnapshot = {
  email?: string;
  displayName?: string;
  plan: 'free' | 'pro' | 'admin';
};

export type ConversationSummary = {
  id: string;
  title: string;
  mode: 'chat' | 'image' | 'mixed';
  updatedAt: string;
};

export type StoredMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  imageUrl?: string;
  createdAt?: string;
};

type CachedMessages = {
  messages: StoredMessage[];
  cachedAt: number;
};

const MESSAGE_CACHE_TTL_MS = 5 * 60 * 1000;
const messageCache = new Map<string, CachedMessages>();
const inFlightMessages = new Map<string, Promise<StoredMessage[]>>();
const conversationVersions = new Map<string, string>();
let prefetchPromise: Promise<void> | null = null;

function isFresh(entry: CachedMessages | undefined): entry is CachedMessages {
  return !!entry && Date.now() - entry.cachedAt < MESSAGE_CACHE_TTL_MS;
}

function mapStoredMessages(data: any[]): StoredMessage[] {
  return data
    .filter((row) => row.role === 'user' || row.role === 'assistant')
    .map((row) => ({
      id: String(row.id),
      role: row.role as StoredMessage['role'],
      content: String(row.content ?? ''),
      imageUrl: row.image_url ? String(row.image_url) : undefined,
      createdAt: row.created_at ? String(row.created_at) : undefined,
    }));
}

async function fetchConversationMessages(conversationId: string): Promise<StoredMessage[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from('messages')
    .select('id,role,content,image_url,created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(200);

  if (error || !data) return [];
  const messages = mapStoredMessages(data);
  messageCache.set(conversationId, { messages, cachedAt: Date.now() });
  return messages;
}

async function prefetchRecentConversations(conversations: ConversationSummary[]): Promise<void> {
  if (!supabase || prefetchPromise) return prefetchPromise ?? Promise.resolve();

  // Image results are persisted as data URLs. Avoid preloading image/mixed threads,
  // otherwise startup can download several megabytes before the user opens them.
  const ids = conversations
    .filter((item) => item.mode === 'chat')
    .slice(0, 6)
    .map((item) => item.id)
    .filter((id) => !isFresh(messageCache.get(id)) && !inFlightMessages.has(id));

  if (ids.length === 0) return;

  prefetchPromise = (async () => {
    const { data, error } = await supabase
      .from('messages')
      .select('id,conversation_id,role,content,image_url,created_at')
      .in('conversation_id', ids)
      .order('created_at', { ascending: true })
      .limit(1200);

    if (error || !data) return;

    const grouped = new Map<string, any[]>();
    for (const id of ids) grouped.set(id, []);
    for (const row of data) {
      const conversationId = String(row.conversation_id ?? '');
      const bucket = grouped.get(conversationId);
      if (bucket) bucket.push(row);
    }

    const cachedAt = Date.now();
    for (const id of ids) {
      messageCache.set(id, {
        messages: mapStoredMessages(grouped.get(id) ?? []),
        cachedAt,
      });
    }
  })().finally(() => {
    prefetchPromise = null;
  });

  return prefetchPromise;
}

export function invalidateConversationMessages(conversationId?: string): void {
  if (!conversationId) return;
  messageCache.delete(conversationId);
}

export function clearConversationMessageCache(): void {
  messageCache.clear();
  inFlightMessages.clear();
  conversationVersions.clear();
  prefetchPromise = null;
}

export async function getAccountSnapshot(): Promise<AccountSnapshot> {
  const fallback: AccountSnapshot = { plan: 'free' };
  if (!supabase) return fallback;

  const [{ data: authData }, { data: profile }] = await Promise.all([
    supabase.auth.getUser(),
    supabase.from('profiles').select('display_name,plan').single(),
  ]);

  const rawPlan = profile?.plan;
  const plan: AccountSnapshot['plan'] = rawPlan === 'pro' || rawPlan === 'admin' ? rawPlan : 'free';
  return {
    email: authData.user?.email ?? undefined,
    displayName: profile?.display_name ? String(profile.display_name) : undefined,
    plan,
  };
}

export async function getCurrentDailyQuota(): Promise<DailyQuota> {
  const full: DailyQuota = { chatRemaining: 10, imageRemaining: 4 };
  if (!supabase) return full;

  const today = new Date().toISOString().slice(0, 10);
  const [{ data: profile }, { data: usage, error }] = await Promise.all([
    supabase.from('profiles').select('plan').maybeSingle(),
    supabase
      .from('daily_usage')
      .select('chat_used,image_used')
      .eq('usage_date', today)
      .maybeSingle(),
  ]);

  if (profile?.plan === 'pro' || profile?.plan === 'admin') {
    return { chatRemaining: 999999, imageRemaining: 999999, unlimited: true };
  }

  if (error || !usage) return full;
  return {
    chatRemaining: Math.max(0, 10 - Number(usage.chat_used ?? 0)),
    imageRemaining: Math.max(0, 4 - Number(usage.image_used ?? 0)),
  };
}

export async function listConversations(): Promise<ConversationSummary[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('conversations')
    .select('id,title,mode,updated_at')
    .order('updated_at', { ascending: false })
    .limit(60);

  if (error || !data) return [];
  const conversations = data.map((row) => ({
    id: String(row.id),
    title: String(row.title ?? 'گفتگوی جدید'),
    mode: (row.mode ?? 'chat') as ConversationSummary['mode'],
    updatedAt: String(row.updated_at),
  }));

  for (const conversation of conversations) {
    const previousVersion = conversationVersions.get(conversation.id);
    if (previousVersion && previousVersion !== conversation.updatedAt) {
      messageCache.delete(conversation.id);
    }
    conversationVersions.set(conversation.id, conversation.updatedAt);
  }

  // One background query warms recent text-only conversations without preloading image payloads.
  void prefetchRecentConversations(conversations);
  return conversations;
}

export async function getConversationMessages(conversationId: string): Promise<StoredMessage[]> {
  const cached = messageCache.get(conversationId);
  if (isFresh(cached)) return cached.messages;

  const existing = inFlightMessages.get(conversationId);
  if (existing) return existing;

  const request = fetchConversationMessages(conversationId).finally(() => {
    inFlightMessages.delete(conversationId);
  });
  inFlightMessages.set(conversationId, request);
  return request;
}
