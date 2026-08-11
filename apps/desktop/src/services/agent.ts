import { normalizeAgentRelativePath } from '../lib/agentPath';
import { supabase } from '../lib/supabase';

export type AgentObservation = {
  role: string;
  name?: string;
  content: string;
};

export type AgentToolCall =
  | { name: 'list_directory'; arguments: { path: string } }
  | { name: 'read_file'; arguments: { path: string } }
  | { name: 'write_file'; arguments: { path: string; content: string } }
  | { name: 'run_command'; arguments: { command: string; args: string[] } };

type AgentResponseMeta = {
  model?: string;
  requestId?: string;
  code?: string;
};

export type AgentPlanResponse =
  | ({ ok: true; type: 'tool'; tool: AgentToolCall } & AgentResponseMeta)
  | ({ ok: true; type: 'final'; message: string } & AgentResponseMeta)
  | ({ ok: false; error: string } & AgentResponseMeta);

const API_URL = import.meta.env.VITE_API_URL?.trim() || 'https://farsiai-api.sorniamir2005.workers.dev';
const CLIENT_VERSION = '0.4.7-codex-pro';
const REQUEST_TIMEOUT_MS = 90_000;

function normalizePlan(data: AgentPlanResponse): AgentPlanResponse {
  if (!data.ok || data.type !== 'tool' || !('path' in data.tool.arguments)) return data;

  try {
    return {
      ...data,
      tool: {
        ...data.tool,
        arguments: {
          ...data.tool.arguments,
          path: normalizeAgentRelativePath(String(data.tool.arguments.path ?? '.')),
        },
      } as AgentToolCall,
    };
  } catch {
    return {
      ok: false,
      error: 'Codex مسیر نامعتبر یا خارج از Workspace برگرداند.',
      code: 'CODEX_INVALID_TOOL_PATH',
      requestId: data.requestId,
    };
  }
}

async function accessToken(forceRefresh = false): Promise<string | undefined> {
  if (!supabase) return undefined;
  if (forceRefresh) {
    const { data, error } = await supabase.auth.refreshSession();
    if (!error && data.session?.access_token) return data.session.access_token;
  }
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token;
}

function createRequestSignal(parent?: AbortSignal): { signal: AbortSignal; cleanup: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let timeoutTriggered = false;
  const onAbort = () => controller.abort(parent?.reason);
  if (parent) {
    if (parent.aborted) controller.abort(parent.reason);
    else parent.addEventListener('abort', onAbort, { once: true });
  }
  const timeout = window.setTimeout(() => {
    timeoutTriggered = true;
    controller.abort(new DOMException('Codex request timeout', 'TimeoutError'));
  }, REQUEST_TIMEOUT_MS);

  return {
    signal: controller.signal,
    timedOut: () => timeoutTriggered,
    cleanup: () => {
      window.clearTimeout(timeout);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

async function postPlan(input: {
  task: string;
  workspace: string;
  observations: AgentObservation[];
  token?: string;
  signal: AbortSignal;
}): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-farsiai-client': `desktop/${CLIENT_VERSION}`,
  };
  if (input.token) headers.authorization = `Bearer ${input.token}`;

  return fetch(`${API_URL}/v1/agent/plan`, {
    method: 'POST',
    headers,
    signal: input.signal,
    body: JSON.stringify({
      task: input.task,
      // Never upload the real local filesystem path. The Worker only needs a virtual boundary label.
      workspace: 'approved-workspace',
      observations: input.observations,
      clientVersion: CLIENT_VERSION,
    }),
  });
}

async function parseResponse(response: Response): Promise<AgentPlanResponse> {
  try {
    const data = (await response.json()) as AgentPlanResponse;
    if (!response.ok && !('error' in data)) {
      return {
        ok: false,
        error: `Codex planner با خطای HTTP ${response.status} پاسخ داد.`,
        code: 'CODEX_HTTP_ERROR',
      };
    }
    return normalizePlan(data);
  } catch {
    return {
      ok: false,
      error: `پاسخ Codex planner معتبر نبود (HTTP ${response.status}).`,
      code: 'CODEX_INVALID_RESPONSE',
    };
  }
}

export async function planAgentStep(input: {
  task: string;
  workspace: string;
  observations: AgentObservation[];
  signal?: AbortSignal;
}): Promise<AgentPlanResponse> {
  const requestSignal = createRequestSignal(input.signal);

  try {
    let token = await accessToken(false);
    let response = await postPlan({
      task: input.task,
      workspace: input.workspace,
      observations: input.observations,
      token,
      signal: requestSignal.signal,
    });

    // Desktop sessions can live for hours. If Supabase rotated the access token, refresh once
    // and replay the planner step instead of making Codex appear randomly broken.
    if (response.status === 401 && supabase && !requestSignal.signal.aborted) {
      token = await accessToken(true);
      if (token) {
        response = await postPlan({
          task: input.task,
          workspace: input.workspace,
          observations: input.observations,
          token,
          signal: requestSignal.signal,
        });
      }
    }

    return await parseResponse(response);
  } catch (error) {
    if (input.signal?.aborted) throw error;
    if (requestSignal.timedOut()) {
      return {
        ok: false,
        error: 'پاسخ Codex بیش از حد طول کشید. درخواست متوقف شد؛ دوباره اجرا کنید.',
        code: 'CODEX_TIMEOUT',
      };
    }
    return {
      ok: false,
      error: error instanceof Error ? `ارتباط با Codex برقرار نشد: ${error.message}` : 'ارتباط با Codex برقرار نشد.',
      code: 'CODEX_NETWORK_ERROR',
    };
  } finally {
    requestSignal.cleanup();
  }
}
