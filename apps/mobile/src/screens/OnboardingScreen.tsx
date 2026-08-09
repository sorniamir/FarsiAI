import React from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { theme } from '../theme';

export function OnboardingScreen({ onContinue }: { onContinue: () => void }) {
  return (
    <ScrollView contentContainerStyle={styles.container} showsVerticalScrollIndicator={false}>
      <View style={styles.badge}><Text style={styles.badgeText}>FarsiAI • Beta</Text></View>
      <Text style={styles.logo}>✦</Text>
      <Text style={styles.title}>هوش مصنوعی، این بار واقعاً برای فارسی</Text>
      <Text style={styles.subtitle}>سؤال بپرس، ایده بساز و در همان گفتگو تصویر تولید کن؛ سریع، ساده و فارسی‌محور.</Text>

      <View style={styles.grid}>
        <Feature icon="💬" title="گفتگوی هوشمند" text="پاسخ‌های روان، ساختاریافته و مناسب زبان فارسی" />
        <Feature icon="🎨" title="ساخت تصویر" text="Image Mode را داخل همان چت روشن کن و تصویر بگیر" />
        <Feature icon="⚡" title="سریع و سبک" text="معماری بهینه برای مصرف کمتر و پاسخ سریع‌تر" />
      </View>

      <TouchableOpacity style={styles.primary} onPress={onContinue} activeOpacity={0.86}>
        <Text style={styles.primaryText}>شروع کنیم</Text>
      </TouchableOpacity>
      <Text style={styles.note}>نسخه ویدیو به‌زودی اضافه می‌شود.</Text>
    </ScrollView>
  );
}

function Feature({ icon, title, text }: { icon: string; title: string; text: string }) {
  return (
    <View style={styles.card}>
      <View style={styles.icon}><Text style={styles.iconText}>{icon}</Text></View>
      <View style={styles.cardCopy}>
        <Text style={styles.cardTitle}>{title}</Text>
        <Text style={styles.cardText}>{text}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, backgroundColor: theme.colors.background, padding: 24, paddingTop: 56, justifyContent: 'center' },
  badge: { alignSelf: 'center', borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7, marginBottom: 24 },
  badgeText: { color: theme.colors.primaryBright, fontSize: 12, fontWeight: '800' },
  logo: { textAlign: 'center', color: theme.colors.cyan, fontSize: 64, marginBottom: 12 },
  title: { color: theme.colors.text, textAlign: 'center', fontWeight: '900', fontSize: 31, lineHeight: 43, writingDirection: 'rtl' },
  subtitle: { color: theme.colors.textMuted, textAlign: 'center', fontSize: 15, lineHeight: 25, marginTop: 12, marginBottom: 28, writingDirection: 'rtl' },
  grid: { gap: 12 },
  card: { flexDirection: 'row-reverse', gap: 14, alignItems: 'center', padding: 16, borderRadius: 22, backgroundColor: theme.colors.surfaceRaised, borderWidth: 1, borderColor: theme.colors.border },
  icon: { width: 48, height: 48, borderRadius: 16, backgroundColor: theme.colors.surfaceSoft, alignItems: 'center', justifyContent: 'center' },
  iconText: { fontSize: 23 },
  cardCopy: { flex: 1 },
  cardTitle: { color: theme.colors.text, textAlign: 'right', fontSize: 15, fontWeight: '900' },
  cardText: { color: theme.colors.textMuted, textAlign: 'right', fontSize: 12, lineHeight: 20, marginTop: 4, writingDirection: 'rtl' },
  primary: { backgroundColor: theme.colors.primary, borderRadius: 20, alignItems: 'center', paddingVertical: 16, marginTop: 28 },
  primaryText: { color: '#fff', fontWeight: '900', fontSize: 16 },
  note: { color: theme.colors.textDim, textAlign: 'center', marginTop: 13, fontSize: 12 },
});
