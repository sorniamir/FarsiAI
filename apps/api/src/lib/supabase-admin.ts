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

/**
 * Calls Supabase's Data API with an elevated server-side key.
 *
 * New `sb_secret_...` keys are sent only in `apikey`. Legacy service-role
 * JWTs also need to be sent as a bearer token so PostgREST receives the
 * `service_role` database role and bypasses RLS as intended.
 */
export function supabaseAdminFetch(
  env: Env,
  path: string,
  init: RequestInit = {},
): Promise<Response> | null {
  const config = adminConfig(env);
  if (!config) return null;

  const headers = new Headers(init.headers);
  headers.set('apikey', config.key);
  headers.set('accept', 'application/json');

  if (config.legacy) {
    headers.set('authorization', `Bearer ${config.key}`);
  }

  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  return fetch(`${config.url}/rest/v1/${path}`, { ...init, headers });
}
