import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { theme } from '../theme';

export function ProfileScreen({ isGuest, credits, onSignOut }: { isGuest: boolean; credits: number; onSignOut: () => void }) {
  return (
    <View style={styles.screen}>
      <View style={styles.hero}>
        <View style={styles.avatar}><Text style={styles.avatarText}>✦</Text></View>
        <Text style={styles.name}>{isGuest ? 'کاربر مهمان' : 'حساب FarsiAI'}</Text>
        <Text style={styles.plan}>{isGuest ? 'Guest Mode' : 'Free Plan'}</Text>
      </View>

      <View style={styles.creditCard}>
        <View style={styles.creditRight}>
          <Text style={styles.creditLabel}>اعتبار باقی‌مانده</Text>
          <Text style={styles.creditHint}>برای چت و ساخت تصویر</Text>
        </View>
        <View style={styles.creditPill}><Text style={styles.creditValue}>{credits}</Text><Text style={styles.creditUnit}> Credits</Text></View>
      </View>

      <View style={styles.menu}>
        <Row icon="◈" title="مدیریت اشتراک" subtitle="Free • ارتقا به Pro به‌زودی" />
        <Row icon="⚙" title="تنظیمات" subtitle="زبان، ظاهر و ترجیحات پاسخ" />
        <Row icon="◌" title="حریم خصوصی" subtitle="مدیریت داده‌ها و تاریخچه" />
        <Row icon="?" title="راهنما و پشتیبانی" subtitle="پاسخ به سوالات و گزارش مشکل" />
      </View>

      <TouchableOpacity style={styles.logout} onPress={onSignOut} activeOpacity={0.8}>
        <Text style={styles.logoutText}>{isGuest ? 'خروج از حالت مهمان' : 'خروج از حساب'}</Text>
      </TouchableOpacity>
      <Text style={styles.version}>FarsiAI v0.3 • Production Beta</Text>
    </View>
  );
}

function Row({ icon, title, subtitle }: { icon: string; title: string; subtitle: string }) {
  return (
    <TouchableOpacity style={styles.row} activeOpacity={0.75}>
      <View style={styles.rowIcon}><Text style={styles.rowIconText}>{icon}</Text></View>
      <View style={styles.rowCopy}><Text style={styles.rowTitle}>{title}</Text><Text style={styles.rowSub}>{subtitle}</Text></View>
      <Text style={styles.chev}>‹</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background, padding: 20 },
  hero: { alignItems: 'center', paddingTop: 20, paddingBottom: 20 },
  avatar: { width: 74, height: 74, borderRadius: 26, backgroundColor: 'rgba(139,92,246,0.15)', borderWidth: 1, borderColor: 'rgba(167,139,250,0.35)', alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: theme.colors.cyan, fontSize: 35 },
  name: { color: theme.colors.text, fontSize: 22, fontWeight: '900', marginTop: 12 },
  plan: { color: theme.colors.primaryBright, fontSize: 12, fontWeight: '800', marginTop: 4 },
  creditCard: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center', borderRadius: 22, padding: 17, backgroundColor: theme.colors.surfaceRaised, borderWidth: 1, borderColor: theme.colors.border },
  creditRight: { flex: 1 },
  creditLabel: { color: theme.colors.text, textAlign: 'right', fontWeight: '900' },
  creditHint: { color: theme.colors.textMuted, textAlign: 'right', fontSize: 11, marginTop: 4 },
  creditPill: { flexDirection: 'row', alignItems: 'baseline', backgroundColor: 'rgba(34,211,238,0.10)', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8 },
  creditValue: { color: theme.colors.cyan, fontSize: 21, fontWeight: '900' },
  creditUnit: { color: theme.colors.cyan, fontSize: 10, fontWeight: '800' },
  menu: { marginTop: 18, borderRadius: 22, overflow: 'hidden', borderWidth: 1, borderColor: theme.colors.border },
  row: { minHeight: 68, backgroundColor: theme.colors.surface, flexDirection: 'row-reverse', alignItems: 'center', gap: 11, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: theme.colors.border },
  rowIcon: { width: 38, height: 38, borderRadius: 13, backgroundColor: theme.colors.surfaceSoft, alignItems: 'center', justifyContent: 'center' },
  rowIconText: { color: theme.colors.primaryBright, fontWeight: '900' },
  rowCopy: { flex: 1 },
  rowTitle: { color: theme.colors.text, textAlign: 'right', fontSize: 13, fontWeight: '900' },
  rowSub: { color: theme.colors.textMuted, textAlign: 'right', fontSize: 10, marginTop: 4 },
  chev: { color: theme.colors.textDim, fontSize: 26 },
  logout: { marginTop: 18, borderRadius: 17, borderWidth: 1, borderColor: 'rgba(251,113,133,0.24)', backgroundColor: 'rgba(251,113,133,0.07)', alignItems: 'center', paddingVertical: 14 },
  logoutText: { color: theme.colors.danger, fontWeight: '900' },
  version: { color: theme.colors.textDim, textAlign: 'center', marginTop: 14, fontSize: 10 },
});
