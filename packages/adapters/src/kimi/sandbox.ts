import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_READ_BYTES = 1024 * 1024; // 1 MiB
const MAX_OUTPUT_BYTES = 64 * 1024; // 64 KiB
const DEFAULT_TIMEOUT_MS = 120_000;
const TRUNCATED_MARKER = '\n[truncated]';

export interface KimiSandbox {
  readonly workdir: string;
  materialize(
    files: readonly {
      path: string;
      content: Uint8Array;
      readonly?: boolean;
    }[],
  ): Promise<void>;
  readFile(relativePath: string): Promise<string>; // ≤ 1 MiB, UTF-8
  writeFile(relativePath: string, content: string): Promise<void>;
  editFile(
    relativePath: string,
    oldText: string,
    newText: string,
  ): Promise<void>; // exactly-one-occurrence
  runBash(
    command: string,
    options?: { timeoutMs?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  destroy(): Promise<void>;
}

/**
 * Thrown for any sandbox confinement or validation failure: invalid session
 * ids, paths that escape the workdir (via `..`, an absolute path, or a
 * symlink), oversized reads, and edits that don't match exactly once.
 */
export class KimiSandboxError extends Error {
  override readonly name = 'KimiSandboxError';
}

export async function createKimiSandbox(options: {
  readonly root: string; // sandboxRoot
  readonly sessionId: string; // becomes the workdir name (validated [A-Za-z0-9_-]+)
}): Promise<KimiSandbox> {
  if (!SESSION_ID_PATTERN.test(options.sessionId)) {
    throw new KimiSandboxError(`invalid sessionId: ${options.sessionId}`);
  }
  const workdir = path.join(options.root, options.sessionId);
  await fs.mkdir(workdir, { recursive: true });
  const workdirReal = await fs.realpath(workdir);

  async function resolveInside(relativePath: string): Promise<string> {
    if (path.isAbsolute(relativePath)) {
      throw new KimiSandboxError(
        `absolute paths are not allowed: ${relativePath}`,
      );
    }
    const resolved = path.resolve(workdir, relativePath);
    if (resolved !== workdir && !resolved.startsWith(workdir + path.sep)) {
      throw new KimiSandboxError(`path escapes sandbox: ${relativePath}`);
    }
    const realAncestor = await deepestExistingRealpath(resolved);
    if (
      realAncestor !== workdirReal &&
      !realAncestor.startsWith(workdirReal + path.sep)
    ) {
      throw new KimiSandboxError(
        `path escapes sandbox via symlink: ${relativePath}`,
      );
    }
    return resolved;
  }

  const sandbox: KimiSandbox = {
    workdir,

    async materialize(files) {
      for (const file of files) {
        const resolved = await resolveInside(file.path);
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await fs.writeFile(resolved, file.content, { mode: 0o644 });
        if (file.readonly === true) {
          await fs.chmod(resolved, 0o444);
        }
      }
    },

    async readFile(relativePath) {
      const resolved = await resolveInside(relativePath);
      const stats = await fs.stat(resolved);
      if (stats.size > MAX_READ_BYTES) {
        throw new KimiSandboxError(
          `file exceeds ${MAX_READ_BYTES} byte read limit: ${relativePath}`,
        );
      }
      return fs.readFile(resolved, 'utf8');
    },

    async writeFile(relativePath, content) {
      const resolved = await resolveInside(relativePath);
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, content, 'utf8');
    },

    async editFile(relativePath, oldText, newText) {
      if (oldText.length === 0) {
        throw new KimiSandboxError('editFile oldText must not be empty');
      }
      const resolved = await resolveInside(relativePath);
      const current = await fs.readFile(resolved, 'utf8');
      const occurrences = countOccurrences(current, oldText);
      if (occurrences === 0) {
        throw new KimiSandboxError(
          `editFile found no occurrence of oldText in ${relativePath}`,
        );
      }
      if (occurrences > 1) {
        throw new KimiSandboxError(
          `editFile found ${occurrences} occurrences of oldText in ${relativePath}, expected exactly one`,
        );
      }
      await fs.writeFile(resolved, current.replace(oldText, newText), 'utf8');
    },

    async runBash(command, runOptions) {
      const timeoutMs = runOptions?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      return new Promise((resolve) => {
        execFile(
          '/bin/bash',
          ['-c', command],
          {
            cwd: workdir,
            timeout: timeoutMs,
            maxBuffer: MAX_OUTPUT_BYTES,
            env: {
              PATH: process.env.PATH ?? '',
              HOME: workdir,
              LANG: 'C.UTF-8',
            },
          },
          (error, stdout, stderr) => {
            resolve(
              Object.freeze({
                stdout: applyTruncationMarker(stdout),
                stderr: applyTruncationMarker(stderr),
                exitCode: resolveExitCode(error),
              }),
            );
          },
        );
      });
    },

    async destroy() {
      await fs.rm(workdir, { recursive: true, force: true });
    },
  };

  return Object.freeze(sandbox);
}

async function deepestExistingRealpath(target: string): Promise<string> {
  let current = target;
  for (;;) {
    try {
      return await fs.realpath(current);
    } catch (error) {
      if (!isEnoent(error)) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Object &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let fromIndex = 0;
  for (;;) {
    const index = haystack.indexOf(needle, fromIndex);
    if (index === -1) break;
    count += 1;
    fromIndex = index + needle.length;
  }
  return count;
}

function applyTruncationMarker(output: string): string {
  return Buffer.byteLength(output, 'utf8') >= MAX_OUTPUT_BYTES
    ? output + TRUNCATED_MARKER
    : output;
}

function resolveExitCode(error: Error | null): number {
  if (error === null) return 0;
  const err = error as NodeJS.ErrnoException & { killed?: boolean };
  if (err.killed === true) return 124; // timed out and was killed
  if (typeof err.code === 'number') return err.code;
  return 1; // e.g. maxBuffer overflow (ERR_CHILD_PROCESS_STDIO_MAXBUFFER)
}
