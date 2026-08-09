import { isSupabaseConfigured, supabase } from '../lib/supabase';

export type AuthResult = { ok: true; needsEmailConfirmation?: boolean } | { ok: false; message: string };

function unavailable(): AuthResult {
  return {
    ok: false,
    message: 'اتصال حساب کاربری هنوز روی سرور فعال نشده. فعلاً می‌توانید با حالت مهمان وارد شوید.',
  };
}

export async function signIn(email: string, password: string): Promise<AuthResult> {
  if (!isSupabaseConfigured || !supabase) return unavailable();
  const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
  return error ? { ok: false, message: error.message } : { ok: true };
}

export async function signUp(email: string, password: string): Promise<AuthResult> {
  if (!isSupabaseConfigured || !supabase) return unavailable();
  const { data, error } = await supabase.auth.signUp({
    email: email.trim(),
    password,
    options: { emailRedirectTo: 'farsiai://auth/callback' },
  });
  if (error) return { ok: false, message: error.message };
  return { ok: true, needsEmailConfirmation: !data.session };
}

export async function createSessionFromUrl(url: string): Promise<AuthResult> {
  if (!supabase) return unavailable();
  try {
    const query = url.includes('#') ? url.split('#')[1] : url.split('?')[1] ?? '';
    const params = new URLSearchParams(query);
    const errorDescription = params.get('error_description');
    if (errorDescription) return { ok: false, message: decodeURIComponent(errorDescription) };

    const code = params.get('code');
    if (code) {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      return error ? { ok: false, message: error.message } : { ok: true };
    }

    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token');
    if (!accessToken || !refreshToken) {
      return { ok: false, message: 'لینک تأیید معتبر نیست یا منقضی شده است.' };
    }
    const { error } = await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
    return error ? { ok: false, message: error.message } : { ok: true };
  } catch {
    return { ok: false, message: 'باز کردن لینک تأیید انجام نشد. دوباره درخواست تأیید بده.' };
  }
}

export async function signOut(): Promise<void> {
  if (supabase) await supabase.auth.signOut();
}

export async function hasActiveSession(): Promise<boolean> {
  if (!supabase) return false;
  const { data } = await supabase.auth.getSession();
  return Boolean(data.session);
}
