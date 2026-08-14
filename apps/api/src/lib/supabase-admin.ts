import type { Env } from '../types';

type AdminConfig = {
  url: string;
  key: string;
  legacy: boolean;
};

function adminConfig(env: Env): AdminConfig | null {
  const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!env.SUPABASE_URL || !key) return null;

  return {
    url: env.SUPABASE_URL.replace(/\/$/, ''),
    key,
    legacy: !key.startsWith('sb_secret_'),
  };
}

function adminHeaders(config: AdminConfig, init: RequestInit): Headers {
  const headers = new Headers(init.headers);
  headers.set('apikey', config.key);
  headers.set('accept', 'application/json');
  if (config.legacy) headers.set('authorization', `Bearer ${config.key}`);
  if (init.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return headers;
}

/** Calls Supabase Data API with the server-side secret/service-role key. */
export function supabaseAdminFetch(
  env: Env,
  path: string,
  init: RequestInit = {},
): Promise<Response> | null {
  const config = adminConfig(env);
  if (!config) return null;
  return fetch(`${config.url}/rest/v1/${path}`, { ...init, headers: adminHeaders(config, init) });
}

/** Calls Supabase Storage API from the Worker only. */
export function supabaseStorageAdminFetch(
  env: Env,
  path: string,
  init: RequestInit = {},
): Promise<Response> | null {
  const config = adminConfig(env);
  if (!config) return null;
  const normalized = path.replace(/^\/+/, '');
  return fetch(`${config.url}/storage/v1/${normalized}`, { ...init, headers: adminHeaders(config, init) });
}

/**
 * Calls Supabase Auth Admin API from the Worker only.
 * The secret/service-role key never leaves the server and is never embedded in the admin page.
 */
export function supabaseAuthAdminFetch(
  env: Env,
  path: string,
  init: RequestInit = {},
): Promise<Response> | null {
  const config = adminConfig(env);
  if (!config) return null;
  const normalized = path.replace(/^\/+/, '');
  return fetch(`${config.url}/auth/v1/admin/${normalized}`, { ...init, headers: adminHeaders(config, init) });
}
