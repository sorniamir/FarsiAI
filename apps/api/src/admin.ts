import { json } from './lib/http';
import { getAccountAccess, type AccountPlan } from './lib/account-access';
import { supabaseAdminFetch, supabaseAuthAdminFetch } from './lib/supabase-admin';
import { resolveAuth, type VerifiedUser } from './lib/supabase-auth';
import type { Env } from './types';

type AuthUser = {
  id: string;
  email?: string;
  phone?: string;
  created_at?: string;
  updated_at?: string;
  last_sign_in_at?: string | null;
  banned_until?: string | null;
  app_metadata?: Record<string, unknown>;
  user_metadata?: Record<string, unknown>;
};

type ProfileRow = {
  id: string;
  display_name?: string | null;
  avatar_url?: string | null;
  plan?: string | null;
  created_at?: string;
  updated_at?: string;
};

type WalletRow = { user_id: string; balance: number; updated_at?: string };
type UsageRow = { user_id: string; usage_date: string; chat_used: number; image_used: number; updated_at?: string };

type AdminContext = { user: VerifiedUser; bootstrap: boolean };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLANS = new Set<AccountPlan>(['free', 'pro', 'admin']);
const MAX_USER_SCAN = 2000;

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizePlan(value: unknown): AccountPlan {
  return value === 'pro' || value === 'admin' ? value : 'free';
}

function isBanned(user: AuthUser): boolean {
  if (user.app_metadata?.farsiai_banned === true) return true;
  if (!user.banned_until) return false;
  const until = Date.parse(user.banned_until);
  return Number.isFinite(until) && until > Date.now();
}

function adminEmailSet(env: Env): Set<string> {
  return new Set((env.ADMIN_EMAILS || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean));
}

function clampInt(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function chunks<T>(items: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
}

async function dataRows<T>(env: Env, path: string, init: RequestInit = {}): Promise<T[]> {
  const request = supabaseAdminFetch(env, path, init);
  if (!request) throw new Error('SUPABASE_ADMIN_UNCONFIGURED');
  const response = await request;
  if (!response.ok) throw new Error(`SUPABASE_DATA_${response.status}:${(await response.text()).slice(0, 180)}`);
  const payload = await response.json().catch(() => []);
  return Array.isArray(payload) ? payload as T[] : [];
}

async function dataCount(env: Env, table: string, filter = ''): Promise<number> {
  const path = `${table}?select=id${filter ? `&${filter}` : ''}`;
  const request = supabaseAdminFetch(env, path, {
    headers: { prefer: 'count=exact', range: '0-0' },
  });
  if (!request) return 0;
  const response = await request;
  if (!response.ok) return 0;
  const total = response.headers.get('content-range')?.split('/').pop();
  const parsed = Number(total);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function authJson<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  const request = supabaseAuthAdminFetch(env, path, init);
  if (!request) throw new Error('SUPABASE_AUTH_ADMIN_UNCONFIGURED');
  const response = await request;
  const text = await response.text();
  if (!response.ok) throw new Error(`SUPABASE_AUTH_${response.status}:${text.slice(0, 180)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

async function requireAdmin(request: Request, env: Env): Promise<AdminContext | Response> {
  const auth = await resolveAuth(request, env);
  if (auth.kind !== 'user') return json(env, { ok: false, error: 'برای ورود به پنل مدیریت ابتدا وارد حساب شوید.' }, 401);
  if (auth.user.banned) return json(env, { ok: false, error: 'این حساب مسدود است.' }, 403);

  const bootstrap = !!auth.user.email && adminEmailSet(env).has(auth.user.email.toLowerCase());
  if (bootstrap) return { user: auth.user, bootstrap: true };

  const access = await getAccountAccess(env, auth.user.id);
  if (access.plan !== 'admin') return json(env, { ok: false, error: 'این حساب دسترسی مدیریت FarsiAI را ندارد.' }, 403);
  return { user: auth.user, bootstrap: false };
}

async function listAuthUsers(env: Env): Promise<{ users: AuthUser[]; truncated: boolean }> {
  const users: AuthUser[] = [];
  const perPage = 200;
  for (let page = 1; page <= Math.ceil(MAX_USER_SCAN / perPage); page += 1) {
    const payload = await authJson<{ users?: AuthUser[] }>(env, `users?page=${page}&per_page=${perPage}`);
    const batch = Array.isArray(payload.users) ? payload.users.filter((item) => typeof item?.id === 'string') : [];
    users.push(...batch);
    if (batch.length < perPage) return { users, truncated: false };
  }
  return { users, truncated: users.length >= MAX_USER_SCAN };
}

async function profilesFor(env: Env, ids: string[]): Promise<Map<string, ProfileRow>> {
  const map = new Map<string, ProfileRow>();
  for (const group of chunks(ids, 100)) {
    if (!group.length) continue;
    const rows = await dataRows<ProfileRow>(env, `profiles?select=id,display_name,avatar_url,plan,created_at,updated_at&id=in.(${group.join(',')})`);
    rows.forEach((row) => map.set(row.id, row));
  }
  return map;
}

async function walletsFor(env: Env, ids: string[]): Promise<Map<string, WalletRow>> {
  const map = new Map<string, WalletRow>();
  for (const group of chunks(ids, 100)) {
    if (!group.length) continue;
    const rows = await dataRows<WalletRow>(env, `credit_wallets?select=user_id,balance,updated_at&user_id=in.(${group.join(',')})`);
    rows.forEach((row) => map.set(row.user_id, row));
  }
  return map;
}

async function usageFor(env: Env, ids: string[]): Promise<Map<string, UsageRow>> {
  const map = new Map<string, UsageRow>();
  const today = new Date().toISOString().slice(0, 10);
  for (const group of chunks(ids, 100)) {
    if (!group.length) continue;
    const rows = await dataRows<UsageRow>(env, `daily_usage?select=user_id,usage_date,chat_used,image_used,updated_at&usage_date=eq.${today}&user_id=in.(${group.join(',')})`);
    rows.forEach((row) => map.set(row.user_id, row));
  }
  return map;
}

function userView(user: AuthUser, profile?: ProfileRow, wallet?: WalletRow, usage?: UsageRow) {
  const plan = normalizePlan(profile?.plan);
  const displayName = profile?.display_name
    || (typeof user.user_metadata?.display_name === 'string' ? user.user_metadata.display_name : undefined)
    || user.email?.split('@')[0]
    || 'کاربر FarsiAI';
  return {
    id: user.id,
    email: user.email || null,
    phone: user.phone || null,
    displayName,
    avatarUrl: profile?.avatar_url || null,
    plan,
    premium: plan === 'pro' || plan === 'admin',
    unlimited: plan === 'pro' || plan === 'admin',
    banned: isBanned(user),
    bannedUntil: user.banned_until || null,
    createdAt: user.created_at || profile?.created_at || null,
    lastSignInAt: user.last_sign_in_at || null,
    walletBalance: Number.isFinite(Number(wallet?.balance)) ? Number(wallet?.balance) : 0,
    usage: {
      chatUsed: Number(usage?.chat_used || 0),
      imageUsed: Number(usage?.image_used || 0),
      date: usage?.usage_date || new Date().toISOString().slice(0, 10),
    },
  };
}

async function writeAudit(env: Env, actorId: string, targetId: string | null, action: string, details: Record<string, unknown>) {
  try {
    const request = supabaseAdminFetch(env, 'admin_audit_log', {
      method: 'POST',
      headers: { prefer: 'return=minimal' },
      body: JSON.stringify({ actor_user_id: actorId, target_user_id: targetId, action, details }),
    });
    if (request) await request;
  } catch (error) {
    console.warn(JSON.stringify({ event: 'admin_audit_unavailable', action, message: error instanceof Error ? error.message : 'unknown' }));
  }
}

async function overview(env: Env) {
  const scanned = await listAuthUsers(env);
  const profiles = await profilesFor(env, scanned.users.map((user) => user.id));
  const now = Date.now();
  const day = 86_400_000;
  let premium = 0;
  let admins = 0;
  let banned = 0;
  let active24h = 0;
  let new7d = 0;
  for (const user of scanned.users) {
    const plan = normalizePlan(profiles.get(user.id)?.plan);
    if (plan === 'pro' || plan === 'admin') premium += 1;
    if (plan === 'admin') admins += 1;
    if (isBanned(user)) banned += 1;
    const last = user.last_sign_in_at ? Date.parse(user.last_sign_in_at) : NaN;
    if (Number.isFinite(last) && now - last <= day) active24h += 1;
    const created = user.created_at ? Date.parse(user.created_at) : NaN;
    if (Number.isFinite(created) && now - created <= 7 * day) new7d += 1;
  }
  const [conversations, messages] = await Promise.all([
    dataCount(env, 'conversations'),
    dataCount(env, 'messages'),
  ]);
  return {
    totalUsers: scanned.users.length,
    premium,
    admins,
    banned,
    active24h,
    new7d,
    conversations,
    messages,
    truncated: scanned.truncated,
  };
}

async function listUsers(env: Env, url: URL) {
  const page = clampInt(url.searchParams.get('page'), 1, 1, 1000);
  const perPage = clampInt(url.searchParams.get('perPage'), 40, 10, 100);
  const q = (url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 120);
  const planFilter = (url.searchParams.get('plan') || 'all').toLowerCase();
  const status = (url.searchParams.get('status') || 'all').toLowerCase();
  const scanned = await listAuthUsers(env);
  const profiles = await profilesFor(env, scanned.users.map((user) => user.id));

  let filtered = scanned.users.filter((user) => {
    const profile = profiles.get(user.id);
    const plan = normalizePlan(profile?.plan);
    const banned = isBanned(user);
    if (planFilter !== 'all' && plan !== planFilter) return false;
    if (status === 'banned' && !banned) return false;
    if (status === 'active' && banned) return false;
    if (!q) return true;
    const haystack = [user.email, user.phone, profile?.display_name, user.id].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(q);
  });
  filtered = filtered.sort((a, b) => Date.parse(b.created_at || '') - Date.parse(a.created_at || ''));
  const total = filtered.length;
  const slice = filtered.slice((page - 1) * perPage, page * perPage);
  const ids = slice.map((user) => user.id);
  const [wallets, usage] = await Promise.all([walletsFor(env, ids), usageFor(env, ids)]);
  return {
    users: slice.map((user) => userView(user, profiles.get(user.id), wallets.get(user.id), usage.get(user.id))),
    page,
    perPage,
    total,
    pages: Math.max(1, Math.ceil(total / perPage)),
    truncated: scanned.truncated,
  };
}

async function detail(env: Env, userId: string) {
  const payload = await authJson<{ user?: AuthUser } | AuthUser>(env, `users/${userId}`);
  const authUser = 'user' in rec(payload) ? (payload as { user?: AuthUser }).user : payload as AuthUser;
  if (!authUser?.id) throw new Error('USER_NOT_FOUND');
  const [profiles, wallets, usage, ledger, conversations, conversationCount, messageCount] = await Promise.all([
    profilesFor(env, [userId]),
    walletsFor(env, [userId]),
    usageFor(env, [userId]),
    dataRows(env, `credit_ledger?select=id,delta,reason,reference_id,created_at&user_id=eq.${userId}&order=created_at.desc&limit=20`),
    dataRows(env, `conversations?select=id,title,mode,created_at,updated_at&user_id=eq.${userId}&order=updated_at.desc&limit=12`),
    dataCount(env, 'conversations', `user_id=eq.${userId}`),
    dataCount(env, 'messages', `user_id=eq.${userId}`),
  ]);
  return {
    user: userView(authUser, profiles.get(userId), wallets.get(userId), usage.get(userId)),
    conversationCount,
    messageCount,
    ledger,
    conversations,
  };
}

async function setPlan(env: Env, actor: VerifiedUser, targetId: string, payload: Record<string, unknown>) {
  const plan = payload.plan;
  if (typeof plan !== 'string' || !PLANS.has(plan as AccountPlan)) throw new Error('INVALID_PLAN');
  const request = supabaseAdminFetch(env, `profiles?id=eq.${targetId}`, {
    method: 'PATCH',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify({ plan, updated_at: new Date().toISOString() }),
  });
  if (!request) throw new Error('SUPABASE_ADMIN_UNCONFIGURED');
  const response = await request;
  if (!response.ok) throw new Error(`PLAN_UPDATE_${response.status}`);
  await writeAudit(env, actor.id, targetId, 'user.plan.changed', { plan });
  return { plan };
}

async function adjustCredits(env: Env, actor: VerifiedUser, targetId: string, payload: Record<string, unknown>) {
  const mode = payload.mode === 'set' ? 'set' : payload.mode === 'add' ? 'add' : null;
  const amount = Number(payload.amount);
  if (!mode || !Number.isSafeInteger(amount) || Math.abs(amount) > 1_000_000_000) throw new Error('INVALID_CREDIT_CHANGE');

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rows = await dataRows<WalletRow>(env, `credit_wallets?select=user_id,balance&user_id=eq.${targetId}&limit=1`);
    const current = Number(rows[0]?.balance ?? 0);
    const next = mode === 'set' ? amount : current + amount;
    if (!Number.isSafeInteger(next) || next < 0 || next > 2_000_000_000) throw new Error('INVALID_CREDIT_BALANCE');
    const request = supabaseAdminFetch(env, `credit_wallets?user_id=eq.${targetId}&balance=eq.${current}`, {
      method: 'PATCH',
      headers: { prefer: 'return=representation' },
      body: JSON.stringify({ balance: next, updated_at: new Date().toISOString() }),
    });
    if (!request) throw new Error('SUPABASE_ADMIN_UNCONFIGURED');
    const response = await request;
    if (!response.ok) throw new Error(`CREDIT_UPDATE_${response.status}`);
    const changed = await response.json().catch(() => []) as unknown[];
    if (!Array.isArray(changed) || changed.length === 0) continue;
    const delta = next - current;
    if (delta !== 0) {
      const ledger = supabaseAdminFetch(env, 'credit_ledger', {
        method: 'POST',
        body: JSON.stringify({ user_id: targetId, delta, reason: mode === 'set' ? 'admin_credit_set' : 'admin_credit_adjust', reference_id: `admin:${actor.id}:${crypto.randomUUID()}` }),
      });
      if (ledger) await ledger;
    }
    await writeAudit(env, actor.id, targetId, 'user.credits.changed', { mode, amount, previous: current, balance: next });
    return { balance: next, delta };
  }
  throw new Error('CREDIT_CONFLICT');
}

async function resetUsage(env: Env, actor: VerifiedUser, targetId: string) {
  const today = new Date().toISOString().slice(0, 10);
  const request = supabaseAdminFetch(env, `daily_usage?user_id=eq.${targetId}&usage_date=eq.${today}`, {
    method: 'PATCH',
    body: JSON.stringify({ chat_used: 0, image_used: 0, updated_at: new Date().toISOString() }),
  });
  if (!request) throw new Error('SUPABASE_ADMIN_UNCONFIGURED');
  const response = await request;
  if (!response.ok) throw new Error(`USAGE_RESET_${response.status}`);
  await writeAudit(env, actor.id, targetId, 'user.usage.reset', { usageDate: today });
  return { chatUsed: 0, imageUsed: 0, date: today };
}

async function setBan(env: Env, actor: VerifiedUser, targetId: string, banned: boolean, reason = '') {
  if (targetId === actor.id) throw new Error('SELF_BAN_FORBIDDEN');
  const currentPayload = await authJson<{ user?: AuthUser } | AuthUser>(env, `users/${targetId}`);
  const current = 'user' in rec(currentPayload) ? (currentPayload as { user?: AuthUser }).user : currentPayload as AuthUser;
  if (!current?.id) throw new Error('USER_NOT_FOUND');
  const metadata = { ...(current.app_metadata || {}) } as Record<string, unknown>;
  metadata.farsiai_banned = banned;
  metadata.farsiai_ban_reason = banned ? reason.slice(0, 300) : null;
  metadata.farsiai_banned_at = banned ? new Date().toISOString() : null;
  await authJson(env, `users/${targetId}`, {
    method: 'PUT',
    body: JSON.stringify({ ban_duration: banned ? '876000h' : 'none', app_metadata: metadata }),
  });
  await writeAudit(env, actor.id, targetId, banned ? 'user.banned' : 'user.unbanned', { reason: banned ? reason.slice(0, 300) : undefined });
  return { banned };
}

async function recentAudit(env: Env) {
  try {
    return await dataRows(env, 'admin_audit_log?select=id,actor_user_id,target_user_id,action,details,created_at&order=created_at.desc&limit=60');
  } catch {
    return [];
  }
}

export async function handleAdminRequest(request: Request, env: Env): Promise<Response> {
  const authz = await requireAdmin(request, env);
  if (authz instanceof Response) return authz;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/v1\/admin\/?/, '');

  try {
    if (request.method === 'GET' && path === 'me') {
      const access = await getAccountAccess(env, authz.user.id);
      return json(env, { ok: true, admin: { id: authz.user.id, email: authz.user.email || null, bootstrap: authz.bootstrap, plan: access.plan } });
    }
    if (request.method === 'GET' && path === 'overview') return json(env, { ok: true, overview: await overview(env) });
    if (request.method === 'GET' && path === 'users') return json(env, { ok: true, ...(await listUsers(env, url)) });
    if (request.method === 'GET' && path === 'audit') return json(env, { ok: true, events: await recentAudit(env) });

    const match = /^users\/([0-9a-f-]{36})(?:\/(plan|credits|reset-usage|ban|unban))?$/.exec(path);
    if (!match || !UUID.test(match[1])) return json(env, { ok: false, error: 'مسیر مدیریت معتبر نیست.' }, 404);
    const targetId = match[1];
    const action = match[2];
    if (request.method === 'GET' && !action) return json(env, { ok: true, ...(await detail(env, targetId)) });
    if (request.method !== 'POST' || !action) return json(env, { ok: false, error: 'متد درخواست مدیریت معتبر نیست.' }, 405);

    const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
    if (action === 'plan') return json(env, { ok: true, ...(await setPlan(env, authz.user, targetId, payload)) });
    if (action === 'credits') return json(env, { ok: true, ...(await adjustCredits(env, authz.user, targetId, payload)) });
    if (action === 'reset-usage') return json(env, { ok: true, usage: await resetUsage(env, authz.user, targetId) });
    if (action === 'ban') return json(env, { ok: true, ...(await setBan(env, authz.user, targetId, true, typeof payload.reason === 'string' ? payload.reason : '')) });
    if (action === 'unban') return json(env, { ok: true, ...(await setBan(env, authz.user, targetId, false)) });
    return json(env, { ok: false, error: 'عملیات مدیریت شناخته نشد.' }, 404);
  } catch (error) {
    const code = error instanceof Error ? error.message : 'ADMIN_UNKNOWN_ERROR';
    console.error(JSON.stringify({ event: 'admin_request_failed', path, actor: authz.user.id, code: code.slice(0, 180) }));
    const messages: Record<string, string> = {
      INVALID_PLAN: 'پلن انتخاب‌شده معتبر نیست.',
      INVALID_CREDIT_CHANGE: 'مقدار تغییر اعتبار معتبر نیست.',
      INVALID_CREDIT_BALANCE: 'موجودی نهایی باید بین صفر و دو میلیارد باشد.',
      CREDIT_CONFLICT: 'موجودی کاربر هم‌زمان تغییر کرد؛ دوباره تلاش کنید.',
      SELF_BAN_FORBIDDEN: 'برای جلوگیری از قفل‌شدن پنل، نمی‌توانید حساب خودتان را Ban کنید.',
      USER_NOT_FOUND: 'کاربر پیدا نشد.',
    };
    return json(env, { ok: false, error: messages[code] || 'عملیات مدیریت انجام نشد. دوباره تلاش کنید.' }, code === 'USER_NOT_FOUND' ? 404 : 500);
  }
}
