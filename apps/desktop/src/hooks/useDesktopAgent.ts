import { useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

export type FileEntry = {
  name: string;
  path: string;
  is_dir: boolean;
};

export type CommandResult = {
  stdout: string;
  stderr: string;
  status: number;
};

export function useDesktopAgent() {
  const [logs, setLogs] = useState<string[]>(['Desktop Agent آماده است.']);
  const [busy, setBusy] = useState(false);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [terminalOutput, setTerminalOutput] = useState('');

  const pushLog = useCallback((text: string) => {
    setLogs((current) => [text, ...current].slice(0, 30));
  }, []);

  const runBusy = useCallback(async <T,>(label: string, task: () => Promise<T>): Promise<T> => {
    setBusy(true);
    pushLog(label);
    try {
      return await task();
    } finally {
      setBusy(false);
    }
  }, [pushLog]);

  const grantDirectory = useCallback(async (path: string) => runBusy(
    `دسترسی Workspace تأیید شد: ${path}`,
    async () => {
      await invoke('grant_directory_access', { path });
      const list = await invoke<FileEntry[]>('list_directory', { path });
      setEntries(list);
      return list;
    },
  ), [runBusy]);

  const listDirectory = useCallback(async (path: string) => runBusy(
    `در حال خواندن پوشه: ${path}`,
    async () => {
      const list = await invoke<FileEntry[]>('list_directory', { path });
      setEntries(list);
      return list;
    },
  ), [runBusy]);

  const readFile = useCallback(async (path: string) => runBusy(
    `در حال خواندن فایل: ${path}`,
    () => invoke<string>('read_text_file', { path }),
  ), [runBusy]);

  const writeFile = useCallback(async (path: string, content: string) => runBusy(
    `در حال ذخیره فایل: ${path}`,
    async () => {
      const backupPath = await invoke<string>('write_text_file', { path, content });
      if (backupPath) pushLog(`Backup ساخته شد: ${backupPath}`);
      pushLog(`فایل ذخیره شد: ${path}`);
      return backupPath;
    },
  ), [pushLog, runBusy]);

  const runCommand = useCallback(async (command: string, args: string[], cwd: string) => runBusy(
    `اجرای دستور: ${command} ${args.join(' ')}`,
    async () => {
      const result = await invoke<CommandResult>('run_command', { command, args, cwd });
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
      setTerminalOutput(output || `Process exited with code ${result.status}`);
      return result;
    },
  ), [runBusy]);

  return {
    logs,
    busy,
    entries,
    terminalOutput,
    grantDirectory,
    listDirectory,
    readFile,
    writeFile,
    runCommand,
  };
}
