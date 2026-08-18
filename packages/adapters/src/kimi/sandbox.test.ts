import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createKimiSandbox, type KimiSandbox } from './sandbox.js';

const tempRoots: string[] = [];

async function newRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kimi-sandbox-'));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function makeSandbox(): Promise<KimiSandbox> {
  const root = await newRoot();
  return createKimiSandbox({ root, sessionId: 'session-1' });
}

describe('createKimiSandbox', () => {
  it('rejects an invalid sessionId', async () => {
    const root = await newRoot();
    await expect(
      createKimiSandbox({ root, sessionId: '../escape' }),
    ).rejects.toThrow();
    await expect(
      createKimiSandbox({ root, sessionId: 'has spaces' }),
    ).rejects.toThrow();
  });

  it('creates the workdir under root/sessionId', async () => {
    const root = await newRoot();
    const sandbox = await createKimiSandbox({ root, sessionId: 'sess_A-1' });
    expect(sandbox.workdir).toBe(path.join(root, 'sess_A-1'));
    const stats = await fs.stat(sandbox.workdir);
    expect(stats.isDirectory()).toBe(true);
  });

  it('round-trips write -> read -> edit', async () => {
    const sandbox = await makeSandbox();
    await sandbox.writeFile('greeting.txt', 'hello world');
    await expect(sandbox.readFile('greeting.txt')).resolves.toBe('hello world');

    await sandbox.editFile('greeting.txt', 'world', 'there');
    await expect(sandbox.readFile('greeting.txt')).resolves.toBe('hello there');
  });

  it('materializes nested files, honoring the readonly flag', async () => {
    const sandbox = await makeSandbox();
    await sandbox.materialize([
      { path: 'nested/dir/a.txt', content: new TextEncoder().encode('a') },
      {
        path: 'nested/dir/b.txt',
        content: new TextEncoder().encode('b'),
        readonly: true,
      },
    ]);
    await expect(sandbox.readFile('nested/dir/a.txt')).resolves.toBe('a');
    await expect(sandbox.readFile('nested/dir/b.txt')).resolves.toBe('b');
    // A readonly-materialized file cannot be overwritten.
    await expect(
      sandbox.writeFile('nested/dir/b.txt', 'changed'),
    ).rejects.toThrow();
  });

  it('editFile rejects zero occurrences', async () => {
    const sandbox = await makeSandbox();
    await sandbox.writeFile('f.txt', 'abc');
    await expect(sandbox.editFile('f.txt', 'xyz', 'q')).rejects.toThrow();
  });

  it('editFile rejects multiple occurrences', async () => {
    const sandbox = await makeSandbox();
    await sandbox.writeFile('f.txt', 'abcabc');
    await expect(sandbox.editFile('f.txt', 'abc', 'q')).rejects.toThrow();
  });

  it('editFile round-trips replacement text containing $$ and $& byte-exact', async () => {
    const sandbox = await makeSandbox();
    await sandbox.writeFile('script.sh', 'PLACEHOLDER');
    await sandbox.editFile('script.sh', 'PLACEHOLDER', 'echo $$ and $&');
    await expect(sandbox.readFile('script.sh')).resolves.toBe('echo $$ and $&');
  });

  it('rejects ../escape paths for read, write, and edit', async () => {
    const sandbox = await makeSandbox();
    await expect(sandbox.readFile('../escape.txt')).rejects.toThrow();
    await expect(sandbox.writeFile('../escape.txt', 'x')).rejects.toThrow();
    await sandbox.writeFile('f.txt', 'abc');
    await expect(sandbox.editFile('../f.txt', 'abc', 'q')).rejects.toThrow();
  });

  it('rejects absolute paths for read, write, and edit', async () => {
    const sandbox = await makeSandbox();
    await expect(sandbox.readFile('/etc/passwd')).rejects.toThrow();
    await expect(sandbox.writeFile('/tmp/evil.txt', 'x')).rejects.toThrow();
    await sandbox.writeFile('f.txt', 'abc');
    await expect(sandbox.editFile('/etc/passwd', 'abc', 'q')).rejects.toThrow();
  });

  it('rejects a symlink that escapes the workdir', async () => {
    const outsideRoot = await newRoot();
    const outsideFile = path.join(outsideRoot, 'secret.txt');
    await fs.writeFile(outsideFile, 'top secret');

    const sandbox = await makeSandbox();
    const linkPath = path.join(sandbox.workdir, 'escape-link');
    await fs.symlink(outsideFile, linkPath);

    await expect(sandbox.readFile('escape-link')).rejects.toThrow();
    await expect(
      sandbox.writeFile('escape-link', 'overwrite'),
    ).rejects.toThrow();
    await expect(
      sandbox.editFile('escape-link', 'top', 'not'),
    ).rejects.toThrow();

    // Confirm the outside file was never touched.
    await expect(fs.readFile(outsideFile, 'utf8')).resolves.toBe('top secret');
  });

  it('rejects a symlinked directory that escapes the workdir', async () => {
    const outsideRoot = await newRoot();
    await fs.mkdir(path.join(outsideRoot, 'outside-dir'));
    await fs.writeFile(
      path.join(outsideRoot, 'outside-dir', 'f.txt'),
      'outside',
    );

    const sandbox = await makeSandbox();
    await fs.symlink(
      path.join(outsideRoot, 'outside-dir'),
      path.join(sandbox.workdir, 'link-dir'),
    );

    await expect(sandbox.readFile('link-dir/f.txt')).rejects.toThrow();
    await expect(sandbox.writeFile('link-dir/new.txt', 'x')).rejects.toThrow();
  });

  it('rejects an oversized read', async () => {
    const sandbox = await makeSandbox();
    const big = Buffer.alloc(1024 * 1024 + 1, 'a');
    await fs.writeFile(path.join(sandbox.workdir, 'big.txt'), big);
    await expect(sandbox.readFile('big.txt')).rejects.toThrow();
  });

  it('runs bash in the workdir with only the explicitly constructed env', async () => {
    const sandbox = await makeSandbox();
    process.env.TEST_SECRET = 'x';
    try {
      const result = await sandbox.runBash(
        'pwd; echo "SECRET=[${TEST_SECRET:-}]"; echo "HOME=$HOME"; echo "LANG=$LANG"',
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(await fs.realpath(sandbox.workdir));
      expect(result.stdout).toContain('SECRET=[]');
      expect(result.stdout).toContain(`HOME=${sandbox.workdir}`);
      expect(result.stdout).toContain('LANG=C.UTF-8');
    } finally {
      delete process.env.TEST_SECRET;
    }
  });

  it('returns the command exit code', async () => {
    const sandbox = await makeSandbox();
    const result = await sandbox.runBash('exit 7');
    expect(result.exitCode).toBe(7);
  });

  it('returns exitCode 124 when the command times out', async () => {
    const sandbox = await makeSandbox();
    const result = await sandbox.runBash('sleep 5', { timeoutMs: 200 });
    expect(result.exitCode).toBe(124);
  }, 10_000);

  it('truncates stdout over 64 KiB with a marker', async () => {
    const sandbox = await makeSandbox();
    const result = await sandbox.runBash('yes a | head -c 200000', {
      timeoutMs: 10_000,
    });
    expect(result.stdout.endsWith('\n[truncated]')).toBe(true);
    expect(result.stdout.length).toBeLessThan(200000);
  }, 15_000);

  it('does not mark exactly-64-KiB stdout as truncated', async () => {
    const sandbox = await makeSandbox();
    const result = await sandbox.runBash(
      "head -c 65536 /dev/zero | tr '\\0' 'a'",
      { timeoutMs: 10_000 },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBe(65536);
    expect(result.stdout.endsWith('\n[truncated]')).toBe(false);
  }, 15_000);

  it('destroy removes the workdir tree', async () => {
    const sandbox = await makeSandbox();
    await sandbox.writeFile('f.txt', 'x');
    await sandbox.destroy();
    await expect(fs.stat(sandbox.workdir)).rejects.toThrow();
  });
});
