import { createHash } from 'node:crypto';

import {
  canonicalConfigHash,
  canonicalJsonValue,
  canonicalPublicationPolicyDigest,
  createFailureFingerprint,
  createGoalWorkflow,
  normalizePublicationPolicySnapshot,
  parseAgentOsConfig,
  persistenceId,
  reduceGoalWorkflow,
  verifyCriterion,
  type CommandCriterion,
  type EvidenceSubmission,
  type ConfigSnapshot,
  type GoalCriterion,
  type GoalProgress,
  type GoalWorkflowState,
  type JsonValue,
  type VerificationResult,
  type WorkflowRun,
} from '@agentos/core';
import { z } from 'zod';

import type {
  DurableGoalWorkflowDependencies,
  GoalStepResult,
  GoalWorkflowResult,
} from './types.js';

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const commandCriterionSchema = z
  .object({
    id: z.string().min(1).max(128),
    type: z.literal('command'),
    description: z.string().min(1).max(1_000),
    required: z.boolean().optional(),
    command: z.string().min(1).max(10_000),
  })
  .strict();
const goalRunInputSchema = z
  .object({
    idempotencyKey: z.string().min(1).max(256),
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(20_000),
    provenance: z
      .object({
        repositorySha: z.string().regex(/^[0-9a-f]{40}$/),
        configDigest: digest,
        modelDigest: digest,
        promptDigest: digest,
        environmentDigest: digest,
        policyDigest: digest,
      })
      .strict(),
    criteria: z.array(commandCriterionSchema).min(1).max(20),
  })
  .strict();
export type GoalRunInput = z.infer<typeof goalRunInputSchema>;

export function parseGoalRunInput(input: JsonValue | undefined): GoalRunInput {
  const parsed = goalRunInputSchema.parse(input);
  const ids = new Set<string>();
  for (const criterion of parsed.criteria) {
    if (ids.has(criterion.id))
      throw new Error('goal criterion IDs must be unique');
    ids.add(criterion.id);
  }
  return parsed;
}
const verificationResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('passed'),
      criterionId: z.string().min(1),
      verifierId: z.string().min(1),
      message: z.string(),
      attestation: z.unknown(),
    })
    .strict(),
  z
    .object({
      status: z.literal('failed'),
      criterionId: z.string().min(1),
      verifierId: z.string().min(1).optional(),
      code: z.string().min(1),
      message: z.string(),
      fingerprint: digest,
    })
    .strict(),
]);
const criterionProgressPayloadSchema = z
  .object({
    version: z.literal('goal-criterion-result-v1'),
    result: verificationResultSchema,
  })
  .strict();
const childProgressPayloadSchema = z
  .object({
    version: z.literal('goal-child-attempt-v1'),
    childRunId: z.string().min(1).max(256),
  })
  .strict();
const goalWorkflowResultSchema = z
  .object({
    status: z.enum(['succeeded', 'failed', 'cancelled']),
    completedSteps: z.number().int().min(0).max(3),
    maxSteps: z.number().int().min(1).max(3),
    reason: z
      .enum(['stuck', 'step_limit', 'crashed', 'cancelled', 'failed'])
      .optional(),
    criteria: z
      .array(
        z
          .object({
            id: z.string().min(1).max(128),
            status: z.enum(['pending', 'passed', 'failed']),
            code: z.string().min(1).max(128).optional(),
          })
          .strict(),
      )
      .max(20),
    children: z
      .array(
        z
          .object({
            step: z.number().int().min(1).max(3),
            runId: z.string().min(1).max(256),
            status: z.string().min(1).max(64).optional(),
            draftPullRequestUrl: z.url().max(2_048).optional(),
          })
          .strict(),
      )
      .max(3),
  })
  .strict();

export function deterministicGoalChildRunId(
  parentRunId: string,
  step: number,
): ReturnType<typeof persistenceId<'run'>> {
  if (!Number.isSafeInteger(step) || step < 1 || step > 3)
    throw new Error('goal child step must be between 1 and 3');
  const binding = createHash('sha256')
    .update(`${parentRunId}\u0000${String(step)}`)
    .digest('hex');
  return persistenceId('run', `goal-child-${binding}`);
}

export function deterministicGoalCriterionId(
  runId: string,
  ordinal: number,
): ReturnType<typeof persistenceId<'goalCriterion'>> {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal > 19)
    throw new Error('goal criterion ordinal must be between 0 and 19');
  const binding = createHash('sha256')
    .update(`goalCriterion:goal:${runId}:criterion:${String(ordinal)}`)
    .digest('hex')
    .slice(0, 32);
  return persistenceId('goalCriterion', `goalCriterion_${binding}`);
}

function componentHash(value: unknown): string {
  return createHash('sha256').update(canonicalJsonValue(value)).digest('hex');
}

function validateSnapshot(
  run: WorkflowRun,
  snapshot: ConfigSnapshot,
  input: GoalRunInput,
): number {
  if (
    snapshot.runId !== run.id ||
    snapshot.configRevisionId !== run.configRevisionId
  )
    throw new Error('goal config snapshot binding mismatch');
  const config = parseAgentOsConfig(snapshot.config);
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
  const promptDigest = componentHash(
    Object.fromEntries(
      Object.entries(config.agents).map(([name, agent]) => [
        name,
        agent.prompt ?? '',
      ]),
    ),
  );
  if (
    snapshot.repositorySha !== input.provenance.repositorySha ||
    snapshot.configDigest !== input.provenance.configDigest ||
    snapshot.modelDigest !== input.provenance.modelDigest ||
    snapshot.promptDigest !== input.provenance.promptDigest ||
    snapshot.environmentDigest !== input.provenance.environmentDigest ||
    snapshot.policyDigest !== input.provenance.policyDigest ||
    canonicalConfigHash(config) !== snapshot.configDigest ||
    componentHash(config.models) !== snapshot.modelDigest ||
    promptDigest !== snapshot.promptDigest ||
    componentHash(config.environments) !== snapshot.environmentDigest ||
    policyDigest !== snapshot.policyDigest
  )
    throw new Error('goal config snapshot provenance mismatch');
  return config.goals.maxSteps;
}

function validateCriteria(
  records: readonly GoalCriterion[],
  input: GoalRunInput,
): readonly CommandCriterion[] {
  if (records.length !== input.criteria.length)
    throw new Error('goal criterion set is incomplete');
  return records.map((record, ordinal) => {
    const parsed = commandCriterionSchema.parse(record.definition);
    const definition: CommandCriterion = {
      id: parsed.id,
      type: 'command',
      description: parsed.description,
      command: parsed.command,
      ...(parsed.required === undefined ? {} : { required: parsed.required }),
    };
    if (
      record.ordinal !== ordinal ||
      record.description !== definition.description ||
      canonicalJsonValue(definition) !==
        canonicalJsonValue(input.criteria[ordinal])
    )
      throw new Error('goal criterion definition mismatch');
    return definition;
  });
}

export function validateDurableGoalInputs(
  run: WorkflowRun,
  snapshots: readonly ConfigSnapshot[],
  records: readonly GoalCriterion[],
): {
  readonly input: GoalRunInput;
  readonly snapshot: ConfigSnapshot;
  readonly definitions: readonly CommandCriterion[];
  readonly maxSteps: number;
} {
  const input = parseGoalRunInput(run.input);
  if (snapshots.length !== 1)
    throw new Error('goal run must have exactly one config snapshot');
  const snapshot = snapshots[0]!;
  const definitions = validateCriteria(records, input);
  const maxSteps = validateSnapshot(run, snapshot, input);
  return { input, snapshot, definitions, maxSteps };
}

function childProgressId(runId: string, step: number) {
  return persistenceId(
    'goalProgress',
    `goal:${runId}:step:${String(step)}:child`,
  );
}

function criterionProgressId(runId: string, step: number, criterionId: string) {
  return persistenceId(
    'goalProgress',
    `goal:${runId}:step:${String(step)}:criterion:${criterionId}`,
  );
}

function failedResult(
  criterionId: string,
  code: string,
  message: string,
): VerificationResult {
  const verifierId = 'goal-step-runner';
  return {
    status: 'failed',
    criterionId,
    verifierId,
    code,
    message,
    fingerprint: createFailureFingerprint({
      criterionId,
      verifierId,
      code,
      message,
    }),
  };
}

interface ReplayedProgress {
  readonly state: GoalWorkflowState;
  readonly completedSteps: number;
  readonly children: ReadonlyMap<number, string>;
  readonly criterionResults: ReadonlyMap<string, VerificationResult>;
  readonly recordsById: ReadonlyMap<string, GoalProgress>;
}

function replayProgress(
  runId: string,
  criteria: readonly GoalCriterion[],
  definitions: readonly CommandCriterion[],
  maxSteps: number,
  progress: readonly GoalProgress[],
): ReplayedProgress {
  let state = reduceGoalWorkflow(
    createGoalWorkflow({ criteria: definitions, maxSteps }),
    { id: `goal:${runId}:start`, type: 'start' },
  );
  const children = new Map<number, string>();
  const criterionResults = new Map<string, VerificationResult>();
  const recordsById = new Map<string, GoalProgress>();
  const criterionByRecordId = new Map(
    criteria.map((record, ordinal) => [record.id, definitions[ordinal]!.id]),
  );
  for (const record of progress) {
    if (recordsById.has(record.id))
      throw new Error('duplicate goal progress record');
    recordsById.set(record.id, record);
    if (record.step > maxSteps)
      throw new Error('goal progress exceeds configured step limit');
    if (record.criterionId === undefined) {
      if (record.status !== 'pending')
        throw new Error('goal child checkpoint status is invalid');
      const payload = childProgressPayloadSchema.parse(record.payload);
      if (
        record.id !== childProgressId(runId, record.step) ||
        payload.childRunId !== deterministicGoalChildRunId(runId, record.step)
      )
        throw new Error(
          'goal child checkpoint deterministic child binding mismatch',
        );
      if (children.has(record.step))
        throw new Error('duplicate goal child checkpoint');
      children.set(record.step, payload.childRunId);
      continue;
    }
    const definitionId = criterionByRecordId.get(record.criterionId);
    if (definitionId === undefined)
      throw new Error('goal progress references an unknown criterion');
    if (record.id !== criterionProgressId(runId, record.step, definitionId))
      throw new Error('goal criterion progress ID binding mismatch');
    const payload = criterionProgressPayloadSchema.parse(record.payload);
    if (payload.result.criterionId !== definitionId)
      throw new Error('goal progress criterion binding mismatch');
    if (
      (payload.result.status === 'passed' && record.status !== 'satisfied') ||
      (payload.result.status === 'failed' && record.status !== 'failed')
    )
      throw new Error('goal progress status does not match its result');
    const key = `${String(record.step)}\u0000${definitionId}`;
    if (criterionResults.has(key))
      throw new Error('duplicate goal criterion progress');
    criterionResults.set(key, payload.result as VerificationResult);
  }

  let completedSteps = 0;
  for (let step = 1; step <= maxSteps; step += 1) {
    const results = definitions.map((definition) =>
      criterionResults.get(`${String(step)}\u0000${definition.id}`),
    );
    const present = results.filter(
      (result): result is VerificationResult => result !== undefined,
    );
    if (present.length === 0) break;
    if (present.length !== definitions.length || !children.has(step)) break;
    if (state.status !== 'running' || state.currentStep !== step)
      throw new Error('goal progress is out of sequence');
    state = reduceGoalWorkflow(state, {
      id: `goal:${runId}:step:${String(step)}`,
      type: 'step_evaluated',
      step,
      results: present,
    });
    completedSteps = step;
  }
  for (const [key] of criterionResults) {
    const step = Number(key.split('\u0000', 1)[0]);
    if (step > completedSteps + 1)
      throw new Error('goal progress skipped a step');
  }
  return { state, completedSteps, children, criterionResults, recordsById };
}

function genericTerminalResult(run: WorkflowRun): GoalWorkflowResult {
  const parsed = goalWorkflowResultSchema.safeParse(run.output);
  if (parsed.success) return parsed.data as GoalWorkflowResult;
  const status =
    run.status === 'succeeded'
      ? 'succeeded'
      : run.status === 'cancelled'
        ? 'cancelled'
        : 'failed';
  return {
    status,
    completedSteps: 0,
    maxSteps: 3,
    ...(status === 'cancelled'
      ? { reason: 'cancelled' as const }
      : status === 'failed'
        ? { reason: 'failed' as const }
        : {}),
    criteria: [],
    children: [],
  };
}

async function workflowResult(
  dependencies: DurableGoalWorkflowDependencies,
  parent: Pick<WorkflowRun, 'id' | 'projectId'>,
  state: GoalWorkflowState,
  completedSteps: number,
  children: ReadonlyMap<number, string>,
): Promise<GoalWorkflowResult> {
  const summaries = await Promise.all(
    [...children.entries()]
      .sort(([left], [right]) => left - right)
      .map(async ([step, runId]) => {
        const child = await dependencies.repository.getRun(
          persistenceId('run', runId),
        );
        if (
          runId !== deterministicGoalChildRunId(parent.id, step) ||
          (child !== undefined &&
            (child.id !== runId ||
              child.projectId !== parent.projectId ||
              child.pipeline !== 'feature'))
        )
          throw new Error('goal child run binding mismatch');
        const output =
          child?.output !== null &&
          typeof child?.output === 'object' &&
          !Array.isArray(child.output)
            ? (child.output as Readonly<Record<string, unknown>>)
            : undefined;
        const draftPullRequestUrl = output?.draftPullRequestUrl;
        return {
          step,
          runId,
          ...(child === undefined ? {} : { status: child.status }),
          ...(typeof draftPullRequestUrl === 'string' &&
          z.url().max(2_048).safeParse(draftPullRequestUrl).success
            ? { draftPullRequestUrl }
            : {}),
        };
      }),
  );
  const status =
    state.status === 'succeeded'
      ? 'succeeded'
      : state.status === 'cancelled'
        ? 'cancelled'
        : 'failed';
  const reason =
    state.failureReason === undefined
      ? status === 'cancelled'
        ? ('cancelled' as const)
        : undefined
      : state.failureReason;
  return {
    status,
    completedSteps,
    maxSteps: state.maxSteps,
    ...(reason === undefined ? {} : { reason }),
    criteria: state.criteria.map((criterion) => {
      const result = state.latestResults[criterion.id];
      if (result === undefined) return { id: criterion.id, status: 'pending' };
      if (result.status === 'passed')
        return { id: criterion.id, status: 'passed' };
      return {
        id: criterion.id,
        status: 'failed',
        code: result.code.slice(0, 128),
      };
    }),
    children: summaries,
  };
}

async function cancelActiveChild(
  dependencies: DurableGoalWorkflowDependencies,
  parent: Pick<WorkflowRun, 'id' | 'projectId'>,
  step: number,
  childRunId: string,
): Promise<void> {
  const child = await dependencies.repository.getRun(
    persistenceId('run', childRunId),
  );
  if (
    childRunId !== deterministicGoalChildRunId(parent.id, step) ||
    (child !== undefined &&
      (child.id !== childRunId ||
        child.projectId !== parent.projectId ||
        child.pipeline !== 'feature'))
  )
    throw new Error('goal child run binding mismatch');
  if (
    child === undefined ||
    ['succeeded', 'failed', 'cancelled'].includes(child.status)
  )
    return;
  await dependencies.repository.transitionRun(
    child.id,
    ['pending', 'running', 'waiting'],
    { status: 'cancelled', updatedAt: dependencies.clock() },
    child.stateVersion,
  );
}

async function cancelRecordedChildren(
  dependencies: DurableGoalWorkflowDependencies,
  parent: Pick<WorkflowRun, 'id' | 'projectId'>,
  children: ReadonlyMap<number, string>,
): Promise<void> {
  await Promise.all(
    [...children.entries()].map(([step, childRunId]) =>
      cancelActiveChild(dependencies, parent, step, childRunId),
    ),
  );
}

async function finishParent(
  dependencies: DurableGoalWorkflowDependencies,
  parent: Pick<WorkflowRun, 'id' | 'projectId'>,
  state: GoalWorkflowState,
  completedSteps: number,
  children: ReadonlyMap<number, string>,
): Promise<GoalWorkflowResult> {
  const result = await workflowResult(
    dependencies,
    parent,
    state,
    completedSteps,
    children,
  );
  const current = await dependencies.repository.getRun(parent.id);
  if (current === undefined)
    throw new Error('authoritative goal run is missing');
  if (['succeeded', 'failed', 'cancelled'].includes(current.status))
    return genericTerminalResult(current);
  const transitioned = await dependencies.repository.transitionRun(
    parent.id,
    ['running'],
    {
      status: result.status,
      output: result as unknown as JsonValue,
      ...(result.status === 'failed'
        ? { error: { code: `goal_${result.reason ?? 'failed'}` } }
        : {}),
      updatedAt: dependencies.clock(),
    },
    current.stateVersion,
  );
  if (transitioned !== undefined) return result;
  const concurrent = await dependencies.repository.getRun(parent.id);
  if (concurrent === undefined)
    throw new Error('authoritative goal run is missing');
  if (['succeeded', 'failed', 'cancelled'].includes(concurrent.status))
    return genericTerminalResult(concurrent);
  throw new Error('goal parent transition conflicted');
}

function boundEvidencePayload(
  submission: EvidenceSubmission,
  parentRunId: string,
  childRunId: string,
): boolean {
  const payload = submission.payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload))
    return false;
  const bound = payload as { parentRunId?: unknown; childRunId?: unknown };
  return bound.parentRunId === parentRunId && bound.childRunId === childRunId;
}

function stepResults(
  dependencies: DurableGoalWorkflowDependencies,
  stepResult: GoalStepResult,
  definitions: readonly CommandCriterion[],
  existing: ReadonlyMap<string, VerificationResult>,
  step: number,
  parentRunId: string,
  childRunId: string,
): Promise<readonly VerificationResult[]> {
  const evidence = new Map(
    stepResult.evidence.map((item) => [item.criterionId, item]),
  );
  if (evidence.size !== stepResult.evidence.length)
    throw new Error('goal step returned duplicate criterion evidence');
  const expectedCriteria = new Set(definitions.map((item) => item.id));
  if (
    [...evidence.keys()].some(
      (criterionId) => !expectedCriteria.has(criterionId),
    )
  )
    throw new Error('goal step returned evidence for an unknown criterion');
  return Promise.all(
    definitions.map(async (definition) => {
      const replayed = existing.get(`${String(step)}\u0000${definition.id}`);
      if (replayed !== undefined) return replayed;
      if (stepResult.status !== 'succeeded')
        return failedResult(
          definition.id,
          'child_failed',
          'Feature child attempt did not complete successfully',
        );
      const submission = evidence.get(definition.id);
      if (submission === undefined)
        return failedResult(
          definition.id,
          'evidence_missing',
          'Feature child did not produce trusted criterion evidence',
        );
      if (!boundEvidencePayload(submission, parentRunId, childRunId))
        return failedResult(
          definition.id,
          'evidence_binding_mismatch',
          'Criterion evidence is not bound to this goal step child',
        );
      return verifyCriterion(
        dependencies.verifierRegistry,
        definition,
        submission,
      );
    }),
  );
}

export function createDurableGoalWorkflow(
  dependencies: DurableGoalWorkflowDependencies,
): { run(input: { readonly runId: string }): Promise<GoalWorkflowResult> } {
  return Object.freeze({
    async run(input) {
      const runId = persistenceId('run', input.runId);
      let parent = await dependencies.repository.getRun(runId);
      if (parent === undefined || parent.pipeline !== 'goal')
        throw new Error('authoritative goal run does not exist');
      if (['succeeded', 'failed'].includes(parent.status))
        return genericTerminalResult(parent);
      const snapshots = await dependencies.repository.listConfigSnapshots(
        runId,
        { limit: 2 },
      );
      const records = await dependencies.repository.listGoalCriteria(runId, {
        limit: 21,
      });
      const { definitions, maxSteps } = validateDurableGoalInputs(
        parent,
        snapshots,
        records,
      );
      const progress = await dependencies.repository.listGoalProgress(runId, {
        limit: 100,
      });
      const replayed = replayProgress(
        parent.id,
        records,
        definitions,
        maxSteps,
        progress,
      );
      let state = replayed.state;
      let completedSteps = replayed.completedSteps;
      const children = new Map(replayed.children);
      const criterionResults = new Map(replayed.criterionResults);
      const recordsById = new Map(replayed.recordsById);

      if (parent.status === 'pending') {
        const transitioned = await dependencies.repository.transitionRun(
          runId,
          ['pending'],
          { status: 'running', updatedAt: dependencies.clock() },
          parent.stateVersion,
        );
        parent =
          transitioned ??
          (await dependencies.repository.getRun(runId)) ??
          (() => {
            throw new Error('authoritative goal run is missing');
          })();
      }
      if (parent.status === 'cancelled') {
        await cancelRecordedChildren(dependencies, parent, children);
        return workflowResult(
          dependencies,
          parent,
          { ...state, status: 'cancelled' },
          completedSteps,
          children,
        );
      }
      if (parent.status !== 'running') return genericTerminalResult(parent);
      if (state.status !== 'running')
        return finishParent(
          dependencies,
          parent,
          state,
          completedSteps,
          children,
        );

      while (state.status === 'running') {
        const authoritative = await dependencies.repository.getRun(runId);
        if (authoritative?.status === 'cancelled') {
          await cancelRecordedChildren(dependencies, parent, children);
          return workflowResult(
            dependencies,
            parent,
            { ...state, status: 'cancelled' },
            completedSteps,
            children,
          );
        }
        if (authoritative?.status !== 'running')
          throw new Error('goal parent is not runnable');
        const step = state.currentStep;
        const childRunId = deterministicGoalChildRunId(runId, step);
        const checkpointId = childProgressId(runId, step);
        if (!recordsById.has(checkpointId)) {
          const checkpoint =
            await dependencies.repository.appendGoalProgressIdempotently({
              id: checkpointId,
              runId,
              step,
              status: 'pending',
              detail: 'Feature child checkpointed',
              payload: {
                version: 'goal-child-attempt-v1',
                childRunId,
              },
              recordedAt: dependencies.clock(),
            });
          recordsById.set(checkpoint.id, checkpoint);
        }
        children.set(step, childRunId);
        const priorFailures = Object.values(state.latestResults).flatMap(
          (result) =>
            result.status === 'failed'
              ? [{ criterionId: result.criterionId, code: result.code }]
              : [],
        );
        const result = await dependencies.stepRunner.run({
          parentRunId: runId,
          projectId: parent.projectId,
          childRunId,
          step,
          criteria: definitions,
          snapshot: snapshots[0]!,
          priorFailures,
        });
        if (result.childRunId !== childRunId)
          throw new Error('goal step returned a mismatched child run');
        const afterChild = await dependencies.repository.getRun(runId);
        if (afterChild?.status === 'cancelled') {
          await cancelRecordedChildren(dependencies, parent, children);
          return workflowResult(
            dependencies,
            parent,
            { ...state, status: 'cancelled' },
            completedSteps,
            children,
          );
        }
        if (afterChild?.status !== 'running')
          throw new Error('goal parent changed state during child execution');
        const results = await stepResults(
          dependencies,
          result,
          definitions,
          criterionResults,
          step,
          runId,
          childRunId,
        );
        for (const [ordinal, verification] of results.entries()) {
          const record = records[ordinal]!;
          const id = criterionProgressId(runId, step, verification.criterionId);
          if (!recordsById.has(id)) {
            const persisted =
              await dependencies.repository.appendGoalProgressIdempotently({
                id,
                runId,
                criterionId: record.id,
                step,
                status:
                  verification.status === 'passed' ? 'satisfied' : 'failed',
                detail:
                  verification.status === 'passed'
                    ? 'Trusted criterion passed'
                    : `Trusted criterion failed: ${verification.code}`,
                payload: {
                  version: 'goal-criterion-result-v1',
                  result: verification,
                } as unknown as JsonValue,
                recordedAt: dependencies.clock(),
              });
            recordsById.set(persisted.id, persisted);
          }
          criterionResults.set(
            `${String(step)}\u0000${verification.criterionId}`,
            verification,
          );
        }
        state = reduceGoalWorkflow(state, {
          id: `goal:${runId}:step:${String(step)}`,
          type: 'step_evaluated',
          step,
          results,
        });
        completedSteps = step;
      }
      return finishParent(
        dependencies,
        parent,
        state,
        completedSteps,
        children,
      );
    },
  });
}
