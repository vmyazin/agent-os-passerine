import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { CliError } from './args.js';

const ROOT_MARKERS = ['.git', 'pnpm-workspace.yaml'] as const;

interface WorkspaceRoot {
  readonly canonical: string;
  readonly lexical: string;
}

async function existingEntry(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new CliError(`cannot inspect workspace path: ${path}`);
  }
}

function isWithin(root: string, path: string): boolean {
  const child = relative(root, path);
  return (
    child === '' ||
    (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
  );
}

async function discoverWorkspaceRoot(start: string): Promise<WorkspaceRoot> {
  let current: string;
  try {
    current = await realpath(resolve(start));
  } catch {
    throw new CliError(`working directory cannot be resolved: ${start}`);
  }
  while (true) {
    for (const marker of ROOT_MARKERS) {
      const info = await existingEntry(resolve(current, marker));
      if (info !== undefined && !info.isSymbolicLink()) {
        return { canonical: current, lexical: current };
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new CliError(
        'workspace root not found; run agentos inside a repository',
      );
    }
    current = parent;
  }
}

export async function findWorkspaceRoot(start: string): Promise<string> {
  return (await discoverWorkspaceRoot(start)).canonical;
}

async function assertNoSymlinkComponents(
  root: string,
  path: string,
): Promise<void> {
  const child = relative(root, path);
  let current = root;
  for (const component of child.split(sep).filter(Boolean)) {
    current = resolve(current, component);
    const info = await existingEntry(current);
    if (info === undefined) break;
    if (info.isSymbolicLink()) {
      throw new CliError(
        `configuration path contains a symbolic link: ${current}`,
      );
    }
  }
}

export async function resolveConfigurationPath(
  configuredPath: string,
  cwd: string,
): Promise<string> {
  if (configuredPath.split(sep).includes('..')) {
    throw new CliError('configuration path must not contain traversal');
  }
  const workspace = await discoverWorkspaceRoot(cwd);
  const candidate = resolve(workspace.canonical, configuredPath);
  const inspectionRoot = isWithin(workspace.canonical, candidate)
    ? workspace.canonical
    : isWithin(workspace.lexical, candidate)
      ? workspace.lexical
      : undefined;
  if (inspectionRoot === undefined) {
    throw new CliError('configuration path is outside the workspace');
  }
  await assertNoSymlinkComponents(inspectionRoot, candidate);
  const existing = await existingEntry(candidate);
  let resolved: string;
  if (existing !== undefined) {
    resolved = await realpath(candidate);
  } else {
    let ancestor = dirname(candidate);
    while (
      (await existingEntry(ancestor)) === undefined &&
      ancestor !== inspectionRoot
    ) {
      ancestor = dirname(ancestor);
    }
    const resolvedAncestor = await realpath(ancestor);
    resolved = resolve(resolvedAncestor, relative(ancestor, candidate));
  }
  if (!isWithin(workspace.canonical, resolved)) {
    throw new CliError('configuration path is outside the workspace');
  }
  return resolved;
}
