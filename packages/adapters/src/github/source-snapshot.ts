import {
  canonicalJsonValue,
  type ArtifactMetadata,
  type ArtifactStore,
} from '@agentos/core';

import { createGitHubReadOnlyClientFactory } from './github-app.js';
import type {
  GitHubReadOnlyClientFactory,
  ReadOnlyInstallationClientScope,
} from './types.js';

export const MAX_SOURCE_FILES = 5_000;
export const MAX_SOURCE_FILE_BYTES = 1024 * 1024;
export const MAX_SOURCE_TOTAL_BYTES = 16 * 1024 * 1024;
export const MAX_SOURCE_BUNDLE_BYTES = 24 * 1024 * 1024;

export interface TrustedSourceSnapshotBinding {
  readonly projectId: string;
  readonly runId: string;
  readonly repositorySha: string;
  readonly baseBranch: string;
  readonly repository: {
    readonly owner: string;
    readonly name: string;
    readonly installationId: number;
    readonly repositoryId: number;
  };
}

export interface TrustedSourceSnapshotIngestor {
  ensure(runId: string): Promise<ArtifactMetadata>;
}

export interface TrustedSourceSnapshotIngestorOptions {
  readonly githubApp: { readonly appId: number; readonly privateKey: string };
  readonly artifacts: ArtifactStore;
  readonly resolveBinding: (
    runId: string,
  ) => Promise<TrustedSourceSnapshotBinding>;
}

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

/** Trusted GitHub-App ingestion. Installation tokens never leave this adapter. */
export function createTrustedSourceSnapshotIngestor(
  options: TrustedSourceSnapshotIngestorOptions,
): TrustedSourceSnapshotIngestor {
  return createTrustedSourceSnapshotIngestorWithClientFactory(
    options,
    createGitHubReadOnlyClientFactory(options.githubApp),
  );
}

export function createTrustedSourceSnapshotIngestorWithClientFactory(
  options: TrustedSourceSnapshotIngestorOptions,
  github: GitHubReadOnlyClientFactory,
): TrustedSourceSnapshotIngestor {
  return Object.freeze({
    async ensure(runId: string): Promise<ArtifactMetadata> {
      const binding = await options.resolveBinding(runId);
      if (binding.runId !== runId)
        throw new Error('source snapshot binding run mismatch');
      const scope: ReadOnlyInstallationClientScope = {
        ...binding.repository,
        repositoryIds: [binding.repository.repositoryId],
        permissions: { contents: 'read' },
      };
      return github.withClient(scope, async (client) => {
        const repository = await client.getRepository();
        if (
          repository.id !== binding.repository.repositoryId ||
          repository.fullName !==
            `${binding.repository.owner}/${binding.repository.name}`
        )
          throw new Error('source snapshot repository binding mismatch');
        const reference = await client.getReference(binding.baseBranch);
        if (reference?.sha !== binding.repositorySha)
          throw new Error('source snapshot base SHA is stale');
        const commit = await client.getCommit(binding.repositorySha);
        if (commit.sha !== binding.repositorySha)
          throw new Error('source snapshot commit binding mismatch');
        const tree = await client.getTree(commit.treeSha);
        if (tree.truncated)
          throw new Error('source snapshot tree is truncated');
        if (tree.entries.length > MAX_SOURCE_FILES * 2)
          throw new Error('source snapshot tree exceeds entry limit');

        const blobEntries = tree.entries.filter((entry) => {
          safePath(entry.path);
          if (
            entry.mode === '120000' ||
            entry.mode === '160000' ||
            entry.type === 'commit'
          )
            throw new Error('source snapshot contains a symlink or submodule');
          if (entry.type === 'tree') return false;
          if (
            entry.type !== 'blob' ||
            (entry.mode !== '100644' && entry.mode !== '100755')
          )
            throw new Error(
              'source snapshot contains an unsupported tree entry',
            );
          return true;
        });
        if (blobEntries.length > MAX_SOURCE_FILES)
          throw new Error('source snapshot exceeds file limit');
        const seen = new Set<string>();
        let totalBytes = 0;
        const files: Array<{
          path: string;
          mode: '100644' | '100755';
          content: string;
        }> = [];
        for (const entry of [...blobEntries].sort((left, right) =>
          left.path.localeCompare(right.path),
        )) {
          if (seen.has(entry.path))
            throw new Error('source snapshot contains duplicate paths');
          seen.add(entry.path);
          const blob = await client.getBlob(entry.sha);
          if (blob.size > MAX_SOURCE_FILE_BYTES)
            throw new Error('source snapshot file exceeds size limit');
          totalBytes += blob.size;
          if (totalBytes > MAX_SOURCE_TOTAL_BYTES)
            throw new Error('source snapshot exceeds total size limit');
          let content: string;
          try {
            content = new TextDecoder('utf-8', { fatal: true }).decode(
              blob.bytes,
            );
          } catch {
            throw new Error('source snapshot contains a binary file');
          }
          if (content.includes('\0'))
            throw new Error('source snapshot contains a binary file');
          files.push({
            path: entry.path,
            mode: entry.mode as '100644' | '100755',
            content,
          });
        }
        const body = {
          version: 'source-bundle-v1' as const,
          repository: {
            owner: binding.repository.owner,
            name: binding.repository.name,
            repositoryId: binding.repository.repositoryId,
          },
          baseBranch: binding.baseBranch,
          repositorySha: binding.repositorySha,
          treeSha: tree.sha,
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
      });
    },
  });
}
