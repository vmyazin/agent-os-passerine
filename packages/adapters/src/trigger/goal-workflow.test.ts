import { createHash } from 'node:crypto';

import {
  canonicalConfigHash,
  canonicalJsonValue,
  canonicalPublicationPolicyDigest,
  createHmacAttestationIssuer,
  createVerifierRegistry,
  isoTimestamp,
  loadAgentOsConfig,
  normalizePublicationPolicySnapshot,
  persistenceId,
  registerVerifier,
  type CommandCriterion,
  type EvidenceSubmission,
  type JsonValue,
} from '@agentos/core';
import { describe, expect, it, vi } from 'vitest';

import { createInMemoryArtifactStorage } from '../artifacts/in-memory.js';
import { InMemoryDomainRepository } from '../persistence/in-memory.js';
import { createTrustedGoalCommandVerifier } from './goal-verifier.js';
import {
  createDurableGoalWorkflow,
  deterministicGoalChildRunId,
} from './goal-workflow.js';
import type { GoalStepRunner } from './types.js';

const now = isoTimestamp('2026-08-17T12:00:00.000Z');
const reportKeys = [
  {
    keyId: 'goal-workflow-test-key',
    secret: 'goal-workflow-test-secret-material-32!',
  },
] as const;
const reportIssuer = createHmacAttestationIssuer({
  ...reportKeys[0],
  kind: 'trusted-test-report',
});
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

function hashes(maxSteps = 3) {
  const config = loadAgentOsConfig(`
version: 1
project: { name: Goal Workflow Test }
models: { standard: { provider: local, model: test } }
agents: { implementer: { model: standard } }
environments: { default: { runtime: process } }
pipelines: { feature: { steps: [{ id: implement, agent: implementer }] } }
policies: {}
budgets: { workflowMicrodollars: 1, dailyMicrodollars: 2, concurrency: 1 }
goals: { maxSteps: ${String(maxSteps)}, maxRetries: 1, timeoutMs: 1000 }
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

async function seedGoal(
  options: {
    readonly snapshot?: boolean;
    readonly persistedDefinition?: CommandCriterion;
    readonly maxSteps?: number;
  } = {},
) {
  const repository = new InMemoryDomainRepository();
  const projectId = persistenceId('project', 'goal-workflow-project');
  const runId = persistenceId('run', 'goal-workflow-parent');
  const revisionId = persistenceId('configRevision', 'goal-workflow-config');
  const configured = hashes(options.maxSteps);
  await repository.createProject({
    id: projectId,
    name: 'Goal Workflow Test',
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
    input: asJson({
      idempotencyKey: 'goal-workflow-test',
      title: 'Finish the goal',
      description: 'Use bounded feature attempts.',
      provenance: configured.provenance,
      criteria: [criterion],
    }),
    createdAt: now,
    updatedAt: now,
  });
  if (options.snapshot !== false)
    await repository.createConfigSnapshot({
      id: persistenceId('configSnapshot', 'goal-workflow-snapshot'),
      runId,
      configRevisionId: revisionId,
      config: asJson(configured.config),
      ...configured.provenance,
      createdAt: now,
    });
  await repository.createGoalCriterion({
    id: persistenceId('goalCriterion', 'goal-workflow-criterion'),
    runId,
    ordinal: 0,
    description: criterion.description,
    definition: asJson(options.persistedDefinition ?? criterion),
    status: 'pending',
    createdAt: now,
  });
  return { repository, projectId, runId };
}

async function signedEvidence(
  artifacts: ReturnType<typeof createInMemoryArtifactStorage>['store'],
  input: {
    readonly parentRunId: string;
    readonly projectId: string;
    readonly childRunId: string;
    readonly criterion: CommandCriterion;
    readonly step: number;
  },
): Promise<EvidenceSubmission> {
  const observation = {
    runId: input.childRunId,
    stepId: 'verification',
    command: input.criterion.command,
    exitCode: 0,
    startedAt: '2026-08-17T12:00:00.000Z',
    completedAt: '2026-08-17T12:00:01.000Z',
    repositorySha: 'a'.repeat(40),
    sourceSnapshotDigest: 'b'.repeat(64),
    changeSetDigest: 'c'.repeat(64),
    configDigest: 'd'.repeat(64),
  };
  const reportEvidence = {
    version: 'workflow-verification-v3',
    runId: input.childRunId,
    testEvidence: {
      version: 'test-evidence-v1',
      passed: true,
      command: input.criterion.command,
      exitCode: 0,
    },
    trustedCommandObservation: observation,
  };
  const evidenceDigest = createHash('sha256')
    .update(canonicalJsonValue(reportEvidence))
    .digest('hex');
  const report = {
    version: 'trusted-test-report-v1',
    evidence: reportEvidence,
    attestation: reportIssuer.issue({
      subject: `${input.childRunId}:verification:${evidenceDigest}`,
      issuedAt: '2026-08-17T11:59:59.000Z',
      claims: {
        source: 'managed-agent-command-observer',
        runId: input.childRunId,
        evidenceDigest,
      },
    }),
  };
  const artifact = await artifacts.put({
    scope: {
      projectId: input.projectId,
      runId: input.childRunId,
      stepId: 'verification',
    },
    artifactId: 'trusted-test-report',
    version: 1,
    bytes: new TextEncoder().encode(canonicalJsonValue(report)),
    mediaType: 'application/json',
    retentionClass: 'working',
  });
  return {
    id: `goal-evidence-${String(input.step)}-${input.criterion.id}`,
    criterionId: input.criterion.id,
    submittedByAgentId: 'goal-workflow',
    observedAt: new Date('2026-08-17T12:00:02.000Z'),
    status: 'submitted',
    payload: {
      version: 'goal-command-evidence-v1',
      parentRunId: input.parentRunId,
      projectId: input.projectId,
      childRunId: input.childRunId,
      artifact,
    },
  };
}

describe('durable goal workflow', () => {
  it('fails closed when the immutable snapshot or criterion set is invalid', async () => {
    const missing = await seedGoal({ snapshot: false });
    const runner: GoalStepRunner = { run: vi.fn() };

    await expect(
      createDurableGoalWorkflow({
        repository: missing.repository,
        stepRunner: runner,
        verifierRegistry: createVerifierRegistry(),
        clock: () => now,
      }).run({ runId: missing.runId }),
    ).rejects.toThrow('exactly one config snapshot');

    const mismatched = await seedGoal({
      persistedDefinition: { ...criterion, command: 'pnpm compromised' },
    });
    await expect(
      createDurableGoalWorkflow({
        repository: mismatched.repository,
        stepRunner: runner,
        verifierRegistry: createVerifierRegistry(),
        clock: () => now,
      }).run({ runId: mismatched.runId }),
    ).rejects.toThrow('criterion');
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('evaluates signed evidence, persists replayable progress, and succeeds once', async () => {
    const seeded = await seedGoal();
    const artifacts = createInMemoryArtifactStorage().store;
    const runner: GoalStepRunner = {
      run: vi.fn(async (request) => ({
        childRunId: request.childRunId,
        status: 'succeeded' as const,
        draftPullRequestUrl: 'https://example.com/pull/1',
        evidence: [
          await signedEvidence(artifacts, {
            parentRunId: request.parentRunId,
            projectId: request.projectId,
            childRunId: request.childRunId,
            criterion: request.criteria[0]!,
            step: request.step,
          }),
        ],
      })),
    };
    const registry = registerVerifier(
      createVerifierRegistry(),
      'command',
      createTrustedGoalCommandVerifier({
        artifacts,
        keys: reportKeys,
        clock: () => '2026-08-17T12:00:03.000Z',
      }),
    );
    const workflow = createDurableGoalWorkflow({
      repository: seeded.repository,
      stepRunner: runner,
      verifierRegistry: registry,
      clock: () => now,
    });

    const result = await workflow.run({ runId: seeded.runId });

    expect(result).toMatchObject({
      status: 'succeeded',
      completedSteps: 1,
      maxSteps: 3,
      children: [
        {
          step: 1,
          runId: deterministicGoalChildRunId(seeded.runId, 1),
        },
      ],
    });
    await expect(
      seeded.repository.listGoalProgress(seeded.runId),
    ).resolves.toHaveLength(2);
    const parent = await seeded.repository.getRun(seeded.runId);
    expect(parent).toMatchObject({ status: 'succeeded', output: result });
    expect(JSON.stringify(parent?.output)).not.toMatch(
      /attestation|signature|trusted-test-report/,
    );

    await expect(workflow.run({ runId: seeded.runId })).resolves.toEqual(
      result,
    );
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it('detects a stuck result after three attempts and never creates a fourth child', async () => {
    const seeded = await seedGoal();
    const runner: GoalStepRunner = {
      run: vi.fn(async (request) => ({
        childRunId: request.childRunId,
        status: 'failed' as const,
        reason: 'child_failed',
        evidence: [],
      })),
    };
    const workflow = createDurableGoalWorkflow({
      repository: seeded.repository,
      stepRunner: runner,
      verifierRegistry: createVerifierRegistry(),
      clock: () => now,
    });

    await expect(workflow.run({ runId: seeded.runId })).resolves.toMatchObject({
      status: 'failed',
      completedSteps: 3,
      maxSteps: 3,
      reason: 'stuck',
    });
    expect(runner.run).toHaveBeenCalledTimes(3);
    expect(
      (runner.run as ReturnType<typeof vi.fn>).mock.calls.map(
        ([request]) => request.childRunId,
      ),
    ).toEqual(
      [1, 2, 3].map((step) => deterministicGoalChildRunId(seeded.runId, step)),
    );
  });

  it('checks authoritative cancellation after a child attempt and stops', async () => {
    const seeded = await seedGoal();
    const runner: GoalStepRunner = {
      run: vi.fn(async (request) => {
        const parent = await seeded.repository.getRun(seeded.runId);
        await seeded.repository.transitionRun(
          seeded.runId,
          ['running'],
          { status: 'cancelled', updatedAt: now },
          parent?.stateVersion,
        );
        return {
          childRunId: request.childRunId,
          status: 'cancelled' as const,
          evidence: [],
        };
      }),
    };

    await expect(
      createDurableGoalWorkflow({
        repository: seeded.repository,
        stepRunner: runner,
        verifierRegistry: createVerifierRegistry(),
        clock: () => now,
      }).run({ runId: seeded.runId }),
    ).resolves.toMatchObject({ status: 'cancelled', completedSteps: 0 });
    expect(runner.run).toHaveBeenCalledTimes(1);
    await expect(
      seeded.repository.listGoalProgress(seeded.runId),
    ).resolves.toHaveLength(1);
  });

  it('cancels a checkpointed active child when a cancelled parent is replayed', async () => {
    const seeded = await seedGoal();
    const childRunId = deterministicGoalChildRunId(seeded.runId, 1);
    const parent = await seeded.repository.getRun(seeded.runId);
    if (parent?.configRevisionId === undefined)
      throw new Error('goal test parent config revision missing');
    await seeded.repository.createRun({
      id: childRunId,
      projectId: seeded.projectId,
      configRevisionId: parent.configRevisionId,
      pipeline: 'feature',
      status: 'running',
      input: {},
      createdAt: now,
      updatedAt: now,
    });
    await seeded.repository.appendGoalProgress({
      id: persistenceId('goalProgress', `goal:${seeded.runId}:step:1:child`),
      runId: seeded.runId,
      step: 1,
      status: 'pending',
      detail: 'Feature child checkpointed',
      payload: { version: 'goal-child-attempt-v1', childRunId },
      recordedAt: now,
    });
    await seeded.repository.transitionRun(
      seeded.runId,
      ['pending'],
      { status: 'cancelled', updatedAt: now },
      parent?.stateVersion,
    );
    const runner: GoalStepRunner = { run: vi.fn() };

    await expect(
      createDurableGoalWorkflow({
        repository: seeded.repository,
        stepRunner: runner,
        verifierRegistry: createVerifierRegistry(),
        clock: () => now,
      }).run({ runId: seeded.runId }),
    ).resolves.toMatchObject({
      status: 'cancelled',
      children: [{ step: 1, runId: childRunId, status: 'cancelled' }],
    });
    await expect(seeded.repository.getRun(childRunId)).resolves.toMatchObject({
      status: 'cancelled',
    });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('rejects a replayed child checkpoint outside its deterministic binding', async () => {
    const seeded = await seedGoal();
    const runner: GoalStepRunner = { run: vi.fn() };
    await seeded.repository.appendGoalProgress({
      id: persistenceId('goalProgress', `goal:${seeded.runId}:step:1:child`),
      runId: seeded.runId,
      step: 1,
      status: 'pending',
      detail: 'Feature child checkpointed',
      payload: {
        version: 'goal-child-attempt-v1',
        childRunId: persistenceId('run', 'unrelated-run'),
      },
      recordedAt: now,
    });

    await expect(
      createDurableGoalWorkflow({
        repository: seeded.repository,
        stepRunner: runner,
        verifierRegistry: createVerifierRegistry(),
        clock: () => now,
      }).run({ runId: seeded.runId }),
    ).rejects.toThrow('deterministic child binding');
    expect(runner.run).not.toHaveBeenCalled();
  });
});
