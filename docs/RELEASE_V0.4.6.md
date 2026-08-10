# FarsiAI v0.4.6

## Image workflow

- A normal image prompt always creates a new image, even when older images exist in the same conversation.
- Image editing is explicit: it activates only when the user replies to a generated image or attaches a supported reference image in the current request.
- The server independently enforces the same contract, so a stale client-side reference cannot silently turn a generate request into an edit.
- Generated image results are persisted with conversation history for authenticated users.

## Attachments

- Desktop and mobile composers can attach images and supported documents.
- Client and server limits: up to 4 files, 6 MB each, 12 MB total.
- Supported document/image content is converted server-side through the Workers AI binding before being passed to Chat.
- Attachment content is treated as quoted user data rather than trusted instructions.

## Nano Banana

- Added an optional server-side Google Gemini Nano Banana provider using `gemini-3.1-flash-lite-image` through the current Interactions API.
- The Gemini API key remains a Worker secret and is never embedded in APK/EXE builds.
- Cloudflare image generation/editing remains an automatic fallback when Gemini is not configured or temporarily fails.

## Release gates

- API, mobile and desktop TypeScript checks.
- Worker regression tests, including stale-reference generate protection and explicit edit behavior.
- Wrangler bundle validation.
- Windows Rust/Tauri local-operation tests and NSIS/portable EXE build.
- Android Expo prebuild and release APK build.
- Production API/Supabase configuration verification in desktop output.
