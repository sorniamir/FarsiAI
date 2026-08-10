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

export type AgentPlanResponse =
  | { ok: true; type: 'tool'; tool: AgentToolCall }
  | { ok: true; type: 'final'; message: string }
  | { ok: false; error: string };

const API_URL = import.meta.env.VITE_API_URL?.trim() || 'http://127.0.0.1:8787';

export async function planAgentStep(input: {
  task: string;
  workspace: string;
  observations: AgentObservation[];
}): Promise<AgentPlanResponse> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };

  if (supabase) {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (token) headers.authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_URL}/v1/agent/plan`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      task: input.task,
      workspace: 'approved-workspace',
      observations: input.observations,
    }),
  });

  try {
    const data = (await response.json()) as AgentPlanResponse;
    if (!response.ok && !('error' in data)) {
      return { ok: false, error: 'Codex planner در دسترس نیست.' };
    }
    return data;
  } catch {
    return { ok: false, error: 'پاسخ Codex planner معتبر نبود.' };
  }
}
