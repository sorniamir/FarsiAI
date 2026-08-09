const baseUrl = process.env.FARSIAI_API_URL?.replace(/\/$/, '');

if (!baseUrl) {
  console.error('Set FARSIAI_API_URL to the deployed Worker URL.');
  process.exit(1);
}

const healthResponse = await fetch(`${baseUrl}/health`);
const health = await healthResponse.json().catch(() => null);

if (!healthResponse.ok || health?.ok !== true || health?.service !== 'farsiai-api') {
  throw new Error(`Health check failed (${healthResponse.status}).`);
}

console.log(`Health check passed: ${health.service} v${health.version}`);

if (process.env.FARSIAI_SMOKE_AI !== '1') {
  console.log('AI smoke test skipped. Set FARSIAI_SMOKE_AI=1 to run it.');
  process.exit(0);
}

const headers = { 'content-type': 'application/json' };
if (process.env.FARSIAI_ACCESS_TOKEN) {
  headers.authorization = `Bearer ${process.env.FARSIAI_ACCESS_TOKEN}`;
}

const aiResponse = await fetch(`${baseUrl}/v1/ai`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    mode: 'chat',
    message: 'Reply with one short word: pong',
    history: [],
  }),
});
const ai = await aiResponse.json().catch(() => null);

if (!aiResponse.ok || ai?.ok !== true || ai?.mode !== 'chat' || typeof ai?.text !== 'string') {
  throw new Error(`AI smoke test failed (${aiResponse.status}): ${JSON.stringify(ai)}`);
}

console.log('AI smoke test passed.');
