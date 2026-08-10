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
  const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
  if (error) return { ok: false, message: error.message };
  if (!data.user?.email_confirmed_at) {
    await supabase.auth.signOut();
    return { ok: false, message: 'ابتدا لینک تأیید ارسال‌شده به ایمیلت را باز کن.' };
  }
  return { ok: true };
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
      if (error) return { ok: false, message: error.message };
      return (await hasActiveSession())
        ? { ok: true }
        : { ok: false, message: 'تأیید ایمیل کامل نشد. لینک جدید درخواست کن.' };
    }

    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token');
    if (!accessToken || !refreshToken) {
      return { ok: false, message: 'لینک تأیید معتبر نیست یا منقضی شده است.' };
    }
    const { error } = await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
    if (error) return { ok: false, message: error.message };
    return (await hasActiveSession())
      ? { ok: true }
      : { ok: false, message: 'تأیید ایمیل کامل نشد. لینک جدید درخواست کن.' };
  } catch {
    return { ok: false, message: 'باز کردن لینک تأیید انجام نشد. دوباره درخواست تأیید بده.' };
  }
}

export async function signOut(): Promise<void> {
  if (supabase) await supabase.auth.signOut();
}

export async function hasActiveSession(): Promise<boolean> {
  if (!supabase) return false;
  const { data, error } = await supabase.auth.getUser();
  const verified = !error && Boolean(data.user?.email_confirmed_at);
  if (!verified) await supabase.auth.signOut();
  return verified;
}

export async function getCurrentUserEmail(): Promise<string | undefined> {
  if (!supabase) return undefined;
  const { data } = await supabase.auth.getUser();
  return data.user?.email ?? undefined;
}
