import React, { useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { sendAiRequest } from '../api';
import { MessageBubble } from '../components/MessageBubble';
import { theme } from '../theme';
import type { AppMode, UiMessage } from '../types';

const STARTERS = [
  'برای امروز یک برنامه مفید و واقع‌بینانه بساز',
  'یک متن حرفه‌ای برای معرفی کسب‌وکار من بنویس',
  'یک ایده خلاقانه برای تصویر آینده تهران پیشنهاد بده',
];

export function ChatScreen({
  mode,
  onModeChange,
  onCreditsChange,
}: {
  mode: Exclude<AppMode, 'video'>;
  onModeChange: (mode: AppMode) => void;
  onCreditsChange?: (credits: number) => void;
}) {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const listRef = useRef<FlatList<UiMessage>>(null);

  async function submit(prefill?: string) {
    const message = (prefill ?? input).trim();
    if (!message || loading) return;

    const userMessage: UiMessage = { id: `${Date.now()}-u`, role: 'user', text: message };
    setMessages((current) => [...current, userMessage]);
    setInput('');
    setLoading(true);

    try {
      const result = await sendAiRequest({
        mode,
        message,
        history: messages
          .filter((item) => item.text)
          .slice(-10)
          .map((item) => ({ role: item.role, content: item.text! })),
      });

      if (result.ok && typeof result.creditsRemaining === 'number') {
        onCreditsChange?.(result.creditsRemaining);
      }

      const assistant: UiMessage = !result.ok
        ? { id: `${Date.now()}-e`, role: 'assistant', text: result.error }
        : result.mode === 'image'
          ? { id: `${Date.now()}-i`, role: 'assistant', image: result.image, text: 'تصویر آماده شد ✨' }
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

  return (
    <View style={styles.wrap}>
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item) => item.id}
        contentContainerStyle={messages.length ? styles.list : styles.emptyList}
        renderItem={({ item }) => <MessageBubble item={item} />}
        ListEmptyComponent={<EmptyState mode={mode} onSelect={submit} />}
        ListFooterComponent={loading ? <Typing mode={mode} /> : null}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
      />

      <View style={styles.composerWrap}>
        {mode === 'image' ? (
          <View style={styles.modeHint}>
            <Text style={styles.modeHintText}>▧ ساخت تصویر روشن است</Text>
            <Pressable onPress={() => onModeChange('chat')}><Text style={styles.close}>×</Text></Pressable>
          </View>
        ) : null}
        <View style={styles.composer}>
          <Pressable style={styles.plus} onPress={() => onModeChange(mode === 'chat' ? 'image' : 'chat')}>
            <Text style={styles.plusText}>{mode === 'image' ? '▧' : '+'}</Text>
          </Pressable>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder={mode === 'image' ? 'تصویری که می‌خواهی را توصیف کن…' : 'هر چیزی می‌خواهی بپرس…'}
            placeholderTextColor={theme.colors.textDim}
            style={styles.input}
            multiline
            textAlign="right"
          />
          <Pressable style={[styles.send, (!input.trim() || loading) && styles.disabled]} disabled={!input.trim() || loading} onPress={() => submit()}>
            {loading ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.sendText}>↑</Text>}
          </Pressable>
        </View>
        <Text style={styles.disclaimer}>پاسخ‌های هوش مصنوعی ممکن است نیاز به بررسی داشته باشند.</Text>
      </View>
    </View>
  );
}

function EmptyState({ mode, onSelect }: { mode: 'chat' | 'image'; onSelect: (value: string) => void }) {
  return (
    <View style={styles.empty}>
      <View style={styles.heroOrb}><Text style={styles.heroOrbText}>{mode === 'image' ? '▧' : '✦'}</Text></View>
      <Text style={styles.heroTitle}>{mode === 'image' ? 'ایده‌ات را به تصویر تبدیل کن' : 'چطور می‌تونم کمکت کنم؟'}</Text>
      <Text style={styles.heroBody}>{mode === 'image' ? 'صحنه، سبک و جزئیات مورد نظرت را فارسی بنویس.' : 'سؤال، ایده یا کاری که می‌خواهی انجام شود را فارسی بنویس.'}</Text>
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
  return (
    <View style={styles.typing}>
      <ActivityIndicator size="small" color={theme.colors.primaryBright} />
      <Text style={styles.typingText}>{mode === 'image' ? 'در حال ساخت تصویر…' : 'در حال فکر کردن…'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  list: { paddingHorizontal: 14, paddingTop: 24, paddingBottom: 20, gap: 16 },
  emptyList: { flexGrow: 1, justifyContent: 'center' },
  empty: { paddingHorizontal: 24, alignItems: 'center', paddingBottom: 30 },
  heroOrb: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(139,92,246,0.14)', borderWidth: 1, borderColor: 'rgba(167,139,250,0.3)', marginBottom: 20 },
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
  modeHint: { alignSelf: 'flex-end', marginBottom: 7, flexDirection: 'row-reverse', alignItems: 'center', gap: 9, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10, backgroundColor: 'rgba(139,92,246,0.1)' },
  modeHintText: { color: theme.colors.primaryBright, fontSize: 11, fontWeight: '700' },
  close: { color: theme.colors.textMuted, fontSize: 17 },
  composer: { minHeight: 58, maxHeight: 140, borderRadius: 24, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceRaised, padding: 7, flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  plus: { width: 42, height: 42, borderRadius: 21, backgroundColor: theme.colors.surfaceSoft, alignItems: 'center', justifyContent: 'center' },
  plusText: { color: theme.colors.text, fontSize: 20, fontWeight: '500' },
  input: { flex: 1, minHeight: 42, maxHeight: 120, paddingHorizontal: 8, paddingVertical: 10, color: theme.colors.text, fontSize: 14, lineHeight: 20 },
  send: { width: 42, height: 42, borderRadius: 21, backgroundColor: theme.colors.primary, alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.35 },
  sendText: { color: '#fff', fontSize: 22, fontWeight: '700', marginTop: -2 },
  disclaimer: { color: theme.colors.textDim, fontSize: 9, textAlign: 'center', marginTop: 7 },
});
