import { open } from '@tauri-apps/plugin-dialog';

export async function pickWorkspaceFolder(): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: 'انتخاب Workspace برای FarsiAI Codex',
  });

  return typeof selected === 'string' ? selected : null;
}
