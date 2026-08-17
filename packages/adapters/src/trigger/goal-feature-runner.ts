import { createHash } from 'node:crypto';

import {
  canonicalJsonValue,
  persistenceId,
  type ArtifactMetadata,
  type ArtifactStore,
  type ConfigSnapshot,
  type DomainRepository,
  type EvidenceSubmission,
  type IsoTimestamp,
  type WorkflowRun,
} from '@agentos/core';
import { z } from 'zod';

import { deterministicGoalChildRunId } from './goal-workflow.js';
import type {
  FeatureWorkflowResult,
  GoalStepRequest,
  GoalStepResult,
  GoalStepRunner,
} from './types.js';
import {
  FeatureWorkflowTaskTransientError,
  GoalWorkflowTaskTransientError,
} from './types.js';

const parentInputSchema = z
  .object({
    idempotencyKey: z.string().min(1).max(256),
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(20_000),
    provenance: z
      .object({
        repositorySha: z.string().regex(/^[0-9a-f]{40}$/),
        configDigest: z.string().regex(/^[0-9a-f]{64}$/),
        modelDigest: z.string().regex(/^[0-9a-f]{64}$/),
        promptDigest: z.string().regex(/^[0-9a-f]{64}$/),
        environmentDigest: z.string().regex(/^[0-9a-f]{64}$/),
        policyDigest: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
    criteria: z.array(z.unknown()).min(1).max(20),
  })
  .strict();
const terminalStatuses = new Set(['succeeded', 'failed', 'cancelled']);

export interface FeatureGoalStepRunnerOptions {
  readonly repository: DomainRepository;
  readonly artifacts: ArtifactStore;
  readonly featureTask: {
    run(
      payload: {
        readonly version: 'feature-task-payload-v1';
        readonly runId: string;
      },
      execution?: {
        readonly taskVersion: string;
        readonly deploymentVersion: string;
        readonly triggerRunId?: string;
      },
    ): Promise<FeatureWorkflowResult>;
  };
  readonly clock: () => IsoTimestamp;
  readonly execution?: {
    readonly taskVersion: string;
    readonly deploymentVersion: string;
    readonly triggerRunId?: string;
  };
}

function runFingerprint(run: WorkflowRun): string {
  return createHash('sha256')
    .update(
      canonicalJsonValue({
        projectId: run.projectId,
        configRevisionId: run.configRevisionId,
        pipeline: run.pipeline,
        input: run.input,
      }),
    )
    .digest('hex');
}

function snapshotMatches(
  child: ConfigSnapshot,
  parent: ConfigSnapshot,
  childRunId: string,
): boolean {
  return (
    child.runId === childRunId &&
    child.configRevisionId === parent.configRevisionId &&
    child.configDigest === parent.configDigest &&
    child.modelDigest === parent.modelDigest &&
    child.promptDigest === parent.promptDigest &&
    child.environmentDigest === parent.environmentDigest &&
    child.policyDigest === parent.policyDigest &&
    child.repositorySha === parent.repositorySha &&
    canonicalJsonValue(child.config) === canonicalJsonValue(parent.config)
  );
}

function safePriorFailureText(request: GoalStepRequest): string {
  const failures = request.priorFailures.slice(-20).map((failure) => {
    const criterionId = failure.criterionId
      .replaceAll(/[^A-Za-z0-9._:-]/g, '_')
      .slice(0, 128);
    const code = failure.code
      .replaceAll(/[^A-Za-z0-9._:-]/g, '_')
      .slice(0, 128);
    return `${criterionId}:${code}`;
  });
  return failures.length === 0
    ? ''
    : `\n\nPrior bounded failures:\n${failures.join('\n')}`;
}

async function copySourceBundle(
  options: FeatureGoalStepRunnerOptions,
  request: GoalStepRequest,
): Promise<ArtifactMetadata> {
  const parentScope = {
    projectId: request.projectId,
    runId: request.parentRunId,
    stepId: 'source',
  };
  const listed = await options.artifacts.list({
    scope: parentScope,
    artifactPrefix: 'bundle',
    limit: 2,
  });
  if (listed.items.length !== 1 || listed.nextCursor !== undefined)
    throw new Error('goal parent must have exactly one source bundle');
  const metadata = listed.items[0]!;
  if (
    metadata.artifactId !== 'bundle' ||
    metadata.version !== 1 ||
    metadata.mediaType !== 'application/json' ||
    metadata.retentionClass !== 'source-bundle'
  )
    throw new Error('goal parent source bundle binding is invalid');
  const value = await options.artifacts.get({
    scope: parentScope,
    key: metadata.key,
    maxBytes: metadata.sizeBytes,
  });
  if (
    value === undefined ||
    value.digest !== metadata.digest ||
    value.sizeBytes !== metadata.sizeBytes
  )
    throw new Error('goal parent source bundle is unavailable');
  return options.artifacts.put({
    scope: {
      projectId: request.projectId,
      runId: request.childRunId,
      stepId: 'source',
    },
    artifactId: 'bundle',
    version: 1,
    digest: value.digest,
    bytes: value.bytes,
    mediaType: value.mediaType,
    retentionClass: 'source-bundle',
  });
}

async function ensureChildSnapshot(
  options: FeatureGoalStepRunnerOptions,
  request: GoalStepRequest,
): Promise<void> {
  const snapshots = await options.repository.listConfigSnapshots(
    persistenceId('run', request.childRunId),
    { limit: 2 },
  );
  if (snapshots.length === 0) {
    try {
      await options.repository.createConfigSnapshot({
        ...request.snapshot,
        id: persistenceId(
          'configSnapshot',
          `goal-child:${request.parentRunId}:${String(request.step)}:snapshot`,
        ),
        runId: persistenceId('run', request.childRunId),
        createdAt: options.clock(),
      });
      return;
    } catch {
      const concurrent = await options.repository.listConfigSnapshots(
        persistenceId('run', request.childRunId),
        { limit: 2 },
      );
      if (
        concurrent.length === 1 &&
        snapshotMatches(concurrent[0]!, request.snapshot, request.childRunId)
      )
        return;
      throw new Error('goal child config snapshot creation conflicted');
    }
  }
  if (
    snapshots.length !== 1 ||
    !snapshotMatches(snapshots[0]!, request.snapshot, request.childRunId)
  )
    throw new Error('goal child config snapshot conflicts with its parent');
}

function safeTerminalFeatureResult(run: WorkflowRun): FeatureWorkflowResult {
  const source =
    run.output !== null &&
    typeof run.output === 'object' &&
    !Array.isArray(run.output)
      ? (run.output as Readonly<Record<string, unknown>>)
      : {};
  const status =
    run.status === 'succeeded'
      ? 'succeeded'
      : run.status === 'cancelled'
        ? 'cancelled'
        : 'failed';
  const draftPullRequestUrl = source.draftPullRequestUrl;
  return {
    status,
    ...(status === 'succeeded' &&
    typeof draftPullRequestUrl === 'string' &&
    z.url().max(2_048).safeParse(draftPullRequestUrl).success
      ? { draftPullRequestUrl }
      : {}),
    ...(status === 'failed' ? { reason: 'child_failed' } : {}),
  };
}

async function trustedReport(
  options: FeatureGoalStepRunnerOptions,
  request: GoalStepRequest,
): Promise<ArtifactMetadata> {
  const listed = await options.artifacts.list({
    scope: {
      projectId: request.projectId,
      runId: request.childRunId,
      stepId: 'verification',
    },
    artifactPrefix: 'trusted-test-report',
    limit: 2,
  });
  if (listed.items.length !== 1 || listed.nextCursor !== undefined)
    throw new Error('successful goal child must have one trusted test report');
  const artifact = listed.items[0]!;
  if (
    artifact.artifactId !== 'trusted-test-report' ||
    artifact.version !== 1 ||
    artifact.mediaType !== 'application/json'
  )
    throw new Error('goal child trusted test report binding is invalid');
  return artifact;
}

function evidenceFor(
  request: GoalStepRequest,
  artifact: ArtifactMetadata,
): readonly EvidenceSubmission[] {
  return request.criteria.map((criterion) => ({
    id: `goal:${request.parentRunId}:step:${String(request.step)}:evidence:${criterion.id}`,
    criterionId: criterion.id,
    submittedByAgentId: 'goal-feature-runner',
    observedAt: new Date(artifact.createdAt),
    status: 'submitted' as const,
    payload: {
      version: 'goal-command-evidence-v1',
      parentRunId: request.parentRunId,
      projectId: request.projectId,
      childRunId: request.childRunId,
      artifact,
    },
  }));
}

async function terminalStepResult(
  options: FeatureGoalStepRunnerOptions,
  request: GoalStepRequest,
  child: WorkflowRun,
): Promise<GoalStepResult> {
  const result = safeTerminalFeatureResult(child);
  const artifact =
    result.status === 'succeeded'
      ? await trustedReport(options, request)
      : undefined;
  return {
    childRunId: request.childRunId,
    status: result.status,
    evidence: artifact === undefined ? [] : evidenceFor(request, artifact),
    ...(result.draftPullRequestUrl === undefined
      ? {}
      : { draftPullRequestUrl: result.draftPullRequestUrl }),
    ...(result.reason === undefined ? {} : { reason: result.reason }),
  };
}

export function createFeatureGoalStepRunner(
  options: FeatureGoalStepRunnerOptions,
): GoalStepRunner {
  const runner: GoalStepRunner = {
    async run(request: GoalStepRequest) {
      const expectedChildRunId = deterministicGoalChildRunId(
        request.parentRunId,
        request.step,
      );
      if (request.childRunId !== expectedChildRunId)
        throw new Error('goal step must use its deterministic child run ID');
      const parent = await options.repository.getRun(
        persistenceId('run', request.parentRunId),
      );
      if (
        parent === undefined ||
        parent.pipeline !== 'goal' ||
        parent.projectId !== request.projectId ||
        parent.status !== 'running' ||
        parent.configRevisionId === undefined
      )
        throw new Error('authoritative goal parent is not runnable');
      if (
        request.snapshot.runId !== parent.id ||
        request.snapshot.configRevisionId !== parent.configRevisionId
      )
        throw new Error('goal step snapshot binding mismatch');
      const input = parentInputSchema.parse(parent.input);
      if (
        canonicalJsonValue(request.criteria) !==
        canonicalJsonValue(input.criteria)
      )
        throw new Error('goal step criterion binding mismatch');
      const parentSnapshots = await options.repository.listConfigSnapshots(
        parent.id,
        { limit: 2 },
      );
      if (
        parentSnapshots.length !== 1 ||
        !snapshotMatches(parentSnapshots[0]!, request.snapshot, parent.id)
      )
        throw new Error(
          'goal step snapshot is not the authoritative parent snapshot',
        );
      const suffix = ` (attempt ${String(request.step)})`;
      const childInput = {
        idempotencyKey: `goal:${parent.id}:step:${String(request.step)}`,
        title: `${input.title.slice(0, 200 - suffix.length)}${suffix}`,
        description:
          `${input.description}${safePriorFailureText(request)}`.slice(
            0,
            20_000,
          ),
        provenance: input.provenance,
      };
      const createdAt = options.clock();
      const childRun: WorkflowRun = {
        id: persistenceId('run', request.childRunId),
        projectId: parent.projectId,
        configRevisionId: parent.configRevisionId,
        pipeline: 'feature',
        status: 'pending',
        input: childInput,
        createdAt,
        updatedAt: createdAt,
      };
      const child = await options.repository.createRunIdempotently(
        childRun,
        runFingerprint(childRun),
      );
      if (
        child.id !== request.childRunId ||
        child.projectId !== request.projectId ||
        child.pipeline !== 'feature'
      )
        throw new Error('goal child run binding mismatch');
      await ensureChildSnapshot(options, request);
      if (terminalStatuses.has(child.status))
        return terminalStepResult(options, request, child);
      const claimed =
        child.status === 'pending'
          ? await options.repository.transitionRun(
              child.id,
              ['pending'],
              { status: 'running', updatedAt: options.clock() },
              child.stateVersion,
            )
          : undefined;
      if (claimed === undefined) {
        const concurrent = await options.repository.getRun(child.id);
        if (concurrent !== undefined && terminalStatuses.has(concurrent.status))
          return terminalStepResult(options, request, concurrent);
        throw new GoalWorkflowTaskTransientError(
          'goal feature child execution is already in progress',
        );
      }
      try {
        await copySourceBundle(options, request);
        await options.featureTask.run(
          { version: 'feature-task-payload-v1', runId: request.childRunId },
          options.execution,
        );
      } catch (error) {
        const active = await options.repository.getRun(child.id);
        if (
          active !== undefined &&
          ['running', 'waiting'].includes(active.status)
        )
          await options.repository.transitionRun(
            active.id,
            ['running', 'waiting'],
            { status: 'pending', updatedAt: options.clock() },
            active.stateVersion,
          );
        if (error instanceof FeatureWorkflowTaskTransientError)
          throw new GoalWorkflowTaskTransientError(error.message);
        throw error;
      }
      const completed = await options.repository.getRun(
        persistenceId('run', request.childRunId),
      );
      if (completed === undefined || !terminalStatuses.has(completed.status))
        throw new Error('feature goal child did not reach a terminal state');
      return terminalStepResult(options, request, completed);
    },
  };
  return Object.freeze(runner);
}
