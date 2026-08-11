import fs from 'node:fs';

const path = 'apps/api/src/ai/agent-v2.ts';
let source = fs.readFileSync(path, 'utf8');
const before = '["\'\\`“]?[^\\s"\'\\`”]+';
const after = '["\'`“]?[^\\s"\'`”]+';
if (!source.includes(before)) throw new Error('escaped backtick target not found');
source = source.replace(before, after);
fs.writeFileSync(path, source);
console.log('Codex regex syntax fixed');
