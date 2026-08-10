import { supabase } from '../lib/supabase';

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
};

export async function listConversations(): Promise<ConversationSummary[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('conversations')
    .select('id,title,mode,updated_at')
    .order('updated_at', { ascending: false })
    .limit(30);

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
    .limit(100);
  if (error || !data) return [];
  return data.map((row) => ({
    id: String(row.id),
    role: row.role as StoredMessage['role'],
    content: String(row.content ?? ''),
    imageUrl: row.image_url ? String(row.image_url) : undefined,
  }));
}
