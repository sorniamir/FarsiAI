import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';

const apiUrl = process.env.VITE_API_URL || 'https://farsiai-api.sorniamir2005.workers.dev';
const supabaseUrl = process.env.VITE_SUPABASE_URL || 'https://amjeqpkdowiqpnbdnlov.supabase.co';
const supabaseKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_dmq29e97vQpib77ne8wVWA_DHuzJ9-U';
const protocol = 'farsiai.codex.desktop.v2';

function fail(message, detail = '') {
  throw new Error(`${message}${detail ? `\n${detail}` : ''}`);
}

async function readJson(response) {
  const text = await response.text();
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    fail(`Production Codex returned non-JSON HTTP ${response.status}.`, text.slice(0, 1200));
  }
}

console.log('[codex-e2e] checking production health');
const health = await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(20_000) });
assert.equal(health.status, 200, `health endpoint returned HTTP ${health.status}`);

console.log('[codex-e2e] checking live v2 route/auth contract');
const unauthenticated = await fetch(`${apiUrl}/v2/codex/turn`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-farsiai-codex-protocol': protocol,
  },
  body: '{}',
  signal: AbortSignal.timeout(30_000),
});
const unauthenticatedPayload = await readJson(unauthenticated);
assert.equal(unauthenticated.status, 401, `unauthenticated Codex route returned HTTP ${unauthenticated.status}`);
assert.equal(unauthenticatedPayload.json.code, 'CODEX_LOGIN_REQUIRED');

let accessToken = process.env.CODEX_E2E_ACCESS_TOKEN?.trim();
let testClient;
if (!accessToken) {
  console.log('[codex-e2e] no static token supplied; creating an ephemeral anonymous Supabase session');
  testClient = createClient(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  const { data, error } = await testClient.auth.signInAnonymously();
  if (error || !data.session?.access_token) {
    fail(
      'Could not create an authenticated production session for the Codex E2E test. Configure CODEX_E2E_ACCESS_TOKEN or enable Supabase anonymous sign-ins for CI.',
      error?.message || 'No access token returned.',
    );
  }
  accessToken = data.session.access_token;
}

const turnBody = {
  task: 'برای تست اتصال، ابتدا فایل package.json را با ابزار read_file بخوان. هیچ تغییر یا دستور دیگری اجرا نکن.',
  workspace: {
    boundary: 'approved-workspace',
    label: 'Codex production E2E workspace',
  },
  observations: [],
  client: {
    kind: 'desktop',
    version: '0.5.0',
    locale: 'fa-IR',
  },
  capabilities: {
    protocol,
    tools: [
      { name: 'read_file', permission: 'automatic' },
    ],
    safeCommands: [],
    approvedApplications: [],
    permissionMode: 'ask',
    boundary: 'session-workspace-grant',
    supports: ['approval_once', 'native_confirmation', 'diff_preview', 'cancellation', 'structured_evidence', 'undo'],
  },
};

console.log('[codex-e2e] sending authenticated turn to the real production planner');
const response = await fetch(`${apiUrl}/v2/codex/turn`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
    'x-farsiai-client': 'desktop/0.5.0-codex-e2e',
    'x-farsiai-codex-protocol': protocol,
  },
  body: JSON.stringify(turnBody),
  signal: AbortSignal.timeout(95_000),
});
const payload = await readJson(response);
if (!response.ok) {
  fail(`Authenticated production Codex turn failed with HTTP ${response.status}.`, payload.text.slice(0, 2000));
}
assert.equal(payload.json.ok, true, 'Codex response must have ok=true');
assert.equal(payload.json.type, 'tool', 'First Codex turn must return a tool call');
assert.equal(payload.json.tool?.name, 'read_file', 'Codex must choose the only offered read_file tool');
assert.equal(typeof payload.json.tool?.callId, 'string', 'Codex tool call must have a correlated callId');
assert.equal(typeof payload.json.tool?.arguments?.path, 'string', 'Codex read_file call must contain a relative path');
assert.ok(payload.json.tool.arguments.path.length > 0 && !payload.json.tool.arguments.path.includes('..'), 'Codex path must stay relative and safe');
assert.equal(typeof payload.json.model, 'string', 'Codex must report the production model that answered');

if (testClient) {
  await testClient.auth.signOut().catch(() => undefined);
}

console.log(`[codex-e2e] PASS: production planner returned ${payload.json.tool.name} using ${payload.json.model}`);
