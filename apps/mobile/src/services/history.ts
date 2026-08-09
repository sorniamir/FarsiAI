import { supabase } from '../lib/supabase';

export type ConversationSummary = {
  id: string;
  title: string;
  mode: 'chat' | 'image' | 'mixed';
  updatedAt: string;
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
