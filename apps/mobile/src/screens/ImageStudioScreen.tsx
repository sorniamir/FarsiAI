import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useAppTheme } from '../ThemeProvider';
import type { AppTheme } from '../theme';
import { listImageLibrary, setImageFavorite, type ImageLibraryItem } from '../services/imageLibrary';

function formatDate(value: string): string {
  try {
    return new Intl.DateTimeFormat('fa-IR', { month: 'short', day: 'numeric' }).format(new Date(value));
  } catch {
    return '';
  }
}

export function ImageStudioScreen({
  isGuest,
  onCreateImage,
  onOpenConversation,
  onRequireAccount,
}: {
  isGuest: boolean;
  onCreateImage: () => void;
  onOpenConversation: (conversationId: string) => void;
  onRequireAccount: () => void;
}) {
  const { theme } = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [items, setItems] = useState<ImageLibraryItem[]>([]);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [loading, setLoading] = useState(!isGuest);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [pendingFavorite, setPendingFavorite] = useState<string | null>(null);

  async function load(refresh = false) {
    if (isGuest) return;
    refresh ? setRefreshing(true) : setLoading(true);
    setError('');
    try {
      setItems(await listImageLibrary());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'خواندن Image Studio ناموفق بود.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void load();
  }, [isGuest]);

  async function toggleFavorite(item: ImageLibraryItem) {
    if (pendingFavorite) return;
    const next = !item.favorite;
    setPendingFavorite(item.id);
    setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, favorite: next } : entry));
    try {
      await setImageFavorite(item.id, next);
    } catch (caught) {
      setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, favorite: item.favorite } : entry));
      setError(caught instanceof Error ? caught.message : 'تغییر Favorite ناموفق بود.');
    } finally {
      setPendingFavorite(null);
    }
  }

  if (isGuest) {
    return (
      <View style={styles.guestWrap}>
        <View style={styles.heroOrb}><Text style={styles.heroOrbText}>▧</Text></View>
        <Text style={styles.heroTitle}>Image Studio Cloud</Text>
        <Text style={styles.heroBody}>برای Gallery، Favorites و Sync تصاویر بین موبایل و دسکتاپ وارد حساب FarsiAI شوید.</Text>
        <Pressable style={({ pressed }) => [styles.primary, pressed && styles.pressed]} onPress={onRequireAccount}>
          <Text style={styles.primaryText}>ورود به حساب</Text>
        </Pressable>
        <Pressable style={({ pressed }) => [styles.secondary, pressed && styles.pressed]} onPress={onCreateImage}>
          <Text style={styles.secondaryText}>ساخت تصویر در حالت مهمان</Text>
        </Pressable>
      </View>
    );
  }

  const visibleItems = favoritesOnly ? items.filter((item) => item.favorite) : items;

  return (
    <View style={styles.screen}>
      <FlatList
        data={visibleItems}
        keyExtractor={(item) => item.id}
        numColumns={2}
        columnWrapperStyle={styles.column}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} tintColor={theme.colors.primaryBright} />}
        ListHeaderComponent={(
          <View style={styles.header}>
            <View style={styles.eyebrowRow}><View style={styles.dot} /><Text style={styles.eyebrow}>FARSIAI IMAGE STUDIO</Text></View>
            <Text style={styles.title}>گالری تصاویر شما</Text>
            <Text style={styles.subtitle}>تصاویر ساخته‌شده با حساب شما از Cloud خوانده می‌شوند و Favorites روی همه دستگاه‌ها همگام می‌ماند.</Text>
            <View style={styles.actions}>
              <Pressable style={({ pressed }) => [styles.primaryCompact, pressed && styles.pressed]} onPress={onCreateImage}>
                <Text style={styles.primaryText}>＋ ساخت تصویر</Text>
              </Pressable>
              <Pressable style={({ pressed }) => [styles.filter, favoritesOnly && styles.filterActive, pressed && styles.pressed]} onPress={() => setFavoritesOnly((value) => !value)}>
                <Text style={[styles.filterText, favoritesOnly && styles.filterTextActive]}>{favoritesOnly ? '★ Favorites' : '☆ فقط Favorites'}</Text>
              </Pressable>
            </View>
            {error ? <View style={styles.error}><Text style={styles.errorText}>{error}</Text></View> : null}
          </View>
        )}
        ListEmptyComponent={loading ? (
          <View style={styles.empty}><ActivityIndicator color={theme.colors.primaryBright} /><Text style={styles.emptyText}>در حال بارگذاری Gallery…</Text></View>
        ) : (
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>{favoritesOnly ? '☆' : '▧'}</Text>
            <Text style={styles.emptyTitle}>{favoritesOnly ? 'هنوز Favorite نداری' : 'هنوز تصویری ذخیره نشده'}</Text>
            <Text style={styles.emptyText}>{favoritesOnly ? 'از Gallery روی ستاره تصاویر دلخواه بزن.' : 'اولین تصویر را بساز تا اینجا به‌صورت Cloud ذخیره شود.'}</Text>
          </View>
        )}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <Image source={{ uri: item.imageUrl }} style={styles.image} resizeMode="cover" />
            <View style={styles.cardBody}>
              <Text style={styles.cardTitle} numberOfLines={2}>{item.title}</Text>
              <Text style={styles.cardDate}>{formatDate(item.createdAt)}</Text>
              <View style={styles.cardActions}>
                <Pressable
                  style={({ pressed }) => [styles.iconButton, item.favorite && styles.iconButtonActive, pressed && styles.pressed]}
                  disabled={pendingFavorite === item.id}
                  onPress={() => void toggleFavorite(item)}
                  accessibilityLabel={item.favorite ? 'حذف از علاقه‌مندی‌ها' : 'افزودن به علاقه‌مندی‌ها'}
                >
                  <Text style={[styles.iconText, item.favorite && styles.iconTextActive]}>{item.favorite ? '★' : '☆'}</Text>
                </Pressable>
                <Pressable style={({ pressed }) => [styles.openButton, pressed && styles.pressed]} onPress={() => onOpenConversation(item.conversationId)}>
                  <Text style={styles.openText}>بازکردن گفتگو</Text>
                </Pressable>
              </View>
            </View>
          </View>
        )}
      />
    </View>
  );
}

const createStyles = (theme: AppTheme) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  content: { paddingHorizontal: 14, paddingTop: 18, paddingBottom: 24 },
  column: { gap: 10 },
  header: { marginBottom: 18 },
  eyebrowRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 7 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.primaryBright },
  eyebrow: { color: theme.colors.primaryBright, fontSize: 9, fontWeight: '900', letterSpacing: 1.1 },
  title: { color: theme.colors.text, fontSize: 26, fontWeight: '900', textAlign: 'right', marginTop: 9 },
  subtitle: { color: theme.colors.textMuted, fontSize: 11, lineHeight: 19, textAlign: 'right', marginTop: 7 },
  actions: { flexDirection: 'row-reverse', gap: 8, marginTop: 15 },
  primary: { marginTop: 18, minWidth: 220, alignItems: 'center', backgroundColor: theme.colors.primary, borderRadius: 17, paddingHorizontal: 18, paddingVertical: 14 },
  primaryCompact: { flex: 1, alignItems: 'center', backgroundColor: theme.colors.primary, borderRadius: 15, paddingHorizontal: 13, paddingVertical: 12 },
  primaryText: { color: theme.colors.onAccent, fontSize: 11, fontWeight: '900' },
  secondary: { marginTop: 9, minWidth: 220, alignItems: 'center', backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 17, paddingHorizontal: 18, paddingVertical: 14 },
  secondaryText: { color: theme.colors.text, fontSize: 11, fontWeight: '800' },
  filter: { flex: 1, alignItems: 'center', justifyContent: 'center', borderRadius: 15, paddingHorizontal: 12, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface },
  filterActive: { borderColor: theme.colors.borderStrong, backgroundColor: theme.colors.accentSoft },
  filterText: { color: theme.colors.textMuted, fontSize: 10, fontWeight: '800' },
  filterTextActive: { color: theme.colors.primaryBright },
  error: { marginTop: 12, borderRadius: 14, borderWidth: 1, borderColor: 'rgba(255,96,120,0.22)', backgroundColor: 'rgba(255,96,120,0.07)', padding: 10 },
  errorText: { color: theme.colors.danger, textAlign: 'right', fontSize: 10, lineHeight: 17 },
  card: { flex: 1, minWidth: 0, marginBottom: 10, borderRadius: 20, overflow: 'hidden', borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface, shadowColor: theme.colors.shadow, shadowOpacity: theme.mode === 'dark' ? 0.28 : 0.08, shadowRadius: 12, shadowOffset: { width: 0, height: 7 }, elevation: 3 },
  image: { width: '100%', aspectRatio: 1, backgroundColor: theme.colors.surfaceSoft },
  cardBody: { padding: 10 },
  cardTitle: { color: theme.colors.text, fontSize: 10, lineHeight: 16, textAlign: 'right', fontWeight: '800', minHeight: 32 },
  cardDate: { color: theme.colors.textDim, fontSize: 8.5, textAlign: 'right', marginTop: 5 },
  cardActions: { flexDirection: 'row-reverse', alignItems: 'center', gap: 6, marginTop: 9 },
  iconButton: { width: 34, height: 34, borderRadius: 11, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceSoft },
  iconButtonActive: { borderColor: theme.colors.borderStrong, backgroundColor: theme.colors.accentSoft },
  iconText: { color: theme.colors.textMuted, fontSize: 18 },
  iconTextActive: { color: theme.colors.primaryBright },
  openButton: { flex: 1, minHeight: 34, alignItems: 'center', justifyContent: 'center', borderRadius: 11, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceSoft },
  openText: { color: theme.colors.text, fontSize: 8.5, fontWeight: '800' },
  empty: { alignItems: 'center', justifyContent: 'center', paddingVertical: 54, paddingHorizontal: 25, gap: 8 },
  emptyIcon: { color: theme.colors.primaryBright, fontSize: 30 },
  emptyTitle: { color: theme.colors.text, fontSize: 15, fontWeight: '900', textAlign: 'center' },
  emptyText: { color: theme.colors.textMuted, fontSize: 11, lineHeight: 18, textAlign: 'center' },
  guestWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28, backgroundColor: theme.colors.background },
  heroOrb: { width: 82, height: 82, borderRadius: 27, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.accentSoft, borderWidth: 1, borderColor: theme.colors.borderStrong, shadowColor: theme.colors.primary, shadowOpacity: theme.mode === 'dark' ? 0.3 : 0.12, shadowRadius: 20, elevation: 5 },
  heroOrbText: { color: theme.colors.primaryBright, fontSize: 31, fontWeight: '900' },
  heroTitle: { color: theme.colors.text, fontSize: 23, fontWeight: '900', marginTop: 18, textAlign: 'center' },
  heroBody: { color: theme.colors.textMuted, fontSize: 12, lineHeight: 20, textAlign: 'center', maxWidth: 330, marginTop: 8 },
  pressed: { opacity: 0.72, transform: [{ scale: 0.98 }] },
});
