import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { theme } from '../theme';

export function VideoComingSoon() {
  return (
    <View style={styles.wrap}>
      <View style={styles.orb}><Text style={styles.orbText}>▶</Text></View>
      <Text style={styles.title}>Video AI</Text>
      <Text style={styles.badge}>COMING SOON</Text>
      <Text style={styles.text}>ساخت ویدیو با هوش مصنوعی در نسخه‌های بعدی فعال می‌شود. معماری این بخش از الان برای اتصال Provider آماده است.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 36 },
  orb: {
    width: 88,
    height: 88,
    borderRadius: 28,
    backgroundColor: 'rgba(34,211,238,0.09)',
    borderWidth: 1,
    borderColor: 'rgba(34,211,238,0.24)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 22,
  },
  orbText: { color: theme.colors.cyan, fontSize: 28 },
  title: { color: theme.colors.text, fontSize: 30, fontWeight: '800' },
  badge: { color: theme.colors.cyan, fontSize: 10, fontWeight: '900', letterSpacing: 2.3, marginTop: 8 },
  text: { color: theme.colors.textMuted, textAlign: 'center', lineHeight: 23, marginTop: 18, maxWidth: 320 },
});
