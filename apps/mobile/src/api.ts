import { supabase } from './lib/supabase';
import type { DailyQuota, UiAttachment } from './types';

export type AiMode = 'chat' | 'image';

export type ApiMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type AiResponse =
  | { ok: true; mode: 'chat'; text: string; quota?: DailyQuota; conversationId?: string }
  | {
      ok: true;
      mode: 'image';
      image: string;
      revisedPrompt?: string;
      edited?: boolean;
      provider?: string;
      quota?: DailyQuota;
      conversationId?: string;
    }
  | { ok: false; error: string };

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://127.0.0.1:8787';

export async function sendAiRequest(input: {
  mode: AiMode;
  message: string;
  history: ApiMessage[];
  conversationId?: string;
  attachments?: UiAttachment[];
  imageAction?: 'generate' | 'edit';
  referenceImage?: string;
  referencePrompt?: string;
  replyToMessageId?: string;
}): Promise<AiResponse> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };

  if (supabase) {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (token) headers.authorization = `Bearer ${token}`;
  }

  const payload = {
    ...input,
    attachments: input.attachments?.map(({ name, mimeType, size, dataUrl }) => ({ name, mimeType, size, dataUrl })),
  };

  const response = await fetch(`${API_URL}/v1/ai`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  let data: AiResponse;
  try {
    data = (await response.json()) as AiResponse;
  } catch {
    return { ok: false, error: 'پاسخ نامعتبر از سرور دریافت شد.' };
  }

  if (!response.ok) {
    if ('error' in data && data.error) return data;
    return { ok: false, error: 'ارتباط با سرور برقرار نشد. دوباره تلاش کنید.' };
  }

  return data;
}
