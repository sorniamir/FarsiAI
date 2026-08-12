import type { Env } from '../types';

export function corsHeaders(env: Env): HeadersInit {
  return {
    'access-control-allow-origin': env.ALLOWED_ORIGIN || '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization,x-farsiai-client,x-farsiai-codex-protocol',
    'cache-control': 'no-store',
  };
}

export function json(env: Env, body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: corsHeaders(env) });
}
