import type { Env } from '../types';

export type VerifiedUser = {
  id: string;
  email?: string;
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

  const payload = (await response.json()) as { id?: unknown; email?: unknown };
  if (typeof payload.id !== 'string' || !payload.id) return { kind: 'invalid' };

  return {
    kind: 'user',
    user: {
      id: payload.id,
      email: typeof payload.email === 'string' ? payload.email : undefined,
    },
  };
}
