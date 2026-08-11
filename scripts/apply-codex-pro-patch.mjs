import fs from 'node:fs';

function read(path) {
  return fs.readFileSync(path, 'utf8');
}

function write(path, content) {
  fs.writeFileSync(path, content);
}

function replaceExact(path, from, to, expected = 1) {
  const source = read(path);
  const count = source.split(from).length - 1;
  if (count !== expected) {
    throw new Error(`${path}: expected ${expected} occurrence(s), found ${count} for: ${from.slice(0, 120)}`);
  }
  write(path, source.split(from).join(to));
}

function replaceRegex(path, regex, to) {
  const source = read(path);
  if (!regex.test(source)) throw new Error(`${path}: regex target not found: ${regex}`);
  regex.lastIndex = 0;
  write(path, source.replace(regex, to));
}

replaceExact(
  'apps/api/src/index.ts',
  "import { handleAgentPlan } from './ai/agent';",
  "import { handleAgentPlan } from './ai/agent-v2';",
);

replaceExact(
  'apps/api/src/index.ts',
  "return json(env, { ok: true, service: 'farsiai-api', version: '0.4.6' });",
  "return json(env, { ok: true, service: 'farsiai-api', version: '0.4.7' });",
);

replaceRegex(
  'apps/api/src/index.ts',
  /    if \(request\.method === 'POST' && url\.pathname === '\/v1\/agent\/plan'\) \{[\s\S]*?      return handleAgentPlan\(request, env\);\n    \}/,
  "    if (request.method === 'POST' && url.pathname === '/v1/agent/plan') {\n      // Local tool failures are intentionally returned to Codex Pro as observations.\n      // The planner can diagnose and recover instead of stopping after the first error.\n      return handleAgentPlan(request, env);\n    }",
);

replaceExact(
  'apps/desktop/src/App.tsx',
  'function truncate(value: string, max = 18000): string {',
  'function truncate(value: string, max = 65000): string {',
);

replaceExact(
  'apps/desktop/src/App.tsx',
  'for (let step = 1; step <= 16; step += 1) {',
  'for (let step = 1; step <= 24; step += 1) {',
);

replaceExact(
  'apps/desktop/src/App.tsx',
  "setAgentTimeline([`● Task: ${task}`, '✓ Permission boundary active', '○ Codex planner connected']);",
  "setAgentTimeline([`● Task: ${task}`, '✓ Permission boundary active', '○ Codex Pro · Kimi K2.7 Code / GLM-5.2']);",
);

replaceExact(
  'apps/desktop/src/App.tsx',
  "setAgentTimeline((current) => [...current, `→ ${tool.name}`]);",
  "setAgentTimeline((current) => [...current, `→ ${tool.name}${plan.model ? ` · ${plan.model.replace('@cf/', '')}` : ''}`]);",
);

replaceExact(
  'apps/desktop/src/App.tsx',
  "setAgentTimeline((current) => [...current, `✓ ${plan.message}`]);",
  "setAgentTimeline((current) => [...current, `✓ ${plan.message}${plan.model ? ` · ${plan.model.replace('@cf/', '')}` : ''}`]);",
);

replaceExact(
  'apps/desktop/src/App.tsx',
  "          setAgentTimeline((current) => [\n            ...current,\n            result.includes('BACKUP') ? `✓ ${tool.name} completed · backup protected` : `✓ ${tool.name} completed`,\n          ]);",
  "          const commandExit = tool.name === 'run_command' ? result.match(/(?:^|\\n)exit=(-?\\d+)/i) : null;\n          const exitCode = commandExit ? Number(commandExit[1]) : 0;\n          const failed = tool.name === 'run_command' && exitCode !== 0;\n          setAgentTimeline((current) => [\n            ...current,\n            failed\n              ? `⚠ ${tool.name} failed · exit ${exitCode} · Codex will diagnose`\n              : result.includes('BACKUP')\n                ? `✓ ${tool.name} completed · backup protected`\n                : `✓ ${tool.name} completed`,\n          ]);",
);

replaceExact(
  'apps/desktop/src/App.tsx',
  '<div><h2>Codex Agent</h2><p>Task را بگو؛ Agent فایل را می‌خواند، تغییر می‌دهد، دستور اجرا می‌کند و نتیجه را بررسی می‌کند.</p></div>',
  '<div><h2>Codex Pro Agent</h2><p>پروژه را تحلیل می‌کند، فایل واقعی را می‌خواند و تغییر می‌دهد، تست/بیلد را اجرا می‌کند و تا نتیجه معتبر روی خطاها ادامه می‌دهد.</p></div>',
);

replaceExact(
  'apps/desktop/src-tauri/src/tools.rs',
  '    const ALLOWED_PROGRAMS: &[&str] = &["npm", "node", "git", "python", "python3", "pnpm", "yarn", "npx"];',
  '    const ALLOWED_PROGRAMS: &[&str] = &["npm", "node", "git", "python", "python3", "pnpm", "yarn", "npx", "bun", "deno", "cargo", "rustc", "go", "dotnet", "java", "javac", "mvn", "gradle", "pytest", "pip", "pip3", "uv", "ruff", "rg"];',
);

replaceExact(
  'apps/desktop/src-tauri/src/tools.rs',
  '        if matches!(normalized, "npm" | "npx" | "pnpm" | "yarn") {\n            return format!("{normalized}.cmd");\n        }',
  '        if matches!(normalized, "npm" | "npx" | "pnpm" | "yarn" | "mvn") {\n            return format!("{normalized}.cmd");\n        }\n        if normalized == "gradle" {\n            return "gradle.bat".to_string();\n        }',
);

replaceExact(
  'apps/desktop/src-tauri/src/tools.rs',
  'fn platform_program(normalized: &str) -> String {\n    #[cfg(target_os = "windows")]\n    {\n        if matches!(normalized, "npm" | "npx" | "pnpm" | "yarn" | "mvn") {\n            return format!("{normalized}.cmd");\n        }\n        if normalized == "gradle" {\n            return "gradle.bat".to_string();\n        }\n    }\n    normalized.to_string()\n}\n',
  'fn platform_program(normalized: &str) -> String {\n    #[cfg(target_os = "windows")]\n    {\n        if matches!(normalized, "npm" | "npx" | "pnpm" | "yarn" | "mvn") {\n            return format!("{normalized}.cmd");\n        }\n        if normalized == "gradle" {\n            return "gradle.bat".to_string();\n        }\n    }\n    normalized.to_string()\n}\n\nfn bounded_output(bytes: &[u8]) -> String {\n    let text = String::from_utf8_lossy(bytes).to_string();\n    const MAX_CHARS: usize = 250_000;\n    if text.chars().count() <= MAX_CHARS {\n        return text;\n    }\n    let clipped: String = text.chars().take(MAX_CHARS).collect();\n    format!("{clipped}\\n...[output truncated by FarsiAI Codex]")\n}\n',
);

replaceExact(
  'apps/desktop/src-tauri/src/tools.rs',
  '        stdout: String::from_utf8_lossy(&output.stdout).to_string(),\n        stderr: String::from_utf8_lossy(&output.stderr).to_string(),',
  '        stdout: bounded_output(&output.stdout),\n        stderr: bounded_output(&output.stderr),',
);

replaceExact(
  'apps/desktop/package.json',
  '"version": "0.4.6"',
  '"version": "0.4.7"',
);

replaceExact(
  'apps/desktop/src-tauri/tauri.conf.json',
  '"version": "0.4.6"',
  '"version": "0.4.7"',
);

replaceExact(
  'apps/api/package.json',
  '"version": "0.4.6"',
  '"version": "0.4.7"',
);

replaceExact(
  'apps/api/package.json',
  'test/v046-image-attachments.test.ts',
  'test/v046-image-attachments.test.ts test/codex-pro.test.ts',
);

replaceExact(
  '.github/workflows/desktop-windows.yml',
  '      - "apps/api/src/ai/agent.ts"',
  '      - "apps/api/src/ai/agent.ts"\n      - "apps/api/src/ai/agent-v2.ts"',
  2,
);

replaceExact(
  '.github/workflows/desktop-windows.yml',
  'name: FarsiAI-Desktop-Windows-v0.4.6',
  'name: FarsiAI-Desktop-Windows-v0.4.7-Codex-Pro',
);

console.log('Codex Pro source patch applied successfully.');
