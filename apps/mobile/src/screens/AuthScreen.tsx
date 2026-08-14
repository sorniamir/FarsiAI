import React, { useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { isSupabaseConfigured } from '../lib/supabase';
import { requestPasswordReset, resendEmailConfirmation, signIn, signUp } from '../services/auth';
import { useAppTheme } from '../ThemeProvider';
import type { AppTheme } from '../theme';

export function AuthScreen({ onDone, onGuest }: { onDone: () => void; onGuest: () => void }) {
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function submit() {
    if (!email.trim() || password.length < 6) {
      setMessage('ایمیل معتبر و رمز حداقل ۶ کاراکتری وارد کن.');
      return;
    }
    setBusy(true);
    setMessage('');
    const result = mode === 'login' ? await signIn(email, password) : await signUp(email, password);
    setBusy(false);
    if (!result.ok) return setMessage(result.message);
    if (result.needsEmailConfirmation) {
      setMessage('لینک تأیید برای ایمیل ارسال شد. بعد از تأیید وارد شو.');
      setMode('login');
      return;
    }
    onDone();
  }

  async function forgotPassword() {
    if (busy) return;
    setBusy(true);
    setMessage('');
    const result = await requestPasswordReset(email);
    setBusy(false);
    setMessage(result.ok
      ? 'لینک امن بازیابی رمز ارسال شد. ایمیلت را باز کن و رمز جدید بساز.'
      : result.message);
  }

  async function resendVerification() {
    if (busy) return;
    setBusy(true);
    setMessage('');
    const result = await resendEmailConfirmation(email);
    setBusy(false);
    setMessage(result.ok
      ? 'ایمیل تأیید جدید ارسال شد. پوشه Spam را هم بررسی کن.'
      : result.message);
  }

  return (
    <View style={styles.container}>
      <View style={styles.brandOrb}><Text style={styles.spark}>✦</Text></View>
      <Text style={styles.eyebrow}>FARSIAI ACCOUNT</Text>
      <Text style={styles.title}>{mode === 'login' ? 'خوش برگشتی' : 'حساب FarsiAI بساز'}</Text>
      <Text style={styles.subtitle}>گفتگوها، تصاویر، اعتبار و تنظیماتت را امن بین دستگاه‌ها نگه دار.</Text>

      {!isSupabaseConfigured && (
        <View style={styles.devNotice}>
          <Text style={styles.devText}>حساب آنلاین هنوز به پروژه Supabase متصل نشده؛ حالت مهمان برای تست کامل UI فعال است.</Text>
        </View>
      )}

      <View style={styles.formCard}>
        <TextInput
          style={styles.input}
          placeholder="ایمیل"
          placeholderTextColor={theme.colors.textDim}
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoCapitalize="none"
          autoComplete="email"
          textAlign="left"
        />
        <TextInput
          style={styles.input}
          placeholder="رمز عبور"
          placeholderTextColor={theme.colors.textDim}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          textAlign="left"
          onSubmitEditing={submit}
        />

        {mode === 'login' ? (
          <View style={styles.recoveryRow}>
            <TouchableOpacity onPress={forgotPassword} disabled={busy} hitSlop={8}>
              <Text style={styles.recoveryLink}>رمز را فراموش کردم</Text>
            </TouchableOpacity>
            <Text style={styles.recoveryDot}>•</Text>
            <TouchableOpacity onPress={resendVerification} disabled={busy} hitSlop={8}>
              <Text style={styles.recoveryLink}>ارسال مجدد تأیید</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {message ? <Text style={styles.message}>{message}</Text> : null}

        <TouchableOpacity style={styles.primary} onPress={submit} disabled={busy} activeOpacity={0.86}>
          {busy ? <ActivityIndicator color={theme.colors.onAccent} /> : <Text style={styles.primaryText}>{mode === 'login' ? 'ورود امن' : 'ساخت حساب'}</Text>}
        </TouchableOpacity>

        <TouchableOpacity style={styles.secondary} onPress={() => { setMode(mode === 'login' ? 'signup' : 'login'); setMessage(''); }} disabled={busy}>
          <Text style={styles.secondaryText}>{mode === 'login' ? 'حساب ندارم — ثبت‌نام' : 'حساب دارم — ورود'}</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.divider}><View style={styles.line} /><Text style={styles.or}>یا</Text><View style={styles.line} /></View>

      <TouchableOpacity style={styles.guest} onPress={onGuest} activeOpacity={0.8} disabled={busy}>
        <Text style={styles.guestText}>ادامه به‌عنوان مهمان</Text>
        <Text style={styles.guestMeta}>۵ Chat + ۲ Image روزانه</Text>
      </TouchableOpacity>
      <Text style={styles.note}>بازیابی رمز از صفحه امن FarsiAI انجام می‌شود و رمز عبور در سرور برنامه ذخیره نمی‌شود.</Text>
    </View>
  );
}

const createStyles = (theme: AppTheme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background, paddingHorizontal: 24, justifyContent: 'center' },
  brandOrb: { width: 68, height: 68, borderRadius: 24, alignSelf: 'center', alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.accentSoft, borderWidth: 1, borderColor: theme.colors.borderStrong, marginBottom: 10 },
  spark: { textAlign: 'center', color: theme.colors.primaryBright, fontSize: 38, lineHeight: 44 },
  eyebrow: { textAlign: 'center', color: theme.colors.primaryBright, fontSize: 10, fontWeight: '900', letterSpacing: 2.1, marginBottom: 7 },
  title: { color: theme.colors.text, textAlign: 'center', fontSize: 29, fontWeight: '900', writingDirection: 'rtl' },
  subtitle: { color: theme.colors.textMuted, textAlign: 'center', lineHeight: 23, marginTop: 8, marginBottom: 23, writingDirection: 'rtl' },
  devNotice: { backgroundColor: 'rgba(34,211,238,0.08)', borderColor: 'rgba(34,211,238,0.22)', borderWidth: 1, borderRadius: 16, padding: 12, marginBottom: 16 },
  devText: { color: theme.colors.cyan, fontSize: 12, textAlign: 'right', lineHeight: 19, writingDirection: 'rtl' },
  formCard: { backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 24, padding: 14 },
  input: { color: theme.colors.text, backgroundColor: theme.colors.surfaceRaised, borderColor: theme.colors.border, borderWidth: 1, borderRadius: 17, paddingHorizontal: 16, paddingVertical: 15, marginBottom: 10, fontSize: 15 },
  recoveryRow: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'flex-start', gap: 9, paddingHorizontal: 5, paddingBottom: 11 },
  recoveryLink: { color: theme.colors.primaryBright, fontSize: 11, fontWeight: '800' },
  recoveryDot: { color: theme.colors.textDim, fontSize: 11 },
  message: { color: theme.colors.warning, textAlign: 'right', marginBottom: 10, paddingHorizontal: 3, fontSize: 12, lineHeight: 19, writingDirection: 'rtl' },
  primary: { height: 54, borderRadius: 17, backgroundColor: theme.colors.primary, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  primaryText: { color: theme.colors.onAccent, fontWeight: '900', fontSize: 16 },
  secondary: { alignItems: 'center', paddingTop: 15, paddingBottom: 4 },
  secondaryText: { color: theme.colors.primaryBright, fontWeight: '800' },
  divider: { flexDirection: 'row', alignItems: 'center', gap: 12, marginVertical: 15 },
  line: { flex: 1, height: 1, backgroundColor: theme.colors.border },
  or: { color: theme.colors.textDim, fontSize: 12 },
  guest: { minHeight: 56, borderRadius: 18, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface, alignItems: 'center', justifyContent: 'center', paddingVertical: 9 },
  guestText: { color: theme.colors.text, fontWeight: '800' },
  guestMeta: { color: theme.colors.textDim, fontSize: 10, marginTop: 2 },
  note: { color: theme.colors.textDim, textAlign: 'center', fontSize: 10, lineHeight: 17, marginTop: 13, paddingHorizontal: 8, writingDirection: 'rtl' },
});
