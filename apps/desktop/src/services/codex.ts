import { invoke } from '@tauri-apps/api/core';
import { supabase } from '../lib/supabase';

export const CODEX_PROTOCOL = 'farsiai.codex.desktop.v2' as const;
export const CODEX_CLIENT_VERSION = '0.5.0-codex-studio';

export type CodexToolName =
  | 'list_directory'
  | 'read_file'
  | 'search_files'
  | 'write_file'
  | 'create_directory'
  | 'run_command'
  | 'launch_app';

export type CodexPermissionMode = 'guarded' | 'confirm-all' | 'read-only';
export type EvidenceStatus = 'success' | 'error' | 'denied' | 'cancelled';

export type WorkspaceGrant = {
  grantId: string;
  label: string;
  root: string;
};

export type ApplicationGrant = {
  appGrantId: string;
  label: string;
};

export type CodexToolCall =
  | { callId: string; name: 'list_directory'; arguments: { path: string } }
  | { callId: string; name: 'read_file'; arguments: { path: string } }
  | { callId: string; name: 'search_files'; arguments: { path: string; query: string; maxResults: number } }
  | { callId: string; name: 'write_file'; arguments: { path: string; content: string; expectedSha256?: string | null } }
  | { callId: string; name: 'create_directory'; arguments: { path: string } }
  | { callId: string; name: 'run_command'; arguments: { command: string; args: string[]; cwd: string } }
  | { callId: string; name: 'launch_app'; arguments: { applicationId: string; args: string[] } };

export type CodexObservation = {
  role: 'tool';
  callId: string;
  name: CodexToolName;
  status: EvidenceStatus;
  content: string;
  evidence: {
    verified: boolean;
    durationMs?: number;
    exitCode?: number;
    beforeSha256?: string | null;
    afterSha256?: string;
    backupId?: string;
    runId?: string;
  };
  createdAt: string;
};

export type CodexTurnResponse =
  | { ok: true; type: 'tool'; tool: CodexToolCall; requestId?: string; model?: string }
  | { ok: true; type: 'final'; message: string; requestId?: string; model?: string }
  | { ok: false; error: string; code: string; requestId?: string; model?: string };

export type ToolCapability = {
  name: CodexToolName;
  permission: 'automatic' | 'ask';
};

export type CodexCapabilities = {
  protocol: typeof CODEX_PROTOCOL;
  tools: ToolCapability[];
  safeCommands: string[];
  approvedApplications: Array<{ id: string; label: string }>;
  permissionMode: CodexPermissionMode;
  boundary: 'session-workspace-grant';
  supports: Array<'approval_once' | 'native_confirmation' | 'diff_preview' | 'cancellation' | 'structured_evidence' | 'undo'>;
};

export type LocalToolEvidence = {
  observation: CodexObservation;
  summary: string;
  output?: string;
  backupId?: string;
  diffSummary?: string;
};

export type FileSnapshot = {
  content: string;
  sha256: string;
  size: number;
};

type DirectoryEntry = {
  name: string;
  relativePath: string;
  isDirectory: boolean;
  size?: number;
};

const API_URL = import.meta.env.VITE_API_URL?.trim() || 'https://farsiai-api.sorniamir2005.workers.dev';
const TURN_TIMEOUT_MS = 90_000;
const MAX_REMOTE_OUTPUT = 120_000;
const MAX_WRITE_CHARS = 5_000_000;
const SIDE_EFFECT_TOOLS = new Set<CodexToolName>(['write_file', 'create_directory', 'run_command', 'launch_app']);

export const SAFE_DEVELOPMENT_COMMANDS = [
  'npm', 'node', 'git', 'python', 'python3', 'pnpm', 'yarn', 'npx', 'bun', 'deno',
  'cargo', 'rustc', 'go', 'dotnet', 'java', 'javac', 'mvn', 'gradle', 'pytest',
  'pip', 'pip3', 'uv', 'ruff', 'rg',
] as const;

const SAFE_COMMAND_SET = new Set<string>(SAFE_DEVELOPMENT_COMMANDS);

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown, max = 10_000): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= max ? text : null;
}

function boundedText(value: string, max = MAX_REMOTE_OUTPUT): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n…[خروجی برای ایمنی کوتاه شد]`;
}

export function normalizeRelativePath(value: unknown): string {
  if (typeof value !== 'string') throw new Error('مسیر ابزار باید متنی باشد.');
  const input = value.trim().replace(/\\/g, '/');
  if (!input || input === '.') return '.';
  if (input.includes('\0') || input.startsWith('/') || input.startsWith('//') || /^[a-z]:/i.test(input)) {
    throw new Error('Codex فقط اجازه دارد مسیر نسبی داخل Workspace تأییدشده را استفاده کند.');
  }
  const parts = input.split('/').filter((part) => part && part !== '.');
  if (!parts.length) return '.';
  if (parts.some((part) => part === '..')) {
    throw new Error('خروج از مرز Workspace مسدود شد.');
  }
  return parts.join('/');
}

function normalizeArgs(value: unknown, limit: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > limit) throw new Error('آرگومان‌های ابزار معتبر نیستند.');
  return value.map((item) => {
    if (typeof item !== 'string' || item.length > 4_096 || item.includes('\0')) {
      throw new Error('یکی از آرگومان‌های ابزار نامعتبر یا بیش‌ازحد بلند است.');
    }
    return item;
  });
}

function createCallId(value: unknown): string {
  const received = nonEmptyString(value, 128);
  if (received && /^[a-zA-Z0-9._:-]+$/.test(received)) return received;
  return `call-${crypto.randomUUID()}`;
}

export function normalizeCodexTurn(data: unknown, allowedTools: ReadonlySet<CodexToolName>, applications: ApplicationGrant[]): CodexTurnResponse {
  const payload = object(data);
  const requestId = nonEmptyString(payload?.requestId, 256) ?? undefined;
  const model = nonEmptyString(payload?.model, 256) ?? undefined;
  if (!payload) return { ok: false, error: 'پاسخ Codex ساختار معتبری ندارد.', code: 'CODEX_INVALID_RESPONSE' };
  if (payload.ok !== true) {
    return {
      ok: false,
      error: nonEmptyString(payload.error, 4_000) ?? 'Codex نتوانست این مرحله را برنامه‌ریزی کند.',
      code: nonEmptyString(payload.code, 128) ?? 'CODEX_REQUEST_FAILED',
      requestId,
      model,
    };
  }

  if (payload.type === 'final') {
    const message = nonEmptyString(payload.message, 100_000);
    return message
      ? { ok: true, type: 'final', message, requestId, model }
      : { ok: false, error: 'پاسخ نهایی Codex خالی است.', code: 'CODEX_INVALID_FINAL', requestId, model };
  }

  const rawTool = object(payload.tool);
  const rawArgs = object(rawTool?.arguments);
  const name = nonEmptyString(rawTool?.name, 64) as CodexToolName | null;
  if (payload.type !== 'tool' || !rawTool || !rawArgs || !name || !allowedTools.has(name)) {
    return {
      ok: false,
      error: 'Codex ابزاری خارج از مجوزهای فعال درخواست کرد؛ اجرا مسدود شد.',
      code: 'CODEX_TOOL_NOT_ALLOWED',
      requestId,
      model,
    };
  }

  try {
    const callId = createCallId(rawTool.callId ?? payload.callId);
    let tool: CodexToolCall;
    if (name === 'run_command') {
      const command = nonEmptyString(rawArgs.command, 64)?.toLowerCase().replace(/\.(exe|cmd|bat)$/i, '');
      if (!command || !SAFE_COMMAND_SET.has(command)) throw new Error('دستور پیشنهادی در فهرست امن توسعه نیست.');
      tool = { callId, name, arguments: { command, args: normalizeArgs(rawArgs.args, 64), cwd: normalizeRelativePath(rawArgs.cwd ?? '.') } };
    } else if (name === 'launch_app') {
      const applicationId = nonEmptyString(rawArgs.applicationId, 256);
      if (!applicationId || !applications.some((app) => app.appGrantId === applicationId)) {
        throw new Error('برنامه موردنظر قبلاً توسط کاربر تأیید نشده است.');
      }
      tool = { callId, name, arguments: { applicationId, args: normalizeArgs(rawArgs.args, 32) } };
    } else if (name === 'search_files') {
      const query = nonEmptyString(rawArgs.query, 200);
      if (!query) throw new Error('عبارت جست‌وجو خالی است.');
      const requestedMax = typeof rawArgs.maxResults === 'number' ? Math.floor(rawArgs.maxResults) : 40;
      tool = {
        callId,
        name,
        arguments: { path: normalizeRelativePath(rawArgs.path ?? '.'), query, maxResults: Math.max(1, Math.min(100, requestedMax)) },
      };
    } else if (name === 'write_file') {
      if (typeof rawArgs.content !== 'string' || rawArgs.content.length > MAX_WRITE_CHARS) {
        throw new Error('محتوای پیشنهادی فایل نامعتبر یا بزرگ‌تر از ۵ مگابایت است.');
      }
      const expectedSha256 = rawArgs.expectedSha256 === null
        ? null
        : nonEmptyString(rawArgs.expectedSha256, 128) ?? undefined;
      tool = { callId, name, arguments: { path: normalizeRelativePath(rawArgs.path), content: rawArgs.content, expectedSha256 } };
    } else {
      tool = { callId, name, arguments: { path: normalizeRelativePath(rawArgs.path ?? '.') } } as CodexToolCall;
    }
    return { ok: true, type: 'tool', tool, requestId, model };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'پارامترهای ابزار Codex معتبر نیستند.',
      code: 'CODEX_INVALID_TOOL_ARGUMENTS',
      requestId,
      model,
    };
  }
}

export function buildCapabilities(input: {
  enabledTools: CodexToolName[];
  permissionMode: CodexPermissionMode;
  applications: ApplicationGrant[];
}): CodexCapabilities {
  const unique = [...new Set(input.enabledTools)];
  const tools = unique
    .filter((name) => input.permissionMode !== 'read-only' || !SIDE_EFFECT_TOOLS.has(name))
    .map((name): ToolCapability => ({
      name,
      permission: input.permissionMode === 'confirm-all' || SIDE_EFFECT_TOOLS.has(name) ? 'ask' : 'automatic',
    }));
  const toolNames = new Set(tools.map((item) => item.name));
  return {
    protocol: CODEX_PROTOCOL,
    tools,
    safeCommands: toolNames.has('run_command') ? [...SAFE_DEVELOPMENT_COMMANDS] : [],
    approvedApplications: toolNames.has('launch_app')
      ? input.applications.map((app) => ({ id: app.appGrantId, label: app.label }))
      : [],
    permissionMode: input.permissionMode,
    boundary: 'session-workspace-grant',
    supports: ['approval_once', 'native_confirmation', 'diff_preview', 'cancellation', 'structured_evidence', 'undo'],
  };
}

function redactLocalRoot(value: string, workspace: WorkspaceGrant): string {
  if (!workspace.root) return value;
  const escaped = workspace.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return value.replace(new RegExp(escaped, 'gi'), '<workspace>');
}

function remoteObservations(observations: CodexObservation[], workspace: WorkspaceGrant): CodexObservation[] {
  return observations.slice(-40).map((item) => ({
    ...item,
    content: boundedText(redactLocalRoot(item.content, workspace)),
    evidence: { ...item.evidence, backupId: undefined },
  }));
}

async function accessToken(forceRefresh: boolean): Promise<string | undefined> {
  if (!supabase) return undefined;
  if (forceRefresh) {
    const refreshed = await supabase.auth.refreshSession();
    if (!refreshed.error && refreshed.data.session?.access_token) return refreshed.data.session.access_token;
  }
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token;
}

async function postTurn(input: {
  task: string;
  observations: CodexObservation[];
  workspace: WorkspaceGrant;
  capabilities: CodexCapabilities;
  token?: string;
  signal: AbortSignal;
}): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (input.token) headers.authorization = `Bearer ${input.token}`;
  return fetch(`${API_URL}/v2/codex/turn`, {
    method: 'POST',
    headers,
    signal: input.signal,
    body: JSON.stringify({
      task: input.task,
      workspace: { boundary: 'approved-workspace', label: input.workspace.label },
      observations: remoteObservations(input.observations, input.workspace),
      client: { kind: 'desktop', version: CODEX_CLIENT_VERSION, locale: 'fa-IR' },
      capabilities: input.capabilities,
    }),
  });
}

export async function requestCodexTurn(input: {
  task: string;
  observations: CodexObservation[];
  workspace: WorkspaceGrant;
  capabilities: CodexCapabilities;
  signal?: AbortSignal;
}): Promise<CodexTurnResponse> {
  const allowedTools = new Set(input.capabilities.tools.map((item) => item.name));
  const applications = input.capabilities.approvedApplications.map((app) => ({ appGrantId: app.id, label: app.label }));
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(input.signal?.reason);
  if (input.signal) {
    if (input.signal.aborted) controller.abort(input.signal.reason);
    else input.signal.addEventListener('abort', onAbort, { once: true });
  }
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException('Codex turn timed out', 'TimeoutError'));
  }, TURN_TIMEOUT_MS);

  try {
    let token = await accessToken(false);
    let response = await postTurn({ ...input, token, signal: controller.signal });
    if (response.status === 401 && supabase && !controller.signal.aborted) {
      token = await accessToken(true);
      if (token) response = await postTurn({ ...input, token, signal: controller.signal });
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { ok: false, error: `پاسخ Codex قابل‌خواندن نبود (HTTP ${response.status}).`, code: 'CODEX_INVALID_RESPONSE' };
    }
    const normalized = normalizeCodexTurn(payload, allowedTools, applications);
    if (!response.ok && normalized.ok) {
      return { ok: false, error: `سرویس Codex با خطای HTTP ${response.status} پاسخ داد.`, code: 'CODEX_HTTP_ERROR' };
    }
    return normalized;
  } catch (error) {
    if (input.signal?.aborted) return { ok: false, error: 'اجرای Codex توسط کاربر متوقف شد.', code: 'CODEX_ABORTED' };
    if (timedOut) return { ok: false, error: 'پاسخ Codex بیش از حد طول کشید و متوقف شد.', code: 'CODEX_TIMEOUT' };
    return {
      ok: false,
      error: error instanceof Error ? `ارتباط با Codex برقرار نشد: ${error.message}` : 'ارتباط با Codex برقرار نشد.',
      code: 'CODEX_NETWORK_ERROR',
    };
  } finally {
    window.clearTimeout(timeout);
    input.signal?.removeEventListener('abort', onAbort);
  }
}

function validWorkspaceGrant(value: unknown): WorkspaceGrant {
  const payload = object(value);
  if (!payload) throw new Error('انتخاب Workspace لغو شد.');
  const grantId = nonEmptyString(payload.id, 256);
  const label = nonEmptyString(payload.name, 512);
  const root = nonEmptyString(payload.displayPath, 4_096);
  if (!grantId || !label || !root) throw new Error('Native broker مجوز معتبر Workspace برنگرداند.');
  return { grantId, label, root };
}

export async function pickWorkspace(): Promise<WorkspaceGrant> {
  return validWorkspaceGrant(await invoke<unknown>('codex_pick_workspace'));
}

export async function revokeWorkspace(grantId: string): Promise<void> {
  await invoke('codex_revoke_workspace', { workspaceId: grantId });
}

export async function pickApplication(): Promise<ApplicationGrant> {
  const payload = object(await invoke<unknown>('codex_pick_application'));
  if (!payload) throw new Error('انتخاب برنامه لغو شد.');
  const appGrantId = nonEmptyString(payload.id, 256);
  const label = nonEmptyString(payload.name, 512);
  if (!appGrantId || !label) throw new Error('Native broker مجوز معتبر برنامه برنگرداند.');
  return { appGrantId, label };
}

export async function readWorkspaceFile(workspace: WorkspaceGrant, relativePath: string): Promise<FileSnapshot> {
  const payload = object(await invoke<unknown>('codex_read_file', {
    workspaceId: workspace.grantId,
    relativePath: normalizeRelativePath(relativePath),
  }));
  const content = typeof payload?.content === 'string' ? payload.content : null;
  const sha256 = nonEmptyString(payload?.sha256, 128);
  const size = typeof payload?.size === 'number' && Number.isFinite(payload.size) ? payload.size : content?.length;
  if (content === null || !sha256 || size === undefined) throw new Error('خواندن فایل شواهد معتبر برنگرداند.');
  return { content, sha256, size };
}

export async function cancelNativeRun(runId: string): Promise<void> {
  await invoke('codex_cancel_run', { runId });
}

export async function undoCodexChange(workspace: WorkspaceGrant, changeId: string): Promise<void> {
  const payload = object(await invoke<unknown>('codex_undo_change', { workspaceId: workspace.grantId, changeId }));
  if (payload?.operation !== 'undo') {
    throw new Error('Native broker بازگردانی تغییر را تأیید نکرد.');
  }
}

function observation(input: {
  call: CodexToolCall;
  status: EvidenceStatus;
  content: string;
  verified: boolean;
  started: number;
  extra?: Omit<CodexObservation['evidence'], 'verified' | 'durationMs'>;
}): CodexObservation {
  return {
    role: 'tool',
    callId: input.call.callId,
    name: input.call.name,
    status: input.status,
    content: boundedText(input.content),
    evidence: { verified: input.verified, durationMs: Math.max(0, Math.round(performance.now() - input.started)), ...input.extra },
    createdAt: new Date().toISOString(),
  };
}

export function deniedObservation(call: CodexToolCall, reason = 'کاربر این عملیات را تأیید نکرد.'): CodexObservation {
  return observation({ call, status: 'denied', content: reason, verified: false, started: performance.now() });
}

export function cancelledObservation(call: CodexToolCall): CodexObservation {
  return observation({ call, status: 'cancelled', content: 'اجرای این عملیات متوقف شد.', verified: false, started: performance.now() });
}

export async function executeCodexTool(input: {
  call: CodexToolCall;
  workspace: WorkspaceGrant;
  applications: ApplicationGrant[];
  runId: string;
}): Promise<LocalToolEvidence> {
  const { call, workspace } = input;
  const started = performance.now();
  try {
    if (call.name === 'list_directory') {
      const result = await invoke<unknown>('codex_list_directory', {
        workspaceId: workspace.grantId,
        relativePath: call.arguments.path,
      });
      if (!Array.isArray(result)) throw new Error('فهرست پوشه ساختار معتبری ندارد.');
      const entries = result.slice(0, 500).map((item) => {
        const entry = object(item);
        const name = nonEmptyString(entry?.name, 1_024);
        const relativePath = nonEmptyString(entry?.relativePath, 4_096);
        if (!name || !relativePath || typeof entry?.isDirectory !== 'boolean') throw new Error('یکی از ورودی‌های پوشه نامعتبر است.');
        return { name, relativePath, isDirectory: entry.isDirectory, size: typeof entry.size === 'number' ? entry.size : undefined } satisfies DirectoryEntry;
      });
      const content = JSON.stringify(entries);
      return { observation: observation({ call, status: 'success', content, verified: true, started }), summary: `${entries.length} مورد از پوشه خوانده شد.`, output: content };
    }

    if (call.name === 'read_file') {
      const snapshot = await readWorkspaceFile(workspace, call.arguments.path);
      return {
        observation: observation({ call, status: 'success', content: snapshot.content, verified: true, started, extra: { afterSha256: snapshot.sha256 } }),
        summary: `فایل با اثرانگشت ${snapshot.sha256.slice(0, 10)} خوانده شد.`,
        output: snapshot.content,
      };
    }

    if (call.name === 'search_files') {
      const raw = object(await invoke<unknown>('codex_search_workspace', {
        workspaceId: workspace.grantId,
        relativePath: call.arguments.path,
        query: call.arguments.query,
        maxResults: call.arguments.maxResults,
      }));
      const result = raw?.matches;
      if (!Array.isArray(result)) throw new Error('نتیجه جست‌وجو ساختار معتبری ندارد.');
      const content = JSON.stringify(result.slice(0, call.arguments.maxResults));
      return { observation: observation({ call, status: 'success', content, verified: true, started }), summary: `${result.length} نتیجه پیدا شد.`, output: content };
    }

    if (call.name === 'write_file') {
      let expectedSha256 = call.arguments.expectedSha256;
      if (expectedSha256 === undefined) {
        try {
          expectedSha256 = (await readWorkspaceFile(workspace, call.arguments.path)).sha256;
        } catch {
          expectedSha256 = null;
        }
      }
      const result = object(await invoke<unknown>('codex_write_file', {
        workspaceId: workspace.grantId,
        relativePath: call.arguments.path,
        content: call.arguments.content,
        expectedSha256,
        reason: 'اجرای وظیفه تأییدشده کاربر در Codex Studio',
      }));
      const afterSha256 = nonEmptyString(result?.afterSha256, 128);
      const beforeSha256 = result?.beforeSha256 === null ? null : nonEmptyString(result?.beforeSha256, 128);
      const backupId = nonEmptyString(result?.changeId, 256) ?? undefined;
      if (!afterSha256 || !backupId) throw new Error('نوشتن فایل توسط Native broker تأیید و اثبات نشد.');
      const verified = await readWorkspaceFile(workspace, call.arguments.path);
      if (verified.sha256 !== afterSha256 || verified.content !== call.arguments.content) {
        throw new Error('محتوای فایل پس از نوشتن با تغییر پیشنهادی یکسان نیست.');
      }
      const diffSummary = nonEmptyString(result?.diffSummary, 8_000) ?? undefined;
      const content = JSON.stringify({ path: call.arguments.path, beforeSha256, afterSha256, backupAvailable: Boolean(backupId), diffSummary });
      return {
        observation: observation({ call, status: 'success', content, verified: true, started, extra: { beforeSha256, afterSha256, backupId } }),
        summary: 'فایل روی دیسک نوشته و دوباره خوانده شد؛ محتوا یکسان است.',
        backupId,
        diffSummary,
      };
    }

    if (call.name === 'create_directory') {
      const result = object(await invoke<unknown>('codex_create_directory', {
        workspaceId: workspace.grantId,
        relativePath: call.arguments.path,
        reason: 'اجرای وظیفه تأییدشده کاربر در Codex Studio',
      }));
      if (result?.operation !== 'create_directory' || !nonEmptyString(result.changeId, 256)) throw new Error('ساخت پوشه توسط Native broker تأیید نشد.');
      await invoke('codex_list_directory', { workspaceId: workspace.grantId, relativePath: call.arguments.path });
      return { observation: observation({ call, status: 'success', content: `Directory verified: ${call.arguments.path}`, verified: true, started }), summary: 'پوشه ساخته و وجود آن روی دیسک تأیید شد.' };
    }

    if (call.name === 'run_command') {
      const result = object(await invoke<unknown>('codex_run_command', {
        workspaceId: workspace.grantId,
        program: call.arguments.command,
        args: call.arguments.args,
        cwd: call.arguments.cwd,
        runId: input.runId,
        timeoutMs: 120_000,
        reason: 'اجرای تست یا بررسی پروژه توسط Codex Studio',
      }));
      const status = typeof result?.exitCode === 'number' ? result.exitCode : null;
      const stdout = typeof result?.stdout === 'string' ? result.stdout : '';
      const stderr = typeof result?.stderr === 'string' ? result.stderr : '';
      if (status === null || result?.timedOut === true || result?.cancelled === true) throw new Error('اجرای دستور کامل یا قابل‌تأیید نبود.');
      const content = boundedText(`exit=${status}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
      return {
        observation: observation({ call, status: status === 0 ? 'success' : 'error', content, verified: true, started, extra: { exitCode: status, runId: input.runId } }),
        summary: status === 0 ? 'دستور با کد خروج ۰ تمام شد.' : `دستور با کد خروج ${status} ناموفق بود.`,
        output: content,
      };
    }

    const app = input.applications.find((item) => item.appGrantId === call.arguments.applicationId);
    if (!app) throw new Error('مجوز این برنامه در نشست فعلی وجود ندارد.');
    const result = object(await invoke<unknown>('codex_launch_application', {
      applicationId: app.appGrantId,
      args: call.arguments.args,
      reason: 'درخواست تأییدشده کاربر در Codex Studio',
    }));
    if (result?.applicationId !== app.appGrantId || typeof result?.processId !== 'number') throw new Error('Native broker اجرای برنامه را تأیید نکرد.');
    const processId = typeof result.processId === 'number' ? result.processId : undefined;
    const content = JSON.stringify({ application: app.label, launched: true, processId });
    return { observation: observation({ call, status: 'success', content, verified: true, started }), summary: `${app.label} با تأیید کاربر باز شد.` };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'اجرای ابزار محلی ناموفق بود.';
    return {
      observation: observation({ call, status: 'error', content: message, verified: false, started, extra: { runId: call.name === 'run_command' ? input.runId : undefined } }),
      summary: message,
    };
  }
}

export function isSideEffectTool(name: CodexToolName): boolean {
  return SIDE_EFFECT_TOOLS.has(name);
}
