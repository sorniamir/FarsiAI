import fs from 'node:fs';

const path = 'apps/api/src/ai/agent-v2.ts';
let source = fs.readFileSync(path, 'utf8');
const before = `  const offeredTools = isDirectSimpleWriteTask(task)\n    ? tools.filter((tool) => tool.name === 'write_file')\n    : tools;`;
const after = `  const offeredTools = isDirectSimpleWriteTask(task) && observations.length === 0\n    ? tools.filter((tool) => tool.name === 'write_file')\n    : tools;`;
if (!source.includes(before)) throw new Error('offered-tools target not found');
source = source.replace(before, after);
fs.writeFileSync(path, source);
console.log('Codex recovery tools enabled after first observation');
