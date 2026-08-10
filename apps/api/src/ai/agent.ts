import { json } from '../lib/http';
import { sanitizeText } from '../lib/language';
import { resolveAuth } from '../lib/supabase-auth';
import type { Env } from '../types';

type AgentObservation = {
  role: 'tool' | 'note';
  name?: string;
  content: string;
};

type ToolCall = {
  name: 'list_directory' | 'read_file' | 'write_file' | 'run_command';
  arguments: Record<string, unknown>;
};

const AGENT_MODEL = '@cf/moonshotai/kimi-k2.7-code';
const TOOL_NAMES = new Set(['list_directory', 'read_file', 'write_file', 'run_command']);
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
    description: 'Create or replace a UTF-8 text file inside the approved workspace. This action requires user approval on the desktop.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative file path inside workspace.' },
        content: { type: 'string', description: 'Complete desired UTF-8 file content.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'run_command',
    description: 'Run an approved development program in the workspace. This action requires user approval on the desktop. Never use a shell wrapper.',
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
];

function cleanCodeContent(value: unknown, max = 120000): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\u0000/g, '').slice(0, max);
}

function normalizeToolCall(raw: unknown): ToolCall | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const functionPayload = item.function && typeof item.function === 'object'
    ? item.function as Record<string, unknown>
    : undefined;
  const nameValue = functionPayload?.name ?? item.name;
  if (typeof nameValue !== 'string' || !TOOL_NAMES.has(nameValue)) return null;

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
    const path = sanitizeText(String(args.path ?? '.'), 700).replace(/^[\\/]+/, '');
    if (!path || path.split(/[\\/]+/).includes('..')) return null;
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

  return { name: nameValue as ToolCall['name'], arguments: args };
}

function extractToolCall(result: any): ToolCall | null {
  const direct = Array.isArray(result?.tool_calls) ? result.tool_calls[0] : undefined;
  const nested = result?.choices?.[0]?.message?.tool_calls?.[0];
  return normalizeToolCall(direct ?? nested);
}

function extractText(result: any): string {
  const value = result?.response ?? result?.choices?.[0]?.message?.content ?? '';
  return sanitizeText(typeof value === 'string' ? value : JSON.stringify(value), 6000);
}

export async function handleAgentPlan(request: Request, env: Env): Promise<Response> {
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
  const workspace = sanitizeText(String(payload.workspace ?? 'workspace'), 700);
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

  const system = [
    'You are FarsiAI Codex, a careful coding agent that plans exactly one next step at a time.',
    'You never have direct access to the computer. The desktop app executes approved tools and sends observations back to you.',
    'All file paths must be relative to the approved workspace. Never use absolute paths, parent traversal, home folders, secrets, credentials, or paths outside the workspace.',
    'Inspect before modifying. Prefer list_directory and read_file before write_file.',
    'Use run_command only for the provided development commands and never request shell wrappers such as cmd, powershell, bash, sh, curl or wget.',
    'Do not delete files, reset git history, force push, change credentials, publish, deploy, purchase, or perform external side effects.',
    'When the task is complete, do not call a tool. Return a concise final response describing what was completed and any remaining user action.',
  ].join('\n');

  const result = await env.AI.run(AGENT_MODEL, {
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: JSON.stringify({ task, workspace, observations }),
      },
    ],
    tools,
    tool_choice: 'auto',
    parallel_tool_calls: false,
    temperature: 0.1,
    max_completion_tokens: 1800,
  });

  const tool = extractToolCall(result);
  if (tool) return json(env, { ok: true, type: 'tool', tool });

  const message = extractText(result) || 'کار تمام شد.';
  return json(env, { ok: true, type: 'final', message });
}
