import {
  canonicalJsonValue,
  isoTimestamp,
  persistenceId,
  type CommandCriterion,
  type ConfigSnapshot,
  type JsonValue,
} from '@agentos/core';
import { describe, expect, it, vi } from 'vitest';

import { createInMemoryArtifactStorage } from '../artifacts/in-memory.js';
import { InMemoryDomainRepository } from '../persistence/in-memory.js';
import { createFeatureGoalStepRunner } from './goal-feature-runner.js';
import { deterministicGoalChildRunId } from './goal-workflow.js';
import {
  FeatureWorkflowTaskTransientError,
  GoalWorkflowTaskTransientError,
} from './types.js';

const now = isoTimestamp('2026-08-17T12:00:00.000Z');
const criterion: CommandCriterion = {
  id: 'tests',
  type: 'command',
  description: 'Tests pass',
  required: true,
  command: 'pnpm test',
};

function asJson(value: unknown): JsonValue {
  return JSON.parse(canonicalJsonValue(value)) as JsonValue;
}

async function fixture() {
  const repository = new InMemoryDomainRepository();
  const artifacts = createInMemoryArtifactStorage({
    now: () => new Date(now),
  }).store;
  const projectId = persistenceId('project', 'goal-runner-project');
  const parentRunId = persistenceId('run', 'goal-runner-parent');
  const revisionId = persistenceId('configRevision', 'goal-runner-config');
  const provenance = {
    repositorySha: 'a'.repeat(40),
    configDigest: 'b'.repeat(64),
    modelDigest: 'c'.repeat(64),
    promptDigest: 'd'.repeat(64),
    environmentDigest: 'e'.repeat(64),
    policyDigest: 'f'.repeat(64),
  };
  await repository.createProject({
    id: projectId,
    name: 'Goal Runner Test',
    createdAt: now,
    updatedAt: now,
  });
  await repository.createConfigRevision({
    id: revisionId,
    projectId,
    revision: 1,
    config: { goals: { maxSteps: 3 } },
    ...provenance,
    createdAt: now,
  });
  await repository.createRun({
    id: parentRunId,
    projectId,
    configRevisionId: revisionId,
    pipeline: 'goal',
    status: 'running',
    input: asJson({
      idempotencyKey: 'goal-runner-test',
      title: 'Finish the goal',
      description: 'Use the child feature workflow.',
      provenance,
      criteria: [criterion],
    }),
    createdAt: now,
    updatedAt: now,
  });
  const snapshot: ConfigSnapshot = {
    id: persistenceId('configSnapshot', 'goal-runner-parent-snapshot'),
    runId: parentRunId,
    configRevisionId: revisionId,
    config: { goals: { maxSteps: 3 } },
    ...provenance,
    createdAt: now,
  };
  await repository.createConfigSnapshot(snapshot);
  const source = await artifacts.put({
    scope: { projectId, runId: parentRunId, stepId: 'source' },
    artifactId: 'bundle',
    version: 1,
    bytes: new TextEncoder().encode(
      canonicalJsonValue({ version: 'source-bundle-v1', files: [] }),
    ),
    mediaType: 'application/json',
    retentionClass: 'source-bundle',
  });
  return {
    repository,
    artifacts,
    projectId,
    parentRunId,
    snapshot,
    source,
  };
}

describe('feature goal step runner', () => {
  it('creates one deterministic child, copies immutable inputs, and replays terminal children', async () => {
    const seeded = await fixture();
    const artifactList = vi.fn(seeded.artifacts.list.bind(seeded.artifacts));
    const artifactStore = {
      get: seeded.artifacts.get.bind(seeded.artifacts),
      put: seeded.artifacts.put.bind(seeded.artifacts),
      list: artifactList,
    };
    const featureTask = {
      run: vi.fn(async (payload: { readonly runId: string }) => {
        const childId = persistenceId('run', payload.runId);
        const child = await seeded.repository.getRun(childId);
        if (child === undefined) throw new Error('child run missing');
        await seeded.artifacts.put({
          scope: {
            projectId: seeded.projectId,
            runId: childId,
            stepId: 'verification',
          },
          artifactId: 'trusted-test-report',
          version: 1,
          bytes: new TextEncoder().encode('{"signed":true}'),
          mediaType: 'application/json',
          retentionClass: 'working',
        });
        await seeded.repository.updateRun(childId, {
          status: 'succeeded',
          output: {
            status: 'succeeded',
            draftPullRequestUrl: 'https://example.com/pull/2',
          },
          updatedAt: now,
        });
        return {
          status: 'succeeded' as const,
          draftPullRequestUrl: 'https://example.com/pull/2',
        };
      }),
    };
    const runner = createFeatureGoalStepRunner({
      repository: seeded.repository,
      artifacts: artifactStore,
      featureTask,
      clock: () => now,
    });
    const childRunId = deterministicGoalChildRunId(seeded.parentRunId, 1);
    const request = {
      parentRunId: seeded.parentRunId,
      projectId: seeded.projectId,
      childRunId,
      step: 1,
      criteria: [criterion],
      snapshot: seeded.snapshot,
      priorFailures: [],
    };

    const first = await runner.run(request);
    const second = await runner.run(request);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      childRunId,
      status: 'succeeded',
      draftPullRequestUrl: 'https://example.com/pull/2',
      evidence: [
        {
          criterionId: criterion.id,
          payload: {
            version: 'goal-command-evidence-v1',
            parentRunId: seeded.parentRunId,
            childRunId,
          },
        },
      ],
    });
    expect(featureTask.run).toHaveBeenCalledTimes(1);
    expect(
      artifactList.mock.calls.filter(
        ([request]) => request.scope.stepId === 'source',
      ),
    ).toHaveLength(1);
    await expect(seeded.repository.getRun(childRunId)).resolves.toMatchObject({
      pipeline: 'feature',
      input: {
        title: 'Finish the goal (attempt 1)',
        provenance: expect.any(Object),
      },
    });
    await expect(
      seeded.repository.listConfigSnapshots(childRunId),
    ).resolves.toHaveLength(1);
    const copiedSource = await seeded.artifacts.list({
      scope: {
        projectId: seeded.projectId,
        runId: childRunId,
        stepId: 'source',
      },
      limit: 2,
    });
    expect(copiedSource.items).toHaveLength(1);
    expect(copiedSource.items[0]?.digest).toBe(seeded.source.digest);
  });

  it('rejects a caller-selected child ID outside the deterministic step binding', async () => {
    const seeded = await fixture();
    const runner = createFeatureGoalStepRunner({
      repository: seeded.repository,
      artifacts: seeded.artifacts,
      featureTask: { run: vi.fn() },
      clock: () => now,
    });

    await expect(
      runner.run({
        parentRunId: seeded.parentRunId,
        projectId: seeded.projectId,
        childRunId: persistenceId('run', 'caller-selected-child'),
        step: 1,
        criteria: [criterion],
        snapshot: seeded.snapshot,
        priorFailures: [],
      }),
    ).rejects.toThrow('deterministic child');
  });

  it('rejects criteria that differ from the immutable parent input', async () => {
    const seeded = await fixture();
    const featureTask = { run: vi.fn() };
    const runner = createFeatureGoalStepRunner({
      repository: seeded.repository,
      artifacts: seeded.artifacts,
      featureTask,
      clock: () => now,
    });

    await expect(
      runner.run({
        parentRunId: seeded.parentRunId,
        projectId: seeded.projectId,
        childRunId: deterministicGoalChildRunId(seeded.parentRunId, 1),
        step: 1,
        criteria: [{ ...criterion, command: 'pnpm compromised' }],
        snapshot: seeded.snapshot,
        priorFailures: [],
      }),
    ).rejects.toThrow('criterion binding');
    expect(featureTask.run).not.toHaveBeenCalled();
  });

  it('allows only one concurrent delivery to execute a feature child', async () => {
    const seeded = await fixture();
    let releaseFeatureTask!: () => void;
    let markFeatureTaskStarted!: () => void;
    const featureTaskStarted = new Promise<void>((resolve) => {
      markFeatureTaskStarted = resolve;
    });
    const featureTaskRelease = new Promise<void>((resolve) => {
      releaseFeatureTask = resolve;
    });
    let invocation = 0;
    const featureTask = {
      run: vi.fn(async (payload: { readonly runId: string }) => {
        invocation += 1;
        markFeatureTaskStarted();
        await featureTaskRelease;
        if (invocation === 1) {
          const childId = persistenceId('run', payload.runId);
          await seeded.artifacts.put({
            scope: {
              projectId: seeded.projectId,
              runId: childId,
              stepId: 'verification',
            },
            artifactId: 'trusted-test-report',
            version: 1,
            bytes: new TextEncoder().encode('{"signed":true}'),
            mediaType: 'application/json',
            retentionClass: 'working',
          });
          await seeded.repository.updateRun(childId, {
            status: 'succeeded',
            output: { status: 'succeeded' },
            updatedAt: now,
          });
        }
        return { status: 'succeeded' as const };
      }),
    };
    const runner = createFeatureGoalStepRunner({
      repository: seeded.repository,
      artifacts: seeded.artifacts,
      featureTask,
      clock: () => now,
    });
    const request = {
      parentRunId: seeded.parentRunId,
      projectId: seeded.projectId,
      childRunId: deterministicGoalChildRunId(seeded.parentRunId, 1),
      step: 1,
      criteria: [criterion],
      snapshot: seeded.snapshot,
      priorFailures: [],
    };

    const first = runner.run(request);
    await featureTaskStarted;
    const second = runner.run(request);
    await expect(second).rejects.toBeInstanceOf(GoalWorkflowTaskTransientError);
    releaseFeatureTask();
    await expect(first).resolves.toMatchObject({ status: 'succeeded' });
    expect(featureTask.run).toHaveBeenCalledTimes(1);
  });

  it('releases the child claim and maps feature transients to goal retries', async () => {
    const seeded = await fixture();
    const runner = createFeatureGoalStepRunner({
      repository: seeded.repository,
      artifacts: seeded.artifacts,
      featureTask: {
        run: vi.fn(async () => {
          throw new FeatureWorkflowTaskTransientError('retry child');
        }),
      },
      clock: () => now,
    });
    const childRunId = deterministicGoalChildRunId(seeded.parentRunId, 1);

    await expect(
      runner.run({
        parentRunId: seeded.parentRunId,
        projectId: seeded.projectId,
        childRunId,
        step: 1,
        criteria: [criterion],
        snapshot: seeded.snapshot,
        priorFailures: [],
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'GoalWorkflowTaskTransientError',
        message: 'retry child',
      }),
    );
    await expect(seeded.repository.getRun(childRunId)).resolves.toMatchObject({
      status: 'pending',
    });
  });
});
