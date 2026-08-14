import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import type { User } from '@supabase/supabase-js';
import { DesktopVoiceChat } from './components/DesktopVoiceChat';
import { CodexStudio } from './components/CodexStudio';
import { DesktopImageStudio } from './components/DesktopImageStudio';
import { prepareAttachments } from './lib/chatAttachments';
import { sendAiRequest, type AiMode, type ApiAttachment, type DailyQuota } from './services/api';
import { getCurrentUser, onAuthChanged, signIn, signOut, signUp } from './services/auth';
import {
  getAccountSnapshot,
  getConversationMessages,
  getCurrentDailyQuota,
  listConversations,
  type AccountSnapshot,
  type ConversationSummary,
} from './services/data';

type Tab = 'chat' | 'imageStudio' | 'voice' | 'codex';
type UiMessage = {
  id: string;
  role: 'user' | 'assistant';
  text?: string;
  image?: string;
  revisedPrompt?: string;
  attachments?: ApiAttachment[];
  replyToId?: string;
};

const USER_FULL_QUOTA: DailyQuota = { chatRemaining: 10, imageRemaining: 4 };
const GUEST_FULL_QUOTA: DailyQuota = { chatRemaining: 5, imageRemaining: 2 };
const STARTERS = [
  'برای امروز یک برنامه کاری حرفه‌ای بساز',
  'این ایده را تبدیل به یک برنامه اجرایی کن',
  'برای محصول من یک متن معرفی حرفه‌ای بنویس',
];
const ATTACH_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/bmp,image/svg+xml,.pdf,.docx,.xlsx,.xls,.csv,.txt,.html,.xml,.odt,.ods';

function formatDate(value: string): string {
  try {
    return new Intl.DateTimeFormat('fa-IR', { month: 'short', day: 'numeric' }).format(new Date(value));
  } catch {
    return '';
  }
}

function formatFileSize(size: number): string {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function quotaSummary(quota: DailyQuota, guest: boolean): string {
  if (quota.unlimited) return 'Chat و Image نامحدود';
  return `Chat ${quota.chatRemaining} · Image ${quota.imageRemaining}${guest ? ' · Guest' : ''}`;
}

export default function AppFinal() {
  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [guestMode, setGuestMode] = useState(false);
  const [tab, setTab] = useState<Tab>('chat');
  const [account, setAccount] = useState<AccountSnapshot>({ plan: 'free' });
  const [quota, setQuota] = useState<DailyQuota | undefined>();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [mode, setMode] = useState<AiMode>('chat');
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<ApiAttachment[]>([]);
  const [replyTarget, setReplyTarget] = useState<UiMessage | null>(null);
  const [composerError, setComposerError] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const dragDepthRef = useRef(0);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let mounted = true;
    getCurrentUser().then((current) => {
      if (!mounted) return;
      setUser(current);
      setGuestMode(false);
      setAuthReady(true);
    });
    const unsubscribe = onAuthChanged((current) => {
      if (!mounted) return;
      setUser(current);
      if (current) setGuestMode(false);
    });
    return () => {
      mounted = false;
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (user) {
      void refreshCloudState();
      return;
    }
    setAccount({ plan: 'free' });
    setConversations([]);
    setConversationId(undefined);
    if (guestMode) setQuota(GUEST_FULL_QUOTA);
  }, [user, guestMode]);

  async function refreshCloudState() {
    if (!user) return;
    const [nextAccount, nextConversations, nextQuota] = await Promise.all([
      getAccountSnapshot(),
      listConversations(),
      getCurrentDailyQuota(),
    ]);
    setAccount(nextAccount);
    setConversations(nextConversations);
    setQuota(nextQuota);
  }

  function resetComposer() {
    setAttachments([]);
    setReplyTarget(null);
    setComposerError('');
    setDragActive(false);
    dragDepthRef.current = 0;
  }

  function enterGuest() {
    setGuestMode(true);
    setQuota(GUEST_FULL_QUOTA);
    setMessages([]);
    setConversationId(undefined);
    resetComposer();
    setTab('chat');
  }

  async function leaveSession() {
    if (user) await signOut();
    setGuestMode(false);
    setUser(null);
    setMessages([]);
    setConversationId(undefined);
    setQuota(undefined);
    resetComposer();
    setTab('chat');
  }

  function setChatMode(next: AiMode) {
    setMode(next);
    if (next !== 'image') setReplyTarget(null);
    setComposerError('');
  }

  async function handleAttachmentFiles(fileList: FileList | null) {
    if (!fileList?.length || sending) return;
    try {
      const result = await prepareAttachments(Array.from(fileList), attachments);
      if (result.accepted.length) {
        if (mode === 'image' && result.accepted.some((item) => item.mimeType.startsWith('image/'))) {
          setReplyTarget(null);
        }
        setAttachments((current) => [...current, ...result.accepted]);
      }
      setComposerError(result.errors.join(' '));
    } catch (error) {
      setComposerError(error instanceof Error ? error.message : 'خواندن فایل ناموفق بود.');
    } finally {
      if (attachmentInputRef.current) attachmentInputRef.current.value = '';
    }
  }

  function handleDragEnter(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (sending || !event.dataTransfer.types.includes('Files')) return;
    dragDepthRef.current += 1;
    setDragActive(true);
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (event.dataTransfer.types.includes('Files')) event.dataTransfer.dropEffect = 'copy';
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    if (sending) return;
    void handleAttachmentFiles(event.dataTransfer.files);
  }

  function removeAttachment(id: string) {
    setAttachments((current) => current.filter((item) => item.id !== id));
  }

  function replyToImage(message: UiMessage) {
    if (!message.image) return;
    setMode('image');
    setReplyTarget(message);
    setAttachments((current) => current.filter((item) => !item.mimeType.startsWith('image/')));
    setComposerError('');
  }

  async function copyMessage(message: UiMessage) {
    const value = message.text?.trim() || message.revisedPrompt?.trim();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopiedMessageId(message.id);
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopiedMessageId(null), 1400);
    } catch {
      setComposerError('کپی متن در این محیط در دسترس نیست.');
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    void submitChat();
  }

  async function submitChat(prefill?: string) {
    const typedText = (prefill ?? input).trim();
    const fallbackText = mode === 'chat' && attachments.length > 0
      ? 'فایل‌های ضمیمه‌شده را بررسی کن و نکات مهم را توضیح بده.'
      : '';
    const text = typedText || fallbackText;
    if (!text || sending) return;

    const before = messages;
    const requestAttachments = attachments;
    const requestReply = replyTarget;
    const attachedImage = requestAttachments.find((item) => item.mimeType.startsWith('image/'));
    const imageAction: 'generate' | 'edit' = mode === 'image' && (requestReply?.image || attachedImage)
      ? 'edit'
      : 'generate';

    setMessages((current) => [...current, {
      id: `${Date.now()}-u`,
      role: 'user',
      text: typedText || undefined,
      attachments: requestAttachments,
      replyToId: requestReply?.id,
    }]);
    setInput('');
    resetComposer();
    setSending(true);

    try {
      const result = await sendAiRequest({
        mode,
        message: text,
        conversationId: user ? conversationId : undefined,
        history: before
          .filter((item) => item.text)
          .slice(-10)
          .map((item) => ({ role: item.role, content: item.text! })),
        attachments: requestAttachments,
        imageAction: mode === 'image' ? imageAction : undefined,
        referenceImage: mode === 'image' && imageAction === 'edit' ? requestReply?.image : undefined,
        referencePrompt: mode === 'image' && imageAction === 'edit' ? requestReply?.revisedPrompt : undefined,
        replyToMessageId: requestReply?.id,
      });

      if (!result.ok) {
        setMessages((current) => [...current, { id: `${Date.now()}-e`, role: 'assistant', text: result.error }]);
        return;
      }

      if (result.conversationId && user) setConversationId(result.conversationId);
      if (result.quota) setQuota(result.quota);

      const assistant: UiMessage = result.mode === 'image'
        ? {
            id: `${Date.now()}-i`,
            role: 'assistant',
            image: result.image,
            revisedPrompt: result.revisedPrompt,
            text: result.edited ? 'ویرایش تصویر آماده شد.' : 'تصویر جدید آماده شد.',
          }
        : { id: `${Date.now()}-a`, role: 'assistant', text: result.text };
      setMessages((current) => [...current, assistant]);
      if (user) await refreshCloudState();
    } catch {
      setMessages((current) => [...current, { id: `${Date.now()}-x`, role: 'assistant', text: 'ارتباط با سرویس برقرار نشد.' }]);
    } finally {
      setSending(false);
    }
  }

  async function submitVoice(text: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    const clean = text.trim();
    if (!clean || sending) return { ok: false, error: sending ? 'پاسخ قبلی هنوز در حال پردازش است.' : 'پیام صوتی خالی است.' };
    const before = messages;
    setMessages((current) => [...current, { id: `${Date.now()}-vu`, role: 'user', text: clean }]);
    setSending(true);
    try {
      const result = await sendAiRequest({
        mode: 'chat',
        message: clean,
        conversationId: user ? conversationId : undefined,
        history: before.filter((item) => item.text).slice(-10).map((item) => ({ role: item.role, content: item.text! })),
      });
      if (!result.ok) {
        setMessages((current) => [...current, { id: `${Date.now()}-ve`, role: 'assistant', text: result.error }]);
        return { ok: false, error: result.error };
      }
      if (result.mode !== 'chat') return { ok: false, error: 'پاسخ صوتی معتبر دریافت نشد.' };
      if (result.conversationId && user) setConversationId(result.conversationId);
      if (result.quota) setQuota(result.quota);
      setMessages((current) => [...current, { id: `${Date.now()}-va`, role: 'assistant', text: result.text }]);
      if (user) await refreshCloudState();
      return { ok: true, text: result.text };
    } catch {
      return { ok: false, error: 'ارتباط Voice Chat با سرویس برقرار نشد.' };
    } finally {
      setSending(false);
    }
  }

  async function openConversation(item: ConversationSummary) {
    if (!user) return;
    const stored = await getConversationMessages(item.id);
    setConversationId(item.id);
    setMode(item.mode === 'image' ? 'image' : 'chat');
    setMessages(stored.map((message) => ({
      id: message.id,
      role: message.role,
      text: message.content,
      image: message.imageUrl,
    })));
    resetComposer();
    setTab('chat');
  }

  async function openImageConversation(id: string) {
    if (!user) return;
    const stored = await getConversationMessages(id);
    setConversationId(id);
    setMode('image');
    setMessages(stored.map((message) => ({
      id: message.id,
      role: message.role,
      text: message.content,
      image: message.imageUrl,
    })));
    resetComposer();
    setTab('chat');
  }

  function startImageStudio() {
    setConversationId(undefined);
    setMessages([]);
    setMode('image');
    setInput('');
    resetComposer();
    setTab('chat');
  }

  function newConversation() {
    setConversationId(undefined);
    setMessages([]);
    setMode('chat');
    setInput('');
    resetComposer();
    setTab('chat');
  }

  if (!authReady) {
    return <div className="center-screen"><div className="loader-orb" /><div>در حال آماده‌سازی FarsiAI…</div></div>;
  }

  if (!user && !guestMode) {
    return <AuthScreen onAuthenticated={() => getCurrentUser().then(setUser)} onGuest={enterGuest} />;
  }

  const isGuest = guestMode && !user;
  const fullQuota = isGuest ? GUEST_FULL_QUOTA : USER_FULL_QUOTA;
  const shownQuota = quota ?? fullQuota;
  const canSend = !sending && (input.trim().length > 0 || (mode === 'chat' && attachments.length > 0));
  const imageIsEditing = mode === 'image' && (Boolean(replyTarget?.image) || attachments.some((item) => item.mimeType.startsWith('image/')));
  const premium = shownQuota.unlimited || account.plan === 'pro' || account.plan === 'admin';
  const topbarTitle = tab === 'chat' ? 'FarsiAI Chat' : tab === 'imageStudio' ? 'Image Studio Cloud' : tab === 'voice' ? 'Voice Chat Live' : 'Codex Studio';
  const topbarCaption = tab === 'chat'
    ? (isGuest ? 'Guest session · بدون ذخیره Cloud' : premium ? 'Premium entitlement active · Mobile ↔ Desktop' : 'همان اکانت و تاریخچه روی موبایل و دسکتاپ')
    : tab === 'imageStudio'
      ? (isGuest ? 'Cloud Gallery نیازمند حساب کاربری است' : 'Generated images · Favorites · Mobile ↔ Desktop')
      : tab === 'voice'
        ? 'میکروفن فقط با لمس کاربر فعال می‌شود'
        : 'Local tools با Permission-first security';

  return (
    <div className="app-shell">
      <aside className="sidebar glass">
        <div className="brand-row">
          <img className="app-icon" src="/app-icon.png" alt="FarsiAI" />
          <div><strong>FarsiAI</strong><span>Commercial Intelligence</span></div>
        </div>

        <button className="new-chat" onClick={newConversation}>＋ گفتگوی جدید</button>
        <nav className="nav-stack">
          <NavButton active={tab === 'chat'} label="Chat" caption="گفتگو، فایل و تصویر" onClick={() => setTab('chat')} />
          <NavButton active={tab === 'imageStudio'} label="Image Studio" caption={isGuest ? 'Cloud Gallery نیازمند ورود' : 'Gallery و Favorites'} onClick={() => setTab('imageStudio')} />
          <NavButton active={tab === 'voice'} label="Voice Chat" caption="گفت‌وگوی زنده فارسی" onClick={() => setTab('voice')} />
          <NavButton active={tab === 'codex'} label="Codex" caption={isGuest ? 'نیازمند ورود' : 'Agent واقعی PC'} onClick={() => setTab('codex')} />
        </nav>

        <div className="history-head"><span>{isGuest ? 'حالت مهمان' : 'تاریخچه مشترک'}</span><span>{isGuest ? 'Local' : conversations.length}</span></div>
        <div className="history-list">
          {!isGuest && conversations.map((item) => (
            <button key={item.id} className={item.id === conversationId ? 'history-item active' : 'history-item'} onClick={() => openConversation(item)}>
              <span className="history-title">{item.title}</span>
              <span className="history-meta">{formatDate(item.updatedAt)} · {item.mode}</span>
            </button>
          ))}
          {isGuest ? <div className="empty-mini">گفتگوهای مهمان در Cloud ذخیره نمی‌شوند.</div> : null}
          {!isGuest && conversations.length === 0 ? <div className="empty-mini">هنوز گفتگویی ذخیره نشده.</div> : null}
        </div>

        <div className={premium ? 'profile-card premium-profile' : 'profile-card'}>
          <div>
            <strong>{isGuest ? 'Guest' : account.displayName || account.email || 'FarsiAI User'}</strong>
            <span>{isGuest ? quotaSummary(shownQuota, true) : `${account.plan.toUpperCase()} · ${quotaSummary(shownQuota, false)}`}</span>
          </div>
          <button className="icon-button" onClick={leaveSession}>↪</button>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar glass">
          <div>
            <strong>{topbarTitle}</strong>
            <span>{topbarCaption}</span>
          </div>
          <div className="top-actions">
            <span className={premium ? 'quota-pill premium-quota' : 'quota-pill'}>{premium ? '◆ PRO · Chat & Image نامحدود' : `Chat ${shownQuota.chatRemaining}/${fullQuota.chatRemaining} · Image ${shownQuota.imageRemaining}/${fullQuota.imageRemaining}`}</span>
            <span className="status-pill"><i /> Online</span>
          </div>
        </header>

        {tab === 'chat' ? (
          <section className="chat-layout">
            <div
              className={dragActive ? 'chat-stage glass drag-active' : 'chat-stage glass'}
              onDragEnter={handleDragEnter}
              onDragLeave={handleDragLeave}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
            >
              {dragActive ? <div className="drag-drop-overlay"><div className="drag-drop-orb">＋</div><strong>فایل‌ها را اینجا رها کن</strong><span>تصویر، PDF، Office، CSV و متن</span></div> : null}

              <div className="mode-row">
                <div className="segmented">
                  <button className={mode === 'chat' ? 'active' : ''} onClick={() => setChatMode('chat')}>Chat</button>
                  <button className={mode === 'image' ? 'active' : ''} onClick={() => setChatMode('image')}>Image Studio</button>
                </div>
                <span>{mode === 'image' ? (imageIsEditing ? 'ویرایش فقط تصویر انتخاب‌شده' : 'هر درخواست، تصویر جدید') : premium ? 'Premium · بدون سقف روزانه' : (isGuest ? 'Guest quota enforced by server' : 'Cloud-synced conversation')}</span>
              </div>

              <div className="messages">
                {messages.length === 0 ? (
                  <div className="welcome commercial-welcome">
                    <div className="welcome-icon-shell"><img src="/app-icon.png" alt="FarsiAI" /></div>
                    <span className="welcome-eyebrow">FARSIAI INTELLIGENCE</span>
                    <h1>{mode === 'chat' ? 'چطور می‌تونم کمکت کنم؟' : 'چه تصویری بسازیم؟'}</h1>
                    <p>{premium ? 'Premium فعال است؛ گفتگو و تصویر بدون سقف روزانه، با محدودیت‌های ایمنی سرویس.' : isGuest ? 'حالت مهمان: ۵ پیام و ۲ تصویر در روز.' : 'Chat، فایل و Image Studio با همان حساب مشترک موبایل و دسکتاپ.'}</p>
                    <div className="starter-grid">{STARTERS.map((starter) => <button key={starter} onClick={() => submitChat(starter)}>{starter}</button>)}</div>
                  </div>
                ) : messages.map((message) => (
                  <article key={message.id} className={`message ${message.role}`}>
                    <div className="message-label">{message.role === 'user' ? 'YOU' : 'FARSIAI'}</div>
                    <div className="message-surface">
                      {message.attachments?.length ? (
                        <div className="message-attachments">
                          {message.attachments.map((attachment) => (
                            <div className="message-attachment" key={attachment.id}>
                              {attachment.previewUrl ? <img src={attachment.previewUrl} alt="attachment" /> : <span className="file-badge">FILE</span>}
                              <div><strong>{attachment.name}</strong><small>{formatFileSize(attachment.size)}</small></div>
                            </div>
                          ))}
                        </div>
                      ) : null}
                      {message.text ? <div className="message-text">{message.text}</div> : null}
                      {message.image ? <img className="generated-image" src={message.image} alt="AI generated" /> : null}
                      <div className="message-action-bar">
                        {(message.text || message.revisedPrompt) ? <button onClick={() => void copyMessage(message)}>{copiedMessageId === message.id ? '✓ کپی شد' : '⧉ کپی'}</button> : null}
                        {message.role === 'assistant' && message.image ? <button onClick={() => replyToImage(message)}>↩ ویرایش همین تصویر</button> : null}
                      </div>
                    </div>
                  </article>
                ))}
                {sending ? <div className="thinking commercial-thinking"><i /><div><strong>FarsiAI</strong><span>{mode === 'image' ? 'در حال پردازش تصویر…' : 'در حال آماده‌سازی پاسخ…'}</span></div></div> : null}
              </div>

              <div className="composer composer-v046 commercial-composer">
                <input
                  ref={attachmentInputRef}
                  className="hidden-file-input"
                  type="file"
                  accept={ATTACH_ACCEPT}
                  multiple
                  onChange={(event) => void handleAttachmentFiles(event.target.files)}
                />

                {replyTarget?.image ? (
                  <div className="reply-preview">
                    <img src={replyTarget.image} alt="reply target" />
                    <div><strong>ویرایش همین تصویر</strong><span>درخواست بعدی فقط روی این تصویر اعمال می‌شود.</span></div>
                    <button className="icon-button" onClick={() => setReplyTarget(null)}>×</button>
                  </div>
                ) : null}

                {attachments.length ? (
                  <div className="attachment-preview-list">
                    {attachments.map((attachment) => (
                      <div className="attachment-preview" key={attachment.id}>
                        {attachment.previewUrl ? <img src={attachment.previewUrl} alt="attachment preview" /> : <span className="file-badge">FILE</span>}
                        <div><strong title={attachment.name}>{attachment.name}</strong><small>{formatFileSize(attachment.size)}</small></div>
                        <button className="attachment-remove" onClick={() => removeAttachment(attachment.id)}>×</button>
                      </div>
                    ))}
                  </div>
                ) : null}

                {composerError ? <div className="composer-error">{composerError}</div> : null}
                <div className="composer-meta-line"><span><i /> FarsiAI Intelligence</span><b className={premium ? 'premium-text' : ''}>{premium ? 'Premium · نامحدود' : mode === 'chat' ? `${shownQuota.chatRemaining} پیام باقی‌مانده` : `${shownQuota.imageRemaining} تصویر باقی‌مانده`}</b></div>
                <textarea
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={handleComposerKeyDown}
                  placeholder={mode === 'image' ? 'صحنه، سبک و جزئیات تصویر را توصیف کن…' : 'هر چیزی بپرس یا فایل را Drag & Drop کن…'}
                  maxLength={6000}
                />
                <div className="composer-footer">
                  <div className="composer-tools">
                    <button className="composer-tool" disabled={sending} onClick={() => attachmentInputRef.current?.click()}><b>＋</b><span>فایل</span></button>
                    <button className={mode === 'image' ? 'composer-tool selected' : 'composer-tool'} disabled={sending} onClick={() => setChatMode('image')}><b>▧</b><span>تصویر</span></button>
                    <button className="composer-tool" disabled={sending} onClick={() => setTab('voice')}><b>◉</b><span>صوتی</span></button>
                    <span className="composer-model"><i /> Enter ارسال · Shift+Enter خط جدید</span>
                  </div>
                  <button className="primary commercial-send" disabled={!canSend} onClick={() => submitChat()}>{sending ? '…' : 'ارسال ↑'}</button>
                </div>
                <div className="composer-policy">{mode === 'image' ? 'ویرایش فقط با تصویر انتخاب‌شده انجام می‌شود؛ تصاویر قبلی خودکار استفاده نمی‌شوند.' : 'خروجی‌های مهم را قبل از استفاده نهایی بررسی کنید.'}</div>
              </div>
            </div>

            <aside className="inspector glass commercial-inspector">
              <div className={premium ? 'membership-mini premium' : 'membership-mini'}>
                <span>{premium ? 'PREMIUM ACTIVE' : isGuest ? 'GUEST' : 'MEMBERSHIP'}</span>
                <strong>{premium ? 'FarsiAI Pro' : isGuest ? 'Guest Access' : 'FarsiAI Free'}</strong>
                <p>{premium ? 'سقف روزانه Chat و Image برداشته شده است.' : 'وضعیت حساب و سهمیه با Cloud همگام است.'}</p>
              </div>
              <Info label="Plan" value={isGuest ? 'guest' : account.plan} />
              <Info label="Chat" value={premium ? 'نامحدود' : `${shownQuota.chatRemaining} از ${fullQuota.chatRemaining}`} />
              <Info label="Image" value={premium ? 'نامحدود' : `${shownQuota.imageRemaining} از ${fullQuota.imageRemaining}`} />
              {!isGuest ? <Info label="Email" value={account.email || '—'} /> : null}
              <div className="divider" />
              <h3>{isGuest ? 'Privacy' : 'Shared data'}</h3>
              <p>{isGuest ? 'حالت مهمان به تاریخچه حساب دسترسی ندارد و Conversationها در حساب ذخیره نمی‌شوند.' : 'Conversationها و Plan از همان حساب Supabase موبایل خوانده می‌شوند؛ Desktop دیتابیس جدا ندارد.'}</p>
              <div className="sync-badge">{isGuest ? 'Guest · 5 Chat · 2 Image' : '✓ Mobile ↔ Desktop'}</div>
            </aside>
          </section>
        ) : null}

        {tab === 'imageStudio' ? (isGuest ? <LoginRequired title="Image Studio Cloud" onExit={leaveSession} /> : <DesktopImageStudio onOpenConversation={openImageConversation} onCreateImage={startImageStudio} />) : null}
        {tab === 'voice' ? <DesktopVoiceChat ask={submitVoice} remaining={premium ? 999999 : shownQuota.chatRemaining} /> : null}
        {tab === 'codex' ? (isGuest ? <LoginRequired title="Codex" onExit={leaveSession} /> : <CodexStudio />) : null}
      </main>
    </div>
  );
}

function AuthScreen({ onAuthenticated, onGuest }: { onAuthenticated: () => void; onGuest: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!email.trim() || password.length < 6 || busy) {
      if (password.length < 6) setStatus('رمز عبور باید حداقل ۶ کاراکتر باشد.');
      return;
    }
    setBusy(true);
    setStatus('');
    const result = mode === 'signin' ? await signIn(email, password) : await signUp(email, password);
    setBusy(false);
    if (!result.ok) return setStatus(result.message);
    if (result.needsEmailConfirmation) {
      setStatus('ایمیل تأیید ارسال شد. بعد از تأیید وارد حساب شو.');
      setMode('signin');
      return;
    }
    onAuthenticated();
  }

  return (
    <div className="auth-screen commercial-auth">
      <div className="auth-ambient" />
      <section className="auth-card glass">
        <div className="auth-icon-shell"><img src="/app-icon.png" alt="FarsiAI" /></div>
        <span className="auth-eyebrow">COMMERCIAL RC</span>
        <h1>FarsiAI</h1>
        <p>یک حساب، یک تاریخچه و یک تجربه مشترک روی Mobile و Windows.</p>
        <div className="auth-tabs"><button className={mode === 'signin' ? 'active' : ''} onClick={() => setMode('signin')}>ورود</button><button className={mode === 'signup' ? 'active' : ''} onClick={() => setMode('signup')}>ساخت حساب</button></div>
        <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Email" type="email" dir="ltr" autoComplete="email" />
        <input value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Password" type="password" dir="ltr" autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} onKeyDown={(event) => { if (event.key === 'Enter') void submit(); }} />
        {status ? <div className="auth-status">{status}</div> : null}
        <button className="primary wide" disabled={busy} onClick={submit}>{busy ? '…' : mode === 'signin' ? 'ورود به FarsiAI' : 'ساخت حساب'}</button>
        <div className="divider" />
        <button className="secondary wide" disabled={busy} onClick={onGuest}>ادامه به‌عنوان مهمان</button>
        <small>Guest: روزانه ۵ پیام + ۲ تصویر. Codex برای امنیت نیازمند ورود است.</small>
      </section>
    </div>
  );
}

function LoginRequired({ title, onExit }: { title: string; onExit: () => void }) {
  return <section className="workspace-layout"><div className="workspace-main glass"><div className="welcome"><img src="/app-icon.png" alt="FarsiAI" /><h1>{title} نیازمند ورود است</h1><p>برای دسترسی به Cloud و ابزارهای محلی، ابتدا با حساب FarsiAI وارد شو.</p><button className="primary" onClick={onExit}>رفتن به صفحه ورود</button></div></div></section>;
}

function NavButton({ active, label, caption, onClick }: { active: boolean; label: string; caption: string; onClick: () => void }) {
  return <button className={active ? 'nav-button active' : 'nav-button'} onClick={onClick}><strong>{label}</strong><span>{caption}</span></button>;
}

function Info({ label, value }: { label: string; value: string }) {
  return <div className="info-row"><span>{label}</span><strong>{value}</strong></div>;
}
