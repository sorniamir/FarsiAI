import type { Env } from './types';

const MODELS = ['@cf/moonshotai/kimi-k2.7-code', '@cf/zai-org/glm-5.2', '@cf/zai-org/glm-4.7-flash'] as const;

function toolCallCandidate(result: any): any {
  const candidates = [result, result?.result, result?.data, result?.result?.result].filter(Boolean);
  for (const item of candidates) {
    const call = item?.tool_calls?.[0] ?? item?.choices?.[0]?.message?.tool_calls?.[0];
    if (call) return call;
  }
  return null;
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
        {
          role: 'system',
          content: 'You are a coding agent connectivity probe. You must call exactly one offered tool and never answer with plain text.',
        },
        {
          role: 'user',
          content: 'Call read_file for package.json now.',
        },
      ],
      tools,
      tool_choice: 'required',
      parallel_tool_calls: false,
      temperature: 0.1,
      max_completion_tokens: 600,
    };

    const failures: Array<{ model: string; error: string }> = [];
    for (const model of MODELS) {
      try {
        const result = await env.AI.run(
          model,
          model === '@cf/zai-org/glm-5.2' ? { ...input, reasoning_effort: 'medium' } : input,
        );
        const call = toolCallCandidate(result);
        if (!call) {
          failures.push({ model, error: 'required tool call missing' });
          continue;
        }
        const name = call?.function?.name ?? call?.name;
        const args = call?.function?.arguments ?? call?.arguments;
        return Response.json({
          ok: true,
          model,
          toolName: name,
          arguments: args,
          preview: true,
        });
      } catch (error) {
        failures.push({ model, error: error instanceof Error ? error.message : String(error) });
      }
    }

    return Response.json({ ok: false, failures, preview: true }, { status: 503 });
  },
};
