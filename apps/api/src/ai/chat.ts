import type { ConversationMessage, Env } from '../types';

const CHAT_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';

const SYSTEM_PROMPT = `You are FarsiAI, a production-quality AI assistant for Persian-speaking users.

Language rules:
- Answer in fluent, modern Persian whenever the user's latest message is Persian.
- Write Persian directly. Never translate an English draft into Persian.
- Use natural Iranian Persian sentence structure and choose precise, familiar words.
- Preserve names, numbers, code, commands, URLs, and technical terms accurately.
- If the user writes in another language, answer in that language unless they ask for Persian.

Quality rules:
- Give a clear, self-contained answer and keep every sentence meaningful.
- Check the answer for contradictions, broken sentences, and awkward wording before returning it.
- If a fact is uncertain, say so plainly instead of inventing it.
- Do not expose chain-of-thought, hidden reasoning, or analysis.

Formatting rules:
- Return clean plain text because the mobile app does not render Markdown.
- Never use Markdown markers such as *, **, _, __, #, backticks, or fenced code blocks.
- Prefer short paragraphs. When a list helps, use Persian numerals or the bullet character •.`;

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

export function normalizeAssistantText(value: string): string {
  return value
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<analysis>[\s\S]*?<\/analysis>/gi, '')
    .replace(/^\s*(?:<think>|<analysis>)[\s\S]*$/gi, '')
    .replace(/```(?:\w+)?\s*([\s\S]*?)```/g, '$1')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/\*+/g, '')
    .replace(/__([^\n]+?)__/g, '$1')
    .replace(/_([^\n_]+?)_/g, '$1')
    .replace(/`([^\n`]+?)`/g, '$1')
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[ \t]+([،؛؟!,.])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function runChat(
  env: Env,
  userText: string,
  history: ConversationMessage[] = [],
): Promise<string> {
  const normalizedHistory = normalizeHistory(history);

  const result = await env.AI.run(CHAT_MODEL, {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      ...normalizedHistory,
      { role: 'user', content: userText },
    ],
    temperature: 0.25,
    top_p: 0.85,
    repetition_penalty: 1.08,
    max_tokens: 1400,
  });

  const answer = normalizeAssistantText(extractText(result));
  if (!answer) throw new Error('Empty chat response');
  return answer;
}

