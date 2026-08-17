import { isoTimestamp, persistenceId } from '@agentos/core';
import { describe, expect, it, vi } from 'vitest';

import { InMemoryDomainRepository } from '../persistence/in-memory.js';
import { createGoalWorkflowTaskHandler } from './goal-task-handler.js';

const now = isoTimestamp('2026-08-17T12:00:00.000Z');

async function fixture(snapshot = true) {
  const repository = new InMemoryDomainRepository();
  const projectId = persistenceId('project', 'goal-task-project');
  const runId = persistenceId('run', 'goal-task-run');
  const revisionId = persistenceId('configRevision', 'goal-task-revision');
  await repository.createProject({
    id: projectId,
    name: 'Goal task',
    createdAt: now,
    updatedAt: now,
  });
  await repository.createConfigRevision({
    id: revisionId,
    projectId,
    revision: 1,
    config: {},
    repositorySha: 'a'.repeat(40),
    configDigest: 'b'.repeat(64),
    modelDigest: 'c'.repeat(64),
    promptDigest: 'd'.repeat(64),
    environmentDigest: 'e'.repeat(64),
    policyDigest: 'f'.repeat(64),
    createdAt: now,
  });
  await repository.createRun({
    id: runId,
    projectId,
    configRevisionId: revisionId,
    pipeline: 'goal',
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  });
  if (snapshot)
    await repository.createConfigSnapshot({
      id: persistenceId('configSnapshot', 'goal-task-snapshot'),
      runId,
      configRevisionId: revisionId,
      config: {},
      repositorySha: 'a'.repeat(40),
      configDigest: 'b'.repeat(64),
      modelDigest: 'c'.repeat(64),
      promptDigest: 'd'.repeat(64),
      environmentDigest: 'e'.repeat(64),
      policyDigest: 'f'.repeat(64),
      createdAt: now,
    });
  await repository.createGoalCriterion({
    id: persistenceId('goalCriterion', 'goal-task-criterion'),
    runId,
    ordinal: 0,
    description: 'Tests pass',
    definition: {
      id: 'tests',
      type: 'command',
      description: 'Tests pass',
      command: 'pnpm test',
    },
    status: 'pending',
    createdAt: now,
  });
  return { repository, runId };
}

describe('goal workflow task handler', () => {
  it('loads the authoritative goal and delegates only after durable inputs exist', async () => {
    const seeded = await fixture();
    const run = vi.fn(async () => ({ status: 'succeeded' as const }));
    const handler = createGoalWorkflowTaskHandler({
      repository: seeded.repository,
      workflow: { run },
    });

    await handler.run({ version: 'goal-task-payload-v1', runId: seeded.runId });

    expect(run).toHaveBeenCalledWith({ runId: seeded.runId });
  });

  it('fails closed before delegation when the config snapshot is missing', async () => {
    const seeded = await fixture(false);
    const run = vi.fn();
    const handler = createGoalWorkflowTaskHandler({
      repository: seeded.repository,
      workflow: { run },
    });

    await expect(
      handler.run({ version: 'goal-task-payload-v1', runId: seeded.runId }),
    ).rejects.toThrow('exactly one config snapshot');
    expect(run).not.toHaveBeenCalled();
  });
});
