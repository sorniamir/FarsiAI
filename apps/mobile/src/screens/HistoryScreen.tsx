import React from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { theme } from '../theme';

const demo = [
  { id: '1', icon: '💬', title: 'بهترین لپ‌تاپ برای برنامه‌نویسی', preview: 'برای انتخاب بهتر، بودجه و نوع کار...', time: 'امروز' },
  { id: '2', icon: '🎨', title: 'تهران آینده در سال ۲۱۰۰', preview: 'تصویر با حال‌وهوای سینمایی ساخته شد', time: 'دیروز' },
  { id: '3', icon: '💬', title: 'برنامه مطالعه زبان انگلیسی', preview: 'یک برنامه ۳۰ روزه مرحله‌ای...', time: '۳ روز پیش' },
];

export function HistoryScreen({ onOpenChat }: { onOpenChat: () => void }) {
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.top}>
        <View>
          <Text style={styles.title}>تاریخچه</Text>
          <Text style={styles.subtitle}>گفتگوها و تصاویر قبلی</Text>
        </View>
        <TouchableOpacity style={styles.newButton} onPress={onOpenChat}><Text style={styles.newText}>+ چت جدید</Text></TouchableOpacity>
      </View>

      <View style={styles.search}><Text style={styles.searchText}>⌕  جستجو در گفتگوها</Text></View>

      <Text style={styles.section}>اخیر</Text>
      <View style={styles.list}>
        {demo.map((item) => (
          <TouchableOpacity key={item.id} style={styles.row} onPress={onOpenChat} activeOpacity={0.82}>
            <View style={styles.rowIcon}><Text style={styles.rowIconText}>{item.icon}</Text></View>
            <View style={styles.rowCopy}>
              <View style={styles.rowHead}><Text style={styles.time}>{item.time}</Text><Text style={styles.rowTitle}>{item.title}</Text></View>
              <Text style={styles.preview} numberOfLines={1}>{item.preview}</Text>
            </View>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.syncCard}>
        <Text style={styles.syncIcon}>☁</Text>
        <View style={{ flex: 1 }}>
          <Text style={styles.syncTitle}>همگام‌سازی ابری آماده است</Text>
          <Text style={styles.syncText}>پس از اتصال Supabase، این لیست از دیتابیس کاربر خوانده می‌شود و بین دستگاه‌ها همگام خواهد شد.</Text>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: 20, paddingBottom: 30 },
  top: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  title: { color: theme.colors.text, fontSize: 27, fontWeight: '900', textAlign: 'right' },
  subtitle: { color: theme.colors.textMuted, fontSize: 12, marginTop: 4, textAlign: 'right' },
  newButton: { backgroundColor: theme.colors.primary, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10 },
  newText: { color: '#fff', fontSize: 12, fontWeight: '900' },
  search: { borderRadius: 17, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface, paddingHorizontal: 15, paddingVertical: 14, marginBottom: 22 },
  searchText: { color: theme.colors.textDim, textAlign: 'right' },
  section: { color: theme.colors.textMuted, textAlign: 'right', fontWeight: '800', marginBottom: 10 },
  list: { gap: 10 },
  row: { flexDirection: 'row-reverse', alignItems: 'center', gap: 12, padding: 14, backgroundColor: theme.colors.surfaceRaised, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 19 },
  rowIcon: { width: 46, height: 46, borderRadius: 15, backgroundColor: theme.colors.surfaceSoft, alignItems: 'center', justifyContent: 'center' },
  rowIconText: { fontSize: 20 },
  rowCopy: { flex: 1 },
  rowHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  rowTitle: { color: theme.colors.text, flex: 1, textAlign: 'right', fontSize: 13, fontWeight: '900', writingDirection: 'rtl' },
  time: { color: theme.colors.textDim, fontSize: 10, marginRight: 8 },
  preview: { color: theme.colors.textMuted, fontSize: 11, textAlign: 'right', marginTop: 5, writingDirection: 'rtl' },
  syncCard: { marginTop: 22, flexDirection: 'row-reverse', gap: 12, borderRadius: 20, backgroundColor: 'rgba(139,92,246,0.08)', borderWidth: 1, borderColor: 'rgba(139,92,246,0.20)', padding: 15 },
  syncIcon: { color: theme.colors.primaryBright, fontSize: 25 },
  syncTitle: { color: theme.colors.text, textAlign: 'right', fontWeight: '900' },
  syncText: { color: theme.colors.textMuted, textAlign: 'right', fontSize: 11, lineHeight: 18, marginTop: 4, writingDirection: 'rtl' },
});
