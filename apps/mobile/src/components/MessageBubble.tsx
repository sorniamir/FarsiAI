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
      {!user ? <View style={styles.avatar}><Text style={styles.avatarText}>✦</Text></View> : null}
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
            <Pressable style={styles.actionButton} onPress={download}>
              <Text style={styles.actionText}>{saving ? 'در حال ذخیره…' : '↓ ذخیره'}</Text>
            </Pressable>
            {onReplyImage ? (
              <Pressable style={styles.actionButton} onPress={() => onReplyImage(item)}>
                <Text style={styles.actionText}>↩ ویرایش این تصویر</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {item.text ? <Text style={styles.text}>{item.text}</Text> : null}
      </View>
    </View>
  );
}

const createStyles = (theme: AppTheme) => StyleSheet.create({
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
  bubble: { maxWidth: '86%', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 12, borderWidth: 1 },
  userBubble: { backgroundColor: theme.colors.userBubble, borderColor: 'rgba(255,255,255,0.08)', borderBottomRightRadius: 6 },
  assistantBubble: { backgroundColor: theme.colors.assistantBubble, borderColor: theme.colors.border, borderBottomLeftRadius: 6 },
  text: { color: theme.colors.text, fontSize: 14, lineHeight: 23, textAlign: 'right' },
  image: { width: 260, height: 260, maxWidth: '100%', borderRadius: 15, marginBottom: 10, backgroundColor: theme.colors.surfaceSoft },
  imageActions: { flexDirection: 'row-reverse', flexWrap: 'wrap', gap: 7, marginBottom: 8 },
  actionButton: { backgroundColor: theme.colors.accentSoft, borderRadius: 12, paddingHorizontal: 11, paddingVertical: 8 },
  actionText: { color: theme.colors.primaryBright, fontSize: 11, fontWeight: '800' },
  attachments: { gap: 7, marginBottom: 9 },
  attachmentCard: { flexDirection: 'row-reverse', alignItems: 'center', gap: 8, padding: 7, borderRadius: 12, backgroundColor: theme.colors.surfaceSoft },
  attachmentImage: { width: 42, height: 42, borderRadius: 9, backgroundColor: theme.colors.surfaceRaised },
  fileIcon: { width: 42, height: 42, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.accentSoft },
  fileIconText: { color: theme.colors.primaryBright, fontSize: 18, fontWeight: '900' },
  attachmentTextWrap: { flex: 1, minWidth: 0 },
  attachmentName: { color: theme.colors.text, textAlign: 'right', fontSize: 11, fontWeight: '700' },
  attachmentMeta: { color: theme.colors.textDim, textAlign: 'right', fontSize: 9, marginTop: 2 },
});
