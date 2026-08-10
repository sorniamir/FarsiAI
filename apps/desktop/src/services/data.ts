import { supabase } from '../lib/supabase';

export type AccountSnapshot = {
  email?: string;
  displayName?: string;
  plan: 'free' | 'pro' | 'admin';
  credits: number | null;
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

export async function getAccountSnapshot(): Promise<AccountSnapshot> {
  const fallback: AccountSnapshot = { plan: 'free', credits: null };
  if (!supabase) return fallback;

  const [{ data: authData }, { data: profile }, { data: wallet }] = await Promise.all([
    supabase.auth.getUser(),
    supabase.from('profiles').select('display_name,plan').single(),
    supabase.from('credit_wallets').select('balance').single(),
  ]);

  return {
    email: authData.user?.email ?? undefined,
    displayName: profile?.display_name ? String(profile.display_name) : undefined,
    plan: (profile?.plan ?? 'free') as AccountSnapshot['plan'],
    credits: wallet ? Number(wallet.balance) : null,
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
  return data.map((row) => ({
    id: String(row.id),
    title: String(row.title ?? 'گفتگوی جدید'),
    mode: (row.mode ?? 'chat') as ConversationSummary['mode'],
    updatedAt: String(row.updated_at),
  }));
}

export async function getConversationMessages(conversationId: string): Promise<StoredMessage[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('messages')
    .select('id,role,content,image_url,created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(200);

  if (error || !data) return [];
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
