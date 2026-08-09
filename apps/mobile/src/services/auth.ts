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
  const { data, error } = await supabase.auth.signUp({ email: email.trim(), password });
  if (error) return { ok: false, message: error.message };
  return { ok: true, needsEmailConfirmation: !data.session };
}

export async function signOut(): Promise<void> {
  if (supabase) await supabase.auth.signOut();
}

export async function hasActiveSession(): Promise<boolean> {
  if (!supabase) return false;
  const { data } = await supabase.auth.getSession();
  return Boolean(data.session);
}
