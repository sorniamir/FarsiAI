import fs from 'node:fs';

function read(path) { return fs.readFileSync(path, 'utf8'); }
function write(path, value) { fs.writeFileSync(path, value); }
function replaceExact(path, from, to, expected = 1) {
  const source = read(path);
  const count = source.split(from).length - 1;
  if (count !== expected) throw new Error(`${path}: expected ${expected}, found ${count}: ${from.slice(0, 100)}`);
  write(path, source.split(from).join(to));
}
function replaceRegex(path, regex, to) {
  const source = read(path);
  if (!regex.test(source)) throw new Error(`${path}: regex target not found: ${regex}`);
  regex.lastIndex = 0;
  write(path, source.replace(regex, to));
}

replaceExact(
  'apps/api/src/ai/agent-v2.ts',
  "  return {\n    messages,\n    tools,\n    tool_choice: requireTool ? 'required' : 'auto',",
  "  const offeredTools = isDirectSimpleWriteTask(task)\n    ? tools.filter((tool) => tool.name === 'write_file')\n    : tools;\n\n  return {\n    messages,\n    tools: offeredTools,\n    tool_choice: requireTool ? 'required' : 'auto',",
);

replaceExact(
  'apps/api/src/ai/agent-v2.ts',
  "        const tool = extractToolCall(result);\n        const rawCall = rawToolCall(result);\n        const text = extractText(result);",
  "        const tool = extractToolCall(result);\n        const rawCall = rawToolCall(result);\n        const text = extractText(result);\n        const offeredToolNames = new Set(\n          (Array.isArray(plannerInput.tools) ? plannerInput.tools : [])\n            .map((item) => item && typeof item === 'object' ? String((item as Record<string, unknown>).name ?? '') : '')\n            .filter(Boolean),\n        );",
);

replaceExact(
  'apps/api/src/ai/agent-v2.ts',
  "        if (rawCall && !tool) {\n          lastError = new Error('Model returned an invalid or unsafe tool call.');",
  "        if (tool && offeredToolNames.size > 0 && !offeredToolNames.has(tool.name)) {\n          lastError = new Error(`Model requested ${tool.name}, which was not offered for this step.`);\n          console.warn(JSON.stringify({ event: 'codex_unoffered_tool_call', requestId, model, tool: tool.name, compatibilityMode }));\n          continue;\n        }\n        if (rawCall && !tool) {\n          lastError = new Error('Model returned an invalid or unsafe tool call.');",
);

replaceExact(
  'apps/api/test/index.test.ts',
  "assert.deepEqual(await response.json(), { ok: true, service: 'farsiai-api', version: '0.4.6' });",
  "assert.deepEqual(await response.json(), { ok: true, service: 'farsiai-api', version: '0.4.7' });",
);
replaceExact(
  'apps/api/test/index.test.ts',
  "assert.equal(model, '@cf/zai-org/glm-4.7-flash');",
  "assert.equal(model, '@cf/zai-org/glm-5.2');",
);
replaceExact(
  'apps/api/test/index.test.ts',
  "      model: '@cf/zai-org/glm-4.7-flash',\n    });",
  "      model: '@cf/zai-org/glm-5.2',\n      requestId: 'codex-test-ray',\n    });",
);

replaceExact(
  'apps/api/test/desktop-regressions.test.ts',
  "      assert.equal(model, '@cf/zai-org/glm-5.2');",
  "      assert.equal(model, '@cf/zai-org/glm-4.7-flash');",
);
replaceExact(
  'apps/api/test/desktop-regressions.test.ts',
  "    assert.equal(payload.model, '@cf/zai-org/glm-5.2');",
  "    assert.equal(payload.model, '@cf/zai-org/glm-4.7-flash');",
);

replaceRegex(
  'apps/api/test/desktop-regressions.test.ts',
  /  it\('stops after a local write failure instead of requesting approval for the same write again',[\s\S]*?\n  \}\);\n\n  it\('keeps Guest Chat available/,
  `  it('feeds a local write failure back to Codex so it can diagnose and recover', async () => {\n    installAuthenticatedUserFetch();\n    const aiRun = mock.fn(async (_model: string, input: any) => {\n      assert.match(JSON.stringify(input.messages), /status=\\\\?"failure/);\n      assert.match(JSON.stringify(input.messages), /Access denied/);\n      return {\n        tool_calls: [\n          { name: 'list_directory', arguments: { path: '.' } },\n        ],\n      };\n    });\n    const env = createEnv({\n      AI: { run: aiRun },\n      SUPABASE_URL: 'https://project.supabase.co',\n      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',\n    });\n\n    const response = await worker.fetch(\n      agentRequest({\n        task: 'یک فایل test.txt بساز و داخلش بنویس FarsiAI Codex Test',\n        workspace: 'approved-workspace',\n        observations: [{\n          role: 'tool',\n          name: 'write_file',\n          content: 'ERROR: Access denied. Approve the workspace directory first.',\n        }],\n      }),\n      env,\n    );\n\n    assert.equal(response.status, 200);\n    const payload = await response.json() as any;\n    assert.equal(payload.ok, true);\n    assert.equal(payload.type, 'tool');\n    assert.equal(payload.tool.name, 'list_directory');\n    assert.equal(aiRun.mock.callCount(), 1);\n  });\n\n  it('keeps Guest Chat available`,
);

console.log('Codex Pro planner/tests finalized.');
