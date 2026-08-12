type ProbeEnv = {
  AI: { run(model: string, input: Record<string, unknown>): Promise<any> };
  API_RATE_LIMITER: { limit(input: { key: string }): Promise<{ success: boolean }> };
};

const MODELS = ['@cf/openai/gpt-oss-120b', '@cf/google/gemma-4-26b-a4b-it'] as const;

function candidate(result: any): { name: string; arguments: unknown; shape: string } | null {
  const candidates = [result, result?.result, result?.data, result?.result?.result].filter(Boolean);
  for (const item of candidates) {
    const direct = item?.tool_calls?.[0];
    if (direct) return { name: String(direct?.function?.name ?? direct?.name ?? ''), arguments: direct?.function?.arguments ?? direct?.arguments, shape: 'tool_calls' };
    const choice = item?.choices?.[0]?.message?.tool_calls?.[0];
    if (choice) return { name: String(choice?.function?.name ?? choice?.name ?? ''), arguments: choice?.function?.arguments ?? choice?.arguments, shape: 'choices.message.tool_calls' };
    const responseCall = item?.output?.find?.((entry: any) => entry?.type === 'function_call');
    if (responseCall) return { name: String(responseCall?.name ?? ''), arguments: responseCall?.arguments, shape: 'responses.output.function_call' };
  }
  return null;
}

function parseArgs(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function validWrite(call: ReturnType<typeof candidate>): boolean {
  if (!call || call.name !== 'write_file') return false;
  const args = parseArgs(call.arguments);
  return !!args && args.path === 'document.txt' && typeof args.content === 'string';
}

function compatibleInput(input: Record<string, unknown>): Record<string, unknown> {
  const next = { ...input };
  delete next.parallel_tool_calls;
  delete next.tool_choice;
  delete next.max_completion_tokens;
  next.max_tokens = 800;
  return next;
}

async function run(env: ProbeEnv, model: string, input: Record<string, unknown>): Promise<{ result: any; mode: string }> {
  try {
    return { result: await env.AI.run(model, input), mode: 'standard' };
  } catch {
    return { result: await env.AI.run(model, compatibleInput(input)), mode: 'compatible' };
  }
}

export default {
  async fetch(request: Request, env: ProbeEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.pathname !== '/codex-create-file-probe') {
      return Response.json({ ok: false, error: 'Not found' }, { status: 404 });
    }

    const limited = await env.API_RATE_LIMITER.limit({ key: `codex-v053-create-file:${request.headers.get('cf-connecting-ip') || 'unknown'}` });
    if (!limited.success) return Response.json({ ok: false, error: 'Rate limited' }, { status: 429 });

    const tools = [{
      name: 'write_file',
      description: 'Create or replace a UTF-8 file inside the approved workspace. Empty content is valid.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative workspace path.' },
          content: { type: 'string', description: 'Complete UTF-8 content. May be empty.' },
        },
        required: ['path', 'content'],
      },
    }];
    const baseMessages = [
      {
        role: 'system',
        content: 'You are a coding agent. Use exactly one offered tool. Creating an empty UTF-8 file is valid: call write_file with content set to an empty string. Never invent tool aliases.',
      },
      { role: 'user', content: 'یک فایل document.txt بساز' },
    ];
    const baseInput: Record<string, unknown> = {
      messages: baseMessages,
      tools,
      tool_choice: 'required',
      parallel_tool_calls: false,
      temperature: 0.1,
      max_completion_tokens: 800,
    };

    const results: Array<Record<string, unknown>> = [];
    for (const model of MODELS) {
      try {
        const first = await run(env, model, baseInput);
        const initial = candidate(first.result);
        if (validWrite(initial)) {
          results.push({ model, ok: true, repaired: false, mode: first.mode, toolName: initial!.name, arguments: parseArgs(initial!.arguments), shape: initial!.shape });
          continue;
        }

        const repairMessages = [...baseMessages, {
          role: 'user',
          content: [
            'PLANNER VALIDATION ERROR: your previous tool proposal was rejected before local execution.',
            'Use exactly the enabled write_file tool and its exact JSON schema.',
            'The path must be document.txt. content MUST be a string and MAY be an empty string.',
            'Do not invent aliases such as create_file, save_file, edit_file, shell or terminal.',
            'Return exactly one valid tool call now.',
          ].join('\n'),
        }];
        const repaired = await run(env, model, { ...baseInput, messages: repairMessages });
        const fixed = candidate(repaired.result);
        results.push({
          model,
          ok: validWrite(fixed),
          repaired: true,
          initialTool: initial?.name ?? null,
          mode: repaired.mode,
          toolName: fixed?.name ?? null,
          arguments: fixed ? parseArgs(fixed.arguments) : null,
          shape: fixed?.shape ?? null,
        });
      } catch (error) {
        results.push({ model, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }

    const primary = results.find((item) => item.model === '@cf/openai/gpt-oss-120b');
    const ok = primary?.ok === true;
    return Response.json({ ok, scenario: 'create-empty-document.txt', results, preview: true }, { status: ok ? 200 : 503 });
  },
};
