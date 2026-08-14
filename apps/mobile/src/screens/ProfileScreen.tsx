import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useAppTheme } from '../ThemeProvider';
import type { AppTheme } from '../theme';
import type { DailyQuota } from '../types';
import type { AccountPlan } from '../services/account';

export function ProfileScreen({
  isGuest,
  email,
  quota,
  plan,
  onSignOut,
}: {
  isGuest: boolean;
  email?: string;
  quota: DailyQuota;
  plan: AccountPlan;
  onSignOut: () => void;
}) {
  const { theme, mode, toggle } = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const unlimited = !isGuest && (plan === 'pro' || plan === 'admin' || quota.unlimited === true);
  const planLabel = isGuest ? 'GUEST' : plan === 'admin' ? 'ADMIN' : plan === 'pro' ? 'PRO' : 'FREE';
  const heroSub = isGuest
    ? 'جلسه محلی بدون Sync حساب'
    : unlimited
      ? 'عضویت Premium فعال است'
      : 'حساب رایگان FarsiAI';

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <View style={styles.ambientOne} pointerEvents="none" />
      <View style={styles.ambientTwo} pointerEvents="none" />

      <View style={styles.hero}>
        <View style={styles.avatarRing}>
          <View style={styles.avatar}><Text style={styles.avatarText}>✦</Text></View>
        </View>
        <View style={styles.planBadge}><Text style={styles.planBadgeText}>{planLabel}</Text></View>
        <Text style={styles.name}>{isGuest ? 'کاربر مهمان' : 'حساب FarsiAI'}</Text>
        <Text style={styles.plan}>{heroSub}</Text>
        {!isGuest && email ? <Text style={styles.email}>{email}</Text> : null}
      </View>

      <View style={[styles.membershipCard, unlimited && styles.membershipActive]}>
        <View style={styles.membershipTop}>
          <View style={styles.membershipCopy}>
            <Text style={styles.eyebrow}>{unlimited ? 'MEMBERSHIP ACTIVE' : 'MEMBERSHIP'}</Text>
            <Text style={styles.membershipTitle}>{unlimited ? 'FarsiAI Pro' : isGuest ? 'Guest Access' : 'FarsiAI Free'}</Text>
            <Text style={styles.membershipDescription}>
              {unlimited
                ? 'سقف روزانه Chat و Image برای این حساب برداشته شده است؛ محدودیت‌های ایمنی و Rate Limit همچنان فعال‌اند.'
                : isGuest
                  ? 'برای Sync تاریخچه و سهمیه حساب، وارد FarsiAI شوید.'
                  : 'پلن رایگان فعال است. زیرساخت Pro آماده است و اتصال پرداخت در مرحله نهایی فعال می‌شود.'}
            </Text>
          </View>
          <View style={[styles.membershipOrb, unlimited && styles.membershipOrbActive]}><Text style={styles.membershipOrbText}>◆</Text></View>
        </View>

        <View style={styles.metrics}>
          <Metric label="Chat" value={unlimited ? 'نامحدود' : `${quota.chatRemaining}`} />
          <Metric label="Image" value={unlimited ? 'نامحدود' : `${quota.imageRemaining}`} />
          <Metric label="Status" value={unlimited ? 'Premium' : 'Standard'} />
        </View>
      </View>

      {!unlimited ? (
        <View style={styles.upgradeCard}>
          <View style={styles.upgradeHead}>
            <View style={styles.recommended}><Text style={styles.recommendedText}>RECOMMENDED</Text></View>
            <Text style={styles.upgradeTitle}>FarsiAI Pro</Text>
            <Text style={styles.upgradeSubtitle}>نسخه آماده فروش اشتراک</Text>
          </View>
          <FeatureLine text="بدون سقف روزانه Chat" />
          <FeatureLine text="بدون سقف روزانه Image" />
          <FeatureLine text="همان حساب روی Mobile و Desktop" />
          <FeatureLine text="کنترل کامل Plan از Admin Center" />
          <TouchableOpacity style={styles.upgradeButton} activeOpacity={0.82} disabled>
            <Text style={styles.upgradeButtonText}>اتصال پرداخت در مرحله نهایی</Text>
          </TouchableOpacity>
          <Text style={styles.upgradeNote}>در این Release Candidate هیچ پرداخت یا برداشت وجهی انجام نمی‌شود.</Text>
        </View>
      ) : (
        <View style={styles.activeCard}>
          <Text style={styles.activeIcon}>✓</Text>
          <View style={styles.activeCopy}>
            <Text style={styles.activeTitle}>Premium entitlement تأیید شد</Text>
            <Text style={styles.activeSub}>این وضعیت از Plan واقعی حساب خوانده می‌شود و با Admin Control Center هماهنگ است.</Text>
          </View>
        </View>
      )}

      <View style={styles.menu}>
        <TouchableOpacity style={styles.themeRow} onPress={toggle} activeOpacity={0.8}>
          <View style={styles.rowIcon}><Text style={styles.rowIconText}>{mode === 'dark' ? '☾' : '☀'}</Text></View>
          <View style={styles.rowCopy}>
            <Text style={styles.rowTitle}>ظاهر برنامه</Text>
            <Text style={styles.rowSub}>{mode === 'dark' ? 'مشکی مات و سینمایی' : 'Light mode حرفه‌ای'}</Text>
          </View>
          <View style={[styles.switch, mode === 'light' && styles.switchLight]}><View style={[styles.switchDot, mode === 'light' && styles.switchDotLight]} /></View>
        </TouchableOpacity>
        <Row icon="◈" title="عضویت و دسترسی" subtitle={`${planLabel} • وضعیت واقعی حساب`} />
        <Row icon="⚙" title="تنظیمات" subtitle="زبان، ظاهر و ترجیحات پاسخ" />
        <Row icon="◌" title="حریم خصوصی" subtitle="مدیریت داده‌ها و تاریخچه" />
        <Row icon="?" title="راهنما و پشتیبانی" subtitle="گزارش مشکل و دریافت کمک" />
      </View>

      <TouchableOpacity style={styles.logout} onPress={onSignOut} activeOpacity={0.8}>
        <Text style={styles.logoutText}>{isGuest ? 'خروج از حالت مهمان' : 'خروج از حساب'}</Text>
      </TouchableOpacity>
      <Text style={styles.version}>FarsiAI v0.6.0 • Commercial RC</Text>
    </ScrollView>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return <View style={styles.metric}><Text style={styles.metricValue}>{value}</Text><Text style={styles.metricLabel}>{label}</Text></View>;
}

function FeatureLine({ text }: { text: string }) {
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return <View style={styles.featureLine}><View style={styles.featureCheck}><Text style={styles.featureCheckText}>✓</Text></View><Text style={styles.featureText}>{text}</Text></View>;
}

function Row({ icon, title, subtitle }: { icon: string; title: string; subtitle: string }) {
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <TouchableOpacity style={styles.row} activeOpacity={0.75}>
      <View style={styles.rowIcon}><Text style={styles.rowIconText}>{icon}</Text></View>
      <View style={styles.rowCopy}><Text style={styles.rowTitle}>{title}</Text><Text style={styles.rowSub}>{subtitle}</Text></View>
      <Text style={styles.chev}>‹</Text>
    </TouchableOpacity>
  );
}

const createStyles = (theme: AppTheme) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: 20, paddingBottom: 36, overflow: 'hidden' },
  ambientOne: { position: 'absolute', width: 260, height: 260, borderRadius: 130, top: -150, right: -110, backgroundColor: theme.colors.accentSoft, opacity: theme.mode === 'dark' ? 0.75 : 0.4 },
  ambientTwo: { position: 'absolute', width: 180, height: 180, borderRadius: 90, top: 260, left: -120, backgroundColor: theme.colors.accentSoft, opacity: theme.mode === 'dark' ? 0.34 : 0.2 },
  hero: { alignItems: 'center', paddingTop: 15, paddingBottom: 22 },
  avatarRing: { width: 86, height: 86, borderRadius: 30, borderWidth: 1, borderColor: theme.colors.borderStrong, backgroundColor: theme.colors.surfaceSoft, alignItems: 'center', justifyContent: 'center', shadowColor: theme.colors.primary, shadowOpacity: theme.mode === 'dark' ? 0.32 : 0.12, shadowRadius: 20, elevation: 6 },
  avatar: { width: 70, height: 70, borderRadius: 24, backgroundColor: theme.colors.accentSoft, borderWidth: 1, borderColor: theme.colors.primary, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: theme.colors.primaryBright, fontSize: 34, fontWeight: '900' },
  planBadge: { marginTop: 12, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 99, backgroundColor: theme.colors.accentSoft, borderWidth: 1, borderColor: theme.colors.borderStrong },
  planBadgeText: { color: theme.colors.primaryBright, fontSize: 9, fontWeight: '900', letterSpacing: 1.5 },
  name: { color: theme.colors.text, fontSize: 22, fontWeight: '900', marginTop: 10 },
  plan: { color: theme.colors.textMuted, fontSize: 12, fontWeight: '700', marginTop: 5 },
  email: { color: theme.colors.textDim, fontSize: 11, marginTop: 7 },
  membershipCard: { borderRadius: 26, padding: 18, backgroundColor: theme.colors.surfaceRaised, borderWidth: 1, borderColor: theme.colors.border, shadowColor: theme.colors.shadow, shadowOpacity: theme.mode === 'dark' ? 0.28 : 0.08, shadowRadius: 18, shadowOffset: { width: 0, height: 10 }, elevation: 4 },
  membershipActive: { borderColor: theme.colors.borderStrong, backgroundColor: theme.colors.surfaceRaised },
  membershipTop: { flexDirection: 'row-reverse', gap: 14, alignItems: 'flex-start' },
  membershipCopy: { flex: 1 },
  eyebrow: { color: theme.colors.primaryBright, textAlign: 'right', fontSize: 9, fontWeight: '900', letterSpacing: 1.2 },
  membershipTitle: { color: theme.colors.text, textAlign: 'right', fontSize: 22, fontWeight: '900', marginTop: 5 },
  membershipDescription: { color: theme.colors.textMuted, textAlign: 'right', fontSize: 11, lineHeight: 19, marginTop: 7 },
  membershipOrb: { width: 50, height: 50, borderRadius: 17, backgroundColor: theme.colors.surfaceSoft, borderWidth: 1, borderColor: theme.colors.border, alignItems: 'center', justifyContent: 'center' },
  membershipOrbActive: { backgroundColor: theme.colors.accentSoft, borderColor: theme.colors.primary },
  membershipOrbText: { color: theme.colors.primaryBright, fontSize: 19, fontWeight: '900' },
  metrics: { flexDirection: 'row-reverse', gap: 8, marginTop: 17 },
  metric: { flex: 1, minHeight: 66, borderRadius: 17, backgroundColor: theme.colors.surfaceSoft, borderWidth: 1, borderColor: theme.colors.border, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  metricValue: { color: theme.colors.text, fontSize: 13, fontWeight: '900', textAlign: 'center' },
  metricLabel: { color: theme.colors.textDim, fontSize: 9, fontWeight: '700', marginTop: 4 },
  upgradeCard: { marginTop: 14, borderRadius: 26, padding: 18, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.borderStrong },
  upgradeHead: { alignItems: 'flex-end', marginBottom: 13 },
  recommended: { paddingHorizontal: 9, paddingVertical: 4, borderRadius: 99, backgroundColor: theme.colors.primary },
  recommendedText: { color: theme.colors.onAccent, fontSize: 8, fontWeight: '900', letterSpacing: 1 },
  upgradeTitle: { color: theme.colors.text, fontSize: 20, fontWeight: '900', marginTop: 9 },
  upgradeSubtitle: { color: theme.colors.textMuted, fontSize: 11, marginTop: 4 },
  featureLine: { flexDirection: 'row-reverse', alignItems: 'center', gap: 9, marginTop: 9 },
  featureCheck: { width: 22, height: 22, borderRadius: 8, backgroundColor: theme.colors.accentSoft, alignItems: 'center', justifyContent: 'center' },
  featureCheckText: { color: theme.colors.primaryBright, fontSize: 11, fontWeight: '900' },
  featureText: { color: theme.colors.text, flex: 1, textAlign: 'right', fontSize: 11, fontWeight: '700' },
  upgradeButton: { marginTop: 17, borderRadius: 16, backgroundColor: theme.colors.primary, alignItems: 'center', paddingVertical: 14, opacity: 0.62 },
  upgradeButtonText: { color: theme.colors.onAccent, fontSize: 12, fontWeight: '900' },
  upgradeNote: { color: theme.colors.textDim, textAlign: 'center', fontSize: 9, lineHeight: 15, marginTop: 8 },
  activeCard: { marginTop: 14, borderRadius: 22, padding: 15, flexDirection: 'row-reverse', gap: 11, alignItems: 'center', backgroundColor: theme.colors.accentSoft, borderWidth: 1, borderColor: theme.colors.borderStrong },
  activeIcon: { color: theme.colors.primaryBright, fontSize: 20, fontWeight: '900' },
  activeCopy: { flex: 1 },
  activeTitle: { color: theme.colors.text, textAlign: 'right', fontSize: 12, fontWeight: '900' },
  activeSub: { color: theme.colors.textMuted, textAlign: 'right', fontSize: 10, lineHeight: 17, marginTop: 3 },
  menu: { marginTop: 18, borderRadius: 24, overflow: 'hidden', borderWidth: 1, borderColor: theme.colors.border },
  row: { minHeight: 68, backgroundColor: theme.colors.surface, flexDirection: 'row-reverse', alignItems: 'center', gap: 11, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: theme.colors.border },
  themeRow: { minHeight: 72, backgroundColor: theme.colors.surface, flexDirection: 'row-reverse', alignItems: 'center', gap: 11, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: theme.colors.border },
  rowIcon: { width: 38, height: 38, borderRadius: 13, backgroundColor: theme.colors.surfaceSoft, alignItems: 'center', justifyContent: 'center' },
  rowIconText: { color: theme.colors.primaryBright, fontWeight: '900' },
  rowCopy: { flex: 1 },
  rowTitle: { color: theme.colors.text, textAlign: 'right', fontSize: 13, fontWeight: '900' },
  rowSub: { color: theme.colors.textMuted, textAlign: 'right', fontSize: 10, marginTop: 4 },
  chev: { color: theme.colors.textDim, fontSize: 26 },
  switch: { width: 44, height: 25, borderRadius: 13, padding: 3, backgroundColor: theme.colors.surfaceSoft, justifyContent: 'center' },
  switchLight: { backgroundColor: theme.colors.primary },
  switchDot: { width: 19, height: 19, borderRadius: 10, backgroundColor: theme.colors.textMuted, alignSelf: 'flex-start' },
  switchDotLight: { backgroundColor: theme.colors.onAccent, alignSelf: 'flex-end' },
  logout: { marginTop: 18, borderRadius: 17, borderWidth: 1, borderColor: 'rgba(251,113,133,0.24)', backgroundColor: 'rgba(251,113,133,0.07)', alignItems: 'center', paddingVertical: 14 },
  logoutText: { color: theme.colors.danger, fontWeight: '900' },
  version: { color: theme.colors.textDim, textAlign: 'center', marginTop: 14, fontSize: 10 },
});
