import { useMemo, useRef, useState } from 'react';
import {
  buildCapabilities, cancelNativeRun, deniedObservation, executeCodexTool,
  isSideEffectTool, pickApplication, pickWorkspace, requestCodexTurn,
  revokeWorkspace, undoCodexChange, type ApplicationGrant, type CodexObservation,
  type CodexPermissionMode, type CodexToolCall, type CodexToolName, type WorkspaceGrant,
} from '../services/codex';

type Activity = { id: string; title: string; detail: string; state: 'running' | 'success' | 'error' | 'denied' };
type Message = { id: string; role: 'user' | 'assistant' | 'system'; text: string };
type Change = { id: string; path: string; detail: string; changeId: string };
type Approval = { call: CodexToolCall; decide: (value: 'once' | 'run' | 'deny') => void };

const PLUGINS: Array<{ id: CodexToolName; title: string; detail: string; risk: string }> = [
  { id: 'list_directory', title: 'Workspace', detail: 'نمایش ساختار پروژه', risk: 'Read' },
  { id: 'read_file', title: 'File Reader', detail: 'خواندن متن و SHA-256', risk: 'Read' },
  { id: 'search_files', title: 'Project Search', detail: 'جست‌وجوی امن متن', risk: 'Read' },
  { id: 'write_file', title: 'Verified Edit', detail: 'Backup، نوشتن و بررسی', risk: 'Confirm' },
  { id: 'create_directory', title: 'Directory', detail: 'ساخت پوشه با تأیید', risk: 'Confirm' },
  { id: 'run_command', title: 'Dev Terminal', detail: 'اجرای محدود و توقف‌پذیر', risk: 'Confirm' },
  { id: 'launch_app', title: 'Windows Apps', detail: 'برنامه منتخب کاربر', risk: 'Confirm' },
];
const id = () => crypto.randomUUID();
const toolLabel = (name: CodexToolName) => ({
  list_directory: 'خواندن پوشه', read_file: 'خواندن فایل', search_files: 'جست‌وجو',
  write_file: 'تغییر فایل', create_directory: 'ساخت پوشه',
  run_command: 'اجرای دستور', launch_app: 'اجرای برنامه',
}[name]);
const target = (call: CodexToolCall) => 'path' in call.arguments
  ? call.arguments.path
  : call.name === 'run_command'
    ? `${call.arguments.command} ${call.arguments.args.join(' ')}`
    : call.arguments.applicationId;

export function CodexStudio() {
  const [workspace, setWorkspace] = useState<WorkspaceGrant | null>(null);
  const [apps, setApps] = useState<ApplicationGrant[]>([]);
  const [tools, setTools] = useState<CodexToolName[]>(PLUGINS.map((item) => item.id));
  const [mode, setMode] = useState<CodexPermissionMode>('guarded');
  const [task, setTask] = useState('');
  const [running, setRunning] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [changes, setChanges] = useState<Change[]>([]);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [panel, setPanel] = useState<'activity' | 'changes' | 'plugins' | 'diagnostics'>('activity');
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const runRef = useRef<string | null>(null);
  const capabilities = useMemo(() => buildCapabilities({ enabledTools: tools, permissionMode: mode, applications: apps }), [tools, mode, apps]);

  async function chooseWorkspace() {
    if (running) return;
    setError('');
    try {
      const next = await pickWorkspace();
      if (workspace) await revokeWorkspace(workspace.grantId).catch(() => undefined);
      setWorkspace(next);
      setMessages((items) => [...items, { id: id(), role: 'system', text: `Workspace «${next.label}» برای همین نشست تأیید شد.` }]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function addApp() {
    try {
      const app = await pickApplication();
      setApps((items) => items.some((item) => item.appGrantId === app.appGrantId) ? items : [...items, app]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  function approve(call: CodexToolCall, forRun: Set<CodexToolName>): Promise<boolean> {
    if (!isSideEffectTool(call.name) || forRun.has(call.name)) return Promise.resolve(true);
    return new Promise((resolve) => setApproval({ call, decide: (decision) => {
      setApproval(null);
      if (decision === 'run') forRun.add(call.name);
      resolve(decision !== 'deny');
    }}));
  }

  async function stop() {
    abortRef.current?.abort();
    approval?.decide('deny');
    if (runRef.current) await cancelNativeRun(runRef.current).catch(() => undefined);
    setRunning(false);
  }

  async function run(seed?: string) {
    const prompt = (seed ?? task).trim();
    if (!workspace || !prompt || running || !capabilities.tools.length) return;
    setTask(''); setError(''); setRunning(true); setPanel('activity'); setActivity([]);
    setMessages((items) => [...items, { id: id(), role: 'user', text: prompt }]);
    const controller = new AbortController();
    const runId = `run_${id().replace(/-/g, '')}`;
    abortRef.current = controller; runRef.current = runId;
    const observations: CodexObservation[] = [];
    const approved = new Set<CodexToolName>();
    try {
      for (let step = 1; step <= 16; step += 1) {
        const activityId = id();
        setActivity((items) => [...items, { id: activityId, title: `مرحله ${step}`, detail: 'در حال برنامه‌ریزی…', state: 'running' }]);
        const turn = await requestCodexTurn({ task: prompt, observations, workspace, capabilities, signal: controller.signal });
        if (!turn.ok) throw new Error(`${turn.error}${turn.requestId ? ` · ${turn.requestId}` : ''}`);
        setDiagnostics((items) => [`step=${step} model=${turn.model ?? '-'} request=${turn.requestId ?? '-'}`, ...items].slice(0, 80));
        if (turn.type === 'final') {
          setActivity((items) => items.map((item) => item.id === activityId ? { ...item, title: 'تکمیل', detail: 'نتیجه با شواهد محلی آماده شد.', state: 'success' } : item));
          setMessages((items) => [...items, { id: id(), role: 'assistant', text: turn.message }]);
          return;
        }
        const call = turn.tool;
        setActivity((items) => items.map((item) => item.id === activityId ? { ...item, title: toolLabel(call.name), detail: target(call), state: 'running' } : item));
        if (!await approve(call, approved)) {
          observations.push(deniedObservation(call));
          setActivity((items) => items.map((item) => item.id === activityId ? { ...item, detail: 'توسط کاربر رد شد.', state: 'denied' } : item));
          continue;
        }
        const evidence = await executeCodexTool({ call, workspace, applications: apps, runId });
        observations.push(evidence.observation);
        setActivity((items) => items.map((item) => item.id === activityId ? { ...item, detail: evidence.summary, state: evidence.observation.status === 'success' ? 'success' : 'error' } : item));
        if (evidence.backupId) setChanges((items) => [{ id: id(), path: 'path' in call.arguments ? call.arguments.path : toolLabel(call.name), detail: evidence.diffSummary || evidence.summary, changeId: evidence.backupId! }, ...items]);
      }
      throw new Error('Codex به سقف ایمن مراحل رسید؛ درخواست را کوچک‌تر کنید.');
    } catch (cause) {
      const message = controller.signal.aborted ? 'اجرای Codex متوقف شد.' : cause instanceof Error ? cause.message : String(cause);
      setError(message);
      setMessages((items) => [...items, { id: id(), role: 'assistant', text: message }]);
    } finally {
      abortRef.current = null; runRef.current = null; setRunning(false);
    }
  }

  async function undo(change: Change) {
    if (!workspace || running) return;
    try {
      await undoCodexChange(workspace, change.changeId);
      setChanges((items) => items.filter((item) => item.id !== change.id));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  return <section className="codex-studio" dir={'rtl'}>
    <main className={'codex-main glass'}>
      <header className={'codex-head'}><h2>FarsiAI Codex</h2><div>{running && <button onClick={() => void stop()}>توقف</button>}<button onClick={() => void chooseWorkspace()} disabled={running}>{workspace?.label || 'انتخاب پوشه'}</button></div></header>
      <div className={'codex-context'}><span>{workspace?.label || 'پوشه‌ای انتخاب نشده'}</span><span>{tools.length} ابزار فعال</span></div>
      <div className={'codex-thread'}>{messages.length ? messages.map((m) => <article key={m.id} className={`codex-message ${m.role}`}><b>{m.role === 'user' ? 'شما' : 'Codex'}</b><p>{m.text}</p></article>) : <div className={'codex-empty'}><h3>چه چیزی بسازیم یا اصلاح کنیم؟</h3><p>یک پوشه انتخاب کنید و درخواستتان را بنویسید.</p></div>}</div>
      {error && <div className={'codex-error'}>{error}</div>}
      <footer className={'codex-composer'}><textarea value={task} onChange={(e) => setTask(e.target.value)} disabled={!workspace || running} placeholder={'درخواست خود را بنویسید…'} /><button className={'primary'} disabled={!workspace || !task.trim() || running} onClick={() => void run()}>{running ? 'در حال اجرا…' : 'ارسال'}</button></footer>
    </main>
    <aside className={'codex-side glass'}><h3>فعالیت زنده</h3>{activity.length ? activity.map((x) => <div className={`activity-card ${x.state}`} key={x.id}><b>{x.title}</b><p>{x.detail}</p></div>) : <p className={'empty-mini'}>هنوز اجرایی شروع نشده است.</p>}</aside>
    {approval && <div className={'approval-backdrop'}><div className={'approval-sheet glass'}><small>نیازمند تأیید</small><h3>{toolLabel(approval.call.name)}</h3><p>{target(approval.call)}</p><div><button onClick={() => approval.decide('deny')}>رد</button><button onClick={() => approval.decide('once')}>فقط این بار</button><button className={'primary'} onClick={() => approval.decide('run')}>تا پایان اجرا</button></div></div></div>}
  </section>;
}
