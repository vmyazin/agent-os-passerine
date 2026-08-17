import { createInMemoryArtifactStorage } from '../artifacts/in-memory.js';
import { describe, expect, it, vi } from 'vitest';

import { createTrustedSourceSnapshotIngestorWithClientFactory } from './source-snapshot.js';
import type {
  GitTreeEntry,
  GitHubInstallationClient,
  GitHubInstallationClientFactory,
} from './types.js';

const sha = (character: string) => character.repeat(40);

function fixture(
  entries: GitTreeEntry[] = [
    {
      path: 'src/index.ts',
      mode: '100644' as const,
      type: 'blob' as const,
      sha: sha('c'),
    },
  ],
) {
  const artifacts = createInMemoryArtifactStorage().store;
  const client = {
    getRepository: vi.fn(async () => ({
      id: 42,
      fullName: 'team/repo',
      defaultBranch: 'main',
    })),
    getReference: vi.fn(async () => ({ sha: sha('a') })),
    getCommit: vi.fn(async () => ({
      sha: sha('a'),
      treeSha: sha('b'),
      parents: [],
      message: 'base',
    })),
    getTree: vi.fn(async () => ({ sha: sha('b'), truncated: false, entries })),
    getBlob: vi.fn(async (blobSha: string) => {
      const bytes = new TextEncoder().encode('export const ok = true;\n');
      return { sha: blobSha, size: bytes.byteLength, bytes };
    }),
  } as unknown as GitHubInstallationClient;
  const factory: GitHubInstallationClientFactory = {
    withClient: async (_scope, operation) => operation(client),
  };
  const ingestor = createTrustedSourceSnapshotIngestorWithClientFactory(
    {
      githubApp: { appId: 1, privateKey: 'unused-in-injected-test' },
      artifacts,
      resolveBinding: async (runId) => ({
        projectId: 'project-1',
        runId,
        repositorySha: sha('a'),
        baseBranch: 'main',
        repository: {
          owner: 'team',
          name: 'repo',
          installationId: 7,
          repositoryId: 42,
        },
      }),
    },
    factory,
  );
  return { artifacts, client, ingestor };
}

describe('trusted GitHub source snapshot ingestion', () => {
  it('writes one content-addressed SHA-bound source/bundle-v1 artifact', async () => {
    const { artifacts, ingestor } = fixture();
    const first = await ingestor.ensure('run-1');
    const second = await ingestor.ensure('run-1');
    expect(second).toEqual(first);
    const value = await artifacts.get({
      scope: { projectId: 'project-1', runId: 'run-1', stepId: 'source' },
      key: first.key,
    });
    expect(JSON.parse(new TextDecoder().decode(value!.bytes))).toMatchObject({
      version: 'source-bundle-v1',
      repositorySha: sha('a'),
      treeSha: sha('b'),
      files: [{ path: 'src/index.ts', mode: '100644' }],
    });
  });

  it.each([
    {
      path: '../escape',
      mode: '100644' as const,
      type: 'blob' as const,
      sha: sha('c'),
    },
    {
      path: 'linked',
      mode: '120000' as const,
      type: 'blob' as const,
      sha: sha('c'),
    },
    {
      path: 'vendor',
      mode: '160000' as const,
      type: 'commit' as const,
      sha: sha('c'),
    },
  ])('rejects unsafe tree entry $path before reading blobs', async (entry) => {
    const { client, ingestor } = fixture([entry]);
    await expect(ingestor.ensure('run-1')).rejects.toThrow(
      /unsafe|symlink|submodule/,
    );
    expect(client.getBlob).not.toHaveBeenCalled();
  });

  it('rejects a stale branch before reading the tree', async () => {
    const { client, ingestor } = fixture();
    vi.mocked(client.getReference).mockResolvedValue({ sha: sha('f') });
    await expect(ingestor.ensure('run-1')).rejects.toThrow('stale');
    expect(client.getTree).not.toHaveBeenCalled();
  });
});
