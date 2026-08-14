import { supabase } from '../lib/supabase';

export type DesktopImageLibraryItem = {
  id: string;
  imageUrl: string;
  conversationId: string;
  title: string;
  createdAt: string;
  favorite: boolean;
};

type ConversationRelation = { title?: string | null } | Array<{ title?: string | null }> | null;
type ImageRow = {
  id?: unknown;
  image_url?: unknown;
  conversation_id?: unknown;
  created_at?: unknown;
  conversations?: ConversationRelation;
};

type FavoriteRow = { message_id?: unknown };

function titleFromRelation(value: ConversationRelation): string {
  const row = Array.isArray(value) ? value[0] : value;
  const title = typeof row?.title === 'string' ? row.title.trim() : '';
  return title || 'تصویر FarsiAI';
}

export async function listDesktopImageLibrary(): Promise<DesktopImageLibraryItem[]> {
  if (!supabase) return [];

  const [imagesResult, favoritesResult] = await Promise.all([
    supabase
      .from('messages')
      .select('id,image_url,conversation_id,created_at,conversations(title)')
      .eq('role', 'assistant')
      .not('image_url', 'is', null)
      .order('created_at', { ascending: false })
      .limit(80),
    supabase
      .from('image_favorites')
      .select('message_id')
      .order('created_at', { ascending: false })
      .limit(250),
  ]);

  if (imagesResult.error) throw new Error('خواندن Image Gallery ناموفق بود.');
  if (favoritesResult.error) throw new Error('خواندن Favorites ناموفق بود.');

  const favoriteIds = new Set(
    ((favoritesResult.data ?? []) as FavoriteRow[])
      .map((row) => typeof row.message_id === 'string' ? row.message_id : '')
      .filter(Boolean),
  );

  return ((imagesResult.data ?? []) as ImageRow[]).flatMap((row) => {
    if (
      typeof row.id !== 'string'
      || typeof row.image_url !== 'string'
      || typeof row.conversation_id !== 'string'
      || typeof row.created_at !== 'string'
    ) return [];

    return [{
      id: row.id,
      imageUrl: row.image_url,
      conversationId: row.conversation_id,
      title: titleFromRelation(row.conversations ?? null),
      createdAt: row.created_at,
      favorite: favoriteIds.has(row.id),
    }];
  });
}

export async function setDesktopImageFavorite(messageId: string, favorite: boolean): Promise<void> {
  if (!supabase) throw new Error('اتصال حساب کاربری در دسترس نیست.');
  const { data: authData, error: authError } = await supabase.auth.getUser();
  const userId = authData.user?.id;
  if (authError || !userId) throw new Error('برای Favorite کردن تصویر دوباره وارد حساب شوید.');

  if (favorite) {
    const { error } = await supabase.from('image_favorites').insert({ user_id: userId, message_id: messageId });
    if (error) throw new Error('ذخیره Favorite ناموفق بود.');
    return;
  }

  const { error } = await supabase
    .from('image_favorites')
    .delete()
    .eq('user_id', userId)
    .eq('message_id', messageId);
  if (error) throw new Error('حذف Favorite ناموفق بود.');
}
