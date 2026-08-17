import { InMemoryDomainRepository } from '../persistence/in-memory.js';
import { isoTimestamp, persistenceId } from '@agentos/core';
import { describe, expect, it } from 'vitest';

import { createFeatureWorkflowTaskHandler } from './task-handler.js';

const now = isoTimestamp('2026-08-17T12:00:00.000Z');

describe('feature workflow task handler', () => {
  it('loads authoritative run input instead of trusting the Trigger payload', async () => {
    const repository = new InMemoryDomainRepository();
    await repository.createProject({
      id: persistenceId('project', 'project-1'),
      name: 'Passerine',
      createdAt: now,
      updatedAt: now,
    });
    await repository.createRun({
      id: persistenceId('run', 'run-1'),
      projectId: persistenceId('project', 'project-1'),
      pipeline: 'feature',
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      input: {
        idempotencyKey: 'secretless-key',
        title: 'Status',
        description: 'Add it.',
        provenance: {
          repositorySha: 'a'.repeat(40),
          configDigest: '1'.repeat(64),
          modelDigest: '2'.repeat(64),
          promptDigest: '3'.repeat(64),
          environmentDigest: '4'.repeat(64),
          policyDigest: '5'.repeat(64),
        },
      },
    });
    const seen: unknown[] = [];
    const handler = createFeatureWorkflowTaskHandler({
      repository,
      workflow: {
        run: async (input) => {
          seen.push(input);
          return { status: 'succeeded' };
        },
      },
      sourceSnapshot: { resolve: async () => '6'.repeat(64) },
    });
    await handler.run({ version: 'feature-task-payload-v1', runId: 'run-1' });
    expect(seen).toEqual([
      expect.objectContaining({
        runId: 'run-1',
        projectId: 'project-1',
        feature: { title: 'Status', description: 'Add it.' },
        source: {
          repositorySha: 'a'.repeat(40),
          sourceSnapshotDigest: '6'.repeat(64),
        },
      }),
    ]);
  });
});
