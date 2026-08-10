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
  const candidates = conversations
    .slice(0, 6)
    .filter((item) => !isFresh(messageCache.get(item.id)) && !inFlightMessages.has(item.id));

  // Keep background work gentle: only two requests at a time.
  for (let index = 0; index < candidates.length; index += 2) {
    const batch = candidates.slice(index, index + 2);
    await Promise.allSettled(batch.map((item) => getConversationMessages(item.id)));
  }
}

export function invalidateConversationMessages(conversationId?: string): void {
  if (!conversationId) return;
  messageCache.delete(conversationId);
}

export function clearConversationMessageCache(): void {
  messageCache.clear();
  inFlightMessages.clear();
  conversationVersions.clear();
}

export async function getAccountSnapshot(): Promise<AccountSnapshot> {
  const fallback: AccountSnapshot = { plan: 'free' };
  if (!supabase) return fallback;

  const [{ data: authData }, { data: profile }] = await Promise.all([
    supabase.auth.getUser(),
    supabase.from('profiles').select('display_name,plan').single(),
  ]);

  return {
    email: authData.user?.email ?? undefined,
    displayName: profile?.display_name ? String(profile.display_name) : undefined,
    plan: (profile?.plan ?? 'free') as AccountSnapshot['plan'],
  };
}

export async function getCurrentDailyQuota(): Promise<DailyQuota> {
  const full: DailyQuota = { chatRemaining: 10, imageRemaining: 4 };
  if (!supabase) return full;

  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('daily_usage')
    .select('chat_used,image_used')
    .eq('usage_date', today)
    .maybeSingle();

  if (error || !data) return full;
  return {
    chatRemaining: Math.max(0, 10 - Number(data.chat_used ?? 0)),
    imageRemaining: Math.max(0, 4 - Number(data.image_used ?? 0)),
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

  // Warm recent conversations without blocking the History list itself.
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
