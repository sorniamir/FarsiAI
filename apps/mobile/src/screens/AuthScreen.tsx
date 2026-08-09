import React, { useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { isSupabaseConfigured } from '../lib/supabase';
import { signIn, signUp } from '../services/auth';
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

  return (
    <View style={styles.container}>
      <Text style={styles.spark}>✦</Text>
      <Text style={styles.title}>{mode === 'login' ? 'خوش برگشتی' : 'حساب FarsiAI بساز'}</Text>
      <Text style={styles.subtitle}>گفتگوها، اعتبار و تنظیماتت را بین دستگاه‌ها نگه دار.</Text>

      {!isSupabaseConfigured && (
        <View style={styles.devNotice}>
          <Text style={styles.devText}>حساب آنلاین هنوز به پروژه Supabase متصل نشده؛ حالت مهمان برای تست کامل UI فعال است.</Text>
        </View>
      )}

      <TextInput
        style={styles.input}
        placeholder="ایمیل"
        placeholderTextColor={theme.colors.textDim}
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        autoCapitalize="none"
        textAlign="left"
      />
      <TextInput
        style={styles.input}
        placeholder="رمز عبور"
        placeholderTextColor={theme.colors.textDim}
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        textAlign="left"
      />

      {message ? <Text style={styles.message}>{message}</Text> : null}

      <TouchableOpacity style={styles.primary} onPress={submit} disabled={busy} activeOpacity={0.86}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>{mode === 'login' ? 'ورود' : 'ساخت حساب'}</Text>}
      </TouchableOpacity>

      <TouchableOpacity style={styles.secondary} onPress={() => { setMode(mode === 'login' ? 'signup' : 'login'); setMessage(''); }}>
        <Text style={styles.secondaryText}>{mode === 'login' ? 'حساب ندارم — ثبت‌نام' : 'حساب دارم — ورود'}</Text>
      </TouchableOpacity>

      <View style={styles.divider}><View style={styles.line} /><Text style={styles.or}>یا</Text><View style={styles.line} /></View>

      <TouchableOpacity style={styles.guest} onPress={onGuest} activeOpacity={0.8}>
        <Text style={styles.guestText}>ادامه به‌عنوان مهمان</Text>
      </TouchableOpacity>
      <Text style={styles.note}>ورود با Google و Apple در مرحله بعد روی همین Auth Layer اضافه می‌شود.</Text>
    </View>
  );
}

const createStyles = (theme: AppTheme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background, padding: 24, justifyContent: 'center' },
  spark: { textAlign: 'center', color: theme.colors.cyan, fontSize: 54, marginBottom: 10 },
  title: { color: theme.colors.text, textAlign: 'center', fontSize: 28, fontWeight: '900', writingDirection: 'rtl' },
  subtitle: { color: theme.colors.textMuted, textAlign: 'center', lineHeight: 23, marginTop: 8, marginBottom: 24, writingDirection: 'rtl' },
  devNotice: { backgroundColor: 'rgba(34,211,238,0.08)', borderColor: 'rgba(34,211,238,0.22)', borderWidth: 1, borderRadius: 16, padding: 12, marginBottom: 16 },
  devText: { color: theme.colors.cyan, fontSize: 12, textAlign: 'right', lineHeight: 19, writingDirection: 'rtl' },
  input: { color: theme.colors.text, backgroundColor: theme.colors.surfaceRaised, borderColor: theme.colors.border, borderWidth: 1, borderRadius: 18, paddingHorizontal: 16, paddingVertical: 15, marginBottom: 11, fontSize: 15 },
  message: { color: theme.colors.warning, textAlign: 'right', marginBottom: 10, fontSize: 12, writingDirection: 'rtl' },
  primary: { height: 54, borderRadius: 18, backgroundColor: theme.colors.primary, alignItems: 'center', justifyContent: 'center', marginTop: 3 },
  primaryText: { color: theme.colors.onAccent, fontWeight: '900', fontSize: 16 },
  secondary: { alignItems: 'center', paddingVertical: 15 },
  secondaryText: { color: theme.colors.primaryBright, fontWeight: '800' },
  divider: { flexDirection: 'row', alignItems: 'center', gap: 12, marginVertical: 5 },
  line: { flex: 1, height: 1, backgroundColor: theme.colors.border },
  or: { color: theme.colors.textDim, fontSize: 12 },
  guest: { borderRadius: 18, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface, alignItems: 'center', paddingVertical: 15 },
  guestText: { color: theme.colors.text, fontWeight: '800' },
  note: { color: theme.colors.textDim, textAlign: 'center', fontSize: 11, lineHeight: 18, marginTop: 13, writingDirection: 'rtl' },
});
