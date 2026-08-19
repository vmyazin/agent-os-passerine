import { basename } from 'node:path';

import {
  canonicalJsonValue,
  type ArtifactMetadata,
  type ArtifactStore,
} from '@agentos/core';

import {
  MAX_SOURCE_BUNDLE_BYTES,
  type TrustedSourceSnapshotIngestor,
} from '../github/source-snapshot.js';
import { assertContainedRepository, runGit, LocalGitError } from './git.js';

export interface LocalSourceSnapshotBinding {
  readonly projectId: string;
  readonly runId: string;
  readonly localPath: string;
  readonly baseBranch: string;
  readonly repositorySha: string;
}

export interface LocalSourceSnapshotIngestorOptions {
  readonly artifacts: ArtifactStore;
  readonly workspacesRoot: string;
  readonly resolveBinding: (
    runId: string,
  ) => Promise<LocalSourceSnapshotBinding>;
}

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const MAX_FILES = 5_000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;

/**
 * Path safety rules replicated verbatim from the `safePath` helper in
 * packages/adapters/src/github/source-snapshot.ts:43-60 (not exported
 * there, so duplicated here rather than reaching across adapter
 * boundaries). Keep these two copies in sync if either changes.
 */
function safePath(path: string): void {
  const segments = path.split('/');
  if (
    path.length === 0 ||
    path.length > 1_024 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    segments.some(
      (segment) => segment.length === 0 || segment === '.' || segment === '..',
    )
  )
    throw new Error('source snapshot contains an unsafe path');
  if (path === '.gitmodules')
    throw new Error(
      'source snapshot contains unsupported submodule configuration',
    );
}

interface RawTreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly sha: string;
  readonly path: string;
}

/** Parses one `git ls-tree -z` line: `<mode> <type> <sha>\t<path>`. */
function parseTreeEntry(line: string): RawTreeEntry {
  const tabIndex = line.indexOf('\t');
  if (tabIndex === -1)
    throw new Error('source snapshot tree entry is malformed');
  const header = line.slice(0, tabIndex).split(' ');
  const [mode, type, sha] = header;
  if (mode === undefined || type === undefined || sha === undefined)
    throw new Error('source snapshot tree entry is malformed');
  return { mode, type, sha, path: line.slice(tabIndex + 1) };
}

/**
 * Ingests a source snapshot from a local, containment-checked git
 * repository, mirroring the bundle shape produced by
 * `createTrustedSourceSnapshotIngestor` (packages/adapters/src/github/
 * source-snapshot.ts) but reading plumbing directly via `runGit` instead of
 * the GitHub API.
 */
export function createLocalSourceSnapshotIngestor(
  options: LocalSourceSnapshotIngestorOptions,
): TrustedSourceSnapshotIngestor {
  return Object.freeze({
    async ensure(runId: string): Promise<ArtifactMetadata> {
      const binding = await options.resolveBinding(runId);
      if (binding.runId !== runId)
        throw new Error('source snapshot binding run mismatch');
      if (!SHA_PATTERN.test(binding.repositorySha))
        throw new Error('source snapshot binding SHA is malformed');

      const repo = await assertContainedRepository(
        binding.localPath,
        options.workspacesRoot,
      );

      // `cat-file -t` is the primary existence/type check: it is the call
      // that actually looks the object up in the object database. A
      // syntactically valid but nonexistent 40-hex SHA makes git exit
      // non-zero here, which `runGit` surfaces as a `LocalGitError` --
      // normalize that into a clear, specific message.
      let objectType: string;
      try {
        objectType = await runGit(repo, [
          'cat-file',
          '-t',
          binding.repositorySha,
        ]);
      } catch (error) {
        if (error instanceof LocalGitError)
          throw new Error(
            'source snapshot pinned SHA not found in repository',
          );
        throw error;
      }
      if (objectType !== 'commit')
        throw new Error('source snapshot pinned SHA is not a commit');

      // `git rev-parse <full-sha>` does not itself verify the object
      // exists -- it just normalizes/echoes a well-formed revision
      // expression -- so this is a secondary self-consistency check, not
      // an existence check (that's what `cat-file -t` above is for).
      const resolvedSha = await runGit(repo, [
        'rev-parse',
        binding.repositorySha,
      ]);
      if (resolvedSha !== binding.repositorySha)
        throw new Error(
          'source snapshot pinned SHA does not resolve to itself',
        );

      const treeSha = await runGit(repo, [
        'rev-parse',
        `${binding.repositorySha}^{tree}`,
      ]);
      if (!SHA_PATTERN.test(treeSha))
        throw new Error('source snapshot could not resolve a tree SHA');

      const raw = await runGit(repo, ['ls-tree', '-r', '-z', treeSha]);
      const lines = raw.split('\0').filter((line) => line !== '');
      if (lines.length > MAX_FILES * 2)
        throw new Error('source snapshot tree exceeds entry limit');

      const entries = lines.map(parseTreeEntry);
      for (const entry of entries) {
        safePath(entry.path);
        if (
          entry.type !== 'blob' ||
          (entry.mode !== '100644' && entry.mode !== '100755')
        )
          throw new Error(
            'source snapshot contains a symlink, submodule, or unsupported tree entry',
          );
      }
      if (entries.length > MAX_FILES)
        throw new Error('source snapshot exceeds file limit');

      const seen = new Set<string>();
      let totalBytes = 0;
      const files: Array<{
        path: string;
        mode: '100644' | '100755';
        content: string;
      }> = [];
      for (const entry of [...entries].sort((left, right) =>
        left.path.localeCompare(right.path),
      )) {
        if (seen.has(entry.path))
          throw new Error('source snapshot contains duplicate paths');
        seen.add(entry.path);
        // `raw: true` disables runGit's default trimEnd(), so this
        // content is byte-exact (matching the GitHub ingestor's
        // exact-byte blob reads) -- required because the materialize
        // script later writes this content verbatim into the
        // verification sandbox.
        const content = await runGit(repo, ['cat-file', 'blob', entry.sha], {
          raw: true,
        });
        if (content.includes('\0'))
          throw new Error('source snapshot contains a binary file');
        const size = new TextEncoder().encode(content).byteLength;
        if (size > MAX_FILE_BYTES)
          throw new Error('source snapshot file exceeds size limit');
        totalBytes += size;
        if (totalBytes > MAX_TOTAL_BYTES)
          throw new Error('source snapshot exceeds total size limit');
        files.push({
          path: entry.path,
          mode: entry.mode as '100644' | '100755',
          content,
        });
      }

      const body = {
        version: 'source-bundle-v1' as const,
        repository: {
          kind: 'local' as const,
          owner: 'local' as const,
          name: basename(repo),
        },
        baseBranch: binding.baseBranch,
        repositorySha: binding.repositorySha,
        treeSha,
        files,
      };
      const bytes = new TextEncoder().encode(canonicalJsonValue(body));
      if (bytes.byteLength > MAX_SOURCE_BUNDLE_BYTES)
        throw new Error(
          'source snapshot bundle exceeds managed resource size limit',
        );
      return options.artifacts.put({
        scope: {
          projectId: binding.projectId,
          runId: binding.runId,
          stepId: 'source',
        },
        artifactId: 'bundle',
        version: 1,
        bytes,
        mediaType: 'application/json',
        retentionClass: 'source-bundle',
      });
    },
  });
}
