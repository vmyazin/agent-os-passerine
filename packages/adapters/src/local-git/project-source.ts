import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { basename } from 'node:path';

import {
  assertValidCommitPage,
  COMMIT_PAGE_SIZE,
  isoTimestamp,
  localProjectSourceKey,
  type CommitPage,
  type LocalProjectSource,
  type ProjectSourceImportInput,
  type ProjectSourceInspection,
} from '@agentos/core';

const MAX_GIT_OUTPUT_BYTES = 256 * 1024;
const MAX_CURSOR_OFFSET = 10_000;
const GIT_TIMEOUT_MS = 5_000;

export class LocalProjectSourceError extends Error {
  override readonly name = 'LocalProjectSourceError';
  public constructor(
    public readonly code:
      | 'invalid_path'
      | 'not_a_repository'
      | 'not_top_level'
      | 'unavailable_branch'
      | 'invalid_cursor'
      | 'provider_unavailable',
    message: string,
  ) {
    super(message);
  }
}

async function gitRead(
  repository: string,
  args: readonly string[],
): Promise<string> {
  if (
    args.some(
      (argument) =>
        argument.length > 4096 ||
        argument.includes('\0') ||
        argument.includes('\n'),
    )
  )
    throw new LocalProjectSourceError(
      'provider_unavailable',
      'Git arguments failed validation',
    );
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn(
      'git',
      ['-c', 'core.quotepath=false', '-C', repository, ...args],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: '0',
          GIT_TERMINAL_PROMPT: '0',
        },
      },
    );
    const stdout: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (error?: LocalProjectSourceError, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error !== undefined) rejectPromise(error);
      else resolvePromise(value ?? '');
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(
        new LocalProjectSourceError(
          'provider_unavailable',
          'Git operation timed out',
        ),
      );
    }, GIT_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_GIT_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(
          new LocalProjectSourceError(
            'provider_unavailable',
            'Git returned too much data',
          ),
        );
        return;
      }
      stdout.push(chunk);
    });
    child.on('error', () =>
      finish(
        new LocalProjectSourceError(
          'provider_unavailable',
          'Git is unavailable',
        ),
      ),
    );
    child.on('close', (code) => {
      if (code !== 0) {
        finish(
          new LocalProjectSourceError(
            'provider_unavailable',
            'Git could not read the repository',
          ),
        );
        return;
      }
      finish(undefined, Buffer.concat(stdout).toString('utf8').trimEnd());
    });
  });
}

function safeBranchCandidate(branch: string): void {
  if (
    branch.length === 0 ||
    branch.length > 255 ||
    branch.startsWith('-') ||
    /[\0\n\r]/.test(branch)
  )
    throw new LocalProjectSourceError(
      'unavailable_branch',
      'The selected branch is unavailable',
    );
}

async function exactBranchRef(
  repository: string,
  branch: string,
): Promise<{ branch: string; ref: string; headSha: string }> {
  safeBranchCandidate(branch);
  try {
    await gitRead(repository, ['check-ref-format', '--branch', branch]);
  } catch {
    throw new LocalProjectSourceError(
      'unavailable_branch',
      'The selected branch is unavailable',
    );
  }
  for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
    try {
      const headSha = await gitRead(repository, [
        'rev-parse',
        '--verify',
        `${ref}^{commit}`,
      ]);
      if (/^[0-9a-f]{40}$/.test(headSha)) return { branch, ref, headSha };
    } catch {
      // Try the explicit remote-tracking ref before reporting the safe error.
    }
  }
  throw new LocalProjectSourceError(
    'unavailable_branch',
    'The selected branch is unavailable',
  );
}

async function detectedBranch(repository: string): Promise<string> {
  try {
    return await gitRead(repository, [
      'symbolic-ref',
      '--quiet',
      '--short',
      'HEAD',
    ]);
  } catch {
    try {
      const remote = await gitRead(repository, [
        'symbolic-ref',
        '--quiet',
        '--short',
        'refs/remotes/origin/HEAD',
      ]);
      return remote.startsWith('origin/')
        ? remote.slice('origin/'.length)
        : remote;
    } catch {
      throw new LocalProjectSourceError(
        'unavailable_branch',
        'No current branch or origin default branch is available',
      );
    }
  }
}

export async function inspectLocalProjectSource(
  input:
    | Extract<ProjectSourceImportInput, { kind: 'local' }>
    | {
        readonly localPath: string;
        readonly defaultBranch?: string;
      },
): Promise<ProjectSourceInspection> {
  if (!input.localPath.startsWith('/') || input.localPath.includes('\0'))
    throw new LocalProjectSourceError(
      'invalid_path',
      'Enter an absolute local path',
    );
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(input.localPath);
    if (!(await stat(canonicalPath)).isDirectory())
      throw new Error('not a directory');
  } catch {
    throw new LocalProjectSourceError(
      'invalid_path',
      'The local path does not exist',
    );
  }

  let topLevel: string;
  try {
    const bare = await gitRead(canonicalPath, [
      'rev-parse',
      '--is-bare-repository',
    ]);
    if (bare !== 'false') throw new Error('bare repository');
    topLevel = await realpath(
      await gitRead(canonicalPath, ['rev-parse', '--show-toplevel']),
    );
  } catch {
    throw new LocalProjectSourceError(
      'not_a_repository',
      'Choose a non-bare Git working tree',
    );
  }
  if (topLevel !== canonicalPath)
    throw new LocalProjectSourceError(
      'not_top_level',
      'Choose the exact top-level directory of the Git working tree',
    );

  const selectedBranch =
    input.defaultBranch ?? (await detectedBranch(canonicalPath));
  const branch = await exactBranchRef(canonicalPath, selectedBranch);
  return {
    kind: 'local',
    sourceKey: localProjectSourceKey(canonicalPath),
    canonicalLocation: canonicalPath,
    suggestedName: basename(canonicalPath),
    defaultBranch: branch.branch,
    headSha: branch.headSha,
  };
}

function cursorOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (cursor.length > 2_048)
    throw new LocalProjectSourceError(
      'invalid_cursor',
      'The commit cursor is invalid',
    );
  try {
    const decoded = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as {
      readonly version?: unknown;
      readonly offset?: unknown;
    };
    if (
      decoded.version !== 1 ||
      !Number.isSafeInteger(decoded.offset) ||
      typeof decoded.offset !== 'number' ||
      decoded.offset < 0 ||
      decoded.offset > MAX_CURSOR_OFFSET ||
      decoded.offset % COMMIT_PAGE_SIZE !== 0
    )
      throw new Error('invalid cursor');
    return decoded.offset;
  } catch {
    throw new LocalProjectSourceError(
      'invalid_cursor',
      'The commit cursor is invalid',
    );
  }
}

function boundedCommitText(
  value: string,
  maximum: number,
  fallback = '',
): string {
  const clean = [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : character;
    })
    .join('')
    .trim();
  return (clean || fallback).slice(0, maximum);
}

export async function listLocalProjectCommits(
  source: LocalProjectSource,
  cursor?: string,
): Promise<CommitPage> {
  const offset = cursorOffset(cursor);
  const branch = await exactBranchRef(source.localPath, source.defaultBranch);
  const output = await gitRead(source.localPath, [
    'log',
    '--no-show-signature',
    `--max-count=${String(COMMIT_PAGE_SIZE + 1)}`,
    `--skip=${String(offset)}`,
    '--format=%H%x00%s%x00%an%x00%cI',
    '-z',
    branch.ref,
    '--',
  ]);
  const fields = output === '' ? [] : output.split('\0');
  while (fields.at(-1) === '') fields.pop();
  if (fields.length % 4 !== 0)
    throw new LocalProjectSourceError(
      'provider_unavailable',
      'Git returned malformed commit data',
    );
  const commits = [];
  for (let index = 0; index < fields.length; index += 4) {
    commits.push({
      sha: fields[index] ?? '',
      subject: boundedCommitText(fields[index + 1] ?? '', 500),
      authorName: boundedCommitText(
        fields[index + 2] ?? '',
        200,
        'Unknown author',
      ),
      committedAt: isoTimestamp(fields[index + 3] ?? ''),
    });
  }
  const hasMore = commits.length > COMMIT_PAGE_SIZE;
  const page: CommitPage = {
    items: commits.slice(0, COMMIT_PAGE_SIZE),
    ...(hasMore
      ? {
          nextCursor: Buffer.from(
            JSON.stringify({ version: 1, offset: offset + COMMIT_PAGE_SIZE }),
          ).toString('base64url'),
        }
      : {}),
  };
  assertValidCommitPage(page);
  return page;
}
