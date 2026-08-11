import { json } from '../lib/http';
import { sanitizeText } from '../lib/language';
import { resolveAuth } from '../lib/supabase-auth';
import type { Env } from '../types';

type AgentObservation = {
  role: 'tool' | 'note';
  name?: ToolName;
  content: string;
};

type ToolName =
  | 'list_directory'
  | 'read_file'
  | 'write_file'
  | 'run_command'
  | 'open_app'
  | 'compose_message'
  | 'read_notifications';

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
  '@cf/zai-org/glm-5.2',
  '@cf/zai-org/glm-4.7-flash',
] as const;

const TOOL_NAMES = new Set<ToolName>([
  'list_directory', 'read_file', 'write_file', 'run_command',
  'open_app', 'compose_message', 'read_notifications',
]);
const COMMANDS = new Set([
  'npm', 'npx', 'node', 'git', 'python', 'python3', 'pnpm', 'yarn',
  'bun', 'deno', 'cargo', 'rustc', 'go', 'dotnet', 'java', 'javac',
  'mvn', 'gradle', 'pytest', 'pip', 'pip3', 'uv', 'ruff', 'rg',
]);

const tools = [
  {
    name: 'list_directory',
    description: 'List files and folders inside the approved desktop workspace. Use relative paths only. Use this to understand project structure before editing when needed.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path inside workspace. Use . for root.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file inside the approved desktop workspace. Use relative paths only. Read relevant files before modifying existing code.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative file path inside workspace.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Create or replace a UTF-8 text file inside the approved workspace. The desktop creates a backup before replacing an existing file and verifies the written content.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative file path inside workspace. Never prefix with approved-workspace or workspace.' },
        content: { type: 'string', description: 'Complete desired UTF-8 file content. Preserve unrelated existing code when editing.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'run_command',
    description: 'Run a direct development executable in the approved workspace without a shell wrapper. Use it for tests, builds, git inspection, package tools and targeted code inspection when read_file output is truncated.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          enum: Array.from(COMMANDS),
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 48,
          description: 'Arguments passed directly to the executable. Never embed cmd, PowerShell, bash or shell operators.',
        },
      },
      required: ['command', 'args'],
    },
  },
  {
    name: 'open_app',
    description: 'Open an installed Android app after direct user confirmation. Use a common app name such as WhatsApp, Telegram, Instagram, Gmail, Messages or Chrome.',
    parameters: {
      type: 'object',
      properties: { app: { type: 'string', description: 'Human-readable app name or Android package id.' } },
      required: ['app'],
    },
  },
  {
    name: 'compose_message',
    description: 'Open the destination Android app with a message draft after direct user confirmation. This never presses the final Send button; the user reviews and sends it.',
    parameters: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'WhatsApp, Telegram, Messages/SMS, Gmail, or another supported app.' },
        recipient: { type: 'string', description: 'Optional phone number, email, username, or recipient hint.' },
        message: { type: 'string', description: 'Complete message draft, maximum 12000 characters.' },
      },
      required: ['app', 'message'],
    },
  },
  {
    name: 'read_notifications',
    description: 'Read recent notification text captured only after the user explicitly enables Android Notification Access for FarsiAI. It cannot read private app databases or old messages.',
    parameters: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'Optional app name/package filter.' },
        limit: { type: 'number', description: 'Number of recent notifications, between 1 and 20.' },
      },
    },
  },
] as const;

function normalizeCapabilities(value: unknown): Set<ToolName> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return new Set(TOOL_NAMES);
  const rawTools = (value as Record<string, unknown>).tools;
  if (!Array.isArray(rawTools)) return new Set(TOOL_NAMES);
  return new Set(
    rawTools
      .filter((item): item is ToolName => typeof item === 'string' && TOOL_NAMES.has(item as ToolName)),
  );
}

function cleanCodeContent(value: unknown, max = 350_000): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\u0000/g, '').slice(0, max);
}

function normalizeRelativePath(value: unknown): string | null {
  const raw = sanitizeText(String(value ?? '.'), 1200).trim().replace(/\\/g, '/');
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

  const args = { ...(argsValue as Record<string, unknown>) };
  if ('path' in args) {
    const path = normalizeRelativePath(args.path);
    if (!path) return null;
    args.path = path;
  }

  if (nameValue === 'write_file') {
    const path = normalizeRelativePath(args.path);
    const content = cleanCodeContent(args.content);
    if (!path || path === '.' || !content) return null;
    args.path = path;
    args.content = content;
  }

  if (nameValue === 'run_command') {
    const command = String(args.command ?? '').trim().toLowerCase().replace(/\.(?:exe|cmd)$/i, '');
    if (!COMMANDS.has(command)) return null;
    const rawArgs = Array.isArray(args.args) ? args.args : [];
    args.command = command;
    args.args = rawArgs.slice(0, 48).map((value) => sanitizeText(String(value), 1600));
  }

  if (nameValue === 'open_app') {
    const app = sanitizeText(String(args.app ?? ''), 180).trim();
    if (!app) return null;
    args.app = app;
  }

  if (nameValue === 'compose_message') {
    const app = sanitizeText(String(args.app ?? ''), 180).trim();
    const recipient = sanitizeText(String(args.recipient ?? ''), 320).trim();
    const message = sanitizeText(String(args.message ?? ''), 12_000).trim();
    if (!app || !message) return null;
    args.app = app;
    if (recipient) args.recipient = recipient;
    else delete args.recipient;
    args.message = message;
  }

  if (nameValue === 'read_notifications') {
    const app = sanitizeText(String(args.app ?? ''), 180).trim();
    const limitValue = Number(args.limit ?? 8);
    if (app) args.app = app;
    else delete args.app;
    args.limit = Number.isFinite(limitValue) ? Math.max(1, Math.min(20, Math.floor(limitValue))) : 8;
  }

  return { name: nameValue as ToolName, arguments: args };
}

function modelResultCandidates(result: any): any[] {
  return [result, result?.result, result?.data, result?.result?.result].filter(Boolean);
}

function rawToolCall(result: any): unknown {
  for (const candidate of modelResultCandidates(result)) {
    const direct = Array.isArray(candidate?.tool_calls) ? candidate.tool_calls[0] : undefined;
    const nested = candidate?.choices?.[0]?.message?.tool_calls?.[0];
    if (direct ?? nested) return direct ?? nested;
  }
  return null;
}

function extractToolCall(result: any): ToolCall | null {
  return normalizeToolCall(rawToolCall(result));
}

function extractText(result: any): string {
  for (const candidate of modelResultCandidates(result)) {
    const value = candidate?.response ?? candidate?.choices?.[0]?.message?.content;
    if (typeof value === 'string' && value.trim()) return sanitizeText(value, 9000);
  }
  return '';
}

function normalizeObservations(value: unknown): AgentObservation[] {
  if (!Array.isArray(value)) return [];

  const normalized = value.slice(-30).map((entry) => {
    const item = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
    const role: AgentObservation['role'] = item.role === 'tool' ? 'tool' : 'note';
    const rawName = typeof item.name === 'string' ? item.name : undefined;
    const name = rawName && TOOL_NAMES.has(rawName as ToolName) ? rawName as ToolName : undefined;
    return {
      role,
      name,
      content: sanitizeText(String(item.content ?? ''), 70_000),
    };
  });

  // Keep the newest observations while capping prompt size. Large repositories can otherwise
  // consume the model context with repeated file reads/build logs.
  const kept: AgentObservation[] = [];
  let chars = 0;
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const observation = normalized[index];
    const size = observation.content.length + 200;
    if (kept.length > 0 && chars + size > 180_000) break;
    kept.unshift(observation);
    chars += size;
  }
  return kept;
}

function commandExitCode(content: string): number | null {
  const match = content.match(/(?:^|\n)exit=(-?\d+)(?:\n|$)/i);
  return match ? Number(match[1]) : null;
}

function observationStatus(observation: AgentObservation): 'success' | 'failure' | 'denied' | 'info' {
  const upper = observation.content.trim().toUpperCase();
  if (upper.startsWith('USER_DENIED_')) return 'denied';
  if (upper.startsWith('ERROR:')) return 'failure';
  if (observation.name === 'run_command') {
    const exit = commandExitCode(observation.content);
    if (exit !== null && exit !== 0) return 'failure';
    if (exit === 0) return 'success';
  }
  if (observation.role === 'tool') return 'success';
  return 'info';
}

function looksLikeActionTask(task: string): boolean {
  const normalized = task.trim().toLowerCase();
  if (!normalized) return false;
  if (/^(سلام|hello|hi|help|کمک|تو کی هستی|چه کار می.?کنی)\b/iu.test(normalized)) return false;
  return true;
}

function isDirectSimpleWriteTask(task: string): boolean {
  const hasFile = /(?:فایل|file)\s+(?:(?:به\s*نام|بنام|named|called)\s+)?["'`“]?[^\s"'`”]+\.[a-zA-Z0-9]{1,12}/iu.test(task);
  const hasWriteVerb = /(?:بنویس|بذار|بزار|قرار\s+بده|write|containing)/iu.test(task);
  const hasContentTarget = /(?:داخل(?:ش|\s+آن)?|محتوا(?:ی|یش)?|with\s+(?:the\s+)?content|containing)/iu.test(task);
  if (!hasFile || !hasWriteVerb || !hasContentTarget) return false;

  // A filename such as test.txt or literal content such as "FarsiAI Codex Test" must not
  // turn a simple create-file request into a complex testing task. Only explicit secondary
  // engineering actions make the request complex.
  const complexAction = /(?:\b(?:fix|debug|refactor|build|run|install|verify|review|inspect|execute)\b|برطرف|دیباگ|ریفکتور|بیلد|اجرا|نصب|بررسی|چک|تست\s+(?:کن|بگیر|اجرا))/iu.test(task);
  return !complexAction;
}

function hasSuccessfulWrite(observations: AgentObservation[]): boolean {
  return observations.some((item) => item.name === 'write_file' && observationStatus(item) === 'success');
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === '`' && last === '`') || (first === '“' && last === '”')) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function deterministicWriteFallback(task: string): ToolCall | null {
  if (!isDirectSimpleWriteTask(task)) return null;
  const fileMatch = task.match(/(?:فایل|file)\s+(?:(?:به\s*نام|بنام|named|called)\s+)?["'`“]?([^\s"'`”]+\.[a-zA-Z0-9]{1,12})["'`”]?/iu)
    ?? task.match(/(?:به\s*نام|بنام|named|called)\s+["'`“]?([^\s"'`”]+\.[a-zA-Z0-9]{1,12})["'`”]?/iu);
  const contentMatch = task.match(/(?:داخل(?:ش|\s+آن)?\s*(?:بنویس|بذار|بزار|قرار\s+بده)|محتوا(?:ی|یش)?\s*(?:باشد|باشه|:)?|with\s+(?:the\s+)?content|containing|write\s+(?:in\s+it\s+)?)\s*[:：]?\s*([\s\S]+)$/iu);
  if (!fileMatch?.[1] || !contentMatch?.[1]) return null;

  const path = normalizeRelativePath(fileMatch[1]);
  const content = stripWrappingQuotes(cleanCodeContent(contentMatch[1]));
  if (!path || path === '.' || !content) return null;
  return { name: 'write_file', arguments: { path, content } };
}

function buildSystem(clientKind: string, capabilities: Set<ToolName>): string {
  const capabilitySummary = Array.from(capabilities).join(', ') || 'none';
  const platformGuardrail = capabilities.has('run_command')
    ? 'Use run_command for tests, builds, git status/diff/grep and supported development executables. Never request shell wrappers such as cmd, powershell, bash or sh, and never use shell operators.'
    : 'This client cannot execute terminal commands. Never claim that tests, builds or commands ran. Use the offered file tools and clearly report when terminal validation must be completed on desktop.';
  const writeGuardrail = clientKind === 'mobile'
    ? 'On mobile, write_file changes the imported virtual workspace only after direct user approval. The user can review and export the modified file.'
    : 'On desktop, write_file changes a real file only after direct user approval, creates a backup and verifies the result on disk.';
  const deviceGuardrail = clientKind === 'mobile'
    ? 'Mobile device tools are consent-gated. open_app and compose_message require direct confirmation. compose_message only prepares a draft in the destination app and the user performs the final send. read_notifications only returns notifications captured after the user explicitly enabled Android Notification Access; never claim access to private app storage, old chats, calls or contacts.'
    : 'Android device and notification actions are unavailable on desktop.';

  return [
    `You are FarsiAI Codex Pro, a production-grade autonomous coding agent running on a ${clientKind} client against a user-approved local workspace.`,
    'Your job is to inspect, understand, edit, test and verify real projects like a professional coding agent. Work iteratively and do not guess about repository contents.',
    `The client offers exactly these local tools: ${capabilitySummary}. Never request any tool outside this list.`,
    'Choose exactly one offered tool for the next concrete step whenever a local action or inspection is needed. The client executes that tool and sends the real observation back on the next turn.',
    'Never claim a file changed, a command passed, a bug was fixed, or a build succeeded unless the corresponding LOCAL TOOL OBSERVATION proves it.',
    'A run_command observation with exit != 0 is a FAILURE, not success. Read stderr/stdout, diagnose it and continue fixing when possible.',
    'If a write/read/command observation says ERROR, adapt instead of blindly repeating the same failing action. If the user denied an action, respect it and choose a safe alternative or stop.',
    'All tool file paths must be relative to the approved workspace. Never send absolute paths, parent traversal, home-directory paths, secrets or credentials.',
    'For an existing file, normally read relevant context before write_file. For a brand-new file with fully specified content, write_file can be called directly.',
    'write_file replaces the complete file. Preserve all unrelated content exactly. Never use it with partial snippets for an existing file.',
    'If read_file output ends with [truncated], do not reconstruct missing code from memory. Use safe direct commands such as git, python or rg to inspect targeted portions before editing.',
    platformGuardrail,
    writeGuardrail,
    deviceGuardrail,
    'Prefer targeted inspection. Do not read vendor/build/cache directories such as node_modules, target, dist, build, .git or generated dependency trees unless specifically necessary.',
    'After meaningful edits, run the most relevant lightweight validation available when the task implies correctness. If validation fails, use the output to continue the repair.',
    'Do not delete files, rewrite git history, force push, change credentials, publish/deploy, purchase, or perform external side effects.',
    'Only return a final response when the requested task is actually complete, intentionally blocked, or requires a decision from the user. Final responses must be concise Persian and must accurately mention validation status.',
  ].join('\n');
}

function observationMessage(observation: AgentObservation, index: number): string {
  const status = observationStatus(observation);
  return [
    `<local_tool_observation index="${index + 1}" role="${observation.role}" tool="${observation.name ?? 'note'}" status="${status}">`,
    observation.content,
    '</local_tool_observation>',
  ].join('\n');
}

function buildPlannerInput(
  task: string,
  workspace: string,
  observations: AgentObservation[],
  requireTool: boolean,
  capabilities: Set<ToolName>,
  clientKind: string,
) {
  const failed = observations.filter((item) => observationStatus(item) === 'failure');
  const denied = observations.filter((item) => observationStatus(item) === 'denied');
  const messages: Array<{ role: 'system' | 'user'; content: string }> = [
    { role: 'system', content: buildSystem(clientKind, capabilities) },
    {
      role: 'user',
      content: [
        `<task>${task}</task>`,
        `<workspace>${workspace || 'approved-workspace'}</workspace>`,
        '<instruction>Decide the single best next step. Use a tool if more local work is needed; otherwise give the truthful final Persian result.</instruction>',
      ].join('\n'),
    },
  ];

  observations.forEach((observation, index) => {
    messages.push({ role: 'user', content: observationMessage(observation, index) });
  });

  if (failed.length > 0) {
    messages.push({
      role: 'user',
      content: `<agent_guardrail>There are ${failed.length} failed local tool observations. Do not report success unless a later observation proves recovery.</agent_guardrail>`,
    });
  }
  if (denied.length > 0) {
    messages.push({
      role: 'user',
      content: '<agent_guardrail>The user denied at least one requested side effect. Respect that boundary.</agent_guardrail>',
    });
  }

  const supportedTools = tools.filter((tool) => capabilities.has(tool.name));
  const offeredTools = isDirectSimpleWriteTask(task) && observations.length === 0 && capabilities.has('write_file')
    ? supportedTools.filter((tool) => tool.name === 'write_file')
    : supportedTools;

  return {
    messages,
    tools: offeredTools,
    tool_choice: requireTool ? 'required' : 'auto',
    parallel_tool_calls: false,
    temperature: 0.1,
    max_completion_tokens: 2600,
  } as Record<string, unknown>;
}

function compatiblePlannerInput(input: Record<string, unknown>): Record<string, unknown> {
  const next = { ...input };
  delete next.parallel_tool_calls;
  delete next.reasoning_effort;
  delete next.chat_template_kwargs;
  if (typeof next.max_completion_tokens === 'number') {
    next.max_tokens = next.max_completion_tokens;
    delete next.max_completion_tokens;
  }
  return next;
}

function plannerInputForModel(model: string, input: Record<string, unknown>): Record<string, unknown> {
  if (model === '@cf/moonshotai/kimi-k2.7-code') {
    return {
      ...input,
      chat_template_kwargs: { thinking: true },
    };
  }
  if (model === '@cf/zai-org/glm-5.2') {
    return {
      ...input,
      reasoning_effort: 'medium',
    };
  }
  return input;
}

async function runPlannerWithFallback(
  env: Env,
  input: Record<string, unknown>,
  requestId: string,
  requireTool: boolean,
): Promise<PlannerResult> {
  let lastError: unknown;

  const tryModels = async (compatibilityMode: boolean): Promise<PlannerResult | null> => {
    for (const model of AGENT_MODELS) {
      try {
        const baseInput = plannerInputForModel(model, input);
        const plannerInput = compatibilityMode ? compatiblePlannerInput(baseInput) : baseInput;
        const result = await env.AI.run(model, plannerInput as any);
        const tool = extractToolCall(result);
        const rawCall = rawToolCall(result);
        const text = extractText(result);
        const offeredToolNames = new Set(
          (Array.isArray(plannerInput.tools) ? plannerInput.tools : [])
            .map((item) => item && typeof item === 'object' ? String((item as Record<string, unknown>).name ?? '') : '')
            .filter(Boolean),
        );

        if (tool && offeredToolNames.size > 0 && !offeredToolNames.has(tool.name)) {
          lastError = new Error(`Model requested ${tool.name}, which was not offered for this step.`);
          console.warn(JSON.stringify({ event: 'codex_unoffered_tool_call', requestId, model, tool: tool.name, compatibilityMode }));
          continue;
        }
        if (rawCall && !tool) {
          lastError = new Error('Model returned an invalid or unsafe tool call.');
          console.warn(JSON.stringify({ event: 'codex_invalid_tool_call', requestId, model, compatibilityMode }));
          continue;
        }
        if (requireTool && !tool) {
          lastError = new Error('Model returned text while a real tool call was required.');
          console.warn(JSON.stringify({ event: 'codex_required_tool_missing', requestId, model, compatibilityMode }));
          continue;
        }
        if (!tool && !text) {
          lastError = new Error('Model returned neither a valid tool call nor final text.');
          console.warn(JSON.stringify({ event: 'codex_empty_model_result', requestId, model, compatibilityMode }));
          continue;
        }

        console.log(JSON.stringify({
          event: 'codex_model_success',
          requestId,
          model,
          tool: tool?.name ?? null,
          final: !tool,
          compatibilityMode,
        }));
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

  const primary = await tryModels(false);
  if (primary) return primary;
  const compatibility = await tryModels(true);
  if (compatibility) return compatibility;
  throw lastError instanceof Error ? lastError : new Error('No Codex planner model was available.');
}

export async function handleAgentPlan(request: Request, env: Env): Promise<Response> {
  const requestId = request.headers.get('cf-ray') || crypto.randomUUID();

  try {
    const auth = await resolveAuth(request, env);
    if (auth.kind === 'invalid') return json(env, { ok: false, error: 'نشست کاربری معتبر نیست. دوباره وارد حساب شوید.', code: 'CODEX_AUTH_INVALID', requestId }, 401);
    if (auth.kind !== 'user') return json(env, { ok: false, error: 'Codex فقط برای کاربران واردشده فعال است.', code: 'CODEX_LOGIN_REQUIRED', requestId }, 401);

    const { success } = await env.API_RATE_LIMITER.limit({ key: `user:${auth.user.id}:agent` });
    if (!success) {
      return json(env, { ok: false, error: 'درخواست‌های Codex زیاد شده. چند لحظه بعد دوباره تلاش کنید.', code: 'CODEX_RATE_LIMITED', requestId }, 429);
    }

    let payload: Record<string, unknown>;
    try {
      payload = await request.json() as Record<string, unknown>;
    } catch {
      return json(env, { ok: false, error: 'درخواست Codex معتبر نیست.', code: 'CODEX_INVALID_REQUEST', requestId }, 400);
    }

    const task = sanitizeText(String(payload.task ?? ''), 8000).trim();
    const workspace = sanitizeText(String(payload.workspace ?? 'approved-workspace'), 1200).trim() || 'approved-workspace';
    const clientKind = payload.clientKind === 'mobile' ? 'mobile' : 'desktop';
    const capabilities = normalizeCapabilities(payload.clientCapabilities);
    if (!task) return json(env, { ok: false, error: 'وظیفه Codex خالی است.', code: 'CODEX_EMPTY_TASK', requestId }, 400);

    const observations = normalizeObservations(payload.observations);

    // Preserve a deterministic, offline-safe path for the simplest explicit file-creation task.
    // Complex coding work always returns to the model so it can inspect tool output and validate the result.
    if (isDirectSimpleWriteTask(task) && hasSuccessfulWrite(observations)) {
      return json(env, {
        ok: true,
        type: 'final',
        message: 'فایل درخواست‌شده روی Workspace ساخته و محتوای آن روی دیسک تأیید شد.',
        model: 'local-confirmation',
        requestId,
      });
    }

    const requireTool = capabilities.size > 0 && observations.length === 0 && looksLikeActionTask(task);
    const plannerInput = buildPlannerInput(task, workspace, observations, requireTool, capabilities, clientKind);

    let planner: PlannerResult;
    try {
      planner = await runPlannerWithFallback(env, plannerInput, requestId, requireTool);
    } catch (plannerError) {
      if (observations.length === 0) {
        const deterministic = capabilities.has('write_file') ? deterministicWriteFallback(task) : null;
        if (deterministic) {
          console.warn(JSON.stringify({ event: 'codex_deterministic_write_fallback', requestId, path: deterministic.arguments.path }));
          return json(env, {
            ok: true,
            type: 'tool',
            tool: deterministic,
            model: 'deterministic-write-fallback',
            requestId,
          });
        }
      }
      throw plannerError;
    }

    const tool = extractToolCall(planner.result);
    if (tool) {
      return json(env, {
        ok: true,
        type: 'tool',
        tool,
        model: planner.model,
        requestId,
      });
    }

    const message = extractText(planner.result);
    if (!message) throw new Error('Codex model did not return a usable final response.');

    return json(env, {
      ok: true,
      type: 'final',
      message,
      model: planner.model,
      requestId,
    });
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
        error: 'Codex planner موقتاً در دسترس نیست. اتصال و مدل‌های جایگزین بررسی شدند؛ دوباره تلاش کنید.',
        code: 'CODEX_PLANNER_UNAVAILABLE',
        requestId,
      },
      503,
    );
  }
}
