import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { canonicalConfigHash } from '@agentos/core';
import { describe, expect, it } from 'vitest';

import {
  MAX_CONFIG_BYTES,
  initConfiguration,
  readConfiguration,
} from './config-files.js';

async function repository(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  await writeFile(join(root, '.git'), 'gitdir: elsewhere\n');
  return root;
}

describe('configuration files', () => {
  it('writes the approved v1 starter atomically with owner-only permissions', async () => {
    const root = await repository('agentos-init-');
    const path = join(root, 'agentos', 'agent-os.yaml');

    const result = await initConfiguration(path, false);

    const info = await stat(path);
    expect(info.mode & 0o777).toBe(0o600);
    expect(result.created).toBe(true);
    const loaded = await readConfiguration(path);
    expect(loaded.config.version).toBe(1);
    expect(loaded.config.project.name).toBe('example');
    expect(loaded.digest).toBe(canonicalConfigHash(loaded.config));
    await expect(readFile(`${path}.tmp`, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('refuses overwrite unless force is explicit', async () => {
    const root = await repository('agentos-overwrite-');
    const path = join(root, 'agent-os.yaml');
    await writeFile(path, 'keep-me', { mode: 0o600 });

    await expect(initConfiguration(path, false)).rejects.toThrow(
      'already exists',
    );
    expect(await readFile(path, 'utf8')).toBe('keep-me');
    await initConfiguration(path, true);
    expect(await readFile(path, 'utf8')).toContain('version: 1');
  });

  it('allows only one concurrent non-force initializer to create the target', async () => {
    const root = await repository('agentos-race-');
    const path = join(root, 'agent-os.yaml');

    const results = await Promise.allSettled([
      initConfiguration(path, false),
      initConfiguration(path, false),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    await expect(readConfiguration(path)).resolves.toMatchObject({
      config: { version: 1 },
    });
  });

  it('reports validation paths and rejects oversized files before parsing', async () => {
    const root = await repository('agentos-invalid-');
    const invalid = join(root, 'invalid.yaml');
    await writeFile(invalid, 'version: 1\nproject: {}\n', 'utf8');
    await expect(readConfiguration(invalid)).rejects.toThrow('project.name');

    const large = join(root, 'large.yaml');
    await writeFile(large, Buffer.alloc(MAX_CONFIG_BYTES + 1, 65));
    await expect(readConfiguration(large)).rejects.toThrow('too large');
  });

  it('revalidates parent directories at the read and write boundary', async () => {
    const root = await repository('agentos-operation-boundary-');
    const outside = await realpath(
      await mkdtemp(join(tmpdir(), 'agentos-operation-outside-')),
    );
    await writeFile(join(outside, 'agent-os.yaml'), 'version: 1\n');
    await symlink(outside, join(root, 'linked'));

    await expect(
      readConfiguration(join(root, 'linked', 'agent-os.yaml')),
    ).rejects.toThrow('symbolic link');
    await expect(
      initConfiguration(join(root, 'linked', 'new.yaml'), true),
    ).rejects.toThrow('symbolic link');
    await expect(readFile(join(outside, 'new.yaml'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('revalidates trusted directory permissions at the read boundary', async () => {
    const root = await repository('agentos-read-permissions-');
    const directory = join(root, 'agentos');
    await mkdir(directory);
    const path = join(directory, 'agent-os.yaml');
    await writeFile(path, 'version: 1\n');
    await chmod(directory, 0o777);

    await expect(readConfiguration(path)).rejects.toThrow(
      'workspace directory permissions',
    );
  });

  it('revalidates trusted directory permissions at the write boundary', async () => {
    const root = await repository('agentos-write-permissions-');
    await chmod(root, 0o770);
    const path = join(root, 'agentos', 'agent-os.yaml');

    await expect(initConfiguration(path, false)).rejects.toThrow(
      'workspace directory permissions',
    );
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
