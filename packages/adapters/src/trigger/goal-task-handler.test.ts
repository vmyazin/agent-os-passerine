import { createHash } from 'node:crypto';

import {
  canonicalConfigHash,
  canonicalJsonValue,
  canonicalPublicationPolicyDigest,
  isoTimestamp,
  loadAgentOsConfig,
  normalizePublicationPolicySnapshot,
  persistenceId,
  type JsonValue,
} from '@agentos/core';
import { describe, expect, it, vi } from 'vitest';

import { InMemoryDomainRepository } from '../persistence/in-memory.js';
import { createGoalWorkflowTaskHandler } from './goal-task-handler.js';

const now = isoTimestamp('2026-08-17T12:00:00.000Z');

function asJson(value: unknown): JsonValue {
  return JSON.parse(canonicalJsonValue(value)) as JsonValue;
}

function configuredGoal() {
  const config = loadAgentOsConfig(`
version: 1
project: { name: Goal Task Test }
models: { standard: { provider: local, model: test } }
agents: { implementer: { model: standard } }
environments: { default: { runtime: process } }
pipelines: { feature: { steps: [{ id: implement, agent: implementer }] } }
policies: {}
budgets: { workflowMicrodollars: 1, dailyMicrodollars: 2, concurrency: 1 }
goals: { maxSteps: 3, maxRetries: 1, timeoutMs: 1000 }
runtime: { provider: local }
`);
  const hash = (value: unknown) =>
    createHash('sha256').update(canonicalJsonValue(value)).digest('hex');
  return {
    config,
    provenance: {
      repositorySha: 'a'.repeat(40),
      configDigest: canonicalConfigHash(config),
      modelDigest: hash(config.models),
      promptDigest: hash(
        Object.fromEntries(
          Object.entries(config.agents).map(([name, agent]) => [
            name,
            agent.prompt ?? '',
          ]),
        ),
      ),
      environmentDigest: hash(config.environments),
      policyDigest: canonicalPublicationPolicyDigest(
        normalizePublicationPolicySnapshot({
          version: 'publication-policy-v1',
          protectedPaths: config.policies.protectedPaths,
          maxFiles: 100,
          maxFileBytes: config.policies.maxFileBytes,
          maxTotalBytes: 5_000_000,
          allowBinary: config.policies.allowBinary,
          allowSymlinks: config.policies.allowSymlinks,
          allowDeletes: true,
          allowedModes: ['100644', '100755'],
        }),
      ),
    },
  };
}

async function fixture(
  options: {
    readonly snapshot?: boolean;
    readonly malformedInput?: boolean;
    readonly mismatchedSnapshot?: boolean;
  } = {},
) {
  const repository = new InMemoryDomainRepository();
  const projectId = persistenceId('project', 'goal-task-project');
  const runId = persistenceId('run', 'goal-task-run');
  const revisionId = persistenceId('configRevision', 'goal-task-revision');
  const configured = configuredGoal();
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
    config: asJson(configured.config),
    ...configured.provenance,
    createdAt: now,
  });
  await repository.createRun({
    id: runId,
    projectId,
    configRevisionId: revisionId,
    pipeline: 'goal',
    status: 'pending',
    ...(options.malformedInput
      ? {}
      : {
          input: asJson({
            idempotencyKey: 'goal-task-test',
            title: 'Finish the task',
            description: 'Validate durable state before delegation.',
            provenance: configured.provenance,
            criteria: [
              {
                id: 'tests',
                type: 'command',
                description: 'Tests pass',
                required: true,
                command: 'pnpm test',
              },
            ],
          }),
        }),
    createdAt: now,
    updatedAt: now,
  });
  if (options.snapshot !== false)
    await repository.createConfigSnapshot({
      id: persistenceId('configSnapshot', 'goal-task-snapshot'),
      runId,
      configRevisionId: revisionId,
      config: asJson(configured.config),
      ...configured.provenance,
      ...(options.mismatchedSnapshot ? { repositorySha: '0'.repeat(40) } : {}),
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
      required: true,
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
    const seeded = await fixture({ snapshot: false });
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

  it('fails closed before delegation when the authoritative goal input is malformed', async () => {
    const seeded = await fixture({ malformedInput: true });
    const run = vi.fn();
    const handler = createGoalWorkflowTaskHandler({
      repository: seeded.repository,
      workflow: { run },
    });

    await expect(
      handler.run({ version: 'goal-task-payload-v1', runId: seeded.runId }),
    ).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it('fails closed before delegation when snapshot provenance is mismatched', async () => {
    const seeded = await fixture({ mismatchedSnapshot: true });
    const run = vi.fn();
    const handler = createGoalWorkflowTaskHandler({
      repository: seeded.repository,
      workflow: { run },
    });

    await expect(
      handler.run({ version: 'goal-task-payload-v1', runId: seeded.runId }),
    ).rejects.toThrow('provenance');
    expect(run).not.toHaveBeenCalled();
  });
});
