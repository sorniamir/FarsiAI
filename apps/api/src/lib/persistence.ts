import type { Env } from '../types';

type ConversationMode = 'chat' | 'image' | 'mixed';
type StoredRole = 'user' | 'assistant';

function adminConfig(env: Env): { url: string; key: string } | null {
  const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!env.SUPABASE_URL || !key) return null;
  return { url: env.SUPABASE_URL.replace(/\/$/, ''), key };
}

async function adminFetch(env: Env, path: string, init: RequestInit = {}): Promise<Response | null> {
  const config = adminConfig(env);
  if (!config) return null;

  const headers = new Headers(init.headers);
  headers.set('apikey', config.key);
  headers.set('content-type', 'application/json');
  headers.set('accept', 'application/json');

  return fetch(`${config.url}/rest/v1/${path}`, { ...init, headers });
}

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
    const response = await adminFetch(env, `conversations?${query.toString()}`);
    if (response?.ok) {
      const rows = (await response.json()) as Array<{ id?: unknown; mode?: unknown }>;
      const row = rows[0];
      if (typeof row?.id === 'string') {
        if (row.mode !== mode && row.mode !== 'mixed') {
          await adminFetch(env, `conversations?id=eq.${encodeURIComponent(row.id)}`, {
            method: 'PATCH',
            headers: { prefer: 'return=minimal' },
            body: JSON.stringify({ mode: 'mixed', updated_at: new Date().toISOString() }),
          });
        }
        return row.id;
      }
    }
  }

  const response = await adminFetch(env, 'conversations?select=id', {
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
): Promise<boolean> {
  const response = await adminFetch(env, 'messages', {
    method: 'POST',
    headers: { prefer: 'return=minimal' },
    body: JSON.stringify({
      conversation_id: conversationId,
      user_id: userId,
      role,
      content,
    }),
  });

  if (!response?.ok) {
    console.error(JSON.stringify({ event: 'message_persist_failed', role, status: response?.status ?? 0 }));
    return false;
  }

  await adminFetch(env, `conversations?id=eq.${encodeURIComponent(conversationId)}`, {
    method: 'PATCH',
    headers: { prefer: 'return=minimal' },
    body: JSON.stringify({ updated_at: new Date().toISOString() }),
  });

  return true;
}
