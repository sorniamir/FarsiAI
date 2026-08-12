import type { Env } from '../types';

export type VerifiedUser = {
  id: string;
  email?: string;
  banned?: boolean;
  bannedUntil?: string;
  appMetadata?: Record<string, unknown>;
};

export type AuthResult =
  | { kind: 'guest' }
  | { kind: 'user'; user: VerifiedUser }
  | { kind: 'invalid' }
  | { kind: 'unconfigured' };

function bearerToken(request: Request): string | null {
  const value = request.headers.get('authorization')?.trim();
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1]?.trim() || null;
}

function isFuture(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && time > Date.now();
}

export async function resolveAuth(request: Request, env: Env): Promise<AuthResult> {
  const token = bearerToken(request);
  if (!token) return { kind: 'guest' };

  if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) {
    return { kind: 'unconfigured' };
  }

  const endpoint = `${env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/user`;
  const response = await fetch(endpoint, {
    headers: {
      apikey: env.SUPABASE_PUBLISHABLE_KEY,
      authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) return { kind: 'invalid' };

  const payload = (await response.json()) as {
    id?: unknown;
    email?: unknown;
    banned_until?: unknown;
    app_metadata?: unknown;
  };
  if (typeof payload.id !== 'string' || !payload.id) return { kind: 'invalid' };

  const appMetadata = payload.app_metadata && typeof payload.app_metadata === 'object' && !Array.isArray(payload.app_metadata)
    ? payload.app_metadata as Record<string, unknown>
    : {};
  const bannedUntil = isFuture(payload.banned_until) ? payload.banned_until : undefined;
  const banned = appMetadata.farsiai_banned === true || !!bannedUntil;

  return {
    kind: 'user',
    user: {
      id: payload.id,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      banned,
      bannedUntil,
      appMetadata,
    },
  };
}
