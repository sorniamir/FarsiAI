import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { sendAiRequest } from '../api';
import { MessageBubble } from '../components/MessageBubble';
import { getConversationMessages } from '../services/history';
import { consumeGuestQuota } from '../services/quota';
import { useAppTheme } from '../ThemeProvider';
import type { AppTheme } from '../theme';
import type { AppMode, DailyQuota, UiAttachment, UiMessage } from '../types';

const STARTERS = [
  'برای امروز یک برنامه مفید و واقع‌بینانه بساز',
  'یک متن حرفه‌ای برای معرفی کسب‌وکار من بنویس',
  'یک ایده خلاقانه برای تصویر آینده تهران پیشنهاد بده',
];

const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 6 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 12 * 1024 * 1024;
const SUPPORTED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/xml',
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/svg+xml',
  'image/webp',
  'text/csv',
  'text/html',
  'text/plain',
]);

function attachmentId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function cleanFileName(value?: string | null): string {
  return (value || 'file').replace(/[\\/\u0000-\u001f]+/g, '_').slice(0, 180);
}

function totalAttachmentSize(items: UiAttachment[]): number {
  return items.reduce((sum, item) => sum + item.size, 0);
}

export function ChatScreen({
  mode,
  onModeChange,
  onQuotaChange,
  initialConversationId,
  isGuest,
  quota,
  onRequireAccount,
}: {
  mode: Exclude<AppMode, 'video'>;
  onModeChange: (mode: AppMode) => void;
  onQuotaChange: (quota: DailyQuota) => void;
  initialConversationId?: string;
  isGuest: boolean;
  quota: DailyQuota;
  onRequireAccount: () => void;
}) {
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>(initialConversationId);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<UiAttachment[]>([]);
  const [replyTarget, setReplyTarget] = useState<UiMessage | null>(null);
  const [loading, setLoading] = useState(false);
  const listRef = useRef<FlatList<UiMessage>>(null);

  useEffect(() => {
    if (!initialConversationId) return;
    setConversationId(initialConversationId);
    setReplyTarget(null);
    setAttachments([]);
    getConversationMessages(initialConversationId).then((rows) => {
      setMessages(rows.map((item) => ({ id: item.id, role: item.role, text: item.content, image: item.imageUrl })));
    });
  }, [initialConversationId]);

  useEffect(() => {
    if (mode !== 'image' && replyTarget) setReplyTarget(null);
  }, [mode, replyTarget]);

  function addAttachment(next: UiAttachment) {
    setAttachments((current) => {
      if (current.length >= MAX_ATTACHMENTS) {
        Alert.alert('تعداد فایل زیاد است', 'حداکثر ۴ فایل را می‌توان هم‌زمان ارسال کرد.');
        return current;
      }
      if (next.size > MAX_ATTACHMENT_BYTES) {
        Alert.alert('فایل بزرگ است', 'حجم هر فایل باید حداکثر ۶ مگابایت باشد.');
        return current;
      }
      if (totalAttachmentSize(current) + next.size > MAX_TOTAL_ATTACHMENT_BYTES) {
        Alert.alert('حجم فایل‌ها زیاد است', 'مجموع حجم فایل‌های ضمیمه باید حداکثر ۱۲ مگابایت باشد.');
        return current;
      }
      if (next.mimeType.startsWith('image/') && mode === 'image') setReplyTarget(null);
      return [...current, next];
    });
  }

  async function pickImage() {
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('دسترسی لازم است', 'برای انتخاب تصویر، دسترسی گالری را برای FarsiAI فعال کنید.');
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: false,
        base64: true,
        quality: 0.9,
      });
      if (result.canceled || !result.assets[0]) return;

      const asset = result.assets[0];
      const base64 = asset.base64 || await new File(asset.uri).base64();
      const size = asset.fileSize ?? Math.floor((base64.length * 3) / 4);
      addAttachment({
        id: attachmentId(),
        name: cleanFileName(asset.fileName || `image-${Date.now()}.jpg`),
        mimeType: 'image/jpeg',
        size,
        dataUrl: `data:image/jpeg;base64,${base64}`,
        previewUri: asset.uri,
      });
    } catch (error) {
      Alert.alert('انتخاب تصویر ناموفق بود', error instanceof Error ? error.message : 'دوباره تلاش کنید.');
    }
  }

  async function pickFiles() {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;

      for (const asset of result.assets.slice(0, MAX_ATTACHMENTS)) {
        const mimeType = (asset.mimeType || 'application/octet-stream').toLowerCase();
        if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
          Alert.alert('فرمت پشتیبانی نمی‌شود', `فایل «${cleanFileName(asset.name)}» فعلاً قابل پردازش نیست.`);
          continue;
        }
        const size = Number(asset.size || 0);
        if (size > MAX_ATTACHMENT_BYTES) {
          Alert.alert('فایل بزرگ است', `فایل «${cleanFileName(asset.name)}» بیشتر از ۶ مگابایت است.`);
          continue;
        }
        const base64 = await new File(asset.uri).base64();
        const effectiveSize = size || Math.floor((base64.length * 3) / 4);
        addAttachment({
          id: attachmentId(),
          name: cleanFileName(asset.name),
          mimeType,
          size: effectiveSize,
          dataUrl: `data:${mimeType};base64,${base64}`,
          previewUri: mimeType.startsWith('image/') ? asset.uri : undefined,
        });
      }
    } catch (error) {
      Alert.alert('انتخاب فایل ناموفق بود', error instanceof Error ? error.message : 'دوباره تلاش کنید.');
    }
  }

  function openAttachmentMenu() {
    if (loading) return;
    Alert.alert('افزودن به پیام', 'چه چیزی می‌خواهید اضافه کنید؟', [
      { text: 'تصویر از گالری', onPress: () => void pickImage() },
      { text: 'فایل', onPress: () => void pickFiles() },
      { text: 'لغو', style: 'cancel' },
    ]);
  }

  function replyToImage(item: UiMessage) {
    if (!item.image) return;
    setReplyTarget(item);
    setAttachments((current) => current.filter((attachment) => !attachment.mimeType.startsWith('image/')));
    if (mode !== 'image') onModeChange('image');
  }

  function removeAttachment(id: string) {
    setAttachments((current) => current.filter((item) => item.id !== id));
  }

  async function submit(prefill?: string) {
    const typedMessage = (prefill ?? input).trim();
    const fallbackMessage = mode === 'chat' && attachments.length > 0
      ? 'فایل‌های ضمیمه‌شده را بررسی کن و نکات مهم را توضیح بده.'
      : '';
    const message = typedMessage || fallbackMessage;
    if (!message || loading) return;

    const remaining = mode === 'chat' ? quota.chatRemaining : quota.imageRemaining;
    if (remaining <= 0) {
      setMessages((current) => [...current, {
        id: `${Date.now()}-limit`,
        role: 'assistant',
        text: isGuest
          ? 'سهمیه مهمان تمام شد. برای ادامه یک حساب رایگان بساز.'
          : mode === 'chat'
            ? 'سهمیه ۱۰ پیام امروز تمام شده است. فردا دوباره شارژ می‌شود.'
            : 'سهمیه ۴ تصویر امروز تمام شده است. فردا دوباره شارژ می‌شود.',
      }]);
      if (isGuest) {
        Alert.alert('سهمیه مهمان تمام شد', 'برای دریافت سهمیه روزانه، حساب رایگان بساز.', [
          { text: 'بعداً', style: 'cancel' },
          { text: 'ساخت حساب', onPress: onRequireAccount },
        ]);
      }
      return;
    }

    const requestAttachments = attachments;
    const requestReply = replyTarget;
    const attachedImage = requestAttachments.find((item) => item.mimeType.startsWith('image/'));
    const imageAction: 'generate' | 'edit' = mode === 'image' && (requestReply?.image || attachedImage)
      ? 'edit'
      : 'generate';

    const userMessage: UiMessage = {
      id: `${Date.now()}-u`,
      role: 'user',
      text: typedMessage || undefined,
      attachments: requestAttachments,
      replyToId: requestReply?.id,
    };
    setMessages((current) => [...current, userMessage]);
    setInput('');
    setAttachments([]);
    setReplyTarget(null);
    setLoading(true);

    try {
      const result = await sendAiRequest({
        mode,
        message,
        conversationId,
        history: messages
          .filter((item) => item.text)
          .slice(-10)
          .map((item) => ({ role: item.role, content: item.text! })),
        attachments: requestAttachments,
        imageAction: mode === 'image' ? imageAction : undefined,
        referenceImage: mode === 'image' && imageAction === 'edit' ? requestReply?.image : undefined,
        referencePrompt: mode === 'image' && imageAction === 'edit' ? requestReply?.revisedPrompt : undefined,
        replyToMessageId: requestReply?.id,
      });

      if (result.ok) {
        if (result.quota) onQuotaChange(result.quota);
        else if (isGuest) {
          const guestQuota = consumeGuestQuota(mode);
          if (guestQuota) onQuotaChange(guestQuota);
        }
        if (result.conversationId) setConversationId(result.conversationId);
      }

      const assistant: UiMessage = !result.ok
        ? { id: `${Date.now()}-e`, role: 'assistant', text: result.error }
        : result.mode === 'image'
          ? {
              id: `${Date.now()}-i`,
              role: 'assistant',
              image: result.image,
              revisedPrompt: result.revisedPrompt,
              text: result.edited ? 'ویرایش تصویر آماده شد ✦' : 'تصویر جدید آماده شد ✦',
            }
          : { id: `${Date.now()}-a`, role: 'assistant', text: result.text };

      setMessages((current) => [...current, assistant]);
    } catch {
      setMessages((current) => [
        ...current,
        { id: `${Date.now()}-x`, role: 'assistant', text: 'در ارتباط با سرویس مشکلی پیش آمد. دوباره امتحان کن.' },
      ]);
    } finally {
      setLoading(false);
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
    }
  }

  const canSend = !loading && (input.trim().length > 0 || (mode === 'chat' && attachments.length > 0));

  return (
    <View style={styles.wrap}>
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item) => item.id}
        contentContainerStyle={messages.length ? styles.list : styles.emptyList}
        renderItem={({ item }) => <MessageBubble item={item} onReplyImage={item.role === 'assistant' && item.image ? replyToImage : undefined} />}
        ListEmptyComponent={<EmptyState mode={mode} onSelect={submit} />}
        ListFooterComponent={loading ? <Typing mode={mode} /> : null}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
      />

      <View style={styles.composerWrap}>
        {replyTarget?.image ? (
          <View style={styles.replyBar}>
            <Pressable onPress={() => setReplyTarget(null)} style={styles.replyClose}><Text style={styles.close}>×</Text></Pressable>
            <View style={styles.replyTextWrap}>
              <Text style={styles.replyTitle}>ویرایش همین تصویر</Text>
              <Text style={styles.replyText}>درخواست بعدی فقط روی این تصویر اعمال می‌شود.</Text>
            </View>
            <Image source={{ uri: replyTarget.image }} style={styles.replyImage} />
          </View>
        ) : null}

        {attachments.length ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.attachmentStrip}>
            {attachments.map((attachment) => (
              <View key={attachment.id} style={styles.pendingAttachment}>
                {attachment.mimeType.startsWith('image/') ? (
                  <Image source={{ uri: attachment.previewUri || attachment.dataUrl }} style={styles.pendingImage} />
                ) : (
                  <View style={styles.pendingFile}><Text style={styles.pendingFileText}>FILE</Text></View>
                )}
                <Text numberOfLines={1} style={styles.pendingName}>{attachment.name}</Text>
                <Pressable onPress={() => removeAttachment(attachment.id)} style={styles.pendingRemove}><Text style={styles.pendingRemoveText}>×</Text></Pressable>
              </View>
            ))}
          </ScrollView>
        ) : null}

        {mode === 'image' ? (
          <View style={styles.modeHint}>
            <Text style={styles.modeHintText}>{replyTarget || attachments.some((item) => item.mimeType.startsWith('image/')) ? '▧ ویرایش تصویر روشن است' : '▧ ساخت تصویر جدید روشن است'}</Text>
            <Pressable onPress={() => { setReplyTarget(null); onModeChange('chat'); }}><Text style={styles.close}>×</Text></Pressable>
          </View>
        ) : null}

        <View style={styles.composer}>
          <Pressable style={styles.plus} onPress={openAttachmentMenu} disabled={loading}>
            <Text style={styles.plusText}>＋</Text>
          </Pressable>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder={mode === 'image' ? 'تصویری که می‌خواهی را توصیف کن…' : 'پیام بنویس یا فایل اضافه کن…'}
            placeholderTextColor={theme.colors.textDim}
            style={styles.input}
            multiline
            textAlign="right"
          />
          <Pressable style={[styles.send, !canSend && styles.disabled]} disabled={!canSend} onPress={() => submit()}>
            {loading ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.sendText}>↑</Text>}
          </Pressable>
        </View>
        <Text style={styles.disclaimer}>ویرایش تصویر فقط با ریپلای یا ضمیمه‌کردن تصویر انجام می‌شود.</Text>
      </View>
    </View>
  );
}

function EmptyState({ mode, onSelect }: { mode: 'chat' | 'image'; onSelect: (value: string) => void }) {
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <View style={styles.empty}>
      <View style={styles.heroOrb}><Text style={styles.heroOrbText}>{mode === 'image' ? '▧' : '✦'}</Text></View>
      <Text style={styles.heroTitle}>{mode === 'image' ? 'ایده‌ات را به تصویر تبدیل کن' : 'چطور می‌تونم کمکت کنم؟'}</Text>
      <Text style={styles.heroBody}>{mode === 'image' ? 'صحنه، سبک و جزئیات موردنظرت را فارسی بنویس.' : 'سؤال، ایده یا فایل موردنظرت را ارسال کن.'}</Text>
      <View style={styles.starters}>
        {STARTERS.map((item) => (
          <Pressable key={item} style={styles.starter} onPress={() => onSelect(item)}>
            <Text style={styles.starterText}>{item}</Text><Text style={styles.arrow}>‹</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function Typing({ mode }: { mode: 'chat' | 'image' }) {
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <View style={styles.typing}>
      <ActivityIndicator size="small" color={theme.colors.primaryBright} />
      <Text style={styles.typingText}>{mode === 'image' ? 'در حال پردازش تصویر…' : 'در حال فکر کردن…'}</Text>
    </View>
  );
}

const createStyles = (theme: AppTheme) => StyleSheet.create({
  wrap: { flex: 1 },
  list: { paddingHorizontal: 14, paddingTop: 24, paddingBottom: 20, gap: 16 },
  emptyList: { flexGrow: 1, justifyContent: 'center' },
  empty: { paddingHorizontal: 24, alignItems: 'center', paddingBottom: 30 },
  heroOrb: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.accentSoft, borderWidth: 1, borderColor: theme.colors.primary, marginBottom: 20 },
  heroOrbText: { color: theme.colors.primaryBright, fontSize: 28, fontWeight: '900' },
  heroTitle: { color: theme.colors.text, fontSize: 25, fontWeight: '800', marginBottom: 10, textAlign: 'center' },
  heroBody: { color: theme.colors.textMuted, lineHeight: 23, fontSize: 14, textAlign: 'center', maxWidth: 330 },
  starters: { width: '100%', marginTop: 28, gap: 10 },
  starter: { minHeight: 58, borderRadius: 18, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface, paddingHorizontal: 16, flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' },
  starterText: { color: theme.colors.text, fontSize: 13, textAlign: 'right', flex: 1 },
  arrow: { color: theme.colors.textDim, fontSize: 22, marginRight: 10 },
  typing: { marginHorizontal: 14, marginBottom: 12, flexDirection: 'row-reverse', alignItems: 'center', gap: 10 },
  typingText: { color: theme.colors.textMuted, fontSize: 12 },
  composerWrap: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 12, backgroundColor: theme.colors.background },
  replyBar: { marginBottom: 8, minHeight: 62, flexDirection: 'row', alignItems: 'center', gap: 9, padding: 8, borderRadius: 15, borderWidth: 1, borderColor: theme.colors.primary, backgroundColor: theme.colors.surfaceRaised },
  replyClose: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surfaceSoft },
  replyImage: { width: 46, height: 46, borderRadius: 10, backgroundColor: theme.colors.surfaceSoft },
  replyTextWrap: { flex: 1 },
  replyTitle: { color: theme.colors.primaryBright, fontSize: 12, fontWeight: '800', textAlign: 'right' },
  replyText: { color: theme.colors.textMuted, fontSize: 10, marginTop: 3, textAlign: 'right' },
  attachmentStrip: { flexDirection: 'row-reverse', gap: 8, paddingBottom: 8 },
  pendingAttachment: { width: 112, minHeight: 72, borderRadius: 14, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceRaised, padding: 7, position: 'relative' },
  pendingImage: { width: '100%', height: 58, borderRadius: 9, backgroundColor: theme.colors.surfaceSoft },
  pendingFile: { height: 58, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.accentSoft },
  pendingFileText: { color: theme.colors.primaryBright, fontSize: 10, fontWeight: '900' },
  pendingName: { color: theme.colors.textMuted, fontSize: 9, marginTop: 5, textAlign: 'center' },
  pendingRemove: { position: 'absolute', top: 3, right: 3, width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.7)' },
  pendingRemoveText: { color: '#fff', fontSize: 15, lineHeight: 17 },
  modeHint: { alignSelf: 'flex-end', marginBottom: 7, flexDirection: 'row-reverse', alignItems: 'center', gap: 9, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10, backgroundColor: theme.colors.accentSoft },
  modeHintText: { color: theme.colors.primaryBright, fontSize: 11, fontWeight: '700' },
  close: { color: theme.colors.textMuted, fontSize: 17 },
  composer: { minHeight: 58, maxHeight: 140, borderRadius: 24, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceRaised, padding: 7, flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  plus: { width: 42, height: 42, borderRadius: 21, backgroundColor: theme.colors.surfaceSoft, alignItems: 'center', justifyContent: 'center' },
  plusText: { color: theme.colors.text, fontSize: 20, fontWeight: '500' },
  input: { flex: 1, minHeight: 42, maxHeight: 120, paddingHorizontal: 8, paddingVertical: 10, color: theme.colors.text, fontSize: 14, lineHeight: 20 },
  send: { width: 42, height: 42, borderRadius: 21, backgroundColor: theme.colors.primary, alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.35 },
  sendText: { color: theme.colors.onAccent, fontSize: 22, fontWeight: '700', marginTop: -2 },
  disclaimer: { color: theme.colors.textDim, fontSize: 9, textAlign: 'center', marginTop: 7 },
});
