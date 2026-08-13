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
type LedgerRow = { id?: string; user_id?: string; delta: number; reason?: string; reference_id?: string; created_at?: string };
type AuditRow = { id: string; actor_user_id?: string | null; target_user_id?: string | null; action: string; details?: Record<string, unknown>; created_at: string };
type AdminContext = { user: VerifiedUser; bootstrap: boolean };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLANS = new Set<AccountPlan>(['free', 'pro', 'admin']);
const MAX_USER_SCAN = 2000;
const DAY_MS = 86_400_000;

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

function analyticsDays(value: string | null): 7 | 30 | 90 {
  const parsed = Number(value);
  return parsed === 7 || parsed === 90 ? parsed : 30;
}

function chunks<T>(items: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
}

function isoDay(input: Date | string | number): string {
  return new Date(input).toISOString().slice(0, 10);
}

function dayRange(days: number): string[] {
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: days }, (_, index) => isoDay(todayUtc - (days - 1 - index) * DAY_MS));
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
  const request = supabaseAdminFetch(env, path, { headers: { prefer: 'count=exact', range: '0-0' } });
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
  const today = isoDay(Date.now());
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
    banReason: typeof user.app_metadata?.farsiai_ban_reason === 'string' ? user.app_metadata.farsiai_ban_reason : null,
    createdAt: user.created_at || profile?.created_at || null,
    lastSignInAt: user.last_sign_in_at || null,
    walletBalance: Number.isFinite(Number(wallet?.balance)) ? Number(wallet?.balance) : 0,
    usage: {
      chatUsed: Number(usage?.chat_used || 0),
      imageUsed: Number(usage?.image_used || 0),
      date: usage?.usage_date || isoDay(Date.now()),
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
    if (request) {
      const response = await request;
      if (!response.ok) console.warn(JSON.stringify({ event: 'admin_audit_write_failed', action, status: response.status }));
    }
  } catch (error) {
    console.warn(JSON.stringify({ event: 'admin_audit_unavailable', action, message: error instanceof Error ? error.message : 'unknown' }));
  }
}

async function overview(env: Env) {
  const scanned = await listAuthUsers(env);
  const profiles = await profilesFor(env, scanned.users.map((user) => user.id));
  const now = Date.now();
  let premium = 0;
  let admins = 0;
  let banned = 0;
  let active24h = 0;
  let active7d = 0;
  let new7d = 0;
  for (const user of scanned.users) {
    const plan = normalizePlan(profiles.get(user.id)?.plan);
    if (plan === 'pro' || plan === 'admin') premium += 1;
    if (plan === 'admin') admins += 1;
    if (isBanned(user)) banned += 1;
    const last = user.last_sign_in_at ? Date.parse(user.last_sign_in_at) : NaN;
    if (Number.isFinite(last) && now - last <= DAY_MS) active24h += 1;
    if (Number.isFinite(last) && now - last <= 7 * DAY_MS) active7d += 1;
    const created = user.created_at ? Date.parse(user.created_at) : NaN;
    if (Number.isFinite(created) && now - created <= 7 * DAY_MS) new7d += 1;
  }
  const [conversations, messages, auditEvents] = await Promise.all([
    dataCount(env, 'conversations'),
    dataCount(env, 'messages'),
    dataCount(env, 'admin_audit_log'),
  ]);
  return { totalUsers: scanned.users.length, premium, admins, banned, active24h, active7d, new7d, conversations, messages, auditEvents, truncated: scanned.truncated };
}

async function analytics(env: Env, url: URL) {
  const days = analyticsDays(url.searchParams.get('days'));
  const labels = dayRange(days);
  const start = labels[0];
  const startIso = `${start}T00:00:00.000Z`;
  const scanned = await listAuthUsers(env);
  const profiles = await profilesFor(env, scanned.users.map((user) => user.id));
  const [usageRows, ledgerRows] = await Promise.all([
    dataRows<UsageRow>(env, `daily_usage?select=user_id,usage_date,chat_used,image_used&usage_date=gte.${start}&order=usage_date.asc&limit=5000`),
    dataRows<LedgerRow>(env, `credit_ledger?select=user_id,delta,reason,created_at&created_at=gte.${encodeURIComponent(startIso)}&order=created_at.asc&limit=5000`),
  ]);
  const points = new Map(labels.map((date) => [date, { date, chat: 0, image: 0, newUsers: 0, creditSpent: 0, creditGranted: 0 }]));
  for (const row of usageRows) {
    const point = points.get(row.usage_date);
    if (!point) continue;
    point.chat += Number(row.chat_used || 0);
    point.image += Number(row.image_used || 0);
  }
  for (const row of ledgerRows) {
    if (!row.created_at) continue;
    const point = points.get(isoDay(row.created_at));
    if (!point) continue;
    const delta = Number(row.delta || 0);
    if (delta < 0) point.creditSpent += Math.abs(delta);
    if (delta > 0) point.creditGranted += delta;
  }
  for (const user of scanned.users) {
    if (!user.created_at) continue;
    const point = points.get(isoDay(user.created_at));
    if (point) point.newUsers += 1;
  }
  let free = 0;
  let pro = 0;
  let admin = 0;
  let banned = 0;
  let active24h = 0;
  let active7d = 0;
  const now = Date.now();
  for (const user of scanned.users) {
    const plan = normalizePlan(profiles.get(user.id)?.plan);
    if (plan === 'admin') admin += 1;
    else if (plan === 'pro') pro += 1;
    else free += 1;
    if (isBanned(user)) banned += 1;
    const last = user.last_sign_in_at ? Date.parse(user.last_sign_in_at) : NaN;
    if (Number.isFinite(last) && now - last <= DAY_MS) active24h += 1;
    if (Number.isFinite(last) && now - last <= 7 * DAY_MS) active7d += 1;
  }
  const series = Array.from(points.values());
  const totals = series.reduce((acc, point) => ({
    chat: acc.chat + point.chat,
    image: acc.image + point.image,
    newUsers: acc.newUsers + point.newUsers,
    creditSpent: acc.creditSpent + point.creditSpent,
    creditGranted: acc.creditGranted + point.creditGranted,
  }), { chat: 0, image: 0, newUsers: 0, creditSpent: 0, creditGranted: 0 });
  return { days, series, totals, plans: { free, pro, admin, premium: pro + admin }, activity: { active24h, active7d, banned }, truncated: scanned.truncated };
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
  return { users: slice.map((user) => userView(user, profiles.get(user.id), wallets.get(user.id), usage.get(user.id))), page, perPage, total, pages: Math.max(1, Math.ceil(total / perPage)), truncated: scanned.truncated };
}

async function detail(env: Env, userId: string) {
  const payload = await authJson<{ user?: AuthUser } | AuthUser>(env, `users/${userId}`);
  const authUser = 'user' in rec(payload) ? (payload as { user?: AuthUser }).user : payload as AuthUser;
  if (!authUser?.id) throw new Error('USER_NOT_FOUND');
  const [profiles, wallets, usage, ledger, conversations, audit, conversationCount, messageCount] = await Promise.all([
    profilesFor(env, [userId]), walletsFor(env, [userId]), usageFor(env, [userId]),
    dataRows(env, `credit_ledger?select=id,delta,reason,reference_id,created_at&user_id=eq.${userId}&order=created_at.desc&limit=20`),
    dataRows(env, `conversations?select=id,title,mode,created_at,updated_at&user_id=eq.${userId}&order=updated_at.desc&limit=12`),
    dataRows(env, `admin_audit_log?select=id,actor_user_id,target_user_id,action,details,created_at&target_user_id=eq.${userId}&order=created_at.desc&limit=20`),
    dataCount(env, 'conversations', `user_id=eq.${userId}`), dataCount(env, 'messages', `user_id=eq.${userId}`),
  ]);
  return { user: userView(authUser, profiles.get(userId), wallets.get(userId), usage.get(userId)), conversationCount, messageCount, ledger, conversations, audit };
}

async function assertTargetMutationAllowed(env: Env, authz: AdminContext, targetId: string, action: string, payload: Record<string, unknown>) {
  if (authz.bootstrap) return;
  const targetPayload = await authJson<{ user?: AuthUser } | AuthUser>(env, `users/${targetId}`);
  const target = 'user' in rec(targetPayload) ? (targetPayload as { user?: AuthUser }).user : targetPayload as AuthUser;
  if (!target?.id) throw new Error('USER_NOT_FOUND');
  if (target.email && adminEmailSet(env).has(target.email.toLowerCase())) throw new Error('OWNER_PROTECTED');
  const targetAccess = await getAccountAccess(env, targetId);
  if (targetAccess.plan === 'admin') throw new Error('ADMIN_ACCOUNT_PROTECTED');
  if (action === 'plan' && payload.plan === 'admin') throw new Error('OWNER_ONLY_ADMIN_GRANT');
}

async function setPlan(env: Env, actor: VerifiedUser, targetId: string, payload: Record<string, unknown>) {
  const plan = payload.plan;
  if (typeof plan !== 'string' || !PLANS.has(plan as AccountPlan)) throw new Error('INVALID_PLAN');
  const previous = await getAccountAccess(env, targetId);
  const request = supabaseAdminFetch(env, 'profiles?on_conflict=id', {
    method: 'POST',
    headers: { prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({ id: targetId, plan, updated_at: new Date().toISOString() }),
  });
  if (!request) throw new Error('SUPABASE_ADMIN_UNCONFIGURED');
  const response = await request;
  if (!response.ok) throw new Error(`PLAN_UPDATE_${response.status}`);
  await writeAudit(env, actor.id, targetId, 'user.plan.changed', { previous: previous.plan, plan });
  return { plan };
}

async function adjustCredits(env: Env, actor: VerifiedUser, targetId: string, payload: Record<string, unknown>) {
  const mode = payload.mode === 'set' ? 'set' : payload.mode === 'add' ? 'add' : null;
  const amount = Number(payload.amount);
  if (!mode || !Number.isSafeInteger(amount) || Math.abs(amount) > 1_000_000_000) throw new Error('INVALID_CREDIT_CHANGE');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rows = await dataRows<WalletRow>(env, `credit_wallets?select=user_id,balance&user_id=eq.${targetId}&limit=1`);
    const exists = !!rows[0];
    const current = Number(rows[0]?.balance ?? 0);
    const next = mode === 'set' ? amount : current + amount;
    if (!Number.isSafeInteger(next) || next < 0 || next > 2_000_000_000) throw new Error('INVALID_CREDIT_BALANCE');
    let response: Response;
    if (!exists) {
      const request = supabaseAdminFetch(env, 'credit_wallets', { method: 'POST', headers: { prefer: 'return=representation' }, body: JSON.stringify({ user_id: targetId, balance: next, updated_at: new Date().toISOString() }) });
      if (!request) throw new Error('SUPABASE_ADMIN_UNCONFIGURED');
      response = await request;
    } else {
      const request = supabaseAdminFetch(env, `credit_wallets?user_id=eq.${targetId}&balance=eq.${current}`, { method: 'PATCH', headers: { prefer: 'return=representation' }, body: JSON.stringify({ balance: next, updated_at: new Date().toISOString() }) });
      if (!request) throw new Error('SUPABASE_ADMIN_UNCONFIGURED');
      response = await request;
    }
    if (!response.ok) {
      if (!exists && response.status === 409) continue;
      throw new Error(`CREDIT_UPDATE_${response.status}`);
    }
    const changed = await response.json().catch(() => []) as unknown[];
    if (exists && (!Array.isArray(changed) || changed.length === 0)) continue;
    const delta = next - current;
    if (delta !== 0) {
      const ledger = supabaseAdminFetch(env, 'credit_ledger', { method: 'POST', body: JSON.stringify({ user_id: targetId, delta, reason: mode === 'set' ? 'admin_credit_set' : 'admin_credit_adjust', reference_id: `admin:${actor.id}:${crypto.randomUUID()}` }) });
      if (ledger) await ledger;
    }
    await writeAudit(env, actor.id, targetId, 'user.credits.changed', { mode, amount, previous: current, balance: next, delta });
    return { balance: next, delta };
  }
  throw new Error('CREDIT_CONFLICT');
}

async function resetUsage(env: Env, actor: VerifiedUser, targetId: string) {
  const today = isoDay(Date.now());
  const previousRows = await dataRows<UsageRow>(env, `daily_usage?select=user_id,usage_date,chat_used,image_used&user_id=eq.${targetId}&usage_date=eq.${today}&limit=1`);
  const previous = previousRows[0] || { chat_used: 0, image_used: 0 };
  const request = supabaseAdminFetch(env, `daily_usage?user_id=eq.${targetId}&usage_date=eq.${today}`, { method: 'PATCH', body: JSON.stringify({ chat_used: 0, image_used: 0, updated_at: new Date().toISOString() }) });
  if (!request) throw new Error('SUPABASE_ADMIN_UNCONFIGURED');
  const response = await request;
  if (!response.ok) throw new Error(`USAGE_RESET_${response.status}`);
  await writeAudit(env, actor.id, targetId, 'user.usage.reset', { usageDate: today, previous: { chat: Number(previous.chat_used || 0), image: Number(previous.image_used || 0) } });
  return { chatUsed: 0, imageUsed: 0, date: today };
}

async function setBan(env: Env, actor: VerifiedUser, targetId: string, banned: boolean, reason = '') {
  if (targetId === actor.id) throw new Error('SELF_BAN_FORBIDDEN');
  const currentPayload = await authJson<{ user?: AuthUser } | AuthUser>(env, `users/${targetId}`);
  const current = 'user' in rec(currentPayload) ? (currentPayload as { user?: AuthUser }).user : currentPayload as AuthUser;
  if (!current?.id) throw new Error('USER_NOT_FOUND');
  const previousBanned = isBanned(current);
  const metadata = { ...(current.app_metadata || {}) } as Record<string, unknown>;
  metadata.farsiai_banned = banned;
  metadata.farsiai_ban_reason = banned ? reason.slice(0, 300) : null;
  metadata.farsiai_banned_at = banned ? new Date().toISOString() : null;
  await authJson(env, `users/${targetId}`, { method: 'PUT', body: JSON.stringify({ ban_duration: banned ? '876000h' : 'none', app_metadata: metadata }) });
  await writeAudit(env, actor.id, targetId, banned ? 'user.banned' : 'user.unbanned', { previousBanned, banned, reason: banned ? reason.slice(0, 300) : undefined });
  return { banned };
}

function auditFilters(url: URL) {
  const filters: string[] = [];
  const actor = (url.searchParams.get('actor') || '').trim();
  const target = (url.searchParams.get('target') || '').trim();
  const action = (url.searchParams.get('action') || '').trim().slice(0, 100);
  const from = (url.searchParams.get('from') || '').trim();
  const to = (url.searchParams.get('to') || '').trim();
  if (UUID.test(actor)) filters.push(`actor_user_id=eq.${actor}`);
  if (UUID.test(target)) filters.push(`target_user_id=eq.${target}`);
  if (action) filters.push(`action=eq.${encodeURIComponent(action)}`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) filters.push(`created_at=gte.${encodeURIComponent(`${from}T00:00:00.000Z`)}`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) filters.push(`created_at=lt.${encodeURIComponent(`${isoDay(Date.parse(`${to}T00:00:00.000Z`) + DAY_MS)}T00:00:00.000Z`)}`);
  return filters;
}

async function auditList(env: Env, url: URL, forceLimit?: number) {
  const page = forceLimit ? 1 : clampInt(url.searchParams.get('page'), 1, 1, 1000);
  const perPage = forceLimit || clampInt(url.searchParams.get('perPage'), 40, 10, 100);
  const filters = auditFilters(url);
  const offset = (page - 1) * perPage;
  const filterQuery = filters.length ? `&${filters.join('&')}` : '';
  const [events, total, scanned] = await Promise.all([
    dataRows<AuditRow>(env, `admin_audit_log?select=id,actor_user_id,target_user_id,action,details,created_at${filterQuery}&order=created_at.desc&limit=${perPage}&offset=${offset}`),
    dataCount(env, 'admin_audit_log', filters.join('&')),
    listAuthUsers(env),
  ]);
  const users = new Map(scanned.users.map((user) => [user.id, user]));
  const enriched = events.map((event) => {
    const actor = event.actor_user_id ? users.get(event.actor_user_id) : undefined;
    const target = event.target_user_id ? users.get(event.target_user_id) : undefined;
    return {
      ...event,
      actor: event.actor_user_id ? { id: event.actor_user_id, email: actor?.email || null } : null,
      target: event.target_user_id ? { id: event.target_user_id, email: target?.email || null } : null,
    };
  });
  return { events: enriched, page, perPage, total, pages: Math.max(1, Math.ceil(total / perPage)) };
}

function csvCell(value: unknown): string {
  const raw = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `"${raw.replace(/"/g, '""')}"`;
}

function csvResponse(filename: string, headers: string[], rows: unknown[][]): Response {
  const body = '\ufeff' + [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${filename}"`, 'cache-control': 'no-store, private', 'x-content-type-options': 'nosniff' } });
}

async function exportCsv(env: Env, url: URL): Promise<Response> {
  const type = (url.searchParams.get('type') || 'users').toLowerCase();
  const stamp = isoDay(Date.now());
  if (type === 'users') {
    const scanned = await listAuthUsers(env);
    const ids = scanned.users.map((user) => user.id);
    const [profiles, wallets, usage] = await Promise.all([profilesFor(env, ids), walletsFor(env, ids), usageFor(env, ids)]);
    const rows = scanned.users.map((user) => {
      const view = userView(user, profiles.get(user.id), wallets.get(user.id), usage.get(user.id));
      return [view.id, view.email, view.displayName, view.plan, view.premium, view.banned, view.walletBalance, view.usage.chatUsed, view.usage.imageUsed, view.createdAt, view.lastSignInAt];
    });
    return csvResponse(`farsiai-users-${stamp}.csv`, ['user_id', 'email', 'display_name', 'plan', 'premium', 'banned', 'credits', 'chat_today', 'image_today', 'created_at', 'last_sign_in_at'], rows);
  }
  if (type === 'usage') {
    const days = analyticsDays(url.searchParams.get('days'));
    const start = dayRange(days)[0];
    const rows = await dataRows<UsageRow>(env, `daily_usage?select=user_id,usage_date,chat_used,image_used&usage_date=gte.${start}&order=usage_date.desc&limit=5000`);
    const scanned = await listAuthUsers(env);
    const users = new Map(scanned.users.map((user) => [user.id, user]));
    return csvResponse(`farsiai-usage-${days}d-${stamp}.csv`, ['date', 'user_id', 'email', 'chat_used', 'image_used'], rows.map((row) => [row.usage_date, row.user_id, users.get(row.user_id)?.email || '', row.chat_used, row.image_used]));
  }
  if (type === 'audit') {
    const result = await auditList(env, url, 5000);
    return csvResponse(`farsiai-audit-${stamp}.csv`, ['created_at', 'action', 'actor_id', 'actor_email', 'target_id', 'target_email', 'details'], result.events.map((event) => [event.created_at, event.action, event.actor?.id, event.actor?.email, event.target?.id, event.target?.email, event.details || {}]));
  }
  throw new Error('INVALID_EXPORT_TYPE');
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
    if (request.method === 'GET' && path === 'analytics') return json(env, { ok: true, analytics: await analytics(env, url) });
    if (request.method === 'GET' && path === 'users') return json(env, { ok: true, ...(await listUsers(env, url)) });
    if (request.method === 'GET' && path === 'audit') return json(env, { ok: true, ...(await auditList(env, url)) });
    if (request.method === 'GET' && path === 'export') return exportCsv(env, url);
    const match = /^users\/([0-9a-f-]{36})(?:\/(plan|credits|reset-usage|ban|unban))?$/.exec(path);
    if (!match || !UUID.test(match[1])) return json(env, { ok: false, error: 'مسیر مدیریت معتبر نیست.' }, 404);
    const targetId = match[1];
    const action = match[2];
    if (request.method === 'GET' && !action) return json(env, { ok: true, ...(await detail(env, targetId)) });
    if (request.method !== 'POST' || !action) return json(env, { ok: false, error: 'متد درخواست مدیریت معتبر نیست.' }, 405);
    const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
    await assertTargetMutationAllowed(env, authz, targetId, action, payload);
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
      INVALID_PLAN: 'پلن انتخاب‌شده معتبر نیست.', INVALID_CREDIT_CHANGE: 'مقدار تغییر اعتبار معتبر نیست.', INVALID_CREDIT_BALANCE: 'موجودی نهایی باید بین صفر و دو میلیارد باشد.', CREDIT_CONFLICT: 'موجودی کاربر هم‌زمان تغییر کرد؛ دوباره تلاش کنید.', SELF_BAN_FORBIDDEN: 'برای جلوگیری از قفل‌شدن پنل، نمی‌توانید حساب خودتان را Ban کنید.', OWNER_PROTECTED: 'حساب Owner اصلی فقط توسط خود Owner قابل مدیریت است.', ADMIN_ACCOUNT_PROTECTED: 'حساب‌های Admin فقط توسط Owner اصلی قابل تغییر هستند.', OWNER_ONLY_ADMIN_GRANT: 'فقط Owner اصلی می‌تواند دسترسی Admin اعطا کند.', USER_NOT_FOUND: 'کاربر پیدا نشد.', INVALID_EXPORT_TYPE: 'نوع خروجی CSV معتبر نیست.',
    };
    const forbidden = new Set(['SELF_BAN_FORBIDDEN', 'OWNER_PROTECTED', 'ADMIN_ACCOUNT_PROTECTED', 'OWNER_ONLY_ADMIN_GRANT']);
    const status = code === 'USER_NOT_FOUND' ? 404 : code === 'INVALID_EXPORT_TYPE' ? 400 : forbidden.has(code) ? 403 : 500;
    return json(env, { ok: false, error: messages[code] || 'عملیات مدیریت انجام نشد. دوباره تلاش کنید.' }, status);
  }
}
