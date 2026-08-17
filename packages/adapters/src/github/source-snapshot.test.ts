import { createInMemoryArtifactStorage } from '../artifacts/in-memory.js';
import { describe, expect, it, vi } from 'vitest';

import { createTrustedSourceSnapshotIngestorWithClientFactory } from './source-snapshot.js';
import type {
  GitTreeEntry,
  GitHubReadOnlyInstallationClient,
  GitHubReadOnlyClientFactory,
  ReadOnlyInstallationClientScope,
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
  } as GitHubReadOnlyInstallationClient;
  const scopes: ReadOnlyInstallationClientScope[] = [];
  const withClient: GitHubReadOnlyClientFactory['withClient'] = async (
    scope,
    operation,
  ) => {
    scopes.push(scope);
    return operation(client);
  };
  const factory: GitHubReadOnlyClientFactory = {
    withClient,
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
  return { artifacts, client, ingestor, scopes };
}

describe('trusted GitHub source snapshot ingestion', () => {
  it('writes one content-addressed SHA-bound source/bundle-v1 artifact', async () => {
    const { artifacts, ingestor, scopes } = fixture();
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
    expect(scopes[0]).toMatchObject({
      repositoryIds: [42],
      permissions: { contents: 'read' },
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

  it('rejects a source bundle one byte beyond the managed resource boundary', async () => {
    const { client, ingestor } = fixture();
    const bytes = new TextEncoder().encode('x'.repeat(1024 * 1024 + 1));
    vi.mocked(client.getBlob).mockResolvedValue({
      sha: sha('c'),
      size: bytes.byteLength,
      bytes,
    });
    await expect(ingestor.ensure('run-1')).rejects.toThrow(/size limit/);
  });

  it('rejects aggregate source content beyond one MiB', async () => {
    const entries = ['one.ts', 'two.ts'].map((path, index) => ({
      path,
      mode: '100644' as const,
      type: 'blob' as const,
      sha: sha(index === 0 ? 'c' : 'd'),
    }));
    const { client, ingestor } = fixture(entries);
    const bytes = new TextEncoder().encode('x'.repeat(600_000));
    vi.mocked(client.getBlob).mockImplementation(async (blobSha) => ({
      sha: blobSha,
      size: bytes.byteLength,
      bytes,
    }));
    await expect(ingestor.ensure('run-1')).rejects.toThrow('total size limit');
  });

  it('rejects more than the bounded source file count before reading blobs', async () => {
    const entries = Array.from({ length: 5_001 }, (_, index) => ({
      path: `src/${String(index)}.ts`,
      mode: '100644' as const,
      type: 'blob' as const,
      sha: sha('c'),
    }));
    const { client, ingestor } = fixture(entries);
    await expect(ingestor.ensure('run-1')).rejects.toThrow('file limit');
    expect(client.getBlob).not.toHaveBeenCalled();
  });
});
