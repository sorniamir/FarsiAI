import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { theme } from '../theme';
import type { AppMode } from '../types';

const subtitles: Record<AppMode, string> = {
  chat: 'دستیار هوشمند فارسی',
  image: 'ساخت تصویر با هوش مصنوعی',
  video: 'نسل بعدی ابزارهای خلاقانه',
};

export function AppHeader({ credits, mode }: { credits: number; mode: AppMode }) {
  return (
    <View style={styles.header}>
      <View>
        <View style={styles.brandRow}>
          <View style={styles.logo}><Text style={styles.logoText}>✦</Text></View>
          <Text style={styles.brand}>FarsiAI</Text>
          <View style={styles.beta}><Text style={styles.betaText}>BETA</Text></View>
        </View>
        <Text style={styles.subtitle}>{subtitles[mode]}</Text>
      </View>
      <View style={styles.creditPill}>
        <Text style={styles.creditIcon}>◆</Text>
        <Text style={styles.creditText}>{credits}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: 18,
    paddingTop: 12,
    paddingBottom: 14,
    flexDirection: 'row-reverse',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  brandRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 8 },
  logo: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoText: { color: '#fff', fontSize: 18, fontWeight: '900' },
  brand: { color: theme.colors.text, fontSize: 22, fontWeight: '800' },
  beta: { borderRadius: 8, backgroundColor: 'rgba(34,211,238,0.12)', paddingHorizontal: 7, paddingVertical: 4 },
  betaText: { color: theme.colors.cyan, fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  subtitle: { color: theme.colors.textMuted, fontSize: 12, marginTop: 6, textAlign: 'right' },
  creditPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: theme.radius.pill,
  },
  creditIcon: { color: theme.colors.warning, fontSize: 15 },
  creditText: { color: theme.colors.text, fontWeight: '700' },
});
