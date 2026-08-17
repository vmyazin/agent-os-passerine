import { describe, expect, it } from 'vitest';

import { isoTimestamp, persistenceId, prepareArtifactPut } from '@agentos/core';

import { InMemoryDomainRepository } from '../persistence/in-memory.js';
import { createInMemoryArtifactStorage } from './in-memory.js';
import {
  cleanupExpiredArtifacts,
  createDomainArtifactManifestStore,
} from './manifest.js';

const created = new Date('2026-08-17T00:00:00.000Z');
const scope = { projectId: 'project-1', runId: 'run-1', stepId: 'step-1' };

async function fixture() {
  const repository = new InMemoryDomainRepository();
  await repository.createProject({
    id: persistenceId('project', scope.projectId),
    name: 'artifact project',
    createdAt: isoTimestamp(created.toISOString()),
    updatedAt: isoTimestamp(created.toISOString()),
  });
  await repository.createRun({
    id: persistenceId('run', scope.runId),
    projectId: persistenceId('project', scope.projectId),
    pipeline: 'artifact-test',
    status: 'running',
    createdAt: isoTimestamp(created.toISOString()),
    updatedAt: isoTimestamp(created.toISOString()),
  });
  const manifest = createDomainArtifactManifestStore(repository);
  return { repository, manifest };
}

describe('authoritative artifact manifest', () => {
  it('atomically binds one logical version and reconstructs it by run', async () => {
    const { manifest } = await fixture();
    const left = prepareArtifactPut(
      {
        scope,
        artifactId: 'spec',
        version: 1,
        bytes: new TextEncoder().encode('left'),
        mediaType: 'text/plain',
      },
      created,
    );
    const right = prepareArtifactPut(
      {
        scope,
        artifactId: 'spec',
        version: 1,
        bytes: new TextEncoder().encode('right'),
        mediaType: 'text/plain',
      },
      created,
    );
    const settled = await Promise.allSettled([
      manifest.claim(left),
      manifest.claim(right),
    ]);
    expect(
      settled.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      settled.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    const page = await manifest.list({ scope, limit: 10 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.digest).toBe(
      settled.find((result) => result.status === 'fulfilled')?.value.digest,
    );
  });

  it('enforces retention with separate admin deletion and durable audit metadata', async () => {
    const { repository, manifest } = await fixture();
    const storage = createInMemoryArtifactStorage({
      manifest,
      now: () => created,
    });
    const metadata = await storage.store.put({
      scope,
      artifactId: 'source',
      version: 1,
      bytes: new TextEncoder().encode('bundle'),
      mediaType: 'text/plain',
      retentionClass: 'source-bundle',
    });
    const result = await cleanupExpiredArtifacts({
      manifest,
      admin: storage.admin,
      now: new Date('2026-08-18T00:00:00.001Z'),
    });
    expect(result).toEqual({ inspected: 1, deleted: 1 });
    expect(
      await storage.store.get({ scope, key: metadata.key }),
    ).toBeUndefined();
    const record = await repository.getArtifactByRunKey(
      persistenceId('run', scope.runId),
      'artifact-manifest/v1/step-1/source/1',
    );
    expect(record).toMatchObject({ deletionReason: 'retention_expired' });
  });
});
