type ProbeEnv = {
  AI: { run(model: string, input: Record<string, unknown>): Promise<any> };
  API_RATE_LIMITER: { limit(input: { key: string }): Promise<{ success: boolean }> };
};

const MODELS = ['@cf/openai/gpt-oss-120b', '@cf/google/gemma-4-26b-a4b-it'] as const;

type ToolCall = { name: string; arguments: Record<string, unknown> | null; shape: string };

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

function toolCall(result: any): ToolCall | null {
  const candidates = [result, result?.result, result?.data, result?.result?.result].filter(Boolean);
  for (const item of candidates) {
    const direct = item?.tool_calls?.[0];
    if (direct) return { name: String(direct?.function?.name ?? direct?.name ?? ''), arguments: parseArgs(direct?.function?.arguments ?? direct?.arguments), shape: 'tool_calls' };
    const choice = item?.choices?.[0]?.message?.tool_calls?.[0];
    if (choice) return { name: String(choice?.function?.name ?? choice?.name ?? ''), arguments: parseArgs(choice?.function?.arguments ?? choice?.arguments), shape: 'choices.message.tool_calls' };
    const responseCall = item?.output?.find?.((entry: any) => entry?.type === 'function_call');
    if (responseCall) return { name: String(responseCall?.name ?? ''), arguments: parseArgs(responseCall?.arguments), shape: 'responses.output.function_call' };
  }
  return null;
}

function text(result: any): string {
  const candidates = [result, result?.result, result?.data, result?.result?.result].filter(Boolean);
  for (const item of candidates) {
    const values = [item?.response, item?.text, item?.output_text, item?.result?.response, item?.choices?.[0]?.message?.content];
    for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
    if (Array.isArray(item?.output)) {
      for (const entry of item.output) {
        if (entry?.type === 'message' && Array.isArray(entry?.content)) {
          for (const part of entry.content) {
            if (typeof part?.text === 'string' && part.text.trim()) return part.text.trim();
          }
        }
      }
    }
  }
  return '';
}

function compatible(input: Record<string, unknown>): Record<string, unknown> {
  const next = { ...input };
  delete next.parallel_tool_calls;
  delete next.tool_choice;
  delete next.max_completion_tokens;
  next.max_tokens = 1000;
  return next;
}

async function run(env: ProbeEnv, model: string, input: Record<string, unknown>): Promise<{ result: any; mode: string }> {
  try {
    return { result: await env.AI.run(model, input), mode: 'standard' };
  } catch {
    return { result: await env.AI.run(model, compatible(input)), mode: 'compatible' };
  }
}

function exactEmptyWrite(call: ToolCall | null): boolean {
  return !!call && call.name === 'write_file' && call.arguments?.path === 'document.txt' && call.arguments?.content === '';
}

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

const system = [
  'You are FarsiAI Codex Studio, a professional coding agent for a native Windows desktop app.',
  'Exactly these tools are enabled: write_file. Never request anything else.',
  'All paths are relative to a native-picker-approved workspace.',
  'Choose only one tool per turn. write_file replaces the complete file. Creating an empty UTF-8 file is valid: use write_file with content set to an empty string.',
  'Never claim completion without a correlated verified tool observation.',
  'Do not repeat an already verified successful side effect unless a later verified observation proves another change is required.',
  'Reply in concise, clear Persian. Use a final answer only when the task is truly complete.',
].join('\n');

export default {
  async fetch(request: Request, env: ProbeEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.pathname !== '/codex-v053-e2e') return Response.json({ ok: false }, { status: 404 });
    const limit = await env.API_RATE_LIMITER.limit({ key: `codex-v053-e2e:${request.headers.get('cf-connecting-ip') || 'unknown'}` });
    if (!limit.success) return Response.json({ ok: false, error: 'rate limited' }, { status: 429 });

    const reports: Array<Record<string, unknown>> = [];
    for (const model of MODELS) {
      try {
        const baseMessages = [
          { role: 'system', content: system },
          { role: 'user', content: 'TASK:\nیک فایل document.txt بساز\n\nWorkspace label: test-workspace' },
        ];
        const first = await run(env, model, {
          messages: baseMessages,
          tools,
          tool_choice: 'required',
          parallel_tool_calls: false,
          temperature: 0.1,
          max_completion_tokens: 1000,
        });
        const firstCall = toolCall(first.result);
        if (!exactEmptyWrite(firstCall)) {
          reports.push({ model, ok: false, stage: 'first_tool', firstTool: firstCall, firstText: text(first.result), mode: first.mode });
          continue;
        }

        const successObservation = {
          role: 'user',
          content: [
            'LOCAL TOOL OBSERVATION (callId=live-write-1, tool=write_file, status=success, verified=true):',
            'Created document.txt successfully.',
            'bytesWritten=0',
            'relativePath=document.txt',
            'postWriteSha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          ].join('\n'),
        };
        const secondMessages = [...baseMessages, successObservation];
        const second = await run(env, model, {
          messages: secondMessages,
          tools,
          tool_choice: 'auto',
          parallel_tool_calls: false,
          temperature: 0.1,
          max_completion_tokens: 1000,
        });
        const secondCall = toolCall(second.result);
        const secondText = text(second.result);
        if (!secondCall && secondText) {
          reports.push({ model, ok: true, finalAfterVerifiedWrite: true, duplicateSuppressionNeeded: false, finalText: secondText, firstMode: first.mode, secondMode: second.mode });
          continue;
        }
        if (!exactEmptyWrite(secondCall)) {
          reports.push({ model, ok: false, stage: 'post_success_behavior', secondTool: secondCall, secondText, firstMode: first.mode, secondMode: second.mode });
          continue;
        }

        // Desktop suppresses this exact duplicate locally without asking permission or writing again.
        const duplicateObservation = {
          role: 'user',
          content: [
            'LOCAL TOOL OBSERVATION (callId=live-write-2, tool=write_file, status=success, verified=true):',
            'Created document.txt successfully.',
            'Duplicate write suppressed locally because the exact content is already verified on disk.',
          ].join('\n'),
        };
        const third = await run(env, model, {
          messages: [...secondMessages, duplicateObservation],
          tools,
          tool_choice: 'auto',
          parallel_tool_calls: false,
          temperature: 0.1,
          max_completion_tokens: 1000,
        });
        const thirdCall = toolCall(third.result);
        const thirdText = text(third.result);
        reports.push({
          model,
          ok: !thirdCall && !!thirdText,
          finalAfterVerifiedWrite: !thirdCall && !!thirdText,
          duplicateSuppressionNeeded: true,
          thirdTool: thirdCall,
          finalText: thirdText,
          firstMode: first.mode,
          secondMode: second.mode,
          thirdMode: third.mode,
        });
      } catch (error) {
        reports.push({ model, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }

    const primary = reports.find((item) => item.model === '@cf/openai/gpt-oss-120b');
    const fallback = reports.find((item) => item.model === '@cf/google/gemma-4-26b-a4b-it');
    const ok = primary?.ok === true && fallback?.ok === true;
    return Response.json({ ok, scenario: 'create-document-then-finalize', reports, preview: true }, { status: ok ? 200 : 503 });
  },
};
