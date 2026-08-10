import assert from 'node:assert/strict';
import { normalizeAgentRelativePath, resolveAgentPath } from '../src/lib/agentPath.ts';

assert.equal(normalizeAgentRelativePath('test.txt'), 'test.txt');
assert.equal(normalizeAgentRelativePath('./test.txt'), 'test.txt');
assert.equal(normalizeAgentRelativePath('approved-workspace/test.txt'), 'test.txt');
assert.equal(normalizeAgentRelativePath('workspace\\src\\hello.txt'), 'src/hello.txt');
assert.equal(resolveAgentPath('C:\\Users\\Tester\\Workspace', 'approved-workspace/test.txt'), 'C:\\Users\\Tester\\Workspace\\test.txt');
assert.equal(resolveAgentPath('C:\\Users\\Tester\\Workspace', 'src/generated/test.txt'), 'C:\\Users\\Tester\\Workspace\\src\\generated\\test.txt');
assert.throws(() => normalizeAgentRelativePath('../outside.txt'));

console.log('Codex desktop path normalization regression tests passed.');
