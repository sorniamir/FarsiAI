import type { Env } from '../types';
import { supabaseAdminFetch } from './supabase-admin';

type ConversationMode = 'chat' | 'image' | 'mixed';
type StoredRole = 'user' | 'assistant';

function titleFromMessage(message: string): string {
  const normalized = message.replace(/\s+/g, ' ').trim();
  if (!normalized) return 'گفتگوی جدید';
  return normalized.length > 72 ? `${normalized.slice(0, 69)}…` : normalized;
}

export async function ensureConversation(
  env: Env,
  userId: string,
  requestedId: string | undefined,
  firstMessage: string,
  mode: Exclude<ConversationMode, 'mixed'>,
): Promise<string | null> {
  if (requestedId && /^[0-9a-f-]{36}$/i.test(requestedId)) {
    const query = new URLSearchParams({
      id: `eq.${requestedId}`,
      user_id: `eq.${userId}`,
      select: 'id,mode',
      limit: '1',
    });
    const response = await supabaseAdminFetch(env, `conversations?${query.toString()}`);
    if (response?.ok) {
      const rows = (await response.json()) as Array<{ id?: unknown; mode?: unknown }>;
      const row = rows[0];
      if (typeof row?.id === 'string') {
        if (row.mode !== mode && row.mode !== 'mixed') {
          await supabaseAdminFetch(env, `conversations?id=eq.${encodeURIComponent(row.id)}`, {
            method: 'PATCH',
            headers: { prefer: 'return=minimal' },
            body: JSON.stringify({ mode: 'mixed', updated_at: new Date().toISOString() }),
          });
        }
        return row.id;
      }
    }
  }

  const response = await supabaseAdminFetch(env, 'conversations?select=id', {
    method: 'POST',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify({
      user_id: userId,
      title: titleFromMessage(firstMessage),
      mode,
    }),
  });

  if (!response?.ok) {
    console.error(JSON.stringify({ event: 'conversation_create_failed', status: response?.status ?? 0 }));
    return null;
  }

  const rows = (await response.json()) as Array<{ id?: unknown }>;
  return typeof rows[0]?.id === 'string' ? rows[0].id : null;
}

export async function saveMessage(
  env: Env,
  conversationId: string,
  userId: string,
  role: StoredRole,
  content: string,
  imageUrl?: string,
): Promise<boolean> {
  const payload: Record<string, string> = {
    conversation_id: conversationId,
    user_id: userId,
    role,
    content,
  };
  if (imageUrl) payload.image_url = imageUrl;

  const response = await supabaseAdminFetch(env, 'messages', {
    method: 'POST',
    headers: { prefer: 'return=minimal' },
    body: JSON.stringify(payload),
  });

  if (!response?.ok) {
    console.error(JSON.stringify({ event: 'message_persist_failed', role, status: response?.status ?? 0 }));
    return false;
  }

  await supabaseAdminFetch(env, `conversations?id=eq.${encodeURIComponent(conversationId)}`, {
    method: 'PATCH',
    headers: { prefer: 'return=minimal' },
    body: JSON.stringify({ updated_at: new Date().toISOString() }),
  });

  return true;
}
