import { containsPersian } from '../lib/language';
import type { ConversationMessage, Env } from '../types';
import { translate } from './translate';

const CHAT_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';

function extractText(result: any): string {
  return String(
    result?.response ??
      result?.result?.response ??
      result?.choices?.[0]?.message?.content ??
      result?.result?.choices?.[0]?.message?.content ??
      '',
  ).trim();
}

function normalizeHistory(history: ConversationMessage[]): ConversationMessage[] {
  return history
    .slice(-8)
    .map((item) => ({ role: item.role, content: item.content.trim().slice(0, 3000) }))
    .filter((item) => item.content.length > 0);
}

export async function runChat(
  env: Env,
  userText: string,
  history: ConversationMessage[] = [],
): Promise<string> {
  const wantsPersian = containsPersian(userText);
  const englishInput = wantsPersian ? await translate(env, userText, 'fa', 'en') : userText;
  const normalizedHistory = normalizeHistory(history);

  const result = await env.AI.run(CHAT_MODEL, {
    messages: [
      {
        role: 'system',
        content:
          'You are FarsiAI, a careful, helpful AI assistant. Give accurate, concise answers. Never invent facts when uncertain. The final answer will be translated to Persian when needed, so write clear natural English and preserve names, numbers, code, URLs, and technical terms precisely.',
      },
      ...normalizedHistory,
      { role: 'user', content: englishInput },
    ],
    temperature: 0.35,
    max_tokens: 1400,
  });

  const englishAnswer = extractText(result);
  if (!englishAnswer) throw new Error('Empty chat response');
  return wantsPersian ? await translate(env, englishAnswer, 'en', 'fa') : englishAnswer;
}
