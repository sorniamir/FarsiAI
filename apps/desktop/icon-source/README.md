# Desktop icon source

The `app-icon64.b64.part*` files are deterministic text chunks of the exact transparent FarsiAI artwork used for the Windows desktop icon. `scripts/materialize-icon.mjs` concatenates them, validates the PNG signature and SHA-256 checksum, and writes `public/app-icon.png` before Tauri generates the Windows icon set.

Do not hand-edit these chunks. Replace them only from the approved transparent source artwork and update the checksum in the materializer at the same time.
