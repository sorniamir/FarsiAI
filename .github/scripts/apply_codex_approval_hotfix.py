from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"Expected exactly one match in {path}, got {count}: {old[:100]!r}")
    p.write_text(text.replace(old, new, 1), encoding="utf-8")


# Native broker: a missing model hash is derived locally. The derived hash is then
# re-used after native approval, preserving the TOCTOU conflict check.
replace_once(
    "apps/desktop/src-tauri/src/codex_broker.rs",
    '''            let supplied = expected
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "expectedSha256 is required when replacing an existing file.".to_string())?;
            if supplied.len() != 64 || !supplied.bytes().all(|value| value.is_ascii_hexdigit()) {
                return Err("expectedSha256 must be a 64-character SHA-256 value.".to_string());
            }
            if !actual.eq_ignore_ascii_case(supplied) {
                return Err(format!(
                    "File changed since it was read (SHA-256 conflict; current hash is {actual})."
                ));
            }
            Ok(Some(actual))''',
    '''            if let Some(supplied) = expected.filter(|value| !value.trim().is_empty()) {
                if supplied.len() != 64 || !supplied.bytes().all(|value| value.is_ascii_hexdigit()) {
                    return Err("expectedSha256 must be a 64-character SHA-256 value.".to_string());
                }
                if !actual.eq_ignore_ascii_case(supplied) {
                    return Err(format!(
                        "File changed since it was read (SHA-256 conflict; current hash is {actual})."
                    ));
                }
            }
            Ok(Some(actual))''',
)
replace_once(
    "apps/desktop/src-tauri/src/codex_broker.rs",
    '''        verify_expected_hash(Some(&current), expected_sha256.as_deref())?;''',
    '''        let recheck_expected = expected_sha256.as_deref().or(before_sha256.as_deref());
        verify_expected_hash(Some(&current), recheck_expected)?;''',
)
replace_once(
    "apps/desktop/src-tauri/src/codex_broker.rs",
    '''mod tests {
    use super::*;''',
    '''mod tests {
    use super::*;

    #[test]
    fn missing_expected_hash_captures_existing_file_for_safe_recheck() {
        let bytes = b"existing file";
        let actual = sha256_bytes(bytes);
        assert_eq!(verify_expected_hash(Some(bytes), None).unwrap(), Some(actual));
    }''',
)

# Desktop service: null and undefined both trigger the local verified pre-read.
# Tauri rejects with strings, so surface those strings instead of a generic error.
replace_once(
    "apps/desktop/src/services/codex.ts",
    '''      if (expectedSha256 === undefined) {''',
    '''      if (expectedSha256 === undefined || expectedSha256 === null) {''',
)
replace_once(
    "apps/desktop/src/services/codex.ts",
    '''    const message = error instanceof Error ? error.message : 'اجرای ابزار محلی ناموفق بود.';''',
    '''    const message = error instanceof Error
      ? error.message
      : typeof error === 'string' && error.trim()
        ? error
        : 'اجرای ابزار محلی ناموفق بود.';''',
)
replace_once(
    "apps/desktop/src/services/codex.ts",
    "export const CODEX_CLIENT_VERSION = '0.5.1-codex-studio';",
    "export const CODEX_CLIENT_VERSION = '0.5.2-codex-studio';",
)

# Desktop state machine: an identical, already verified write or mkdir is idempotent.
# Correlate the new callId to prior verified evidence instead of prompting/writing again.
replace_once(
    "apps/desktop/src/components/CodexStudio.tsx",
    '''    const observations: CodexObservation[] = [];
    const approved = new Set<CodexToolName>();
    try {''',
    '''    const observations: CodexObservation[] = [];
    const approved = new Set<CodexToolName>();
    const completedWrites = new Map<string, { content: string; observation: CodexObservation }>();
    const completedDirectories = new Map<string, CodexObservation>();
    try {''',
)
replace_once(
    "apps/desktop/src/components/CodexStudio.tsx",
    '''        if (!await approve(call, approved)) {''',
    '''        if (call.name === 'write_file') {
          const completed = completedWrites.get(call.arguments.path);
          if (completed && completed.content === call.arguments.content) {
            observations.push({
              ...completed.observation,
              callId: call.callId,
              createdAt: new Date().toISOString(),
              content: `${completed.observation.content}\\nDuplicate write suppressed locally because the exact content is already verified on disk.`,
            });
            setActivity((items) => items.map((item) => item.id === activityId ? {
              ...item,
              detail: 'این تغییر قبلاً با موفقیت روی دیسک اعمال و تأیید شده بود؛ اجرای تکراری حذف شد.',
              state: 'success',
            } : item));
            continue;
          }
        }
        if (call.name === 'create_directory') {
          const completed = completedDirectories.get(call.arguments.path);
          if (completed) {
            observations.push({
              ...completed,
              callId: call.callId,
              createdAt: new Date().toISOString(),
              content: `${completed.content}\\nDuplicate directory creation suppressed locally because it is already verified.`,
            });
            setActivity((items) => items.map((item) => item.id === activityId ? {
              ...item,
              detail: 'این پوشه قبلاً ساخته و تأیید شده بود؛ اجرای تکراری حذف شد.',
              state: 'success',
            } : item));
            continue;
          }
        }
        if (!await approve(call, approved)) {''',
)
replace_once(
    "apps/desktop/src/components/CodexStudio.tsx",
    '''        observations.push(evidence.observation);
        setActivity((items) => items.map((item) => item.id === activityId ? { ...item, detail: evidence.summary, state: evidence.observation.status === 'success' ? 'success' : 'error' } : item));''',
    '''        observations.push(evidence.observation);
        if (evidence.observation.status === 'success') {
          if (call.name === 'write_file') {
            completedWrites.set(call.arguments.path, { content: call.arguments.content, observation: evidence.observation });
          } else if (call.name === 'create_directory') {
            completedDirectories.set(call.arguments.path, evidence.observation);
          }
        }
        setActivity((items) => items.map((item) => item.id === activityId ? { ...item, detail: evidence.summary, state: evidence.observation.status === 'success' ? 'success' : 'error' } : item));''',
)

# Planner: don't turn an omitted optimistic hash into an explicit null, and make
# verified observations authoritative so the model moves forward after success.
replace_once(
    "apps/api/src/ai/codex-v2.ts",
    '''    normalized = { path, content: input.content, expectedSha256: typeof input.expectedSha256 === 'string' ? input.expectedSha256 : null };''',
    '''    normalized = { path, content: input.content };
    if (typeof input.expectedSha256 === 'string' && input.expectedSha256.trim()) normalized.expectedSha256 = input.expectedSha256;''',
)
replace_once(
    "apps/api/src/ai/codex-v2.ts",
    '''    'Never claim a change, command, test, launch or completion without a correlated verified tool observation. A nonzero exit code or error/denied/cancelled status is not success.',
    'After edits, run the most relevant validation when the terminal plugin is enabled. Do not repeat a failed side effect automatically.', ''',
    '''    'Never claim a change, command, test, launch or completion without a correlated verified tool observation. A nonzero exit code or error/denied/cancelled status is not success.',
    'A LOCAL TOOL OBSERVATION with status=success and verified=true is authoritative proof that the operation already completed. Never request the same write_file with the same path/content or the same create_directory again; continue to the next distinct step or finalize.',
    'After edits, run the most relevant validation when the terminal plugin is enabled. Do not repeat a failed side effect automatically.', ''',
)

# v0.5.2 release metadata.
replace_once("apps/desktop/package.json", '"version": "0.5.1"', '"version": "0.5.2"')
replace_once("apps/desktop/src-tauri/Cargo.toml", 'version = "0.5.1"', 'version = "0.5.2"')
replace_once("apps/desktop/src-tauri/tauri.conf.json", '"version": "0.5.1"', '"version": "0.5.2"')
replace_once(
    "apps/desktop/src-tauri/src/codex_transport.rs",
    'assert_eq!(codex_client_header(), "desktop/0.5.1-codex-studio");',
    'assert_eq!(codex_client_header(), "desktop/0.5.2-codex-studio");',
)

workflow = Path(".github/workflows/desktop-windows.yml")
workflow_text = workflow.read_text(encoding="utf-8")
if "0.5.1-codex-studio" not in workflow_text or "v0.5.1" not in workflow_text:
    raise SystemExit("desktop-windows.yml v0.5.1 markers were not found")
workflow.write_text(
    workflow_text.replace("0.5.1-codex-studio", "0.5.2-codex-studio").replace("v0.5.1", "v0.5.2"),
    encoding="utf-8",
)

# Clean all one-shot patch plumbing before the real fix commit is pushed.
Path(".github/scripts/apply_codex_approval_hotfix.py").unlink()
Path(".github/workflows/codex-approval-hotfix.yml").unlink(missing_ok=True)
Path(".github/workflows/ci.yml").write_text('''name: CI

on:
  push:
    branches: [main, "agent/**"]
  pull_request:
    branches: [main]

jobs:
  typecheck:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Install dependencies
        run: npm install

      # Expo/Metro currently inherits image-size High advisories with no patched
      # image-size release. ICNS/JXL/HEIF are not accepted by FarsiAI attachments,
      # and Metro is build tooling rather than an application-side Node service.
      # Keep Critical findings release-blocking while upstream resolves the Highs.
      - name: Audit production dependencies for critical vulnerabilities
        run: npm audit --omit=dev --audit-level=critical

      - name: Typecheck API, mobile, and desktop
        run: npm run check

      - name: Test Worker behavior
        run: npm run test:api

      - name: Validate Cloudflare Worker bundle
        working-directory: apps/api
        run: npx wrangler deploy --dry-run
''', encoding="utf-8")
