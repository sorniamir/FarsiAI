import fs from 'node:fs';

function replaceOnce(path, from, to) {
  const source = fs.readFileSync(path, 'utf8');
  if (!source.includes(from)) throw new Error(`Patch anchor not found in ${path}: ${from.slice(0, 90)}`);
  if (source.split(from).length !== 2) throw new Error(`Patch anchor is not unique in ${path}`);
  fs.writeFileSync(path, source.replace(from, to));
}

replaceOnce(
  'apps/api/src/index.ts',
  "import { handleVoiceSynthesis, handleVoiceTranscription } from './ai/voice';\n",
  "import { handleVoiceSynthesis, handleVoiceTranscription } from './ai/voice';\nimport { handleAdminRequest } from './admin';\nimport { renderAdminPanel } from './admin-ui';\n",
);

replaceOnce(
  'apps/api/src/index.ts',
  "    if (request.method === 'GET' && url.pathname === '/health') {\n      return json(env, { ok: true, service: 'farsiai-api', version: '0.5.3' });\n    }\n",
  "    if (request.method === 'GET' && (url.pathname === '/admin' || url.pathname === '/admin/')) {\n      return renderAdminPanel(env);\n    }\n\n    if (url.pathname.startsWith('/v1/admin/')) {\n      return handleAdminRequest(request, env);\n    }\n\n    if (request.method === 'GET' && url.pathname === '/health') {\n      return json(env, { ok: true, service: 'farsiai-api', version: '0.5.3' });\n    }\n",
);

replaceOnce(
  'apps/api/src/index.ts',
  "      if (auth.kind === 'unconfigured') {\n        return json(env, { ok: false, error: 'اتصال حساب کاربری به سرور هنوز کامل نشده است.' }, 503);\n      }\n\n      const guestKey",
  "      if (auth.kind === 'unconfigured') {\n        return json(env, { ok: false, error: 'اتصال حساب کاربری به سرور هنوز کامل نشده است.' }, 503);\n      }\n      if (auth.kind === 'user' && auth.user.banned) {\n        return json(env, { ok: false, error: 'این حساب توسط مدیریت FarsiAI مسدود شده است.' }, 403);\n      }\n\n      const guestKey",
);

replaceOnce(
  'apps/api/src/index.ts',
  "      let quota: { chatRemaining: number; imageRemaining: number; resetsAt?: string } | undefined;",
  "      let quota: { chatRemaining: number; imageRemaining: number; resetsAt?: string; unlimited?: boolean } | undefined;",
);

replaceOnce(
  'apps/api/src/ai/codex-v2.ts',
  "    const auth = await resolveAuth(request, env);\n    if (auth.kind !== 'user') return json(env, { ok: false, error: 'برای استفاده از Codex وارد حساب شوید.', code: 'CODEX_LOGIN_REQUIRED', requestId }, 401);\n    let payload: Record<string, unknown>;",
  "    const auth = await resolveAuth(request, env);\n    if (auth.kind !== 'user') return json(env, { ok: false, error: 'برای استفاده از Codex وارد حساب شوید.', code: 'CODEX_LOGIN_REQUIRED', requestId }, 401);\n    if (auth.user.banned) return json(env, { ok: false, error: 'این حساب توسط مدیریت FarsiAI مسدود شده است.', code: 'CODEX_ACCOUNT_BANNED', requestId }, 403);\n    let payload: Record<string, unknown>;",
);

console.log('Admin Control Center routes, bans and unlimited quota response contract patched.');
