import { useEffect, useMemo, useState } from 'react';
import {
  listDesktopImageLibrary,
  setDesktopImageFavorite,
  type DesktopImageLibraryItem,
} from '../services/imageLibrary';

type FilterMode = 'all' | 'favorites';

export function DesktopImageStudio({
  onOpenConversation,
  onCreateImage,
}: {
  onOpenConversation: (conversationId: string) => void | Promise<void>;
  onCreateImage: () => void;
}) {
  const [items, setItems] = useState<DesktopImageLibraryItem[]>([]);
  const [filter, setFilter] = useState<FilterMode>('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const visibleItems = useMemo(
    () => filter === 'favorites' ? items.filter((item) => item.favorite) : items,
    [items, filter],
  );

  const favoriteCount = useMemo(() => items.filter((item) => item.favorite).length, [items]);

  useEffect(() => {
    void load(false);
  }, []);

  async function load(manual: boolean) {
    manual ? setRefreshing(true) : setLoading(true);
    setError('');
    try {
      setItems(await listDesktopImageLibrary());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'خواندن Image Studio ناموفق بود.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  async function toggleFavorite(item: DesktopImageLibraryItem) {
    if (busyId) return;
    const next = !item.favorite;
    setBusyId(item.id);
    setError('');
    setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, favorite: next } : entry));
    try {
      await setDesktopImageFavorite(item.id, next);
    } catch (caught) {
      setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, favorite: !next } : entry));
      setError(caught instanceof Error ? caught.message : 'تغییر Favorite ناموفق بود.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="desktop-image-studio">
      <div className="image-studio-hero glass">
        <div>
          <span className="image-studio-eyebrow">FARSIAI · IMAGE CLOUD</span>
          <h1>Image Studio</h1>
          <p>تمام تصاویر ساخته‌شده با همان حساب؛ همگام بین Windows و Mobile و آماده برای ویرایش دوباره.</p>
        </div>
        <div className="image-studio-hero-actions">
          <button className="secondary" disabled={refreshing} onClick={() => void load(true)}>{refreshing ? '…' : '↻ Refresh'}</button>
          <button className="primary image-create-cta" onClick={onCreateImage}>＋ ساخت تصویر جدید</button>
        </div>
      </div>

      <div className="image-studio-toolbar glass">
        <div className="image-filter-tabs">
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>همه تصاویر <b>{items.length}</b></button>
          <button className={filter === 'favorites' ? 'active' : ''} onClick={() => setFilter('favorites')}>منتخب‌ها <b>{favoriteCount}</b></button>
        </div>
        <span>Cloud Gallery · پیام‌های AI بدون تغییر باقی می‌مانند</span>
      </div>

      {error ? <div className="image-studio-error glass">{error}<button onClick={() => void load(true)}>تلاش دوباره</button></div> : null}

      {loading ? (
        <div className="image-studio-loading glass"><div className="loader-orb" /><strong>در حال همگام‌سازی گالری…</strong></div>
      ) : visibleItems.length === 0 ? (
        <div className="image-studio-empty glass">
          <div className="image-empty-icon">▧</div>
          <h2>{filter === 'favorites' ? 'هنوز تصویری Favorite نشده' : 'هنوز تصویری در Cloud Gallery نیست'}</h2>
          <p>{filter === 'favorites' ? 'از گالری اصلی روی ستاره هر تصویر بزن.' : 'اولین تصویر را بساز؛ بعد از ذخیره Conversation اینجا ظاهر می‌شود.'}</p>
          {filter === 'favorites' ? <button className="secondary" onClick={() => setFilter('all')}>نمایش همه تصاویر</button> : <button className="primary" onClick={onCreateImage}>شروع Image Studio</button>}
        </div>
      ) : (
        <div className="image-studio-grid">
          {visibleItems.map((item) => (
            <article className="image-library-card glass" key={item.id}>
              <div className="image-library-media">
                <img src={item.imageUrl} alt={item.title} loading="lazy" />
                <button
                  className={item.favorite ? 'image-favorite active' : 'image-favorite'}
                  disabled={busyId === item.id}
                  aria-label={item.favorite ? 'حذف از منتخب‌ها' : 'افزودن به منتخب‌ها'}
                  onClick={() => void toggleFavorite(item)}
                >{item.favorite ? '★' : '☆'}</button>
              </div>
              <div className="image-library-info">
                <div>
                  <strong title={item.title}>{item.title}</strong>
                  <span>{new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium' }).format(new Date(item.createdAt))}</span>
                </div>
                <button className="secondary compact" onClick={() => void onOpenConversation(item.conversationId)}>بازکردن گفتگو ↗</button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
