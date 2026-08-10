import React, { useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useAppTheme } from '../ThemeProvider';
import type { AppTheme } from '../theme';
import type { DailyQuota } from '../types';

export function ProfileScreen({ isGuest, email, quota, onSignOut }: { isGuest: boolean; email?: string; quota: DailyQuota; onSignOut: () => void }) {
  const { theme, mode, toggle } = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <View style={styles.screen}>
      <View style={styles.hero}>
        <View style={styles.avatar}><Text style={styles.avatarText}>✦</Text></View>
        <Text style={styles.name}>{isGuest ? 'کاربر مهمان' : 'حساب FarsiAI'}</Text>
        <Text style={styles.plan}>{isGuest ? 'حالت مهمان' : 'وارد شده'}</Text>
        {!isGuest && email ? <Text style={styles.email}>{email}</Text> : null}
      </View>

      <View style={styles.creditCard}>
        <View style={styles.creditRight}>
          <Text style={styles.creditLabel}>سهمیه امروز</Text>
          <Text style={styles.creditHint}>هر روز ساعت ۰۰:۰۰ UTC تازه می‌شود</Text>
        </View>
        <View style={styles.quotaStack}>
          <Text style={styles.quotaText}>{quota.chatRemaining} پیام</Text>
          <Text style={styles.quotaText}>{quota.imageRemaining} تصویر</Text>
        </View>
      </View>

      <View style={styles.menu}>
        <TouchableOpacity style={styles.themeRow} onPress={toggle} activeOpacity={0.8}>
          <View style={styles.rowIcon}><Text style={styles.rowIconText}>{mode === 'dark' ? '☾' : '☀'}</Text></View>
          <View style={styles.rowCopy}>
            <Text style={styles.rowTitle}>ظاهر برنامه</Text>
            <Text style={styles.rowSub}>{mode === 'dark' ? 'حالت تیره فعال است' : 'حالت روشن فعال است'}</Text>
          </View>
          <View style={[styles.switch, mode === 'light' && styles.switchLight]}><View style={[styles.switchDot, mode === 'light' && styles.switchDotLight]} /></View>
        </TouchableOpacity>
        <Row icon="◈" title="مدیریت اشتراک" subtitle="Free • ارتقا به Pro به‌زودی" />
        <Row icon="⚙" title="تنظیمات" subtitle="زبان، ظاهر و ترجیحات پاسخ" />
        <Row icon="◌" title="حریم خصوصی" subtitle="مدیریت داده‌ها و تاریخچه" />
        <Row icon="?" title="راهنما و پشتیبانی" subtitle="پاسخ به سوالات و گزارش مشکل" />
      </View>

      <TouchableOpacity style={styles.logout} onPress={onSignOut} activeOpacity={0.8}>
        <Text style={styles.logoutText}>{isGuest ? 'خروج از حالت مهمان' : 'خروج از حساب'}</Text>
      </TouchableOpacity>
      <Text style={styles.version}>FarsiAi v0.3.1 • Production Beta</Text>
    </View>
  );
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
  screen: { flex: 1, backgroundColor: theme.colors.background, padding: 20 },
  hero: { alignItems: 'center', paddingTop: 20, paddingBottom: 20 },
  avatar: { width: 74, height: 74, borderRadius: 26, backgroundColor: theme.colors.accentSoft, borderWidth: 1, borderColor: theme.colors.primary, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: theme.colors.cyan, fontSize: 35 },
  name: { color: theme.colors.text, fontSize: 22, fontWeight: '900', marginTop: 12 },
  plan: { color: theme.colors.primaryBright, fontSize: 12, fontWeight: '800', marginTop: 4 },
  email: { color: theme.colors.textMuted, fontSize: 12, marginTop: 7 },
  creditCard: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center', borderRadius: 22, padding: 17, backgroundColor: theme.colors.surfaceRaised, borderWidth: 1, borderColor: theme.colors.border },
  creditRight: { flex: 1 },
  creditLabel: { color: theme.colors.text, textAlign: 'right', fontWeight: '900' },
  creditHint: { color: theme.colors.textMuted, textAlign: 'right', fontSize: 11, marginTop: 4 },
  creditPill: { flexDirection: 'row', alignItems: 'baseline', backgroundColor: theme.colors.accentSoft, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8 },
  creditValue: { color: theme.colors.cyan, fontSize: 21, fontWeight: '900' },
  creditUnit: { color: theme.colors.cyan, fontSize: 10, fontWeight: '800' },
  quotaStack: { alignItems: 'flex-end', gap: 4, backgroundColor: theme.colors.accentSoft, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8 },
  quotaText: { color: theme.colors.cyan, fontSize: 12, fontWeight: '900' },
  menu: { marginTop: 18, borderRadius: 22, overflow: 'hidden', borderWidth: 1, borderColor: theme.colors.border },
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
