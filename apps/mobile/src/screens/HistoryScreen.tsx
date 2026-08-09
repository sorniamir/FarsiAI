import React, { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { listConversations, type ConversationSummary } from '../services/history';
import { theme } from '../theme';

export function HistoryScreen({ onOpenChat }: { onOpenChat: () => void }) {
  const [items, setItems] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listConversations().then((rows) => {
      setItems(rows);
      setLoading(false);
    });
  }, []);

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

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.colors.primaryBright} /></View>
      ) : items.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyIcon}>◌</Text>
          <Text style={styles.emptyTitle}>هنوز گفتگویی ذخیره نشده</Text>
          <Text style={styles.emptyText}>اولین گفتگوی تو بعد از اتصال حساب کاربری و ذخیره‌سازی، اینجا ظاهر می‌شود.</Text>
          <TouchableOpacity style={styles.emptyButton} onPress={onOpenChat}><Text style={styles.emptyButtonText}>شروع گفتگو</Text></TouchableOpacity>
        </View>
      ) : (
        <View style={styles.list}>
          {items.map((item) => (
            <TouchableOpacity key={item.id} style={styles.row} onPress={onOpenChat} activeOpacity={0.82}>
              <View style={styles.rowIcon}><Text style={styles.rowIconText}>{item.mode === 'image' ? '🎨' : '💬'}</Text></View>
              <View style={styles.rowCopy}>
                <View style={styles.rowHead}>
                  <Text style={styles.time}>{formatDate(item.updatedAt)}</Text>
                  <Text style={styles.rowTitle} numberOfLines={1}>{item.title}</Text>
                </View>
                <Text style={styles.preview}>{item.mode === 'image' ? 'گفتگوی تصویری' : item.mode === 'mixed' ? 'چت و تصویر' : 'گفتگوی متنی'}</Text>
              </View>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('fa-IR', { month: 'short', day: 'numeric' });
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
  center: { paddingVertical: 40, alignItems: 'center' },
  empty: { alignItems: 'center', backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 24, padding: 26 },
  emptyIcon: { color: theme.colors.primaryBright, fontSize: 36 },
  emptyTitle: { color: theme.colors.text, fontWeight: '900', fontSize: 16, marginTop: 10 },
  emptyText: { color: theme.colors.textMuted, textAlign: 'center', fontSize: 12, lineHeight: 20, marginTop: 7, writingDirection: 'rtl' },
  emptyButton: { marginTop: 16, backgroundColor: theme.colors.surfaceSoft, borderRadius: 14, paddingHorizontal: 18, paddingVertical: 10 },
  emptyButtonText: { color: theme.colors.primaryBright, fontWeight: '900' },
  list: { gap: 10 },
  row: { flexDirection: 'row-reverse', alignItems: 'center', gap: 12, padding: 14, backgroundColor: theme.colors.surfaceRaised, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 19 },
  rowIcon: { width: 46, height: 46, borderRadius: 15, backgroundColor: theme.colors.surfaceSoft, alignItems: 'center', justifyContent: 'center' },
  rowIconText: { fontSize: 20 },
  rowCopy: { flex: 1 },
  rowHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  rowTitle: { color: theme.colors.text, flex: 1, textAlign: 'right', fontSize: 13, fontWeight: '900', writingDirection: 'rtl' },
  time: { color: theme.colors.textDim, fontSize: 10, marginRight: 8 },
  preview: { color: theme.colors.textMuted, fontSize: 11, textAlign: 'right', marginTop: 5, writingDirection: 'rtl' },
});
