import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { theme } from '../theme';
import type { UiMessage } from '../types';

export function MessageBubble({ item }: { item: UiMessage }) {
  const user = item.role === 'user';
  return (
    <View style={[styles.row, user ? styles.userRow : styles.assistantRow]}>
      {!user ? <View style={styles.avatar}><Text style={styles.avatarText}>✦</Text></View> : null}
      <View style={[styles.bubble, user ? styles.userBubble : styles.assistantBubble]}>
        {item.image ? <Image source={{ uri: item.image }} style={styles.image} resizeMode="cover" /> : null}
        {item.text ? <Text style={styles.text}>{item.text}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { width: '100%', flexDirection: 'row', gap: 8, alignItems: 'flex-end' },
  userRow: { justifyContent: 'flex-end' },
  assistantRow: { justifyContent: 'flex-start' },
  avatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: theme.colors.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: theme.colors.primaryBright, fontSize: 13 },
  bubble: { maxWidth: '82%', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 12, borderWidth: 1 },
  userBubble: { backgroundColor: theme.colors.userBubble, borderColor: 'rgba(255,255,255,0.08)', borderBottomRightRadius: 6 },
  assistantBubble: { backgroundColor: theme.colors.assistantBubble, borderColor: theme.colors.border, borderBottomLeftRadius: 6 },
  text: { color: theme.colors.text, fontSize: 14, lineHeight: 23, textAlign: 'right' },
  image: { width: 260, height: 260, maxWidth: '100%', borderRadius: 15, marginBottom: 10, backgroundColor: theme.colors.surfaceSoft },
});
