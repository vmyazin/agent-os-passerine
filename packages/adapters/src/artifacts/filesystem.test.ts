import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { artifactStoreContract } from './artifact-store-contract.js';
import { createFilesystemArtifactStorage } from './filesystem.js';
import { createInMemoryArtifactManifestStore } from './manifest.js';

const scope = { projectId: 'project-1', runId: 'run-1', stepId: 'step-1' };
const roots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agentos-artifacts-'));
  roots.push(root);
  return root;
}

function request(artifactId: string, content = artifactId) {
  const bytes = new TextEncoder().encode(content);
  return {
    scope,
    artifactId,
    version: 1,
    digest: createHash('sha256').update(bytes).digest('hex'),
    bytes,
    mediaType: 'text/plain; charset=utf-8',
    retentionClass: 'working' as const,
  };
}

async function entries(directory: string): Promise<readonly string[]> {
  const found = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  return found.filter((entry) => entry.isFile()).map((entry) => entry.name);
}

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

artifactStoreContract('filesystem', async () =>
  createFilesystemArtifactStorage({
    root: await createRoot(),
    now: () => new Date('2026-08-17T00:00:00.000Z'),
  }),
);

describe('filesystem artifact storage', () => {
  it('writes the body atomically and leaves no temporary file behind', async () => {
    const root = await createRoot();
    const { store } = createFilesystemArtifactStorage({ root });
    const artifact = await store.put(request('spec', 'hello'));

    const body = join(
      root,
      'artifacts',
      'v1',
      scope.projectId,
      scope.runId,
      scope.stepId,
      'spec',
      `1-${artifact.digest}`,
    );
    expect(new TextDecoder().decode(await readFile(body))).toBe('hello');
    expect(await entries(root)).toEqual([`1-${artifact.digest}`]);
  });

  it('creates the root lazily on the first write', async () => {
    const root = join(await createRoot(), 'nested', 'store');
    const { store } = createFilesystemArtifactStorage({ root });
    await expect(readdir(root)).rejects.toMatchObject({ code: 'ENOENT' });

    const artifact = await store.put(request('spec', 'hello'));
    expect(
      new TextDecoder().decode(
        (await store.get({ scope, key: artifact.key }))?.bytes,
      ),
    ).toBe('hello');
  });

  it('refuses a relative root', () => {
    expect(() =>
      createFilesystemArtifactStorage({ root: 'relative/artifacts' }),
    ).toThrow(/absolute/);
  });

  it('reports a body the manifest still knows as an integrity failure', async () => {
    const root = await createRoot();
    const { store } = createFilesystemArtifactStorage({ root });
    const artifact = await store.put(request('spec', 'hello'));
    await rm(join(root, 'artifacts'), { recursive: true, force: true });

    await expect(store.get({ scope, key: artifact.key })).rejects.toMatchObject(
      { code: 'artifact_integrity_error' },
    );
  });

  it('returns false when deleting a key the manifest never claimed', async () => {
    const { store, admin } = createFilesystemArtifactStorage({
      root: await createRoot(),
    });
    await store.put(request('spec', 'hello'));
    const ghost = `artifacts/v1/${scope.projectId}/${scope.runId}/${scope.stepId}/ghost/1/sha256/${'a'.repeat(64)}`;

    expect(await admin.delete(ghost)).toBe(false);
  });

  it('rejects a path-traversal-shaped scope id without touching the filesystem', async () => {
    const root = await createRoot();
    const { store } = createFilesystemArtifactStorage({ root });

    for (const traversal of [
      { ...scope, projectId: '..' },
      { ...scope, runId: '../../etc' },
      { ...scope, stepId: 'step/../../step-1' },
    ])
      await expect(
        store.put({ ...request('spec', 'hello'), scope: traversal }),
      ).rejects.toMatchObject({ code: 'invalid_artifact' });
    expect(await readdir(root)).toEqual([]);
  });

  it('serves bodies written by an earlier store instance over the same root', async () => {
    const root = await createRoot();
    const manifest = createInMemoryArtifactManifestStore();
    const first = createFilesystemArtifactStorage({ root, manifest });
    const artifact = await first.store.put(request('spec', 'durable'));

    const second = createFilesystemArtifactStorage({ root, manifest });
    const value = await second.store.get({ scope, key: artifact.key });

    expect(new TextDecoder().decode(value?.bytes)).toBe('durable');
    expect((await second.store.list({ scope })).items).toEqual([artifact]);
  });

  it('replays an identical put against a body already on disk', async () => {
    const root = await createRoot();
    const manifest = createInMemoryArtifactManifestStore();
    const first = createFilesystemArtifactStorage({ root, manifest });
    const artifact = await first.store.put(request('spec', 'durable'));

    const second = createFilesystemArtifactStorage({ root, manifest });
    expect(await second.store.put(request('spec', 'durable'))).toEqual(
      artifact,
    );
    expect(await entries(root)).toEqual([`1-${artifact.digest}`]);
  });
});
