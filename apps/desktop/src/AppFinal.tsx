import { useEffect, useRef, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { open } from '@tauri-apps/plugin-dialog';
import { useDesktopAgent } from './hooks/useDesktopAgent';
import { planAgentStep, type AgentObservation, type AgentToolCall } from './services/agent';
import { sendAiRequest, type AiMode, type DailyQuota } from './services/api';
import { getCurrentUser, onAuthChanged, signIn, signOut, signUp } from './services/auth';
import {
  getAccountSnapshot,
  getConversationMessages,
  getCurrentDailyQuota,
  listConversations,
  type AccountSnapshot,
  type ConversationSummary,
} from './services/data';

type Tab = 'chat' | 'codex' | 'computer';
type UiMessage = { id: string; role: 'user' | 'assistant'; text?: string; image?: string };
type ApprovalState = { title: string; detail: string; confirmLabel: string };

const USER_FULL_QUOTA: DailyQuota = { chatRemaining: 10, imageRemaining: 4 };
const GUEST_FULL_QUOTA: DailyQuota = { chatRemaining: 5, imageRemaining: 2 };
const STARTERS = [
  'برای امروز یک برنامه کاری حرفه‌ای بساز',
  'این ایده را تبدیل به یک برنامه اجرایی کن',
  'برای محصول من یک متن معرفی حرفه‌ای بنویس',
];

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

function truncate(value: string, max = 18000): string {
  return value.length > max ? `${value.slice(0, max)}\n…[truncated]` : value;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
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

  function enterGuest() {
    setGuestMode(true);
    setQuota(GUEST_FULL_QUOTA);
    setMessages([]);
    setConversationId(undefined);
    setTab('chat');
  }

  async function leaveSession() {
    if (user) await signOut();
    setGuestMode(false);
    setUser(null);
    setMessages([]);
    setConversationId(undefined);
    setQuota(undefined);
    setTab('chat');
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
    const text = (prefill ?? input).trim();
    if (!text || sending) return;

    const before = messages;
    setMessages((current) => [...current, { id: `${Date.now()}-u`, role: 'user', text }]);
    setInput('');
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
      });

      if (!result.ok) {
        setMessages((current) => [...current, { id: `${Date.now()}-e`, role: 'assistant', text: result.error }]);
        return;
      }

      if (result.conversationId && user) setConversationId(result.conversationId);
      if (result.quota) setQuota(result.quota);

      const assistant: UiMessage = result.mode === 'image'
        ? { id: `${Date.now()}-i`, role: 'assistant', image: result.image, text: 'تصویر آماده شد.' }
        : { id: `${Date.now()}-a`, role: 'assistant', text: result.text };
      setMessages((current) => [...current, assistant]);
      if (user) await refreshCloudState();
    } catch {
      setMessages((current) => [...current, { id: `${Date.now()}-x`, role: 'assistant', text: 'ارتباط با سرویس برقرار نشد.' }]);
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
    setTab('chat');
  }

  function newConversation() {
    setConversationId(undefined);
    setMessages([]);
    setMode('chat');
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
      setAgentTimeline((current) => ['✓ Workspace approved', ...current]);
    } catch (error) {
      setWorkspaceGranted(false);
      setAgentTimeline((current) => [`✕ ${String(error)}`, ...current]);
    }
  }

  async function browseWorkspace() {
    try {
      const selected = await open({ directory: true, multiple: false, title: 'انتخاب Workspace برای FarsiAI Codex' });
      if (!selected) return;
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (typeof path === 'string' && path.trim()) await grantWorkspace(path);
    } catch (error) {
      setAgentTimeline((current) => [`✕ Folder picker: ${String(error)}`, ...current]);
    }
  }

  async function openFile(path: string) {
    try {
      const content = await agent.readFile(path);
      setSelectedFile(path);
      setEditorValue(content);
    } catch (error) {
      setAgentTimeline((current) => [`✕ ${String(error)}`, ...current]);
    }
  }

  async function saveSelectedFile() {
    if (!selectedFile) return;
    const approved = await requestApproval({
      title: 'اجازه ذخیره فایل',
      detail: `FarsiAI می‌خواهد این فایل را تغییر دهد:\n${selectedFile}\n\nقبل از تغییر، Backup خودکار ساخته می‌شود.`,
      confirmLabel: 'ذخیره فایل',
    });
    if (!approved) return;

    try {
      const backup = await agent.writeFile(selectedFile, editorValue);
      setAgentTimeline((current) => [backup ? '✓ Saved · backup created' : '✓ Saved new file', ...current]);
    } catch (error) {
      setAgentTimeline((current) => [`✕ ${String(error)}`, ...current]);
    }
  }

  async function runManualCommand() {
    if (!workspaceGranted) {
      setAgentTimeline((current) => ['ابتدا Workspace را approve کن.', ...current]);
      return;
    }
    const args = commandArgs.trim().split(/\s+/).filter(Boolean);
    const approved = await requestApproval({
      title: 'اجازه اجرای Terminal',
      detail: `${command} ${args.join(' ')}\n\nWorking directory:\n${workspace}`,
      confirmLabel: 'اجرا',
    });
    if (!approved) return;

    try {
      await agent.runCommand(command.trim(), args, workspace);
    } catch (error) {
      setAgentTimeline((current) => [`✕ ${String(error)}`, ...current]);
    }
  }

  async function executeAgentTool(tool: AgentToolCall): Promise<string> {
    if (tool.name === 'list_directory') {
      const path = toolPath(workspace, tool.arguments.path);
      const entries = await agent.listDirectory(path);
      return truncate(JSON.stringify(entries.map((entry) => ({ name: entry.name, is_dir: entry.is_dir }))));
    }

    if (tool.name === 'read_file') {
      const path = toolPath(workspace, tool.arguments.path);
      const content = await agent.readFile(path);
      setSelectedFile(path);
      setEditorValue(content);
      return truncate(content);
    }

    if (tool.name === 'write_file') {
      const path = toolPath(workspace, tool.arguments.path);
      const approved = await requestApproval({
        title: 'Codex می‌خواهد فایل را تغییر دهد',
        detail: `${tool.arguments.path}\n\nقبل از Write از نسخه فعلی Backup گرفته می‌شود. تغییر فقط داخل Workspace تأییدشده انجام می‌شود.`,
        confirmLabel: 'اعمال تغییر',
      });
      if (!approved) return 'USER_DENIED_WRITE';

      const backup = await agent.writeFile(path, tool.arguments.content);
      setSelectedFile(path);
      setEditorValue(tool.arguments.content);
      return backup ? 'WRITE_OK_BACKUP_CREATED' : 'WRITE_OK_NEW_FILE';
    }

    const args = Array.isArray(tool.arguments.args) ? tool.arguments.args : [];
    const approved = await requestApproval({
      title: 'Codex می‌خواهد Terminal اجرا کند',
      detail: `${tool.arguments.command} ${args.join(' ')}\n\nWorkspace:\n${workspace}`,
      confirmLabel: 'اجرا',
    });
    if (!approved) return 'USER_DENIED_COMMAND';

    const result = await agent.runCommand(tool.arguments.command, args, workspace);
    return truncate(`exit=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }

  function stopAgent() {
    if (!agentRunning) return;
    agentAbortRef.current?.abort();
    setAgentTimeline((current) => [...current, '■ توقف توسط کاربر درخواست شد.']);
    if (approval) resolveApproval(false);
  }

  async function runAgent() {
    const task = agentTask.trim();
    if (!task || agentRunning) return;
    if (!user) {
      setAgentTimeline(['✕ برای استفاده از Codex باید وارد حساب شوی.']);
      return;
    }
    if (!workspaceGranted) {
      setAgentTimeline((current) => ['ابتدا Workspace را approve کن.', ...current]);
      return;
    }

    const controller = new AbortController();
    agentAbortRef.current = controller;
    setAgentRunning(true);
    setAgentTimeline([`● Task: ${task}`, '✓ Permission boundary active', '○ Codex planner connected']);
    let observations: AgentObservation[] = [];

    try {
      for (let step = 1; step <= 16; step += 1) {
        if (controller.signal.aborted) break;
        setAgentTimeline((current) => [...current, `○ Planning step ${step}…`]);

        const plan = await planAgentStep({ task, workspace, observations, signal: controller.signal });
        if (controller.signal.aborted) break;
        if (!plan.ok) {
          setAgentTimeline((current) => [...current, `✕ ${plan.error}`]);
          break;
        }
        if (plan.type === 'final') {
          setAgentTimeline((current) => [...current, `✓ ${plan.message}`]);
          break;
        }

        const tool = plan.tool;
        setAgentTimeline((current) => [...current, `→ ${tool.name}`]);
        try {
          const result = await executeAgentTool(tool);
          observations = [...observations, { role: 'tool', name: tool.name, content: result }].slice(-18);
          setAgentTimeline((current) => [
            ...current,
            result.includes('BACKUP') ? `✓ ${tool.name} completed · backup protected` : `✓ ${tool.name} completed`,
          ]);
          if (result.startsWith('USER_DENIED_')) {
            observations = [...observations, { role: 'note', content: 'The user denied the requested side effect. Choose a safer alternative or stop.' }].slice(-18);
          }
        } catch (error) {
          const message = String(error);
          observations = [...observations, { role: 'tool', name: tool.name, content: `ERROR: ${message}` }].slice(-18);
          setAgentTimeline((current) => [...current, `✕ ${message}`]);
        }
      }
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        setAgentTimeline((current) => [...current, '■ Agent متوقف شد.']);
      } else {
        setAgentTimeline((current) => [...current, `✕ ${String(error)}`]);
      }
    } finally {
      if (controller.signal.aborted) setAgentTimeline((current) => [...current, '■ Agent stopped']);
      if (agentAbortRef.current === controller) agentAbortRef.current = null;
      setAgentRunning(false);
      await refreshCloudState();
    }
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

  return (
    <div className="app-shell">
      <aside className="sidebar glass">
        <div className="brand-row">
          <img className="app-icon" src="/app-icon.png" alt="FarsiAI" />
          <div><strong>FarsiAI</strong><span>Desktop Intelligence</span></div>
        </div>

        <button className="new-chat" onClick={newConversation}>＋ گفتگوی جدید</button>
        <nav className="nav-stack">
          <NavButton active={tab === 'chat'} label="Chat" caption="گفتگو و تصویر" onClick={() => setTab('chat')} />
          <NavButton active={tab === 'codex'} label="Codex" caption={isGuest ? 'نیازمند ورود' : 'Agent واقعی PC'} onClick={() => setTab('codex')} />
          <NavButton active={tab === 'computer'} label="Computer" caption={isGuest ? 'نیازمند ورود' : 'Workspace و Terminal'} onClick={() => setTab('computer')} />
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

        <div className="profile-card">
          <div>
            <strong>{isGuest ? 'Guest' : account.displayName || account.email || 'FarsiAI User'}</strong>
            <span>{isGuest ? 'GUEST' : account.plan.toUpperCase()} · Chat {shownQuota.chatRemaining} · Image {shownQuota.imageRemaining}</span>
          </div>
          <button className="icon-button" onClick={leaveSession}>↪</button>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar glass">
          <div>
            <strong>{tab === 'chat' ? 'Chat' : tab === 'codex' ? 'Codex Workspace' : 'Computer Access'}</strong>
            <span>{tab === 'chat' ? (isGuest ? 'Guest session · بدون ذخیره Cloud' : 'همان اکانت و تاریخچه روی موبایل و دسکتاپ') : 'Local tools با Permission-first security'}</span>
          </div>
          <div className="top-actions">
            <span className="quota-pill">Chat {shownQuota.chatRemaining}/{fullQuota.chatRemaining} · Image {shownQuota.imageRemaining}/{fullQuota.imageRemaining}</span>
            {agentRunning ? <span className="quota-pill">Agent working</span> : null}
            <span className="status-pill"><i /> Online</span>
          </div>
        </header>

        {tab === 'chat' ? (
          <section className="chat-layout">
            <div className="chat-stage glass">
              <div className="mode-row">
                <div className="segmented">
                  <button className={mode === 'chat' ? 'active' : ''} onClick={() => setMode('chat')}>Chat</button>
                  <button className={mode === 'image' ? 'active' : ''} onClick={() => setMode('image')}>Image</button>
                </div>
                <span>{isGuest ? 'Guest quota enforced by server' : 'Cloud-synced conversation'}</span>
              </div>

              <div className="messages">
                {messages.length === 0 ? (
                  <div className="welcome">
                    <img src="/app-icon.png" alt="FarsiAI" />
                    <h1>{mode === 'chat' ? 'چطور می‌تونم کمکت کنم؟' : 'چه تصویری بسازیم؟'}</h1>
                    <p>{isGuest ? 'حالت مهمان: ۵ پیام و ۲ تصویر در روز.' : 'پلن Free: ۱۰ پیام و ۴ تصویر در روز، با داده مشترک موبایل و دسکتاپ.'}</p>
                    <div className="starter-grid">{STARTERS.map((starter) => <button key={starter} onClick={() => submitChat(starter)}>{starter}</button>)}</div>
                  </div>
                ) : messages.map((message) => (
                  <article key={message.id} className={`message ${message.role}`}>
                    <div className="message-label">{message.role === 'user' ? 'You' : 'FarsiAI'}</div>
                    {message.text ? <div className="message-text">{message.text}</div> : null}
                    {message.image ? <img className="generated-image" src={message.image} alt="AI generated" /> : null}
                  </article>
                ))}
                {sending ? <div className="thinking"><i /><span>{mode === 'image' ? 'در حال ساخت تصویر…' : 'در حال فکر کردن…'}</span></div> : null}
              </div>

              <div className="composer">
                <textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder={mode === 'image' ? 'تصویر موردنظرت را توصیف کن…' : 'هر چیزی می‌خواهی بپرس…'} />
                <div className="composer-footer">
                  <span>{mode === 'image' ? 'Image mode' : 'FarsiAI Chat'}</span>
                  <button className="primary" disabled={!input.trim() || sending} onClick={() => submitChat()}>{sending ? '…' : 'ارسال ↑'}</button>
                </div>
              </div>
            </div>

            <aside className="inspector glass">
              <h3>{isGuest ? 'Guest session' : 'Account sync'}</h3>
              <Info label="Plan" value={isGuest ? 'guest' : account.plan} />
              <Info label="Chat باقی‌مانده" value={`${shownQuota.chatRemaining} از ${fullQuota.chatRemaining}`} />
              <Info label="Image باقی‌مانده" value={`${shownQuota.imageRemaining} از ${fullQuota.imageRemaining}`} />
              {!isGuest ? <Info label="Email" value={account.email || '—'} /> : null}
              <div className="divider" />
              <h3>{isGuest ? 'Privacy' : 'Shared data'}</h3>
              <p>{isGuest ? 'حالت مهمان به تاریخچه حساب دسترسی ندارد و Conversationها در حساب ذخیره نمی‌شوند.' : 'Conversationها و سهمیه از همان Supabase موبایل خوانده می‌شوند؛ Desktop دیتابیس جدا ندارد.'}</p>
              <div className="sync-badge">{isGuest ? 'Guest · 5 Chat · 2 Image' : '✓ Mobile ↔ Desktop'}</div>
            </aside>
          </section>
        ) : null}

        {tab === 'codex' ? (
          isGuest ? <LoginRequired title="Codex" onExit={leaveSession} /> : (
          <section className="workspace-layout">
            <div className="workspace-main glass">
              <div className="workspace-title">
                <div><h2>Codex Agent</h2><p>Task را بگو؛ Agent فایل را می‌خواند، تغییر می‌دهد، دستور اجرا می‌کند و نتیجه را بررسی می‌کند.</p></div>
                <span className={workspaceGranted ? 'workspace-status ready' : 'workspace-status'}>{workspaceGranted ? 'Workspace approved' : 'No workspace'}</span>
              </div>

              <div className="field-row">
                <input value={workspace} onChange={(event) => { setWorkspace(event.target.value); setWorkspaceGranted(false); }} placeholder="یک پوشه انتخاب کن یا مسیر را وارد کن" />
                <button className="secondary" onClick={browseWorkspace}>Browse…</button>
                <button className="secondary" disabled={!workspace.trim()} onClick={() => grantWorkspace(workspace)}>Approve</button>
              </div>

              <div className="agent-task-card">
                <textarea value={agentTask} onChange={(event) => setAgentTask(event.target.value)} placeholder="مثلاً: یک فایل hello.txt بساز، داخلش Hello FarsiAI بنویس، بعد فایل را بخوان و نتیجه را تأیید کن." />
                <div className="field-row">
                  <button className="primary wide" disabled={!agentTask.trim() || agentRunning} onClick={runAgent}>{agentRunning ? 'Codex در حال اجراست…' : 'شروع Codex Agent'}</button>
                  <button className="secondary" disabled={!agentRunning} onClick={stopAgent}>Stop Agent</button>
                </div>
              </div>

              <div className="codex-columns">
                <div className="file-browser">
                  <div className="panel-head"><span>Workspace files</span><button onClick={() => workspaceGranted && agent.listDirectory(workspace)}>Refresh</button></div>
                  <div className="file-list">
                    {agent.entries.map((entry) => <button key={entry.path} onClick={() => entry.is_dir ? agent.listDirectory(entry.path) : openFile(entry.path)}><span>{entry.is_dir ? '▸' : '·'} {entry.name}</span><small>{entry.is_dir ? 'folder' : 'file'}</small></button>)}
                    {agent.entries.length === 0 ? <div className="empty-mini">بعد از Approve، فایل‌ها اینجا دیده می‌شوند.</div> : null}
                  </div>
                </div>

                <div className="editor-panel">
                  <div className="panel-head"><span>{selectedFile || 'File preview'}</span><button disabled={!selectedFile} onClick={saveSelectedFile}>Save</button></div>
                  <textarea className="code-editor" value={editorValue} onChange={(event) => setEditorValue(event.target.value)} placeholder="فایل انتخابی اینجا نمایش داده می‌شود…" spellCheck={false} />
                </div>
              </div>
            </div>

            <aside className="inspector glass activity-inspector">
              <h3>Permission Center</h3>
              <Feature title="Workspace" value={workspaceGranted ? 'Approved' : 'Required'} ready={workspaceGranted} />
              <Feature title="Read files" value={workspaceGranted ? 'Scoped' : 'Locked'} ready={workspaceGranted} />
              <Feature title="Write files" value="Ask every time" ready />
              <Feature title="Terminal" value="Ask every time" ready />
              <Feature title="Auto backup" value="Enabled" ready />
              <div className="divider" />
              <h3>Live Activity</h3>
              <div className="timeline">{agentTimeline.map((item, index) => <div key={`${index}-${item}`} className="timeline-item"><i /><span>{item}</span></div>)}{agentTimeline.length === 0 ? <p>هنوز Task اجرا نشده.</p> : null}</div>
              <div className="divider" />
              <h3>Safety</h3>
              <ul><li>Read فقط داخل Workspace تأییدشده</li><li>Write و Terminal نیازمند Approval مستقیم</li><li>Backup خودکار قبل از تغییر فایل</li><li>مسیر واقعی PC به Cloud planner ارسال نمی‌شود</li><li>بدون shell آزاد و با command allowlist</li><li>Stop Agent همیشه در دسترس است</li></ul>
            </aside>
          </section>)
        ) : null}

        {tab === 'computer' ? (
          isGuest ? <LoginRequired title="Computer" onExit={leaveSession} /> : (
          <section className="workspace-layout">
            <div className="workspace-main glass">
              <div className="workspace-title"><div><h2>Computer</h2><p>کنترل Local tools با تأیید کاربر و محدوده Workspace.</p></div><span className={workspaceGranted ? 'workspace-status ready' : 'workspace-status'}>{workspaceGranted ? 'Permission active' : 'Manual tools'}</span></div>
              <div className="field-row">
                <input value={workspace} onChange={(event) => { setWorkspace(event.target.value); setWorkspaceGranted(false); }} placeholder="Workspace" />
                <button className="secondary" onClick={browseWorkspace}>Browse…</button>
                <button className="secondary" disabled={!workspace.trim()} onClick={() => grantWorkspace(workspace)}>Approve</button>
              </div>
              <div className="terminal-card">
                <div className="terminal-fields"><input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="npm" /><input value={commandArgs} onChange={(event) => setCommandArgs(event.target.value)} placeholder="run test" /><button className="primary" disabled={!workspaceGranted || agent.busy} onClick={runManualCommand}>Run</button></div>
                <pre>{agent.terminalOutput || 'Terminal output will appear here.'}</pre>
              </div>
              <div className="future-grid"><Feature title="Files" value="Active" ready /><Feature title="Terminal" value="Active" ready /><Feature title="Native folder picker" value="Active" ready /><Feature title="Auto backup" value="Active" ready /><Feature title="Browser" value="Next" /><Feature title="Screen Vision" value="Next" /></div>
            </div>
            <aside className="inspector glass activity-inspector"><h3>Local Agent log</h3><div className="timeline">{agent.logs.map((item, index) => <div className="timeline-item" key={`${index}-${item}`}><i /><span>{item}</span></div>)}</div></aside>
          </section>)
        ) : null}
      </main>

      {approval ? (
        <div className="approval-backdrop"><div className="approval-modal glass"><div className="approval-icon">!</div><h2>{approval.title}</h2><pre>{approval.detail}</pre><p>این عملیات فقط با تأیید مستقیم شما انجام می‌شود.</p><div className="approval-actions"><button className="secondary" onClick={() => resolveApproval(false)}>لغو</button><button className="primary" onClick={() => resolveApproval(true)}>{approval.confirmLabel}</button></div></div></div>
      ) : null}
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
    <div className="auth-screen">
      <div className="auth-ambient" />
      <section className="auth-card glass">
        <img src="/app-icon.png" alt="FarsiAI" />
        <h1>FarsiAI Desktop</h1>
        <p>ورود با حساب اصلی: ۱۰ پیام و ۴ تصویر در روز + Sync موبایل و دسترسی Codex.</p>
        <div className="auth-tabs"><button className={mode === 'signin' ? 'active' : ''} onClick={() => setMode('signin')}>ورود</button><button className={mode === 'signup' ? 'active' : ''} onClick={() => setMode('signup')}>ساخت حساب</button></div>
        <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Email" type="email" dir="ltr" />
        <input value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Password" type="password" dir="ltr" />
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
  return <section className="workspace-layout"><div className="workspace-main glass"><div className="welcome"><img src="/app-icon.png" alt="FarsiAI" /><h1>{title} نیازمند ورود است</h1><p>برای دسترسی به PC و اجرای دستور، ابتدا با حساب FarsiAI وارد شو.</p><button className="primary" onClick={onExit}>رفتن به صفحه ورود</button></div></div></section>;
}

function NavButton({ active, label, caption, onClick }: { active: boolean; label: string; caption: string; onClick: () => void }) {
  return <button className={active ? 'nav-button active' : 'nav-button'} onClick={onClick}><strong>{label}</strong><span>{caption}</span></button>;
}

function Info({ label, value }: { label: string; value: string }) {
  return <div className="info-row"><span>{label}</span><strong>{value}</strong></div>;
}

function Feature({ title, value, ready = false }: { title: string; value: string; ready?: boolean }) {
  return <div className={ready ? 'feature-card ready' : 'feature-card'}><strong>{title}</strong><span>{value}</span></div>;
}
