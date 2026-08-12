import fs from 'node:fs';

function replaceOnce(path, from, to) {
  const source = fs.readFileSync(path, 'utf8');
  if (!source.includes(from)) throw new Error(`Anchor missing in ${path}: ${from.slice(0, 90)}`);
  if (source.split(from).length !== 2) throw new Error(`Anchor not unique in ${path}`);
  fs.writeFileSync(path, source.replace(from, to));
}

replaceOnce(
  'apps/api/src/admin.ts',
  `async function setPlan(env: Env, actor: VerifiedUser, targetId: string, payload: Record<string, unknown>) {`,
  `async function assertTargetMutationAllowed(\n  env: Env,\n  authz: AdminContext,\n  targetId: string,\n  action: string,\n  payload: Record<string, unknown>,\n) {\n  if (authz.bootstrap) return;\n\n  const targetPayload = await authJson<{ user?: AuthUser } | AuthUser>(env, \`users/\${targetId}\`);\n  const target = 'user' in rec(targetPayload) ? (targetPayload as { user?: AuthUser }).user : targetPayload as AuthUser;\n  if (!target?.id) throw new Error('USER_NOT_FOUND');\n  if (target.email && adminEmailSet(env).has(target.email.toLowerCase())) throw new Error('OWNER_PROTECTED');\n\n  const targetAccess = await getAccountAccess(env, targetId);\n  if (targetAccess.plan === 'admin') throw new Error('ADMIN_ACCOUNT_PROTECTED');\n  if (action === 'plan' && payload.plan === 'admin') throw new Error('OWNER_ONLY_ADMIN_GRANT');\n}\n\nasync function setPlan(env: Env, actor: VerifiedUser, targetId: string, payload: Record<string, unknown>) {`,
);

replaceOnce(
  'apps/api/src/admin.ts',
  `    const payload = await request.json().catch(() => ({})) as Record<string, unknown>;\n    if (action === 'plan') return json(env, { ok: true, ...(await setPlan(env, authz.user, targetId, payload)) });`,
  `    const payload = await request.json().catch(() => ({})) as Record<string, unknown>;\n    await assertTargetMutationAllowed(env, authz, targetId, action, payload);\n    if (action === 'plan') return json(env, { ok: true, ...(await setPlan(env, authz.user, targetId, payload)) });`,
);

replaceOnce(
  'apps/api/src/admin.ts',
  `      SELF_BAN_FORBIDDEN: 'برای جلوگیری از قفل‌شدن پنل، نمی‌توانید حساب خودتان را Ban کنید.',\n      USER_NOT_FOUND: 'کاربر پیدا نشد.',\n    };\n    return json(env, { ok: false, error: messages[code] || 'عملیات مدیریت انجام نشد. دوباره تلاش کنید.' }, code === 'USER_NOT_FOUND' ? 404 : 500);`,
  `      SELF_BAN_FORBIDDEN: 'برای جلوگیری از قفل‌شدن پنل، نمی‌توانید حساب خودتان را Ban کنید.',\n      OWNER_PROTECTED: 'حساب Owner اصلی فقط توسط خود Owner قابل مدیریت است.',\n      ADMIN_ACCOUNT_PROTECTED: 'حساب‌های Admin فقط توسط Owner اصلی قابل تغییر هستند.',\n      OWNER_ONLY_ADMIN_GRANT: 'فقط Owner اصلی می‌تواند دسترسی Admin اعطا کند.',\n      USER_NOT_FOUND: 'کاربر پیدا نشد.',\n    };\n    const forbidden = new Set(['SELF_BAN_FORBIDDEN', 'OWNER_PROTECTED', 'ADMIN_ACCOUNT_PROTECTED', 'OWNER_ONLY_ADMIN_GRANT']);\n    const status = code === 'USER_NOT_FOUND' ? 404 : forbidden.has(code) ? 403 : 500;\n    return json(env, { ok: false, error: messages[code] || 'عملیات مدیریت انجام نشد. دوباره تلاش کنید.' }, status);`,
);

replaceOnce(
  'apps/api/src/ai/agent-v2.ts',
  `    if (auth.kind === 'invalid') return json(env, { ok: false, error: 'نشست کاربری معتبر نیست. دوباره وارد حساب شوید.', code: 'CODEX_AUTH_INVALID', requestId }, 401);\n    if (auth.kind !== 'user') return json(env, { ok: false, error: 'Codex فقط برای کاربران واردشده فعال است.', code: 'CODEX_LOGIN_REQUIRED', requestId }, 401);\n\n    const { success }`,
  `    if (auth.kind === 'invalid') return json(env, { ok: false, error: 'نشست کاربری معتبر نیست. دوباره وارد حساب شوید.', code: 'CODEX_AUTH_INVALID', requestId }, 401);\n    if (auth.kind !== 'user') return json(env, { ok: false, error: 'Codex فقط برای کاربران واردشده فعال است.', code: 'CODEX_LOGIN_REQUIRED', requestId }, 401);\n    if (auth.user.banned) return json(env, { ok: false, error: 'این حساب توسط مدیریت FarsiAI مسدود شده است.', code: 'CODEX_ACCOUNT_BANNED', requestId }, 403);\n\n    const { success }`,
);

const testPath = 'apps/api/test/admin-control-center.test.ts';
const testSource = fs.readFileSync(testPath, 'utf8');
const extra = `\n\ntest('a banned account is stopped on the legacy Codex planner too', async () => {\n  const original = globalThis.fetch;\n  let aiCalls = 0;\n  const env = baseEnv();\n  env.AI = { run: async () => { aiCalls += 1; return {}; } };\n  globalThis.fetch = async () => Response.json({\n    id: '11111111-1111-4111-8111-111111111111',\n    email: 'member@example.com',\n    app_metadata: { farsiai_banned: true },\n  });\n  try {\n    const response = await worker.fetch(new Request('https://api.example/v1/agent/plan', {\n      method: 'POST',\n      headers: { authorization: 'Bearer user-token', 'content-type': 'application/json' },\n      body: JSON.stringify({ task: 'فایل را بررسی کن', clientCapabilities: { tools: [] } }),\n    }), env);\n    assert.equal(response.status, 403);\n    const payload = await response.json() as { code?: string };\n    assert.equal(payload.code, 'CODEX_ACCOUNT_BANNED');\n    assert.equal(aiCalls, 0);\n  } finally {\n    globalThis.fetch = original;\n  }\n});\n\ntest('non-bootstrap admins cannot mutate the bootstrap owner account', async () => {\n  const original = globalThis.fetch;\n  const actorId = '11111111-1111-4111-8111-111111111111';\n  const ownerId = '22222222-2222-4222-8222-222222222222';\n  globalThis.fetch = async (input) => {\n    const url = String(input);\n    if (url.endsWith('/auth/v1/user')) return Response.json({ id: actorId, email: 'staff-admin@example.com', app_metadata: {} });\n    if (url.includes('/rest/v1/profiles?select=plan') && url.includes(actorId)) return Response.json([{ plan: 'admin' }]);\n    if (url.includes('/auth/v1/admin/users/' + ownerId)) return Response.json({ id: ownerId, email: 'owner@example.com', app_metadata: {} });\n    throw new Error('Unexpected fetch in owner protection test: ' + url);\n  };\n  try {\n    const env = baseEnv();\n    env.ADMIN_EMAILS = 'owner@example.com';\n    const response = await handleAdminRequest(new Request('https://api.example/v1/admin/users/' + ownerId + '/ban', {\n      method: 'POST',\n      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },\n      body: JSON.stringify({ reason: 'should be blocked' }),\n    }), env);\n    assert.equal(response.status, 403);\n    const payload = await response.json() as { error?: string };\n    assert.match(payload.error || '', /Owner/);\n  } finally {\n    globalThis.fetch = original;\n  }\n});\n`;
if (!testSource.includes("non-bootstrap admins cannot mutate the bootstrap owner account")) {
  fs.writeFileSync(testPath, testSource + extra);
}

console.log('Admin owner/root hardening applied.');
