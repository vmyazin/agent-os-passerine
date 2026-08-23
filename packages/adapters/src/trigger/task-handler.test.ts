import { createHash } from 'node:crypto';

import { InMemoryDomainRepository } from '../persistence/in-memory.js';
import {
  canonicalConfigHash,
  canonicalJsonValue,
  canonicalPublicationPolicyDigest,
  DEFAULT_PROTECTED_PATHS,
  isoTimestamp,
  normalizePublicationPolicySnapshot,
  persistenceId,
} from '@agentos/core';
import { describe, expect, it } from 'vitest';

import { createFeatureWorkflowTaskHandler } from './task-handler.js';

const now = isoTimestamp('2026-08-17T12:00:00.000Z');

describe('feature workflow task handler', () => {
  const seed = async (chain?: {
    readonly baseRunId: string;
    readonly baseBranch: string;
    readonly baseCommitSha: string;
  }) => {
    const config = {
      version: 1 as const,
      project: { name: 'Passerine', defaultBranch: 'main' },
      models: {
        standard: {
          provider: 'anthropic',
          model: 'sonnet',
          inputMicrodollarsPerMillionTokens: 0,
          outputMicrodollarsPerMillionTokens: 0,
          runtimeMicrodollarsPerMinute: 0,
        },
      },
      agents: {
        specification: {
          model: 'standard',
          environment: 'spec',
          tools: [],
          mcps: [],
          retries: 0,
          timeoutMs: 1_200_000,
        },
      },
      environments: {
        spec: { runtime: 'managed', variables: {}, tools: [], mcps: [] },
      },
      pipelines: {
        feature: {
          steps: [
            {
              id: 'specification',
              agent: 'specification',
              environment: 'spec',
              dependsOn: [],
            },
          ],
        },
      },
      policies: {
        protectedPaths: [...DEFAULT_PROTECTED_PATHS],
        allowBinary: false,
        allowSymlinks: false,
        maxFileBytes: 1_000_000,
        tools: { allow: [], deny: [] },
        mcp: { allow: [], deny: [] },
      },
      budgets: {
        workflowMicrodollars: 2_000_000,
        dailyMicrodollars: 5_000_000,
        concurrency: 1,
        admissionReservePercent: 80,
      },
      goals: { maxSteps: 3, maxRetries: 1, timeoutMs: 3_600_000 },
      runtime: { provider: 'managed', routing: {} },
    };
    const configDigest = canonicalConfigHash(config);
    const componentHash = (value: unknown) =>
      createHash('sha256').update(canonicalJsonValue(value)).digest('hex');
    const modelDigest = componentHash(config.models);
    const promptDigest = componentHash({ specification: '' });
    const environmentDigest = componentHash(config.environments);
    const policyDigest = canonicalPublicationPolicyDigest(
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
    );
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
        ...(chain === undefined ? {} : { chain }),
        provenance: {
          repositorySha: 'a'.repeat(40),
          configDigest,
          modelDigest,
          promptDigest,
          environmentDigest,
          policyDigest,
        },
      },
    });
    const revisionId = persistenceId('configRevision', 'revision-1');
    await repository.createConfigRevision({
      id: revisionId,
      projectId: persistenceId('project', 'project-1'),
      config,
      configDigest,
      modelDigest,
      promptDigest,
      environmentDigest,
      policyDigest,
      repositorySha: 'a'.repeat(40),
      createdAt: now,
      revision: 1,
    });
    await repository.createConfigSnapshot({
      id: persistenceId('configSnapshot', 'snapshot-1'),
      runId: persistenceId('run', 'run-1'),
      configRevisionId: revisionId,
      config,
      configDigest,
      modelDigest,
      promptDigest,
      environmentDigest,
      policyDigest,
      repositorySha: 'a'.repeat(40),
      createdAt: now,
    });
    const seen: unknown[] = [];
    const ingested: unknown[] = [];
    const handler = createFeatureWorkflowTaskHandler({
      repository,
      workflow: {
        run: async (input) => {
          seen.push(input);
          return { status: 'succeeded' };
        },
      },
      sourceSnapshot: {
        resolve: async (request) => {
          ingested.push(request);
          return '6'.repeat(64);
        },
      },
    });
    return { handler, seen, ingested };
  };

  it('loads authoritative run input instead of trusting the Trigger payload', async () => {
    const { handler, seen } = await seed();

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

  it('ingests a chained run at its base commit, not at the configuration SHA', async () => {
    const chain = {
      baseRunId: 'run-0',
      baseBranch: 'agentos/run-0-abcdef01',
      baseCommitSha: 'd'.repeat(40),
    };
    const { handler, seen, ingested } = await seed(chain);

    await handler.run({ version: 'feature-task-payload-v1', runId: 'run-1' });

    // The provenance assertions above still ran against 'a'*40 -- the
    // configuration revision is unchanged. Only the source moved.
    expect(ingested).toEqual([
      expect.objectContaining({ repositorySha: chain.baseCommitSha }),
    ]);
    expect(seen).toEqual([
      expect.objectContaining({
        chain,
        source: {
          repositorySha: chain.baseCommitSha,
          sourceSnapshotDigest: '6'.repeat(64),
        },
      }),
    ]);
  });
});
