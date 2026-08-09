export type AiMode = 'chat' | 'image';

export type ApiMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type AiResponse =
  | { ok: true; mode: 'chat'; text: string }
  | { ok: true; mode: 'image'; image: string; revisedPrompt?: string }
  | { ok: false; error: string };

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://127.0.0.1:8787';

export async function sendAiRequest(input: {
  mode: AiMode;
  message: string;
  history: ApiMessage[];
}): Promise<AiResponse> {
  const response = await fetch(`${API_URL}/v1/ai`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });

  const data = (await response.json()) as AiResponse;
  if (!response.ok) return { ok: false, error: 'ارتباط با سرور برقرار نشد. دوباره تلاش کنید.' };
  return data;
}
