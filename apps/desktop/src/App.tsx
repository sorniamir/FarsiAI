import { useEffect, useRef, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { open } from '@tauri-apps/plugin-dialog';
import { DesktopVoiceChat } from './components/DesktopVoiceChat';
import { CodexStudio } from './components/CodexStudio';
import { useDesktopAgent } from './hooks/useDesktopAgent';
import { prepareAttachments } from './lib/chatAttachments';
import { planAgentStep, type AgentObservation, type AgentToolCall } from './services/agent';
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

type Tab = 'chat' | 'voice' | 'codex' | 'computer';
type UiMessage = {
  id: string;
  role: 'user' | 'assistant';
  text?: string;
  image?: string;
  revisedPrompt?: string;
  attachments?: ApiAttachment[];
  replyToId?: string;
};
type ApprovalState = { title: string; detail: string; confirmLabel: string };

const USER_FULL_QUOTA: DailyQuota = { chatRemaining: 10, imageRemaining: 4 };
const GUEST_FULL_QUOTA: DailyQuota = { chatRemaining: 5, imageRemaining: 2 };
const STARTERS = [
  'Ø¨Ø±Ø§ÛŒ Ø§Ù…Ø±ÙˆØ² ÛŒÚ© Ø¨Ø±Ù†Ø§Ù…Ù‡ Ú©Ø§Ø±ÛŒ Ø­Ø±ÙÙ‡â€ŒØ§ÛŒ Ø¨Ø³Ø§Ø²',
  'Ø§ÛŒÙ† Ø§ÛŒØ¯Ù‡ Ø±Ø§ ØªØ¨Ø¯ÛŒÙ„ Ø¨Ù‡ ÛŒÚ© Ø¨Ø±Ù†Ø§Ù…Ù‡ Ø§Ø¬Ø±Ø§ÛŒÛŒ Ú©Ù†',
  'Ø¨Ø±Ø§ÛŒ Ù…Ø­ØµÙˆÙ„ Ù…Ù† ÛŒÚ© Ù…ØªÙ† Ù…Ø¹Ø±ÙÛŒ Ø­Ø±ÙÙ‡â€ŒØ§ÛŒ Ø¨Ù†ÙˆÛŒØ³',
];
const ATTACH_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/bmp,image/svg+xml,.pdf,.docx,.xlsx,.xls,.csv,.txt,.html,.xml,.odt,.ods';

function formatDate(value: string): string {
  try {
    return new Intl.DateTimeFormat('fa-IR', { month: 'short', day: 'numeric' }).format(new Date(value));
  } catch {
    return '';
  }
}

function toolPath(workspace: string, relative: string): string {
  const base = workspace.replace(/[\\/]+$/, '');
  const clean = relative.trim().replace(/^[.][\\/]?/, '').replace(/^[\\/]+/, '');
  if (!clean || clean === '.') return base;
  const separator = base.includes('\\') ? '\\' : '/';
  return `${base}${separator}${clean.replace(/[\\/]+/g, separator)}`;
}

function truncate(value: string, max = 65000): string {
  return value.length > max ? `${value.slice(0, max)}\nâ€¦[truncated]` : value;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function formatFileSize(size: number): string {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export default function AppFinal() {
  const agent = useDesktopAgent();
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
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);

  const [workspace, setWorkspace] = useState('');
  const [workspaceGranted, setWorkspaceGranted] = useState(false);
  const [selectedFile, setSelectedFile] = useState('');
  const [editorValue, setEditorValue] = useState('');
  const [command, setCommand] = useState('npm');
  const [commandArgs, setCommandArgs] = useState('run test');
  const [agentTask, setAgentTask] = useState('');
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentTimeline, setAgentTimeline] = useState<string[]>([]);
  const [approval, setApproval] = useState<ApprovalState | null>(null);
  const approvalResolver = useRef<((approved: boolean) => void) | null>(null);
  const agentAbortRef = useRef<AbortController | null>(null);

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
      agentAbortRef.current?.abort();
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
      setComposerError(error instanceof Error ? error.message : 'Ø®ÙˆØ§Ù†Ø¯Ù† ÙØ§ÛŒÙ„ Ù†Ø§Ù…ÙˆÙÙ‚ Ø¨ÙˆØ¯.');
    } finally {
      if (attachmentInputRef.current) attachmentInputRef.current.value = '';
    }
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

  function requestApproval(next: ApprovalState): Promise<boolean> {
    setApproval(next);
    return new Promise((resolve) => {
      approvalResolver.current = resolve;
    });
  }

  function resolveApproval(value: boolean) {
    setApproval(null);
    approvalResolver.current?.(value);
    approvalResolver.current = null;
  }

  async function submitChat(prefill?: string) {
    const typedText = (prefill ?? input).trim();
    const fallbackText = mode === 'chat' && attachments.length > 0
      ? 'ÙØ§ÛŒÙ„â€ŒÙ‡Ø§ÛŒ Ø¶Ù…ÛŒÙ…Ù‡â€ŒØ´Ø¯Ù‡ Ø±Ø§ Ø¨Ø±Ø±Ø³ÛŒ Ú©Ù† Ùˆ Ù†Ú©Ø§Øª Ù…Ù‡Ù… Ø±Ø§ ØªÙˆØ¶ÛŒØ­ Ø¨Ø¯Ù‡.'
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
            text: result.edited ? 'ÙˆÛŒØ±Ø§ÛŒØ´ ØªØµÙˆÛŒØ± Ø¢Ù…Ø§Ø¯Ù‡ Ø´Ø¯.' : 'ØªØµÙˆÛŒØ± Ø¬Ø¯ÛŒØ¯ Ø¢Ù…Ø§Ø¯Ù‡ Ø´Ø¯.',
          }
        : { id: `${Date.now()}-a`, role: 'assistant', text: result.text };
      setMessages((current) => [...current, assistant]);
      if (user) await refreshCloudState();
    } catch {
      setMessages((current) => [...current, { id: `${Date.now()}-x`, role: 'assistant', text: 'Ø§Ø±ØªØ¨Ø§Ø· Ø¨Ø§ Ø³Ø±ÙˆÛŒØ³ Ø¨Ø±Ù‚Ø±Ø§Ø± Ù†Ø´Ø¯.' }]);
    } finally {
      setSending(false);
    }
  }

  async function submitVoice(text: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    const clean = text.trim();
    if (!clean || sending) return { ok: false, error: sending ? 'Ù¾Ø§Ø³Ø® Ù‚Ø¨Ù„ÛŒ Ù‡Ù†ÙˆØ² Ø¯Ø± Ø­Ø§Ù„ Ù¾Ø±Ø¯Ø§Ø²Ø´ Ø§Ø³Øª.' : 'Ù¾ÛŒØ§Ù… ØµÙˆØªÛŒ Ø®Ø§Ù„ÛŒ Ø§Ø³Øª.' };
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
      if (result.mode !== 'chat') return { ok: false, error: 'Ù¾Ø§Ø³Ø® ØµÙˆØªÛŒ Ù…Ø¹ØªØ¨Ø± Ø¯Ø±ÛŒØ§ÙØª Ù†Ø´Ø¯.' };
      if (result.conversationId && user) setConversationId(result.conversationId);
      if (result.quota) setQuota(result.quota);
      setMessages((current) => [...current, { id: `${Date.now()}-va`, role: 'assistant', text: result.text }]);
      if (user) await refreshCloudState();
      return { ok: true, text: result.text };
    } catch {
      return { ok: false, error: 'Ø§Ø±ØªØ¨Ø§Ø· Voice Chat Ø¨Ø§ Ø³Ø±ÙˆÛŒØ³ Ø¨Ø±Ù‚Ø±Ø§Ø± Ù†Ø´Ø¯.' };
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

  function newConversation() {
    setConversationId(undefined);
    setMessages([]);
    setMode('chat');
    setInput('');
    resetComposer();
    setTab('chat');
  }

  async function grantWorkspace(path: string) {
    const normalized = path.trim();
    if (!normalized) return;
    try {
      await agent.grantDirectory(normalized);
      setWorkspace(normalized);
      setWorkspaceGranted(true);
      setSelectedFile('');
      setEditorValue('');
      setAgentTimeline((current) => ['âœ“ Workspace approved', ...current]);
    } catch (error) {
      setWorkspaceGranted(false);
      setAgentTimeline((current) => [`âœ• ${String(error)}`, ...current]);
    }
  }

  async function browseWorkspace() {
    try {
      const selected = await open({ directory: true, multiple: false, title: 'Ø§Ù†ØªØ®Ø§Ø¨ Workspace Ø¨Ø±Ø§ÛŒ FarsiAI Codex' });
      if (!selected) return;
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (typeof path === 'string' && path.trim()) await grantWorkspace(path);
    } catch (error) {
      setAgentTimeline((current) => [`âœ• Folder picker: ${String(error)}`, ...current]);
    }
  }

  async function openFile(path: string) {
    try {
      const content = await agent.readFile(path);
      setSelectedFile(path);
      setEditorValue(content);
    } catch (error) {
      setAgentTimeline((current) => [`âœ• ${String(error)}`, ...current]);
    }
  }

  async function saveSelectedFile() {
    if (!selectedFile) return;
    const approved = await requestApproval({
      title: 'Ø§Ø¬Ø§Ø²Ù‡ Ø°Ø®ÛŒØ±Ù‡ ÙØ§ÛŒÙ„',
      detail: `FarsiAI Ù…ÛŒâ€ŒØ®ÙˆØ§Ù‡Ø¯ Ø§ÛŒÙ† ÙØ§ÛŒÙ„ Ø±Ø§ ØªØºÛŒÛŒØ± Ø¯Ù‡Ø¯:\n${selectedFile}\n\nÙ‚Ø¨Ù„ Ø§Ø² ØªØºÛŒÛŒØ±ØŒ Backup Ø®ÙˆØ¯Ú©Ø§Ø± Ø³Ø§Ø®ØªÙ‡ Ù…ÛŒâ€ŒØ´ÙˆØ¯.`,
      confirmLabel: 'Ø°Ø®ÛŒØ±Ù‡ ÙØ§ÛŒÙ„',
    });
    if (!approved) return;

    try {
      const backup = await agent.writeFile(selectedFile, editorValue);
      setAgentTimeline((current) => [backup ? 'âœ“ Saved Â· backup created' : 'âœ“ Saved new file', ...current]);
    } catch (error) {
      setAgentTimeline((current) => [`âœ• ${String(error)}`, ...current]);
    }
  }

  async function runManualCommand() {
    if (!workspaceGranted) {
      setAgentTimeline(ç4¶‰žËkºwµçx(€€€€€€€€€€€€€€€€€€€€ñ‰ÕÑÑ½¸±…ÍÍ9…µ”õíµ½‘”€ôôô€¥µ…”œ€ü€½µÁ½Í•ÈµÑ½½°Í•±•Ñ•œ€è€½µÁ½Í•ÈµÑ½½°ô‘¥Í…‰±•õíÍ•¹‘¥¹ô½¹±¥¬õì ¤€ôøÍ•Ñ¡…Ñ5½‘” ¥µ…”œ¥ôøñˆûŠZœð½ˆøñÍÁ…¸ûb«b×f#n3bÄð½ÍÁ…¸øð½‰ÕÑÑ½¸ø(€€€€€€€€€€€€€€€€€€€€ñ‰ÕÑÑ½¸±…ÍÍ9…µ”ô‰½µÁ½Í•ÈµÑ½½°ˆ‘¥Í…‰±•õíÍ•¹‘¥¹ô½¹±¥¬õì ¤€ôøÍ•ÑQ…ˆ Ù½¥”œ¥ôøñˆûŠ^$ð½ˆøñÍÁ…¸ûb×f#b«n0ð½ÍÁ…¸øð½‰ÕÑÑ½¸ø(€€€€€€€€€€€€€€€€€€€€ñÍÁ…¸±…ÍÍ9…µ”ô‰½µÁ½Í•Èµµ½‘•°ˆøñ¤€¼ø…ÉÍ¥$AÉ¼ð½ÍÁ…¸ø(€€€€€€€€€€€€€€€€€€ð½‘¥Øø(€€€€€€€€€€€€€€€€€€ñ‰ÕÑÑ½¸±…ÍÍ9…µ”ô‰ÁÉ¥µ…Éäˆ‘¥Í…‰±•õì……¹M•¹‘ô½¹±¥¬õì ¤€ôøÍÕ‰µ¥Ñ¡…Ð ¥ôùíÍ•¹‘¥¹œ€ü€ŸŠ˜œ€è€ŸbŸbÇbÏbŸfƒŠDôð½‰ÕÑÑ½¸ø(€€€€€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰½µÁ½Í•ÈµÁ½±¥äˆûf#n3bÇbŸn3bÐƒb«b×f#n3bÄƒffbÜƒb£bœƒ
¯f#n3bÇbŸn3bÐƒffn3fƒb«b×f#n3bÇ
ìƒn3bœƒbÛfn3ffŠ3j§bÇb¿fƒb«b×f#n3bÄƒfbçbŸfƒfn3Š3bÓf#b¿blƒb«b×bŸf#n3bÄƒfb£fn0ƒb»f#b¿j§bŸbÄƒbŸbÏb«fbŸb¿fƒffn3Š3bÓf#fb¼¸ð½‘¥Øø4(€€€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€€€ð½‘¥Øø4(4(€€€€€€€€€€€€ñ…Í¥‘”±…ÍÍ9…µ”ô‰¥¹ÍÁ•Ñ½È±…ÍÌˆø4(€€€€€€€€€€€€€€ñ Ìùí¥ÍÕ•ÍÐ€ü€Õ•ÍÐÍ•ÍÍ¥½¸œ€è€½Õ¹ÐÍå¹Œôð½ Ìø4(€€€€€€€€€€€€€€ñ%¹™¼±…‰•°ô‰A±…¸ˆÙ…±Õ”õí¥ÍÕ•ÍÐ€ü€Õ•ÍÐœ€è…½Õ¹Ð¹Á±…¹ô€¼ø4(€€€€€€€€€€€€€€ñ%¹™¼±…‰•°ô‰¡…Ðƒb£bŸfn3Š3fbŸfb¿fˆÙ…±Õ”õí€‘íÍ¡½Ý¹EÕ½Ñ„¹¡…ÑI•µ…¥¹¥¹ôƒbŸbÈ€‘í™Õ±±EÕ½Ñ„¹¡…ÑI•µ…¥¹¥¹õô€¼ø4(€€€€€€€€€€€€€€ñ%¹™¼±…‰•°ô‰%µ…”ƒb£bŸfn3Š3fbŸfb¿fˆÙ…±Õ”õí€‘íÍ¡½Ý¹EÕ½Ñ„¹¥µ…•I•µ…¥¹¥¹ôƒbŸbÈ€‘í™Õ±±EÕ½Ñ„¹¥µ…•I•µ…¥¹¥¹õô€¼ø4(€€€€€€€€€€€€€ì…¥ÍÕ•ÍÐ€ü€ñ%¹™¼±…‰•°ô‰µ…¥°ˆÙ…±Õ”õí…½Õ¹Ð¹•µ…¥°ñð€ŸŠPô€¼ø€è¹Õ±±ô4(€€€€€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰‘¥Ù¥‘•Èˆ€¼ø4(€€€€€€€€€€€€€€ñ Ìùí¥ÍÕ•ÍÐ€ü€AÉ¥Ù…äœ€è€M¡…É•‘…Ñ„ôð½ Ìø4(€€€€€€€€€€€€€€ñÀùí¥ÍÕ•ÍÐ€ü€Ÿb·bŸfb¨ƒfffbŸfƒb£fƒb«bŸbÇn3b»jfƒb·bÏbŸb ƒb¿bÏb«bÇbÏn0ƒfb¿bŸbÇb¼ƒf ½¹Ù•ÉÍ…Ñ¥½»fbœƒb¿bÄƒb·bÏbŸb ƒbÃb»n3bÇfƒffn3Š3bÓf#fb¼¸œ€è€½¹Ù•ÉÍ…Ñ¥½»fbœƒf ƒbÏffn3fƒbŸbÈƒffbŸfMÕÁ…‰…Í”ƒff#b£bŸn3fƒb»f#bŸfb¿fƒfn3Š3bÓf#fb¿bl•Í­Ñ½Àƒb¿n3b«bŸb£n3bÌƒb³b¿bœƒfb¿bŸbÇb¼¸ôð½Àø4(€€€€€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰Íå¹Œµ‰…‘”ˆùí¥ÍÕ•ÍÐ€ü€Õ•ÍÐƒ
Ü€Ô¡…Ðƒ
Ü€È%µ…”œ€è€ŸŠrL5½‰¥±”ƒŠP•Í­Ñ½Àôð½‘¥Øø4(€€€€€€€€€€€€ð½…Í¥‘”ø4(€€€€€€€€€€ð½Í•Ñ¥½¸ø4(€€€€€€€€¤€è¹Õ±±ô((€€€€€€€íÑ…ˆ€ôôô€Ù½¥”œ€ü€ñ•Í­Ñ½ÁY½¥•¡…Ð…Í¬õíÍÕ‰µ¥ÑY½¥•ôÉ•µ…¥¹¥¹œõíÍ¡½Ý¹EÕ½Ñ„¹¡…ÑI•µ…¥¹¥¹ô€¼ø€è¹Õ±±ô((€€€€€€€íÑ…ˆ€ôôô€½‘•àœ€ü€¡¥ÍÕ•ÍÐ€ü€ñ1½¥¹I•ÅÕ¥É•Ñ¥Ñ±”ô‰½‘•àˆ½¹á¥Ðõí±•…Ù•M•ÍÍ¥½¹ô€¼ø€è€ñ½‘•áMÑÕ‘¥¼€¼ø¤€è¹Õ±±ô((€€€€€€€í™…±Í”€˜˜Ñ…ˆ€ôôô€½‘•àœ€ü€ (€€€€€€€€€¥ÍÕ•ÍÐ€ü€ñ1½¥¹I•ÅÕ¥É•Ñ¥Ñ±”ô‰½‘•àˆ½¹á¥Ðõí±•…Ù•M•ÍÍ¥½¹ô€¼ø€è€ 4(€€€€€€€€€€ñÍ•Ñ¥½¸±…ÍÍ9…µ”ô‰Ý½É­ÍÁ…”µ±…å½ÕÐˆø4(€€€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰Ý½É­ÍÁ…”µµ…¥¸±…ÍÌˆø4(€€€€€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰Ý½É­ÍÁ…”µÑ¥Ñ±”ˆø4(€€€€€€€€€€€€€€€€ñ‘¥Øøñ Èù½‘•àAÉ¼•¹Ðð½ ÈøñÀûfûbÇf#jcfƒbÇbœƒb«b·fn3fƒfn3Š3j§fb¿b0ƒfbŸn3fƒf#bŸfbçn0ƒbÇbœƒfn3Š3b»f#bŸfb¼ƒf ƒb«bën3n3bÄƒfn3Š3b¿fb¿b0ƒb«bÏb¨¿b£n3fb¼ƒbÇbœƒbŸb³bÇbœƒfn3Š3j§fb¼ƒf ƒb«bœƒfb«n3b³fƒfbçb«b£bÄƒbÇf#n0ƒb»bßbŸfbœƒbŸb¿bŸffƒfn3Š3b¿fb¼¸ð½Àøð½‘¥Øø4(€€€€€€€€€€€€€€€€ñÍÁ…¸±…ÍÍ9…µ”õíÝ½É­ÍÁ…•É…¹Ñ•€ü€Ý½É­ÍÁ…”µÍÑ…ÑÕÌÉ•…‘äœ€è€Ý½É­ÍÁ…”µÍÑ…ÑÕÌôùíÝ½É­ÍÁ…•É…¹Ñ•€ü€]½É­ÍÁ…”…ÁÁÉ½Ù•œ€è€9¼Ý½É­ÍÁ…”ôð½ÍÁ…¸ø4(€€€€€€€€€€€€€€ð½‘¥Øø4(4(€€€€€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰™¥•±µÉ½Üˆø4(€€€€€€€€€€€€€€€€ñ¥¹ÁÕÐÙ…±Õ”õíÝ½É­ÍÁ…•ô½¹¡…¹”õì¡•Ù•¹Ð¤€ôøìÍ•Ñ]½É­ÍÁ…”¡•Ù•¹Ð¹Ñ…É•Ð¹Ù…±Õ”¤ìÍ•Ñ]½É­ÍÁ…•É…¹Ñ•¡™…±Í”¤ìõôÁ±…•¡½±‘•Èô‹n3j¤ƒfûf#bÓfƒbŸfb«b»bŸb ƒj§fƒn3bœƒfbÏn3bÄƒbÇbœƒf#bŸbÇb¼ƒj§fˆ€¼ø4(€€€€€€€€€€€€€€€€ñ‰ÕÑÑ½¸±…ÍÍ9…µ”ô‰Í•½¹‘…Éäˆ½¹±¥¬õí‰É½ÝÍ•]½É­ÍÁ…•ôù	É½ÝÍ—Š˜ð½‰ÕÑÑ½¸ø4(€€€€€€€€€€€€€€€€ñ‰ÕÑÑ½¸±…ÍÍ9…µ”ô‰Í•½¹‘…Éäˆ‘¥Í…‰±•õì…Ý½É­ÍÁ…”¹ÑÉ¥´ ¥ô½¹±¥¬õì ¤€ôøÉ…¹Ñ]½É­ÍÁ…”¡Ý½É­ÍÁ…”¥ôùÁÁÉ½Ù”ð½‰ÕÑÑ½¸ø4(€€€€€€€€€€€€€€ð½‘¥Øø((€€€€€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰…•¹ÐµÑ…Í¬µ…Éˆø(€€€€€€€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰½‘•àµ½µµ…¹µÁÉ•Í•ÑÌˆø(€€€€€€€€€€€€€€€€€€ñÍÁ…¸ûbÓbÇf#bäƒbÏbÇn3bäð½ÍÁ…¸ø(€€€€€€€€€€€€€€€€€€ñ‰ÕÑÑ½¸‘¥Í…‰±•õí…•¹ÑIÕ¹¹¥¹ô½¹±¥¬õì ¤€ôøÍ•Ñ•¹ÑQ…Í¬ ŸfûbÇf#jcfƒbÇbœƒb£bÇbÇbÏn0ƒj§fb0ƒb»bßbŸfbŸn0ƒfffƒbÇbœƒfûn3b¿bœƒj§fƒf ƒfb£fƒbŸbÈƒfbÄƒb«bën3n3bÄƒn3j¤ƒb£bÇfbŸffƒj§f#b«bŸfƒbŸbÇbŸb›fƒb£b¿f¸œ¥ôûb£bÇbÇbÏn0ƒfûbÇf#jcfð½‰ÕÑÑ½¸ø(€€€€€€€€€€€€€€€€€€ñ‰ÕÑÑ½¸‘¥Í…‰±•õí…•¹ÑIÕ¹¹¥¹ô½¹±¥¬õì ¤€ôøÍ•Ñ•¹ÑQ…Í¬ Ÿb«bÏb«Š3fbŸn0ƒfûbÇf#jcfƒbÇbœƒbŸb³bÇbœƒj§fb0ƒbçfb¨ƒb»bßbŸfbœƒbÇbœƒfbÓb»bÔƒj§fƒf ƒb£bœƒj§fb«bÇn3fƒb«bën3n3bÄƒbŸffƒbŸb×fbŸb·bÓbŸfƒj§f¸œ¥ôûbÇfbäƒb«bÏb«Š3fbœð½‰ÕÑÑ½¸ø(€€€€€€€€€€€€€€€€€€ñ‰ÕÑÑ½¸‘¥Í…‰±•õí…•¹ÑIÕ¹¹¥¹ô½¹±¥¬õì ¤€ôøÍ•Ñ•¹ÑQ…Í¬ Ÿj§b¼ƒbÇbœƒbŸbÈƒfbãbÄƒbŸffn3b«b0ƒfûbŸn3b¿bŸbÇn0ƒf ƒb«b³bÇb£fƒj§bŸbÇb£bÇn0ƒb£bÇbÇbÏn0ƒj§fƒf ƒff#bŸbÇb¼ƒb£b·bÇbŸfn0ƒbÇbœƒbŸb×fbŸb´ƒj§f¸œ¥ôûb£bŸbËb£n3fn0ƒb·bÇffŠ3bŸn0ð½‰ÕÑÑ½¸ø(€€€€€€€€€€€€€€€€ð½‘¥Øø(€€€€€€€€€€€€€€€€ñÑ•áÑ…É•„(€€€€€€€€€€€€€€€€€Ù…±Õ”õí…•¹ÑQ…Í­ô(€€€€€€€€€€€€€€€€€½¹¡…¹”õì¡•Ù•¹Ð¤€ôøÍ•Ñ•¹ÑQ…Í¬¡•Ù•¹Ð¹Ñ…É•Ð¹Ù…±Õ”¥ô(€€€€€€€€€€€€€€€€€½¹-•å½Ý¸õì¡•Ù•¹Ð¤€ôøì(€€€€€€€€€€€€€€€€€€€¥˜€ ¡•Ù•¹Ð¹ÑÉ±-•äñð•Ù•¹Ð¹µ•Ñ…-•ä¤€˜˜•Ù•¹Ð¹­•ä€ôôô€¹Ñ•Èœ¤ì(€€€€€€€€€€€€€€€€€€€€€•Ù•¹Ð¹ÁÉ•Ù•¹Ñ•™…Õ±Ð ¤ì(€€€€€€€€€€€€€€€€€€€€€Ù½¥ÉÕ¹•¹Ð ¤ì(€€€€€€€€€€€€€€€€€€€ô(€€€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€€€Á±…•¡½±‘•Èô‹fb¿fƒbÇbœƒbßb£n3bçn0ƒf ƒb¿fn3fƒb£ff#n3bÏblƒfb¯fbŸf,ƒb»bßbŸn0ƒf#bÇf#b¼ƒbÇbœƒfûn3b¿bœƒj§fb0ƒb«bÏb¨ƒfbÇb«b£bÜƒb£bÏbŸbËb0ƒbŸb×fbŸb´ƒj§fƒf ƒfb«n3b³fƒbÇbœƒj¿bËbŸbÇbÐƒb£b¿fŠ˜ˆ(€€€€€€€€€€€€€€€€¼ø(€€€€€€€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰½‘•àµÍ…™•ÑäµÍÑÉ¥Àˆø(€€€€€€€€€€€€€€€€€€ñÍÁ…¸ûfb·b×f#bÄƒb¿bÄ]½É­ÍÁ…”ð½ÍÁ…¸øñÍÁ…¸ûb«bn3n3b¼ƒfb£fƒbŸbÈƒb«bën3n3bÄð½ÍÁ…¸øñÍÁ…¸ù	…­ÕÀƒb»f#b¿j§bŸbÄð½ÍÁ…¸øñÍÁ…¸ùÑÉ°€¬¹Ñ•Èƒb£bÇbŸn0ƒbŸb³bÇbœð½ÍÁ…¸ø(€€€€€€€€€€€€€€€€ð½‘¥Øø(€€€€€€€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰™¥•±µÉ½Üˆø(€€€€€€€€€€€€€€€€€€ñ‰ÕÑÑ½¸±…ÍÍ9…µ”ô‰ÁÉ¥µ…ÉäÝ¥‘”ˆ‘¥Í…‰±•õì……•¹ÑQ…Í¬¹ÑÉ¥´ ¤ñð…•¹ÑIÕ¹¹¥¹ô½¹±¥¬õíÉÕ¹•¹Ñôùí…•¹ÑIÕ¹¹¥¹œ€ü€½‘•àƒb¿bÄƒb·bŸfƒbŸb³bÇbŸbÏb«Š˜œ€è€ŸbÓbÇf#bä½‘•à•¹Ðôð½‰ÕÑÑ½¸ø(€€€€€€€€€€€€€€€€€€ñ‰ÕÑÑ½¸±…ÍÍ9…µ”ô‰Í•½¹‘…Éäˆ‘¥Í…‰±•õì……•¹ÑIÕ¹¹¥¹ô½¹±¥¬õíÍÑ½Á•¹ÑôùMÑ½À•¹Ðð½‰ÕÑÑ½¸ø(€€€€€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€€€€€ð½‘¥Øø4(4(€€€€€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰½‘•àµ½±Õµ¹Ìˆø4(€€€€€€€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰™¥±”µ‰É½ÝÍ•Èˆø4(€€€€€€€€€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰Á…¹•°µ¡•…ˆøñÍÁ…¸ù]½É­ÍÁ…”™¥±•Ìð½ÍÁ…¸øñ‰ÕÑÑ½¸½¹±¥¬õì ¤€ôøÝ½É­ÍÁ…•É…¹Ñ•€˜˜…•¹Ð¹±¥ÍÑ¥É•Ñ½Éä¡Ý½É­ÍÁ…”¥ôùI•™É•Í ð½‰ÕÑÑ½¸øð½‘¥Øø4(€€€€€€€€€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰™¥±”µ±¥ÍÐˆø4(€€€€€€€€€€€€€€€€€€€í…•¹Ð¹•¹ÑÉ¥•Ì¹µ…À ¡•¹ÑÉä¤€ôø€ñ‰ÕÑÑ½¸­•äõí•¹ÑÉä¹Á…Ñ¡ô½¹±¥¬õì ¤€ôø•¹ÑÉä¹¥Í}‘¥È€ü…•¹Ð¹±¥ÍÑ¥É•Ñ½Éä¡•¹ÑÉä¹Á…Ñ ¤€è½Á•¹¥±”¡•¹ÑÉä¹Á…Ñ ¥ôøñÍÁ…¸ùí•¹ÑÉä¹¥Í}‘¥È€ü€ŸŠZàœ€è€Ÿ
Üôí•¹ÑÉä¹¹…µ•ôð½ÍÁ…¸øñÍµ…±°ùí•¹ÑÉä¹¥Í}‘¥È€ü€™½±‘•Èœ€è€™¥±”ôð½Íµ…±°øð½‰ÕÑÑ½¸ø¥ô4(€€€€€€€€€€€€€€€€€€€í…•¹Ð¹•¹ÑÉ¥•Ì¹±•¹Ñ €ôôô€À€ü€ñ‘¥Ø±…ÍÍ9…µ”ô‰•µÁÑäµµ¥¹¤ˆûb£bçb¼ƒbŸbÈÁÁÉ½Ù—b0ƒfbŸn3fŠ3fbœƒbŸn3fb³bœƒb¿n3b¿fƒfn3Š3bÓf#fb¼¸ð½‘¥Øø€è¹Õ±±ô4(€€€€€€€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€€€€€€€ð½‘¥Øø4(4(€€€€€€€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰•‘¥Ñ½ÈµÁ…¹•°ˆø4(€€€€€€€€€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰Á…¹•°µ¡•…ˆøñÍÁ…¸ùíÍ•±•Ñ•‘¥±”ñð€¥±”ÁÉ•Ù¥•Üôð½ÍÁ…¸øñ‰ÕÑÑ½¸‘¥Í…‰±•õì…Í•±•Ñ•‘¥±•ô½¹±¥¬õíÍ…Ù•M•±•Ñ•‘¥±•ôùM…Ù”ð½‰ÕÑÑ½¸øð½‘¥Øø4(€€€€€€€€€€€€€€€€€€ñÑ•áÑ…É•„±…ÍÍ9…µ”ô‰½‘”µ•‘¥Ñ½ÈˆÙ…±Õ”õí•‘¥Ñ½ÉY…±Õ•ô½¹¡…¹”õì¡•Ù•¹Ð¤€ôøÍ•Ñ‘¥Ñ½ÉY…±Õ”¡•Ù•¹Ð¹Ñ…É•Ð¹Ù…±Õ”¥ôÁ±…•¡½±‘•Èô‹fbŸn3fƒbŸfb«b»bŸb£n0ƒbŸn3fb³bœƒffbŸn3bÐƒb¿bŸb¿fƒfn3Š3bÓf#b¿Š˜ˆÍÁ•±±¡•¬õí™…±Í•ô€¼ø4(€€€€€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€€€ð½‘¥Øø4(4(€€€€€€€€€€€€ñ…Í¥‘”±…ÍÍ9…µ”ô‰¥¹ÍÁ•Ñ½È±…ÍÌ…Ñ¥Ù¥Ñäµ¥¹ÍÁ•Ñ½Èˆø4(€€€€€€€€€€€€€€ñ ÌùA•Éµ¥ÍÍ¥½¸•¹Ñ•Èð½ Ìø4(€€€€€€€€€€€€€€ñ•…ÑÕÉ”Ñ¥Ñ±”ô‰]½É­ÍÁ…”ˆÙ…±Õ”õíÝ½É­ÍÁ…•É…¹Ñ•€ü€ÁÁÉ½Ù•œ€è€I•ÅÕ¥É•ôÉ•…‘äõíÝ½É­ÍÁ…•É…¹Ñ•‘ô€¼ø4(€€€€€€€€€€€€€€ñ•…ÑÕÉ”Ñ¥Ñ±”ô‰I•…™¥±•ÌˆÙ…±Õ”õíÝ½É­ÍÁ…•É…¹Ñ•€ü€M½Á•œ€è€1½­•ôÉ•…‘äõíÝ½É­ÍÁ…•É…¹Ñ•‘ô€¼ø4(€€€€€€€€€€€€€€ñ•…ÑÕÉ”Ñ¥Ñ±”ô‰]É¥Ñ”™¥±•ÌˆÙ…±Õ”ô‰Í¬•Ù•ÉäÑ¥µ”ˆÉ•…‘ä€¼ø4(€€€€€€€€€€€€€€ñ•…ÑÕÉ”Ñ¥Ñ±”ô‰Q•Éµ¥¹…°ˆÙ…±Õ”ô‰Í¬•Ù•ÉäÑ¥µ”ˆÉ•…‘ä€¼ø4(€€€€€€€€€€€€€€ñ•…ÑÕÉ”Ñ¥Ñ±”ô‰ÕÑ¼‰…­ÕÀˆÙ…±Õ”ô‰¹…‰±•ˆÉ•…‘ä€¼ø4(€€€€€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰‘¥Ù¥‘•Èˆ€¼ø4(€€€€€€€€€€€€€€ñ Ìù1¥Ù”Ñ¥Ù¥Ñäð½ Ìø4(€€€€€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰Ñ¥µ•±¥¹”ˆùí…•¹ÑQ¥µ•±¥¹”¹µ…À ¡¥Ñ•´°¥¹‘•à¤€ôø€ñ‘¥Ø­•äõí€‘í¥¹‘•áô´‘í¥Ñ•µõô±…ÍÍ9…µ”ô‰Ñ¥µ•±¥¹”µ¥Ñ•´ˆøñ¤€¼øñÍÁ…¸ùí¥Ñ•µôð½ÍÁ…¸øð½‘¥Øø¥õí…•¹ÑQ¥µ•±¥¹”¹±•¹Ñ €ôôô€À€ü€ñÀûfff#bÈQ…Í¬ƒbŸb³bÇbœƒfbÓb¿f¸ð½Àø€è¹Õ±±ôð½‘¥Øø4(€€€€€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰‘¥Ù¥‘•Èˆ€¼ø4(€€€€€€€€€€€€€€ñ ÌùM…™•Ñäð½ Ìø4(€€€€€€€€€€€€€€ñÕ°øñ±¤ùI•…ƒffbÜƒb¿bŸb»f]½É­ÍÁ…”ƒb«bn3n3b¿bÓb¿fð½±¤øñ±¤ù]É¥Ñ”ƒf Q•Éµ¥¹…°ƒfn3bŸbËffb¼ÁÁÉ½Ù…°ƒfbÏb«fn3fð½±¤øñ±¤ù	…­ÕÀƒb»f#b¿j§bŸbÄƒfb£fƒbŸbÈƒb«bën3n3bÄƒfbŸn3fð½±¤øñ±¤ûfbÏn3bÄƒf#bŸfbçn0Aƒb£f±½ÕÁ±…¹¹•ÈƒbŸbÇbÏbŸfƒffn3Š3bÓf#b¼ð½±¤øñ±¤ûb£b¿f#fÍ¡•±°ƒb‹bËbŸb¼ƒf ƒb£bœ½µµ…¹…±±½Ý±¥ÍÐð½±¤øñ±¤ùMÑ½À•¹Ðƒffn3bÓfƒb¿bÄƒb¿bÏb«bÇbÌƒbŸbÏb¨ð½±¤øð½Õ°ø4(€€€€€€€€€€€€ð½…Í¥‘”ø4(€€€€€€€€€€ð½Í•Ñ¥½¸ø¤4(€€€€€€€€¤€è¹Õ±±ô4(4(€€€€€€€í™…±Í”€˜˜Ñ…ˆ€ôôô€½µÁÕÑ•Èœ€ü€ (€€€€€€€€€¥ÍÕ•ÍÐ€ü€ñ1½¥¹I•ÅÕ¥É•Ñ¥Ñ±”ô‰½µÁÕÑ•Èˆ½¹á¥Ðõí±•…Ù•M•ÍÍ¥½¹ô€¼ø€è€ 4(€€€€€€€€€€ñÍ•Ñ¥½¸±…ÍÍ9…µ”ô‰Ý½É­ÍÁ…”µ±…å½ÕÐˆø4(€€€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰Ý½É­ÍÁ…”µµ…¥¸±…ÍÌˆø4(€€€€€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰Ý½É­ÍÁ…”µÑ¥Ñ±”ˆøñ‘¥Øøñ Èù½µÁÕÑ•Èð½ ÈøñÀûj§fb«bÇf1½…°Ñ½½±Ìƒb£bœƒb«bn3n3b¼ƒj§bŸbÇb£bÄƒf ƒfb·b¿f#b¿f]½É­ÍÁ…”¸ð½Àøð½‘¥ØøñÍÁ…¸±…ÍÍ9…µ”õíÝ½É­ÍÁ…•É…¹Ñ•€ü€Ý½É­ÍÁ…”µÍÑ…ÑÕÌÉ•…‘äœ€è€Ý½É­ÍÁ…”µÍÑ…ÑÕÌôùíÝ½É­ÍÁ…•É…¹Ñ•€ü€A•Éµ¥ÍÍ¥½¸…Ñ¥Ù”œ€è€5…¹Õ…°Ñ½½±Ìôð½ÍÁ…¸øð½‘¥Øø4(€€€€€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰™¥•±µÉ½Üˆø4(€€€€€€€€€€€€€€€€ñ¥¹ÁÕÐÙ…±Õ”õíÝ½É­ÍÁ…•ô½¹¡…¹”õì¡•Ù•¹Ð¤€ôøìÍ•Ñ]½É­ÍÁ…”¡•Ù•¹Ð¹Ñ…É•Ð¹Ù…±Õ”¤ìÍ•Ñ]½É­ÍÁ…•É…¹Ñ•¡™…±Í”¤ìõôÁ±…•¡½±‘•Èô‰]½É­ÍÁ…”ˆ€¼ø4(€€€€€€€€€€€€€€€€ñ‰ÕÑÑ½¸±…ÍÍ9…µ”ô‰Í•½¹‘…Éäˆ½¹±¥¬õí‰É½ÝÍ•]½É­ÍÁ…•ôù	É½ÝÍ—Š˜ð½‰ÕÑÑ½¸ø4(€€€€€€€€€€€€€€€€ñ‰ÕÑÑ½¸±…ÍÍ9…µ”ô‰Í•½¹‘…Éäˆ‘¥Í…‰±•õì…Ý½É­ÍÁ…”¹ÑÉ¥´ ¥ô½¹±¥¬õì ¤€ôøÉ…¹Ñ]½É­ÍÁ…”¡Ý½É­ÍÁ…”¥ôùÁÁÉ½Ù”ð½‰ÕÑÑ½¸ø4(€€€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰Ñ•Éµ¥¹…°µ…Éˆø4(€€€€€€€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰Ñ•Éµ¥¹…°µ™¥•±‘Ìˆøñ¥¹ÁÕÐÙ…±Õ”õí½µµ…¹‘ô½¹¡…¹”õì¡•Ù•¹Ð¤€ôøÍ•Ñ½µµ…¹¡•Ù•¹Ð¹Ñ…É•Ð¹Ù…±Õ”¥ôÁ±…•¡½±‘•Èô‰¹Á´ˆ€¼øñ¥¹ÁÕÐÙ…±Õ”õí½µµ…¹‘ÉÍô½¹¡…¹”õì¡•Ù•¹Ð¤€ôøÍ•Ñ½µµ…¹‘ÉÌ¡•Ù•¹Ð¹Ñ…É•Ð¹Ù…±Õ”¥ôÁ±…•¡½±‘•Èô‰ÉÕ¸Ñ•ÍÐˆ€¼øñ‰ÕÑÑ½¸±…ÍÍ9…µ”ô‰ÁÉ¥µ…Éäˆ‘¥Í…‰±•õì…Ý½É­ÍÁ…•É…¹Ñ•ñð…•¹Ð¹‰ÕÍåô½¹±¥¬õíÉÕ¹5…¹Õ…±½µµ…¹‘ôùIÕ¸ð½‰ÕÑÑ½¸øð½‘¥Øø4(€€€€€€€€€€€€€€€€ñÁÉ”ùí…•¹Ð¹Ñ•Éµ¥¹…±=ÕÑÁÕÐñð€Q•Éµ¥¹…°½ÕÑÁÕÐÝ¥±°…ÁÁ•…È¡•É”¸ôð½ÁÉ”ø4(€€€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰™ÕÑÕÉ”µÉ¥ˆøñ•…ÑÕÉ”Ñ¥Ñ±”ô‰¥±•ÌˆÙ…±Õ”ô‰Ñ¥Ù”ˆÉ•…‘ä€¼øñ•…ÑÕÉ”Ñ¥Ñ±”ô‰Q•Éµ¥¹…°ˆÙ…±Õ”ô‰Ñ¥Ù”ˆÉ•…‘ä€¼øñ•…ÑÕÉ”Ñ¥Ñ±”ô‰9…Ñ¥Ù”™½±‘•ÈÁ¥­•ÈˆÙ…±Õ”ô‰Ñ¥Ù”ˆÉ•…‘ä€¼øñ•…ÑÕÉ”Ñ¥Ñ±”ô‰ÕÑ¼‰…­ÕÀˆÙ…±Õ”ô‰Ñ¥Ù”ˆÉ•…‘ä€¼øñ•…ÑÕÉ”Ñ¥Ñ±”ô‰	É½ÝÍ•ÈˆÙ…±Õ”ô‰9•áÐˆ€¼øñ•…ÑÕÉ”Ñ¥Ñ±”ô‰MÉ••¸Y¥Í¥½¸ˆÙ…±Õ”ô‰9•áÐˆ€¼øð½‘¥Øø4(€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€€€ñ…Í¥‘”±…ÍÍ9…µ”ô‰¥¹ÍÁ•Ñ½È±…ÍÌ…Ñ¥Ù¥Ñäµ¥¹ÍÁ•Ñ½Èˆøñ Ìù1½…°•¹Ð±½œð½ Ìøñ‘¥Ø±…ÍÍ9…µ”ô‰Ñ¥µ•±¥¹”ˆùí…•¹Ð¹±½Ì¹µ…À ¡¥Ñ•´°¥¹‘•à¤€ôø€ñ‘¥Ø±…ÍÍ9…µ”ô‰Ñ¥µ•±¥¹”µ¥Ñ•´ˆ­•äõí€‘í¥¹‘•áô´‘í¥Ñ•µõôøñ¤€¼øñÍÁ…¸ùí¥Ñ•µôð½ÍÁ…¸øð½‘¥Øø¥ôð½‘¥Øøð½…Í¥‘”ø4(€€€€€€€€€€ð½Í•Ñ¥½¸ø¤4(€€€€€€€€¤€è¹Õ±±ô4(€€€€€€ð½µ…¥¸ø4(4(€€€€€í…ÁÁÉ½Ù…°€ü€ 4(€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰…ÁÁÉ½Ù…°µ‰…­‘É½Àˆøñ‘¥Ø±…ÍÍ9…µ”ô‰…ÁÁÉ½Ù…°µµ½‘…°±…ÍÌˆøñ‘¥Ø±…ÍÍ9…µ”ô‰…ÁÁÉ½Ù…°µ¥½¸ˆø„ð½‘¥Øøñ Èùí…ÁÁÉ½Ù…°¹Ñ¥Ñ±•ôð½ ÈøñÁÉ”ùí…ÁÁÉ½Ù…°¹‘•Ñ…¥±ôð½ÁÉ”øñÀûbŸn3fƒbçffn3bŸb¨ƒffbÜƒb£bœƒb«bn3n3b¼ƒfbÏb«fn3fƒbÓfbœƒbŸfb³bŸfƒfn3Š3bÓf#b¼¸ð½Àøñ‘¥Ø±…ÍÍ9…µ”ô‰…ÁÁÉ½Ù…°µ…Ñ¥½¹Ìˆøñ‰ÕÑÑ½¸±…ÍÍ9…µ”ô‰Í•½¹‘…Éäˆ½¹±¥¬õì ¤€ôøÉ•Í½±Ù•ÁÁÉ½Ù…°¡™…±Í”¥ôûfbëf ð½‰ÕÑÑ½¸øñ‰ÕÑÑ½¸±…ÍÍ9…µ”ô‰ÁÉ¥µ…Éäˆ½¹±¥¬õì ¤€ôøÉ•Í½±Ù•ÁÁÉ½Ù…°¡ÑÉÕ”¥ôùí…ÁÁÉ½Ù…°¹½¹™¥Éµ1…‰•±ôð½‰ÕÑÑ½¸øð½‘¥Øøð½‘¥Øøð½‘¥Øø4(€€€€€€¤€è¹Õ±±ô4(€€€€ð½‘¥Øø4(€€¤ì4)ô4(4)™Õ¹Ñ¥½¸ÕÑ¡MÉ••¸¡ì½¹ÕÑ¡•¹Ñ¥…Ñ•°½¹Õ•ÍÐôèì½¹ÕÑ¡•¹Ñ¥…Ñ•è€ ¤€ôøÙ½¥ì½¹Õ•ÍÐè€ ¤€ôøÙ½¥ô¤ì4(€½¹ÍÐm•µ…¥°°Í•Ñµ…¥±t€ôÕÍ•MÑ…Ñ” œœ¤ì4(€½¹ÍÐmÁ…ÍÍÝ½É°Í•ÑA…ÍÍÝ½É‘t€ôÕÍ•MÑ…Ñ” œœ¤ì4(€½¹ÍÐmµ½‘”°Í•Ñ5½‘•t€ôÕÍ•MÑ…Ñ”ðÍ¥¹¥¸œð€Í¥¹ÕÀœø Í¥¹¥¸œ¤ì4(€½¹ÍÐmÍÑ…ÑÕÌ°Í•ÑMÑ…ÑÕÍt€ôÕÍ•MÑ…Ñ” œœ¤ì4(€½¹ÍÐm‰ÕÍä°Í•Ñ	ÕÍåt€ôÕÍ•MÑ…Ñ”¡™…±Í”¤ì4(4(€…Íå¹Œ™Õ¹Ñ¥½¸ÍÕ‰µ¥Ð ¤ì4(€€€¥˜€ …•µ…¥°¹ÑÉ¥´ ¤ñðÁ…ÍÍÝ½É¹±•¹Ñ €ð€Øñð‰ÕÍä¤ì4(€€€€€¥˜€¡Á…ÍÍÝ½É¹±•¹Ñ €ð€Ø¤Í•ÑMÑ…ÑÕÌ ŸbÇfbÈƒbçb£f#bÄƒb£bŸn3b¼ƒb·b¿bŸffƒnØƒj§bŸbÇbŸj§b«bÄƒb£bŸbÓb¼¸œ¤ì4(€€€€€É•ÑÕÉ¸ì4(€€€ô4(€€€Í•Ñ	ÕÍä¡ÑÉÕ”¤ì4(€€€Í•ÑMÑ…ÑÕÌ œœ¤ì4(€€€½¹ÍÐÉ•ÍÕ±Ð€ôµ½‘”€ôôô€Í¥¹¥¸œ€ü…Ý…¥ÐÍ¥¹%¸¡•µ…¥°°Á…ÍÍÝ½É¤€è…Ý…¥ÐÍ¥¹UÀ¡•µ…¥°°Á…ÍÍÝ½É¤ì4(€€€Í•Ñ	ÕÍä¡™…±Í”¤ì4(€€€¥˜€ …É•ÍÕ±Ð¹½¬¤É•ÑÕÉ¸Í•ÑMÑ…ÑÕÌ¡É•ÍÕ±Ð¹µ•ÍÍ…”¤ì4(€€€¥˜€¡É•ÍÕ±Ð¹¹••‘Íµ…¥±½¹™¥Éµ…Ñ¥½¸¤ì4(€€€€€Í•ÑMÑ…ÑÕÌ ŸbŸn3fn3fƒb«bn3n3b¼ƒbŸbÇbÏbŸfƒbÓb¼¸ƒb£bçb¼ƒbŸbÈƒb«bn3n3b¼ƒf#bŸbÇb¼ƒb·bÏbŸb ƒbÓf ¸œ¤ì4(€€€€€Í•Ñ5½‘” Í¥¹¥¸œ¤ì4(€€€€€É•ÑÕÉ¸ì4(€€€ô4(€€€½¹ÕÑ¡•¹Ñ¥…Ñ• ¤ì4(€ô4(4(€É•ÑÕÉ¸€ 4(€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰…ÕÑ µÍÉ••¸ˆø4(€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰…ÕÑ µ…µ‰¥•¹Ðˆ€¼ø4(€€€€€€ñÍ•Ñ¥½¸±…ÍÍ9…µ”ô‰…ÕÑ µ…É±…ÍÌˆø4(€€€€€€€€ñ¥µœÍÉŒôˆ½…ÁÀµ¥½¸¹Á¹œˆ…±Ðô‰…ÉÍ¥$ˆ€¼ø4(€€€€€€€€ñ Äù…ÉÍ¥$•Í­Ñ½Àð½ Äø4(€€€€€€€€ñÀûf#bÇf#b¼ƒb£bœƒb·bÏbŸb ƒbŸb×fn0èƒnÇnÀƒfûn3bŸfƒf ƒnÐƒb«b×f#n3bÄƒb¿bÄƒbÇf#bÈ€¬Må¹Œƒff#b£bŸn3fƒf ƒb¿bÏb«bÇbÏn0½‘•à¸ð½Àø4(€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰…ÕÑ µÑ…‰Ìˆøñ‰ÕÑÑ½¸±…ÍÍ9…µ”õíµ½‘”€ôôô€Í¥¹¥¸œ€ü€…Ñ¥Ù”œ€è€œô½¹±¥¬õì ¤€ôøÍ•Ñ5½‘” Í¥¹¥¸œ¥ôûf#bÇf#b¼ð½‰ÕÑÑ½¸øñ‰ÕÑÑ½¸±…ÍÍ9…µ”õíµ½‘”€ôôô€Í¥¹ÕÀœ€ü€…Ñ¥Ù”œ€è€œô½¹±¥¬õì ¤€ôøÍ•Ñ5½‘” Í¥¹ÕÀœ¥ôûbÏbŸb»b¨ƒb·bÏbŸb ð½‰ÕÑÑ½¸øð½‘¥Øø4(€€€€€€€€ñ¥¹ÁÕÐÙ…±Õ”õí•µ…¥±ô½¹¡…¹”õì¡•Ù•¹Ð¤€ôøÍ•Ñµ…¥°¡•Ù•¹Ð¹Ñ…É•Ð¹Ù…±Õ”¥ôÁ±…•¡½±‘•Èô‰µ…¥°ˆÑåÁ”ô‰•µ…¥°ˆ‘¥Èô‰±ÑÈˆ€¼ø4(€€€€€€€€ñ¥¹ÁÕÐÙ…±Õ”õíÁ…ÍÍÝ½É‘ô½¹¡…¹”õì¡•Ù•¹Ð¤€ôøÍ•ÑA…ÍÍÝ½É¡•Ù•¹Ð¹Ñ…É•Ð¹Ù…±Õ”¥ôÁ±…•¡½±‘•Èô‰A…ÍÍÝ½ÉˆÑåÁ”ô‰Á…ÍÍÝ½Éˆ‘¥Èô‰±ÑÈˆ€¼ø4(€€€€€€€íÍÑ…ÑÕÌ€ü€ñ‘¥Ø±…ÍÍ9…µ”ô‰…ÕÑ µÍÑ…ÑÕÌˆùíÍÑ…ÑÕÍôð½‘¥Øø€è¹Õ±±ô4(€€€€€€€€ñ‰ÕÑÑ½¸±…ÍÍ9…µ”ô‰ÁÉ¥µ…ÉäÝ¥‘”ˆ‘¥Í…‰±•õí‰ÕÍåô½¹±¥¬õíÍÕ‰µ¥Ñôùí‰ÕÍä€ü€ŸŠ˜œ€èµ½‘”€ôôô€Í¥¹¥¸œ€ü€Ÿf#bÇf#b¼ƒb£f…ÉÍ¥$œ€è€ŸbÏbŸb»b¨ƒb·bÏbŸb ôð½‰ÕÑÑ½¸ø4(€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰‘¥Ù¥‘•Èˆ€¼ø4(€€€€€€€€ñ‰ÕÑÑ½¸±…ÍÍ9…µ”ô‰Í•½¹‘…ÉäÝ¥‘”ˆ‘¥Í…‰±•õí‰ÕÍåô½¹±¥¬õí½¹Õ•ÍÑôûbŸb¿bŸffƒb£fŠ3bçff#bŸfƒfffbŸfð½‰ÕÑÑ½¸ø4(€€€€€€€€ñÍµ…±°ùÕ•ÍÐèƒbÇf#bËbŸffƒnÔƒfûn3bŸf€¬ƒnÈƒb«b×f#n3bÄ¸½‘•àƒb£bÇbŸn0ƒbŸffn3b¨ƒfn3bŸbËffb¼ƒf#bÇf#b¼ƒbŸbÏb¨¸ð½Íµ…±°ø4(€€€€€€ð½Í•Ñ¥½¸ø4(€€€€ð½‘¥Øø4(€€¤ì4)ô4(4)™Õ¹Ñ¥½¸1½¥¹I•ÅÕ¥É•¡ìÑ¥Ñ±”°½¹á¥ÐôèìÑ¥Ñ±”èÍÑÉ¥¹œì½¹á¥Ðè€ ¤€ôøÙ½¥ô¤ì4(€É•ÑÕÉ¸€ñÍ•Ñ¥½¸±…ÍÍ9…µ”ô‰Ý½É­ÍÁ…”µ±…å½ÕÐˆøñ‘¥Ø±…ÍÍ9…µ”ô‰Ý½É­ÍÁ…”µµ…¥¸±…ÍÌˆøñ‘¥Ø±…ÍÍ9…µ”ô‰Ý•±½µ”ˆøñ¥µœÍÉŒôˆ½…ÁÀµ¥½¸¹Á¹œˆ…±Ðô‰…ÉÍ¥$ˆ€¼øñ ÄùíÑ¥Ñ±•ôƒfn3bŸbËffb¼ƒf#bÇf#b¼ƒbŸbÏb¨ð½ ÄøñÀûb£bÇbŸn0ƒb¿bÏb«bÇbÏn0ƒb£fAƒf ƒbŸb³bÇbŸn0ƒb¿bÏb«f#bÇb0ƒbŸb£b«b¿bœƒb£bœƒb·bÏbŸb …ÉÍ¥$ƒf#bŸbÇb¼ƒbÓf ¸ð½Àøñ‰ÕÑÑ½¸±…ÍÍ9…µ”ô‰ÁÉ¥µ…Éäˆ½¹±¥¬õí½¹á¥ÑôûbÇfb«fƒb£fƒb×fb·fƒf#bÇf#b¼ð½‰ÕÑÑ½¸øð½‘¥Øøð½‘¥Øøð½Í•Ñ¥½¸øì4)ô4(4)™Õ¹Ñ¥½¸9…Ù	ÕÑÑ½¸¡ì…Ñ¥Ù”°±…‰•°°…ÁÑ¥½¸°½¹±¥¬ôèì…Ñ¥Ù”è‰½½±•…¸ì±…‰•°èÍÑÉ¥¹œì…ÁÑ¥½¸èÍÑÉ¥¹œì½¹±¥¬è€ ¤€ôøÙ½¥ô¤ì4(€É•ÑÕÉ¸€ñ‰ÕÑÑ½¸±…ÍÍ9…µ”õí…Ñ¥Ù”€ü€¹…Øµ‰ÕÑÑ½¸…Ñ¥Ù”œ€è€¹…Øµ‰ÕÑÑ½¸ô½¹±¥¬õí½¹±¥­ôøñÍÑÉ½¹œùí±…‰•±ôð½ÍÑÉ½¹œøñÍÁ…¸ùí…ÁÑ¥½¹ôð½ÍÁ…¸øð½‰ÕÑÑ½¸øì4)ô4(4)™Õ¹Ñ¥½¸%¹™¼¡ì±…‰•°°Ù…±Õ”ôèì±…‰•°èÍÑÉ¥¹œìÙ…±Õ”èÍÑÉ¥¹œô¤ì4(€É•ÑÕÉ¸€ñ‘¥Ø±…ÍÍ9…µ”ô‰¥¹™¼µÉ½ÜˆøñÍÁ…¸ùí±…‰•±ôð½ÍÁ…¸øñÍÑÉ½¹œùíÙ…±Õ•ôð½ÍÑÉ½¹œøð½‘¥Øøì4)ô4(4)™Õ¹Ñ¥½¸•…ÑÕÉ”¡ìÑ¥Ñ±”°Ù…±Õ”°É•…‘ä€ô™…±Í”ôèìÑ¥Ñ±”èÍÑÉ¥¹œìÙ…±Õ”èÍÑÉ¥¹œìÉ•…‘äüè‰½½±•…¸ô¤ì4(€É•ÑÕÉ¸€ñ‘¥Ø±…ÍÍ9…µ”õíÉ•…‘ä€ü€™•…ÑÕÉ”µ…ÉÉ•…‘äœ€è€™•…ÑÕÉ”µ…ÉôøñÍÑÉ½¹œùíÑ¥Ñ±•ôð½ÍÑÉ½¹œøñÍÁ…¸ùíÙ…±Õ•ôð½ÍÁ…¸øð½‘¥Øøì4)ô4