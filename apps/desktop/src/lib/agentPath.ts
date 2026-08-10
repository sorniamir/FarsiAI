export function normalizeAgentRelativePath(input: string): string {
  const raw = input.trim().replace(/\\/g, '/');
  const withoutLeading = raw.replace(/^\/+/, '').replace(/^\.\//, '');
  const withoutVirtualRoot = withoutLeading.replace(/^(approved-workspace|workspace)(?:\/|$)/i, '');
  const normalized = withoutVirtualRoot.replace(/^\/+/, '');

  if (!normalized || normalized === '.') return '.';
  if (/^[a-zA-Z]:\//.test(normalized) || normalized.startsWith('//')) {
    throw new Error('Agent path must be relative to the approved workspace.');
  }

  const parts = normalized.split('/').filter(Boolean);
  if (parts.some((part) => part === '..')) {
    throw new Error('Agent path cannot leave the approved workspace.');
  }

  return parts.join('/');
}

export function resolveAgentPath(workspace: string, input: string): string {
  const relative = normalizeAgentRelativePath(input);
  const base = workspace.replace(/[\\/]+$/, '');
  if (!base) throw new Error('Workspace is not selected.');
  if (relative === '.') return base;

  const separator = base.includes('\\') ? '\\' : '/';
  return `${base}${separator}${relative.replace(/\//g, separator)}`;
}
