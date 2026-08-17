import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { findWorkspaceRoot, resolveConfigurationPath } from './workspace.js';

async function workspace() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'agentos-workspace-'));
  const root = await realpath(temporaryRoot);
  await writeFile(join(root, '.git'), 'gitdir: elsewhere\n');
  const nested = join(root, 'packages', 'app', 'src');
  await mkdir(nested, { recursive: true });
  await mkdir(join(root, 'agentos'));
  await writeFile(join(root, 'agentos', 'agent-os.yaml'), 'version: 1\n');
  return { root, nested };
}

describe('workspace configuration discovery', () => {
  it('discovers the repository root from a nested working directory', async () => {
    const { root, nested } = await workspace();
    await expect(findWorkspaceRoot(nested)).resolves.toBe(root);
    await expect(
      resolveConfigurationPath('agentos/agent-os.yaml', nested),
    ).resolves.toBe(join(root, 'agentos', 'agent-os.yaml'));
  });

  it('canonicalizes a symlinked working directory before ascending', async () => {
    const { root, nested } = await workspace();
    const unrelated = await realpath(
      await mkdtemp(join(tmpdir(), 'agentos-unrelated-root-')),
    );
    await writeFile(join(unrelated, '.git'), 'gitdir: unrelated\n');
    await symlink(nested, join(unrelated, 'linked-cwd'));

    await expect(
      findWorkspaceRoot(join(unrelated, 'linked-cwd')),
    ).resolves.toBe(root);
  });

  it('fails closed when no repository marker exists', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentos-no-root-'));
    await expect(findWorkspaceRoot(directory)).rejects.toThrow(
      'workspace root',
    );
  });

  it.each([
    '../outside.yaml',
    '../../outside.yaml',
    'agentos/../agentos/agent-os.yaml',
  ])('rejects traversal path %s', async (path) => {
    const { nested } = await workspace();
    await expect(resolveConfigurationPath(path, nested)).rejects.toThrow(
      'traversal',
    );
  });

  it('rejects absolute paths outside the workspace', async () => {
    const { nested } = await workspace();
    await expect(
      resolveConfigurationPath(join(tmpdir(), 'outside.yaml'), nested),
    ).rejects.toThrow('outside the workspace');
  });

  it('rejects symlinked config files and directories', async () => {
    const { root, nested } = await workspace();
    await symlink(
      join(root, 'agentos', 'agent-os.yaml'),
      join(root, 'agentos', 'linked.yaml'),
    );
    await symlink(join(root, 'agentos'), join(root, 'linked-agentos'));

    await expect(
      resolveConfigurationPath('agentos/linked.yaml', nested),
    ).rejects.toThrow('symbolic link');
    await expect(
      resolveConfigurationPath('linked-agentos/agent-os.yaml', nested),
    ).rejects.toThrow('symbolic link');
  });

  it('rejects a group-writable workspace root', async () => {
    const { root, nested } = await workspace();
    await chmod(root, 0o770);

    await expect(findWorkspaceRoot(nested)).rejects.toThrow(
      'workspace directory permissions',
    );
  });

  it('rejects group- or world-writable directories below the workspace root', async () => {
    const { root, nested } = await workspace();
    await chmod(join(root, 'agentos'), 0o777);

    await expect(
      resolveConfigurationPath('agentos/agent-os.yaml', nested),
    ).rejects.toThrow('workspace directory permissions');
  });

  it.runIf(typeof process.getuid === 'function')(
    'rejects workspace directories owned by another uid when ownership is available',
    async () => {
      const { nested } = await workspace();
      const getuid = process.getuid as () => number;
      const getuidSpy = vi
        .spyOn(process, 'getuid')
        .mockReturnValue(getuid() + 1);
      try {
        await expect(findWorkspaceRoot(nested)).rejects.toThrow(
          'workspace directory ownership',
        );
      } finally {
        getuidSpy.mockRestore();
      }
    },
  );
});
