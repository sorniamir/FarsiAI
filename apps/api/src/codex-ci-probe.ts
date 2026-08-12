import type { Env } from './types';

const MODELS = [
  '@cf/openai/gpt-oss-120b',
  '@cf/openai/gpt-oss-20b',
  '@cf/google/gemma-4-26b-a4b-it',
  '@cf/zai-org/glm-4.7-flash',
] as const;

function toolCallCandidate(result: any): { call: any; shape: string } | null {
  const candidates = [result, result?.result, result?.data, result?.result?.result].filter(Boolean);
  for (const item of candidates) {
    if (item?.tool_calls?.[0]) return { call: item.tool_calls[0], shape: 'tool_calls' };
    if (item?.choices?.[0]?.message?.tool_calls?.[0]) return { call: item.choices[0].message.tool_calls[0], shape: 'choices.message.tool_calls' };
    const responseCall = item?.output?.find?.((entry: any) => entry?.type === 'function_call');
    if (responseCall) return { call: responseCall, shape: 'responses.output.function_call' };
  }
  return null;
}

function responseText(result: any): string {
  const candidates = [result, result?.result, result?.data, result?.result?.result].filter(Boolean);
  for (const item of candidates) {
    const text = item?.response ?? item?.choices?.[0]?.message?.content ?? item?.output_text;
    if (typeof text === 'string' && text.trim()) return text.trim();
  }
  return '';
}

function compatibleInput(input: Record<string, unknown>): Record<string, unknown> {
  const next = { ...input };
  delete next.parallel_tool_calls;
  delete next.tool_choice;
  delete next.max_completion_tokens;
  next.max_tokens = 600;
  return next;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.pathname !== '/codex-ai-probe') {
      return Response.json({ ok: false, error: 'Not found' }, { status: 404 });
    }

    const rateKey = `codex-preview-probe:${request.headers.get('cf-connecting-ip') || 'unknown'}`;
    const limited = await env.API_RATE_LIMITER.limit({ key: rateKey });
    if (!limited.success) return Response.json({ ok: false, error: 'Rate limited' }, { status: 429 });

    const tools = [{
      name: 'read_file',
      description: 'Read a UTF-8 file inside the approved workspace.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    }];
    const input: Record<string, unknown> = {
      messages: [
        { role: 'system', content: 'You are a coding agent connectivity probe. You must call exactly one offered tool and never answer with plain text.' },
        { role: 'user', content: 'Call read_file for package.json now.' },
      ],
      tools,
      tool_choice: 'required',
      parallel_tool_calls: false,
      temperature: 0.1,
      max_completion_tokens: 600,
    };

    const successes: Array<{ model: string; mode: string; shape: string; toolName: string; arguments: unknown }> = [];
    const failures: Array<{ model: string; mode: string; error: string }> = [];

    for (const model of MODELS) {
      for (const [mode, modelInput] of [
        ['standard', input],
        ['compatible', compatibleInput(input)],
      ] as const) {
        try {
          const result = await env.AI.run(model, modelInput);
          const candidate = toolCallCandidate(result);
          if (candidate) {
            const call = candidate.call;
            const name = call?.function?.name ?? call?.name;
            const args = call?.function?.arguments ?? call?.arguments;
            successes.push({ model, mode, shape: candidate.shape, toolName: String(name ?? ''), arguments: args });
            break;
          }
          failures.push({ model, mode, error: `no tool call; text=${responseText(result).slice(0, 160)}` });
        } catch (error) {
          failures.push({ model, mode, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }

    return Response.json({ ok: successes.length > 0, successes, failures, preview: true }, { status: successes.length > 0 ? 200 : 503 });
  },
};
