import React, { useMemo, useState } from 'react';
import { Alert, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { saveGeneratedImage } from '../services/images';
import { useAppTheme } from '../ThemeProvider';
import type { AppTheme } from '../theme';
import type { UiMessage } from '../types';

export function MessageBubble({
  item,
  onReplyImage,
}: {
  item: UiMessage;
  onReplyImage?: (item: UiMessage) => void;
}) {
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [saving, setSaving] = useState(false);
  const user = item.role === 'user';

  async function download() {
    if (!item.image || saving) return;
    setSaving(true);
    try {
      await saveGeneratedImage(item.image);
      Alert.alert('ذخیره شد', 'تصویر در گالری دستگاه ذخیره شد.');
    } catch (error) {
      Alert.alert('ذخیره نشد', error instanceof Error ? error.message : 'دوباره تلاش کن.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={[styles.row, user ? styles.userRow : styles.assistantRow]}>
      {!user ? (
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>✦</Text>
        </View>
      ) : null}
      <View style={styles.stack}>
        <Text style={[styles.role, user && styles.userRole]}>{user ? 'YOU' : 'FARSIAI'}</Text>
        <View style={[styles.bubble, user ? styles.userBubble : styles.assistantBubble]}>
          {item.attachments?.length ? (
            <View style={styles.attachments}>
              {item.attachments.map((attachment) => (
                <View key={attachment.id} style={styles.attachmentCard}>
                  {attachment.mimeType.startsWith('image/') ? (
                    <Image source={{ uri: attachment.previewUri || attachment.dataUrl }} style={styles.attachmentImage} />
                  ) : (
                    <View style={styles.fileIcon}><Text style={styles.fileIconText}>↧</Text></View>
                  )}
                  <View style={styles.attachmentTextWrap}>
                    <Text style={styles.attachmentName} numberOfLines={1}>{attachment.name}</Text>
                    <Text style={styles.attachmentMeta}>{Math.max(1, Math.round(attachment.size / 1024))} KB</Text>
                  </View>
                </View>
              ))}
            </View>
          ) : null}
          {item.image ? <Image source={{ uri: item.image }} style={styles.image} resizeMode="cover" /> : null}
          {item.image ? (
            <View style={styles.imageActions}>
              <Pressable style={({ pressed }) => [styles.actionButton, pressed && styles.actionPressed]} onPress={download}>
                <Text style={styles.actionText}>{saving ? 'در حال ذخیره…' : '↓ ذخیره'}</Text>
              </Pressable>
              {onReplyImage ? (
                <Pressable style={({ pressed }) => [styles.actionButton, pressed && styles.actionPressed]} onPress={() => onReplyImage(item)}>
                  <Text style={styles.actionText}>↩ ویرایش این تصویر</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          {item.text ? <Text selectable style={styles.text}>{item.text}</Text> : null}
        </View>
      </View>
    </View>
  );
}

const createStyles = (theme: AppTheme) => StyleSheet.create({
  row: { width: '100%', flexDirection: 'row', gap: 9, alignItems: 'flex-end' },
  userRow: { justifyContent: 'flex-end' },
  assistantRow: { justifyContent: 'flex-start' },
  stack: { maxWidth: '88%' },
  role: {
    color: theme.colors.textDim,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.3,
    marginBottom: 5,
    marginLeft: 3,
  },
  userRole: { textAlign: 'right', marginRight: 3, marginLeft: 0 },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 12,
    backgroundColor: theme.colors.surfaceRaised,
    borderWidth: 1,
    borderColor: theme.colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: theme.colors.primary,
    shadowOpacity: theme.mode === 'dark' ? 0.24 : 0.10,
    shadowRadius: 10,
    elevation: 4,
  },
  avatarText: { color: theme.colors.primaryBright, fontSize: 13, fontWeight: '900' },
  bubble: {
    borderRadius: 20,
    paddingHorizontal: 15,
    paddingVertical: 13,
    borderWidth: 1,
    shadowColor: theme.colors.shadow,
    shadowOpacity: theme.mode === 'dark' ? 0.30 : 0.10,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 7 },
    elevation: 3,
  },
  userBubble: {
    backgroundColor: theme.colors.userBubble,
    borderColor: theme.colors.borderStrong,
    borderBottomRightRadius: 7,
  },
  assistantBubble: {
    backgroundColor: theme.colors.assistantBubble,
    borderColor: theme.colors.border,
    borderBottomLeftRadius: 7,
  },
  text: { color: theme.colors.text, fontSize: 14, lineHeight: 24, textAlign: 'right' },
  image: {
    width: 276,
    height: 276,
    maxWidth: '100%',
    borderRadius: 17,
    marginBottom: 11,
    backgroundColor: theme.colors.surfaceSoft,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  imageActions: { flexDirection: 'row-reverse', flexWrap: 'wrap', gap: 7, marginBottom: 9 },
  actionButton: {
    backgroundColor: theme.colors.accentSoft,
    borderWidth: 1,
    borderColor: theme.colors.borderStrong,
    borderRadius: 12,
    paddingHorizontal: 11,
    paddingVertical: 8,
  },
  actionPressed: { opacity: 0.72, transform: [{ scale: 0.98 }] },
  actionText: { color: theme.colors.primaryBright, fontSize: 11, fontWeight: '800' },
  attachments: { gap: 7, marginBottom: 10 },
  attachmentCard: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 8,
    padding: 8,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSoft,
  },
  attachmentImage: { width: 44, height: 44, borderRadius: 10, backgroundColor: theme.colors.surfaceRaised },
  fileIcon: { width: 44, height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.accentSoft },
  fileIconText: { color: theme.colors.primaryBright, fontSize: 18, fontWeight: '900' },
  attachmentTextWrap: { flex: 1, minWidth: 0 },
  attachmentName: { color: theme.colors.text, textAlign: 'right', fontSize: 11, fontWeight: '800' },
  attachmentMeta: { color: theme.colors.textDim, textAlign: 'right', fontSize: 9, marginTop: 2 },
});
