import { json } from '../lib/http';
import { sanitizeText } from '../lib/language';
import { resolveAuth } from '../lib/supabase-auth';
import type { Env } from '../types';

type AgentObservation = {
  role: 'tool' | 'note';
  name?: string;
  content: string;
};

type ToolName = 'list_directory' | 'read_file' | 'write_file' | 'run_command';

type ToolCall = {
  name: ToolName;
  arguments: Record<string, unknown>;
};

type PlannerResult = {
  result: unknown;
  model: string;
};

const AGENT_MODELS = [
  '@cf/moonshotai/kimi-k2.7-code',
  '@cf/zai-org/glm-4.7-flash',
  '@cf/zai-org/glm-5.2',
] as const;

const TOOL_NAMES = new Set<ToolName>(['list_directory', 'read_file', 'write_file', 'run_command']);
const COMMANDS = new Set(['npm', 'npx', 'node', 'git', 'python', 'python3', 'pnpm', 'yarn']);

const tools = [
  {
    name: 'list_directory',
    description: 'List files and folders inside the approved desktop workspace. Use relative paths only.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative path inside workspace. Use . for root.' } },
      required: ['path'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file inside the approved desktop workspace. Use relative paths only.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative file path inside workspace.' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Create or replace a UTF-8 text file inside the approved workspace. The desktop asks the user before this action.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative file path inside workspace. Do not prefix with approved-workspace or workspace.' },
        content: { type: 'string', description: 'Complete desired UTF-8 file content.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'run_command',
    description: 'Run an approved development program in the workspace. The desktop asks the user before this action. Never use a shell wrapper.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          enum: ['npm', 'npx', 'node', 'git', 'python', 'python3', 'pnpm', 'yarn'],
        },
        args: { type: 'array', items: { type: 'string' }, maxItems: 32 },
      },
      required: ['command', 'args'],
    },
  },
] as const;

function cleanCodeContent(value: unknown, max = 120000): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\u0000/g, '').slice(0, max);
}

function normalizeRelativePath(value: unknown): string | null {
  const raw = sanitizeText(String(value ?? '.'), 700).trim().replace(/\\/g, '/');
  let path = raw.replace(/^\/+/, '').replace(/^\.\//, '');
  path = path.replace(/^(approved-workspace|workspace)(?:\/|$)/i, '');
  path = path.replace(/^\/+/, '');

  if (!path || path === '.') return '.';
  if (/^[a-zA-Z]:\//.test(path) || path.startsWith('//')) return null;
  const parts = path.split('/').filter(Boolean);
  if (parts.some((part) => part === '..')) return null;
  return parts.join('/');
}

function normalizeToolCall(raw: unknown): ToolCall | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const functionPayload = item.function && typeof item.function === 'object'
    ? item.function as Record<string, unknown>
    : undefined;
  const nameValue = functionPayload?.name ?? item.name;
  if (typeof nameValue !== 'string' || !TOOL_NAMES.has(nameValue as ToolName)) return null;

  let argsValue: unknown = functionPayload?.arguments ?? item.arguments ?? {};
  if (typeof argsValue === 'string') {
    try {
      argsValue = JSON.parse(argsValue);
    } catch {
      return null;
    }
  }
  if (!argsValue || typeof argsValue !== 'object' || Array.isArray(argsValue)) return null;

  const args = argsValue as Record<string, unknown>;
  if ('path' in args) {
    const path = normalizeRelativePath(args.path);
    if (!path) return null;
    args.path = path;
  }
  if (nameValue === 'write_file') {
    args.content = cleanCodeContent(args.content);
  }
  if (nameValue === 'run_command') {
    const command = String(args.command ?? '').toLowerCase();
    if (!COMMANDS.has(command)) return null;
    const rawArgs = Array.isArray(args.args) ? args.args : [];
    args.command = command;
    args.args = rawArgs.slice(0, 32).map((value) => sanitizeText(String(value), 600));
  }

  return { name: nameValue as ToolName, arguments: args };
}

function modelResultCandidates(result: any): any[] {
  return [result, result?.result, result?.data, result?.result?.result].filter(Boolean);
}

function extractToolCall(result: any): ToolCall | null {
  for (const candidate of modelResultCandidates(result)) {
    const direct = Array.isArray(candidate?.tool_calls) ? candidate.tool_calls[0] : undefined;
    const nested = candidate?.choices?.[0]?.message?.tool_calls?.[0];
    const normalized = normalizeToolCall(direct ?? nested);
    if (normalized) return normalized;
  }
  return null;
}

function extractText(result: any): string {
  for (const candidate of modelResultCandidates(result)) {
    const value = candidate?.response ?? candidate?.choices?.[0]?.message?.content;
    if (typeof value === 'string' && value.trim()) return sanitizeText(value, 6000);
  }
  return '';
}

function successfulObservation(observation: AgentObservation, name: ToolName): boolean {
  if (observation.role !== 'tool' || observation.name !== name) return false;
  const content = observation.content.trim().toUpperCase();
  return !content.startsWith('ERROR:') && !content.startsWith('USER_DENIED_');
}

function lastSuccessfulIndex(observations: AgentObservation[], name: ToolName): number {
  for (let index = observations.length - 1; index >= 0; index -= 1) {
    if (successfulObservation(observations[index], name)) return index;
  }
  return -1;
}

function taskRequirements(task: string, observations: AgentObservation[]) {
  const normalized = task.toLowerCase();
  const createRequested = /(create|make\s+(a\s+)?file|new\s+file|فایل.*(بساز|ایجاد)|بساز|ایجاد کن)/iu.test(normalized);
  const writeRequested = /(create|write|save|edit|modify|replace|update|make\s+(a\s+)?file|فایل.*(بساز|ایجاد|ذخیره|ویرایش|تغییر)|بساز|ایجاد کن|ذخیره کن|ویرایش کن|تغییر بده|به.?روزرسانی)/iu.test(normalized);
  const commandRequested = /(?:\brun\s+(?:the\s+)?(?:tests?|build|command)\b|\b(?:npm|npx|node|pnpm|yarn|git|python|python3)\b|\b(?:build|test|install|compile)\s+(?:it|this|the|project|app|code|tests?)\b|اجرا\s*کن|بیلد\s*کن|تست\s*کن|نصب\s*کن|کامپایل\s*کن)/iu.test(normalized);
  const verifyRequested = /(verify|confirm|read it back|check it|دوباره.*بخوان|تأیید کن|چک کن|بررسی.*فایل)/iu.test(normalized);
  const denied = observations.some((item) => item.content.trim().toUpperCase().startsWith('USER_DENIED_'));
  const writeIndex = lastSuccessfulIndex(observations, 'write_file');
  const commandIndex = lastSuccessfulIndex(observations, 'run_command');
  const readIndex = lastSuccessfulIndex(observations, 'read_file');

  const missing: string[] = [];
  if (writeRequested && writeIndex < 0) missing.push('write_file must successfully create or modify the requested file');
  if (commandRequested && commandIndex < 0) missing.push('run_command must successfully execute the requested command');
  if (verifyRequested && writeIndex >= 0 && readIndex <= writeIndex) missing.push('read_file must verify the written file after write_file');

  let requiredTool: ToolName | undefined;
  if (!denied) {
    if (writeRequested && writeIndex < 0 && (createRequested || observations.length > 0)) {
      requiredTool = 'write_file';
    } else if (commandRequested && commandIndex < 0 && (!writeRequested || writeIndex >= 0)) {
      requiredTool = 'run_command';
    } else if (verifyRequested && writeIndex >= 0 && readIndex <= writeIndex) {
      requiredTool = 'read_file';
    }
  }

  const requireTool = !denied && (observations.length === 0 || missing.length > 0);
  const hasTrackedActions = writeRequested || commandRequested || verifyRequested;
  return { requireTool, requiredTool, missing, hasTrackedActions };
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === '`' && last === '`') || (first === '“' && last === '”')) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

function deterministicWriteFallback(task: string, requiredTool?: ToolName): ToolCall | null {
  if (requiredTool !== 'write_file') return null;

  const fileMatch = task.match(/(?:فایل|file)\s+(?:(?:به\s*نام|بنام|named|called)\s+)?["'`“]?([^\s"'`”]+\.[a-zA-Z0-9]{1,12})["'`”]?/iu)
    ?? task.match(/(?:به\s*نام|بنام|named|called)\s+["'`“]?([^\s"'`”]+\.[a-zA-Z0-9]{1,12})["'`”]?/iu);
  if (!fileMatch?.[1]) return null;

  const contentMatch = task.match(/(?:داخل(?:ش|\s+آن)?\s*(?:بنویس|بذار|بزار|قرار\s+بده)|محتوا(?:ی|یش)?\s*(?:باشد|باشه|:)?|with\s+(?:the\s+)?content|containing|write\s+(?:in\s+it\s+)?)\s*[:：]?\s*([\s\S]+)$/iu);
  if (!contentMatch?.[1]) return null;

  const path = normalizeRelativePath(fileMatch[1]);
  const content = stripWrappingQuotes(cleanCodeContent(contentMatch[1]));
  if (!path || path === '.' || !content) return null;

  return { name: 'write_file', arguments: { path, content } };
}

function compatiblePlannerInput(input: Record<string, unknown>): Record<string, unknown> {
  const next = { ...input };
  delete next.tool_choice;
  delete next.parallel_tool_calls;
  if (typeof next.max_completion_tokens === 'number') {
    next.max_tokens = next.max_completion_tokens;
    delete next.max_completion_tokens;
  }
  return next;
}

async function runPlannerWithFallback(
  env: Env,
  input: Record<string, unknown>,
  requestId: string,
  requireTool: boolean,
  requiredTool?: ToolName,
): Promise<PlannerResult> {
  let lastError: unknown;

  const tryModels = async (plannerInput: Record<string, unknown>, compatibilityMode: boolean): Promise<PlannerResult | null> => {
    for (const model of AGENT_MODELS) {
      try {
        const result = await env.AI.run(model, plannerInput as any);
        const tool = extractToolCall(result);
        if (requireTool && !tool) {
          lastError = new Error('Model returned text while a real tool call was required.');
          console.warn(JSON.stringify({ event: 'codex_required_tool_missing', requestId, model, compatibilityMode }));
          continue;
        }
        if (requiredTool && tool?.name !== requiredTool) {
          lastError = new Error(`Model returned ${tool?.name ?? 'no tool'} while ${requiredTool} was required.`);
          console.warn(JSON.stringify({ event: 'codex_wrong_tool', requestId, model, requiredTool, received: tool?.name ?? null, compatibilityMode }));
          continue;
        }
        console.log(JSON.stringify({ event: 'codex_model_success', requestId, model, tool: tool?.name ?? null, compatibilityMode }));
        return { result, model };
      } catch (error) {
        lastError = error;
        console.warn(JSON.stringify({
          event: 'codex_model_failed',
          requestId,
          model,
          compatibilityMode,
          message: error instanceof Error ? error.message : 'unknown_model_error',
        }));
      }
    }
    return null;
  };

  const primary = await tryModels(input, false);
  if (primary) return primary;

  const compatibility = await tryModels(compatiblePlannerInput(input), true);
  if (compatibility) return compatibility;

  throw lastError instanceof Error ? lastError : new Error('No Codex planner model was available.');
}

export async function handleAgentPlan(request: Request, env: Env): Promise<Response> {
  const requestId = request.headers.get('cf-ray') || crypto.randomUUID();

  try {
    const auth = await resolveAuth(request, env);
    if (auth.kind === 'invalid') return json(env, { ok: false, error: 'نشست کاربری معتبر نیست.' }, 401);
    if (auth.kind !== 'user') return json(env, { ok: false, error: 'Codex فقط برای کاربران واردشده فعال است.' }, 401);

    const { success } = await env.API_RATE_LIMITER.limit({ key: `user:${auth.user.id}:agent` });
    if (!success) return json(env, { ok: false, error: 'درخواست‌های Codex زیاد شده. کمی بعد دوباره تلاش کنید.' }, 429);

    let payload: Record<string, unknown>;
    try {
      payload = await request.json() as Record<string, unknown>;
    } catch {
      return json(env, { ok: false, error: 'درخواست Codex معتبر نیست.' }, 400);
    }

    const task = sanitizeText(String(payload.task ?? ''), 5000);
    const workspace = sanitizeText(String(payload.workspace ?? 'approved-workspace'), 700);
    if (!task) return json(env, { ok: false, error: 'وظیفه Codex خالی است.' }, 400);

    const observations: AgentObservation[] = Array.isArray(payload.observations)
      ? payload.observations.slice(-18).map((value) => {
          const item = value && typeof value === 'object' ? value as Record<string, unknown> : {};
          return {
            role: item.role === 'tool' ? 'tool' : 'note',
            name: typeof item.name === 'string' ? sanitizeText(item.name, 80) : undefined,
            content: sanitizeText(String(item.content ?? ''), 18000),
          };
        })
      : [];

    const requirements = taskRequirements(task, observations);

    if (requirements.hasTrackedActions && observations.length > 0 && requirements.missing.length === 0) {
      return json(env, {
        ok: true,
        type: 'final',
        message: 'عملیات درخواست‌شده با موفقیت روی Workspace تأییدشده اجرا و تأیید شد.',
        model: 'local-confirmation',
      });
    }

    const system = [
      'You are FarsiAI Codex, a careful coding and computer-work agent.',
      'Plan exactly one next step at a time and call exactly one available tool when a tool is needed.',
      'The desktop app executes tools locally and sends observations back to you. Never claim a local action succeeded until a tool observation confirms it.',
      'All file paths must be relative to the approved workspace. Never include the literal prefixes approved-workspace or workspace in a tool path.',
      'Never use absolute paths, parent traversal, home folders, secrets, credentials, or paths outside the workspace.',
      'Inspect before modifying only when inspection is actually useful. For a direct request to create a new file with known content, call write_file immediately.',
      'When the user asks to create or change a file, you MUST use write_file. A textual answer is not completion.',
      'When the user asks to run, test, install, build, inspect git, or execute a development command, you MUST use run_command.',
      'If the request asks you to verify a file after writing it, use read_file after the successful write_file observation.',
      'Use run_command only for the provided development commands and never request shell wrappers such as cmd, powershell, bash, sh, curl or wget.',
      'Do not delete files, reset git history, force push, change credentials, publish, deploy, purchase, or perform external side effects.',
      'After a write or command, inspect its returned result and continue until the requested task is genuinely complete or a user approval is denied.',
      'Only return a final answer when every required real-world action is confirmed by tool observations.',
      'When complete, return a concise Persian final response describing exactly what was completed and any remaining user action.',
    ].join('\n');

    const availableTools = requirements.requiredTool
      ? tools.filter((tool) => tool.name === requirements.requiredTool)
      : tools;

    const plannerInput = {
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: JSON.stringify({
            task,
            workspace,
            observations,
            requiredActionsStillMissing: requirements.missing,
            requiredToolNow: requirements.requiredTool ?? null,
          }),
        },
      ],
      tools: availableTools,
      tool_choice: requirements.requireTool ? 'required' : 'auto',
      parallel_tool_calls: false,
      temperature: 0.1,
      max_completion_tokens: 1800,
    };

    let planner: PlannerResult;
    try {
      planner = await runPlannerWithFallback(
        env,
        plannerInput,
        requestId,
        requirements.requireTool,
        requirements.requiredTool,
      );
    } catch (plannerError) {
      const deterministic = deterministicWriteFallback(task, requirements.requiredTool);
      if (deterministic) {
        console.warn(JSON.stringify({ event: 'codex_deterministic_write_fallback', requestId, path: deterministic.arguments.path }));
        return json(env, { ok: true, type: 'tool', tool: deterministic, model: 'deterministic-write-fallback' });
      }
      throw plannerError;
    }

    const { result, model } = planner;
    const tool = extractToolCall(result);
    if (tool) return json(env, { ok: true, type: 'tool', tool, model });

    if (requirements.missing.length > 0) {
      const deterministic = deterministicWriteFallback(task, requirements.requiredTool);
      if (deterministic) {
        return json(env, { ok: true, type: 'tool', tool: deterministic, model: 'deterministic-write-fallback' });
      }
      return json(env, { ok: false, error: 'Codex هنوز عمل واقعی موردنیاز را اجرا نکرده است.' }, 503);
    }

    const message = extractText(result) || 'کار تمام شد.';
    return json(env, { ok: true, type: 'final', message, model });
  } catch (error) {
    console.error(JSON.stringify({
      event: 'codex_plan_error',
      requestId,
      message: error instanceof Error ? error.message : 'unknown_codex_error',
    }));

    return json(
      env,
      {
        ok: false,
        error: 'Codex planner موقتاً در دسترس نیست. چند لحظه بعد دوباره تلاش کنید.',
        code: 'CODEX_PLANNER_UNAVAILABLE',
        requestId,
      },
      503,
    );
  }
}
