# FarsiAI Desktop v0.2

FarsiAI Desktop is the Windows surface of the same FarsiAI product. It is **not a separate data silo**.

## Shared cloud identity and data

Desktop and mobile must point to the same:

- Cloudflare Worker API
- Supabase project
- Supabase Auth tenant
- `profiles`
- `credit_wallets`
- `conversations`
- `messages`

A user who signs into desktop with the same account sees the same profile, wallet and conversation history that the mobile app sees.

Desktop public build variables:

```env
VITE_API_URL=https://your-worker.example
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

No Supabase secret key or other privileged credential belongs in the desktop bundle.

## Product surfaces

### Chat

Uses the same `/v1/ai` API as mobile. Authenticated requests send the current Supabase access token and continue the same server-persisted conversations.

### Codex

Codex is an agent loop. The cloud planner proposes exactly one next tool step and the local Tauri runtime executes only allowed operations inside the user-approved workspace.

Cloud planner tools:

- `list_directory`
- `read_file`
- `write_file`
- `run_command`

The actual local workspace path is kept on-device; the cloud planner sees the abstract label `approved-workspace`.

### Computer

Manual local tools for the approved workspace. Current v0.2 scope:

- file listing
- text file reading
- text file writing
- approved development commands

## Permission model

1. The user explicitly approves a workspace folder.
2. Read/list operations can execute inside that folder.
3. Every file write requires an approval dialog.
4. Every terminal command requires an approval dialog.
5. Commands execute directly without a shell wrapper.
6. The Rust runtime canonicalizes paths and rejects access outside approved workspace roots.
7. The agent is capped at 12 planning/execution steps per task in v0.2.

Current terminal allowlist:

- `npm`
- `npx`
- `node`
- `git`
- `python`
- `python3`
- `pnpm`
- `yarn`

## Windows build

```bash
npm install
npm run desktop:build
```

The build script first generates native platform icons from `public/app-icon.png`, then builds the Tauri NSIS installer.

GitHub Actions also builds the Windows installer and uploads it as the `FarsiAI-Desktop-Windows` workflow artifact.

## Next desktop milestones

- Browser automation with isolated session control
- Screenshot/screen vision
- Mouse/keyboard control with explicit scopes
- Patch previews before writes
- Persistent trusted-workspace grants using OS-secure storage
- Remote task handoff from mobile to an online desktop agent
