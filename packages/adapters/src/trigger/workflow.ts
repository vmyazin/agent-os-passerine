import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  canonicalJsonValue,
  isoTimestamp,
  persistenceId,
  type ArtifactMetadata,
  type ExternalSessionId,
  type JsonValue,
  type RunStatus,
  type RuntimeHandle,
  type RuntimeOutput,
  type StepRun,
  type WorkflowRun,
  type WorkflowRunUpdate,
} from '@agentos/core';
import type { ZodType } from 'zod';

import {
  changeSetSchema,
  definitionOfDoneSchema,
  draftPublicationResultSchema,
  featureSpecificationSchema,
  featureWorkflowInputSchema,
  implementationOutputSchema,
  implementationPlanSchema,
  planOutputSchema,
  reviewArtifactSchema,
  reviewOutputSchema,
  specificationOutputSchema,
  testEvidenceSchema,
} from './schemas.js';
import { createAesWorkflowHandleSealer } from './handle-sealer.js';
import {
  FEATURE_WORKFLOW_DEFAULTS,
  FeatureWorkflowTaskTransientError,
  type DurableFeatureWorkflowDependencies,
  type FeatureRole,
  type FeatureWorkflowInput,
  type FeatureWorkflowResult,
  type WorkflowEffect,
  type WorkflowEffectLease,
} from './types.js';

const SAFE_RUNTIME_EVENTS = new Set([
  'session.created',
  'session.updated',
  'session.completed',
  'session.failed',
  'session.cancelled',
  'message.created',
  'message.completed',
  'tool.started',
  'tool.completed',
]);

const asJson = (value: unknown): JsonValue => {
  const encoded = JSON.stringify(value);
  if (encoded === undefined)
    throw new WorkflowPermanentError('value is not JSON');
  return JSON.parse(encoded) as JsonValue;
};

function isJsonObject(
  value: JsonValue | undefined,
): value is { readonly [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const hash = (value: unknown): string =>
  createHash('sha256')
    .update(canonicalJsonValue(asJson(value)))
    .digest('hex');

const at = (value: string) => isoTimestamp(value);

function triggerWaitDuration(deadlineMs: number, now: string): string {
  const remainingSeconds = Math.ceil((deadlineMs - Date.parse(now)) / 1_000);
  if (
    !Number.isSafeInteger(remainingSeconds) ||
    remainingSeconds < 1 ||
    remainingSeconds > FEATURE_WORKFLOW_DEFAULTS.workflowTimeoutMs / 1_000
  ) {
    throw new WorkflowPermanentError('approval wait duration is out of bounds');
  }
  return `${String(remainingSeconds)}s`;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : 'workflow operation failed')
    .replace(
      /((?:token|secret|password|private.?key))\s*[:=]\s*\S+/gi,
      '$1=[REDACTED]',
    )
    .slice(0, 1_000);
}

function isTransientPublisherError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error))
    return false;
  return (
    error.code === 'github_unavailable' ||
    error.code === 'publication_busy' ||
    error.code === 'publication_store_conflict'
  );
}

export class WorkflowPermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowPermanentError';
  }
}

export class WorkflowTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowTransientError';
  }
}

class RuntimeStartPendingError extends WorkflowTransientError {}

export class WorkflowBudgetExhaustedError extends Error {
  constructor(readonly reason: 'workflow_budget' | 'daily_budget') {
    super(reason);
    this.name = 'WorkflowBudgetExhaustedError';
  }
}

function assertRoleIsolation(
  roles: DurableFeatureWorkflowDependencies['roles'],
): void {
  const agentIds = new Set<string>();
  const environmentIds = new Set<string>();
  for (const role of Object.keys(roles) as FeatureRole[]) {
    const definition = roles[role];
    if (agentIds.has(definition.agent.id))
      throw new WorkflowPermanentError(
        'feature roles must use separate agents',
      );
    if (environmentIds.has(definition.environment.id))
      throw new WorkflowPermanentError(
        'feature roles must use separate environments',
      );
    agentIds.add(definition.agent.id);
    environmentIds.add(definition.environment.id);
    const exposed = [
      ...definition.agent.tools,
      ...definition.agent.mcps,
      ...Object.keys(definition.environment.variables),
    ].join(' ');
    if (
      /(github|merge|publish|private.?key|installation.?token)/i.test(exposed)
    )
      throw new WorkflowPermanentError(
        `role ${role} exposes repository publication authority`,
      );
  }
}

async function parseArtifact<T>(
  dependencies: DurableFeatureWorkflowDependencies,
  workflow: FeatureWorkflowInput,
  metadata: ArtifactMetadata,
  expected: { readonly stepId: string; readonly artifactId: string },
  schema: ZodType<T>,
): Promise<T> {
  if (
    metadata.projectId !== workflow.projectId ||
    metadata.runId !== workflow.runId ||
    metadata.stepId !== expected.stepId ||
    metadata.artifactId !== expected.artifactId
  )
    throw new WorkflowPermanentError('artifact scope does not match workflow');
  const value = await dependencies.artifacts.get({
    scope: {
      projectId: metadata.projectId,
      runId: metadata.runId,
      stepId: metadata.stepId,
    },
    key: metadata.key,
    maxBytes: metadata.sizeBytes,
  });
  if (
    value === undefined ||
    value.digest !== metadata.digest ||
    value.sizeBytes !== metadata.sizeBytes ||
    value.mediaType !== 'application/json'
  ) {
    throw new WorkflowPermanentError('artifact manifest could not be verified');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(value.bytes),
    );
  } catch {
    throw new WorkflowPermanentError('artifact is not valid UTF-8 JSON');
  }
  const result = schema.safeParse(decoded);
  if (!result.success)
    throw new WorkflowPermanentError(
      'artifact did not match its required schema',
    );
  return result.data;
}

function effectDraft(
  runId: string,
  key: string,
  kind: string,
  input: unknown,
  now: string,
): Omit<
  WorkflowEffect,
  'status' | 'ownerId' | 'leaseVersion' | 'leaseExpiresAt'
> {
  return {
    key,
    runId,
    kind,
    inputFingerprint: hash(input),
    createdAt: now,
    updatedAt: now,
  };
}

function handleAad(
  workflow: FeatureWorkflowInput,
  stepId: string,
  role: FeatureRole,
  externalId: string,
): JsonValue {
  return asJson({
    version: 'runtime-handle-aad-v1',
    runId: workflow.runId,
    stepId,
    role,
    externalId,
    repositorySha: workflow.source.repositorySha,
    sourceSnapshotDigest: workflow.source.sourceSnapshotDigest,
    configDigest: workflow.digests.config,
  });
}

function effectLease(
  effect: WorkflowEffect,
  ownerId: string,
): WorkflowEffectLease {
  if (effect.ownerId !== ownerId)
    throw new WorkflowTransientError(
      'workflow effect is owned by another execution',
    );
  return { key: effect.key, ownerId, leaseVersion: effect.leaseVersion };
}

async function claimEffect(
  dependencies: DurableFeatureWorkflowDependencies,
  ownerId: string,
  draft: Omit<
    WorkflowEffect,
    'status' | 'ownerId' | 'leaseVersion' | 'leaseExpiresAt'
  >,
  leaseMs: number,
): Promise<{ effect: WorkflowEffect; lease: WorkflowEffectLease }> {
  const now = dependencies.clock();
  const effect = await dependencies.checkpoints.claimEffect(draft, {
    ownerId,
    now,
    leaseExpiresAt: new Date(Date.parse(now) + leaseMs).toISOString(),
  });
  return {
    effect,
    lease:
      effect.status === 'succeeded'
        ? {
            key: effect.key,
            ownerId: effect.ownerId ?? ownerId,
            leaseVersion: effect.leaseVersion,
          }
        : effectLease(effect, ownerId),
  };
}

async function sumWorkflowUsage(
  dependencies: DurableFeatureWorkflowDependencies,
  runId: string,
): Promise<number> {
  const values = await dependencies.repository.listUsage(
    persistenceId('run', runId),
    { limit: 1_000 },
  );
  return values.reduce((total, item) => total + item.microdollars, 0);
}

function isTerminalRun(status: string): boolean {
  return (
    status === 'cancelled' || status === 'failed' || status === 'succeeded'
  );
}

function terminalResult(run: {
  readonly status: string;
  readonly output?: JsonValue;
}): FeatureWorkflowResult {
  if (run.status === 'cancelled') return { status: 'cancelled' };
  if (run.status === 'succeeded' && isJsonObject(run.output))
    return run.output as unknown as FeatureWorkflowResult;
  if (run.status === 'failed' && isJsonObject(run.output))
    return run.output as unknown as FeatureWorkflowResult;
  return { status: 'failed', reason: `run_${run.status}` };
}

async function transitionCurrentRun(
  dependencies: DurableFeatureWorkflowDependencies,
  runId: ReturnType<typeof persistenceId<'run'>>,
  expectedStatuses: readonly RunStatus[],
  update: WorkflowRunUpdate,
): Promise<WorkflowRun | undefined> {
  const current = await dependencies.repository.getRun(runId);
  if (current === undefined || isTerminalRun(current.status)) return undefined;
  return dependencies.repository.transitionRun(
    runId,
    expectedStatuses,
    update,
    current.stateVersion ?? 0,
  );
}

async function assertContinuable(
  dependencies: DurableFeatureWorkflowDependencies,
  workflow: FeatureWorkflowInput,
  deadlineMs: number,
): Promise<void> {
  const run = await dependencies.repository.getRun(
    persistenceId('run', workflow.runId),
  );
  if (run === undefined)
    throw new WorkflowPermanentError('workflow run does not exist');
  if (run.projectId !== workflow.projectId)
    throw new WorkflowPermanentError('workflow project binding mismatch');
  if (run.status === 'cancelled')
    throw new WorkflowPermanentError('run_cancelled');
  if (run.status === 'failed') throw new WorkflowPermanentError('run_failed');
  if (Date.parse(dependencies.clock()) >= deadlineMs)
    throw new WorkflowPermanentError('workflow_deadline_exceeded');
}

async function consumeEvents(
  dependencies: DurableFeatureWorkflowDependencies,
  runId: string,
  handle: RuntimeHandle,
): Promise<void> {
  let count = 0;
  for await (const event of dependencies.runtime.events(handle)) {
    const run = await dependencies.repository.getRun(
      persistenceId('run', runId),
    );
    if (run?.status === 'cancelled') {
      await dependencies.runtime.cancel(
        handle,
        'authoritative run cancellation',
      );
      throw new WorkflowPermanentError('run_cancelled');
    }
    count += 1;
    if (count > 10_000)
      throw new WorkflowPermanentError('runtime emitted too many events');
    if (
      typeof event.id !== 'string' ||
      event.id.length < 1 ||
      event.id.length > 256 ||
      !SAFE_RUNTIME_EVENTS.has(event.type) ||
      !(event.occurredAt instanceof Date) ||
      !Number.isFinite(event.occurredAt.getTime())
    ) {
      throw new WorkflowPermanentError('runtime emitted a malformed event');
    }
  }
}

function classifiedRuntimeError(error: unknown): Error {
  if (
    error instanceof WorkflowPermanentError ||
    error instanceof WorkflowTransientError ||
    error instanceof WorkflowBudgetExhaustedError
  )
    return error;
  const code =
    typeof error === 'object' && error !== null
      ? Reflect.get(error, 'code')
      : undefined;
  const status =
    typeof error === 'object' && error !== null
      ? Reflect.get(error, 'status')
      : undefined;
  if (
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'timeout_error' ||
    code === 'overloaded_error' ||
    code === 'rate_limit_error' ||
    code === 429 ||
    code === 502 ||
    code === 503 ||
    code === 504 ||
    status === 429 ||
    status === 502 ||
    status === 503 ||
    status === 504
  )
    return new WorkflowTransientError('runtime transient failure');
  return error instanceof Error
    ? error
    : new WorkflowPermanentError('runtime operation failed');
}

async function withTimeout<T>(
  operation: Promise<T>,
  milliseconds: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new WorkflowTransientError('runtime session timed out')),
      milliseconds,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function runAgentStep<T>(
  dependencies: DurableFeatureWorkflowDependencies,
  workflow: FeatureWorkflowInput,
  deadlineMs: number,
  stepKey: string,
  role: FeatureRole,
  input: JsonValue,
  schema: ZodType<T>,
  ownerId: string,
  handleSealer: NonNullable<DurableFeatureWorkflowDependencies['handleSealer']>,
): Promise<T> {
  const inputFingerprint = hash(input);
  const existing = await dependencies.repository.listStepRuns(
    persistenceId('run', workflow.runId),
    { limit: 100 },
  );
  for (const step of existing.filter(
    (candidate) => candidate.stepKey === stepKey,
  )) {
    const storedFingerprint =
      isJsonObject(step.input) &&
      typeof step.input.inputFingerprint === 'string'
        ? step.input.inputFingerprint
        : undefined;
    if (storedFingerprint !== inputFingerprint)
      throw new WorkflowPermanentError(
        `step ${stepKey} was replayed with different input`,
      );
    if (step.status === 'succeeded') {
      const replay = schema.safeParse(step.output);
      if (!replay.success)
        throw new WorkflowPermanentError(
          `stored output for ${stepKey} is invalid`,
        );
      return replay.data;
    }
  }

  let lastError: unknown;
  for (
    let attempt = 1;
    attempt <= FEATURE_WORKFLOW_DEFAULTS.maxStepAttempts;
    attempt += 1
  ) {
    await assertContinuable(dependencies, workflow, deadlineMs);
    const stepId = persistenceId(
      'stepRun',
      `${workflow.runId}:${stepKey}:${String(attempt)}`,
    );
    const now = at(dependencies.clock());
    const roleDefinition = dependencies.roles[role];
    const prior = existing.find(
      (candidate) =>
        candidate.stepKey === stepKey && candidate.attempt === attempt,
    );
    const step: StepRun = prior ?? {
      id: stepId,
      runId: persistenceId('run', workflow.runId),
      stepKey,
      attempt,
      status: 'pending',
      input: asJson({
        inputFingerprint,
        payload: input,
        provenance: {
          workflowVersion: 'feature-workflow-v1',
          taskVersion:
            dependencies.execution?.taskVersion ??
            'agentos-feature-workflow-v1',
          deploymentVersion:
            dependencies.execution?.deploymentVersion ?? 'test-or-unknown',
          role,
          agentId: roleDefinition.agent.id,
          model: roleDefinition.agent.model,
          environmentId: roleDefinition.environment.id,
          environmentRuntime: roleDefinition.environment.runtime,
          repositorySha: workflow.source.repositorySha,
          execution: dependencies.execution ?? {
            taskVersion: 'agentos-feature-workflow-v1',
            deploymentVersion: 'test-or-unknown',
          },
          sourceSnapshotDigest: workflow.source.sourceSnapshotDigest,
          digests: workflow.digests,
        },
      }),
      createdAt: now,
      updatedAt: now,
    };
    const effectKey = `runtime:${workflow.runId}:${stepKey}:${String(attempt)}`;
    const claim = await claimEffect(
      dependencies,
      ownerId,
      effectDraft(
        workflow.runId,
        effectKey,
        'runtime-session',
        {
          stepKey,
          attempt,
          inputFingerprint,
          agentId: roleDefinition.agent.id,
          environmentId: roleDefinition.environment.id,
          digests: workflow.digests,
          repositorySha: workflow.source.repositorySha,
          sourceSnapshotDigest: workflow.source.sourceSnapshotDigest,
          execution: dependencies.execution ?? {
            taskVersion: 'agentos-feature-workflow-v1',
            deploymentVersion: 'test-or-unknown',
          },
        },
        now,
      ),
      FEATURE_WORKFLOW_DEFAULTS.sessionTimeoutMs + 60_000,
    );
    const claimed = claim.effect;
    if (claimed.status === 'succeeded') {
      const parsed = schema.safeParse(claimed.output);
      if (!parsed.success)
        throw new WorkflowPermanentError(
          `checkpoint output for ${stepKey} is invalid`,
        );
      await dependencies.repository.upsertStepRun({
        ...step,
        status: 'succeeded',
        output: asJson(parsed.data),
        updatedAt: now,
        completedAt: now,
      });
      return parsed.data;
    }
    if (claimed.status === 'dead_letter')
      throw new WorkflowPermanentError(
        claimed.error ?? 'dead-lettered session',
      );
    if (claimed.status === 'failed') {
      lastError = new WorkflowTransientError(
        claimed.error ?? 'transient session failure',
      );
      continue;
    }

    const workflowSpent = await sumWorkflowUsage(dependencies, workflow.runId);
    const dailySpent = await (dependencies.dailyUsageMicrodollars?.(
      dependencies.clock(),
      workflow.projectId,
    ) ?? Promise.resolve(workflowSpent));
    const estimatedMicrodollars =
      roleDefinition.maxReservationMicrodollars ??
      FEATURE_WORKFLOW_DEFAULTS.defaultSessionReservationMicrodollars;
    if (
      !Number.isSafeInteger(estimatedMicrodollars) ||
      estimatedMicrodollars < 1 ||
      estimatedMicrodollars > FEATURE_WORKFLOW_DEFAULTS.workflowMicrodollars
    ) {
      throw new WorkflowPermanentError('role cost reservation is invalid');
    }
    const reservationKey = `reservation:${effectKey}`;
    const admission = await dependencies.checkpoints.admitSession({
      reservationKey,
      projectId: workflow.projectId,
      runId: workflow.runId,
      stepKey,
      workflowSpentMicrodollars: workflowSpent,
      dailySpentMicrodollars: dailySpent,
      workflowLimitMicrodollars: FEATURE_WORKFLOW_DEFAULTS.workflowMicrodollars,
      dailyLimitMicrodollars: FEATURE_WORKFLOW_DEFAULTS.dailyMicrodollars,
      admissionNumerator: FEATURE_WORKFLOW_DEFAULTS.admissionNumerator,
      admissionDenominator: FEATURE_WORKFLOW_DEFAULTS.admissionDenominator,
      now,
      leaseExpiresAt: new Date(
        Date.parse(now) + FEATURE_WORKFLOW_DEFAULTS.sessionTimeoutMs + 60_000,
      ).toISOString(),
      estimatedMicrodollars,
    });
    if (!admission.admitted) {
      if (admission.reason === 'concurrency')
        throw new WorkflowTransientError('global workflow session is busy');
      throw new WorkflowBudgetExhaustedError(admission.reason);
    }

    let handle: RuntimeHandle | undefined;
    let externalSessionId: ExternalSessionId | undefined;
    let usageSettled = false;
    let runtimeStartAttempted = false;
    const settleUsage = async (candidate?: RuntimeHandle): Promise<void> => {
      if (usageSettled) return;
      let usage = {
        inputTokens: 0,
        outputTokens: 0,
        runtimeMs: runtimeStartAttempted
          ? FEATURE_WORKFLOW_DEFAULTS.sessionTimeoutMs
          : 0,
      };
      let microdollars = runtimeStartAttempted ? estimatedMicrodollars : 0;
      if (candidate !== undefined) {
        try {
          const reported = await dependencies.runtime.usage(candidate);
          const priced = dependencies.priceUsage(
            reported,
            roleDefinition.agent.model,
          );
          if (!Number.isSafeInteger(priced) || priced < 0)
            throw new Error('invalid reported price');
          usage = reported;
          microdollars = priced;
        } catch {
          // Charge the full reservation if the provider cannot report usage.
        }
      }
      await dependencies.repository.appendUsage({
        idempotencyId: persistenceId(
          'usage',
          `usage:${workflow.runId}:${stepKey}:${String(attempt)}`,
        ),
        runId: persistenceId('run', workflow.runId),
        stepRunId: stepId,
        model: roleDefinition.agent.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        runtimeMs: usage.runtimeMs,
        microdollars,
        recordedAt: at(dependencies.clock()),
      });
      const settlement = await dependencies.checkpoints.settleSession({
        reservationKey,
        runId: workflow.runId,
        stepKey,
        actualMicrodollars: microdollars,
        workflowSpentMicrodollars: workflowSpent + microdollars,
        dailySpentMicrodollars: dailySpent + microdollars,
        workflowLimitMicrodollars:
          FEATURE_WORKFLOW_DEFAULTS.workflowMicrodollars,
        dailyLimitMicrodollars: FEATURE_WORKFLOW_DEFAULTS.dailyMicrodollars,
        now: dependencies.clock(),
      });
      usageSettled = true;
      if (!settlement.settled)
        throw new WorkflowBudgetExhaustedError(settlement.reason);
    };
    try {
      await dependencies.runtime.syncAgent(roleDefinition.agent);
      await dependencies.runtime.syncEnvironment(roleDefinition.environment);
      const started = await dependencies.checkpoints.markEffectStarted(
        claim.lease,
        dependencies.clock(),
      );
      const startRequest = {
        runId: workflow.runId,
        stepId,
        agentId: roleDefinition.agent.id,
        environmentId: roleDefinition.environment.id,
        input,
        timeoutMs: FEATURE_WORKFLOW_DEFAULTS.sessionTimeoutMs,
        idempotencyKey: effectKey,
        maxCostMicrodollars: estimatedMicrodollars,
      };
      if (
        started.status === 'started' &&
        started.externalRef === undefined &&
        claimed.status === 'started'
      ) {
        if (dependencies.runtime.reconcileStart === undefined)
          throw new WorkflowPermanentError(
            'runtime provider does not support start reconciliation',
          );
        runtimeStartAttempted = true;
        handle = await dependencies.runtime.reconcileStart(startRequest);
        if (handle === undefined)
          throw new RuntimeStartPendingError(
            'runtime start reconciliation has not found the session yet',
          );
      }
      if (started.externalRef === undefined) {
        await dependencies.repository.upsertStepRun({
          ...step,
          status: 'running',
          updatedAt: at(dependencies.clock()),
          startedAt: at(dependencies.clock()),
        });
        runtimeStartAttempted = true;
        if (handle === undefined) {
          try {
            handle = await dependencies.runtime.start(startRequest);
          } catch (startError) {
            if (startError instanceof WorkflowTransientError) throw startError;
            const classified = classifiedRuntimeError(startError);
            if (!(classified instanceof WorkflowTransientError))
              throw classified;
            if (dependencies.runtime.reconcileStart === undefined)
              throw new WorkflowPermanentError(
                'runtime provider does not support start reconciliation',
              );
            handle = await dependencies.runtime.reconcileStart(startRequest);
            if (handle === undefined)
              throw new RuntimeStartPendingError(
                'runtime create response was ambiguous and reconciliation is pending',
              );
          }
        }
        await dependencies.checkpoints.attachExternalRef(
          claim.lease,
          handle.id,
          dependencies.clock(),
        );
        const externalId = persistenceId(
          'externalSession',
          `runtime:${handle.id}`,
        );
        externalSessionId = externalId;
        if (
          (await dependencies.repository.getExternalSession(externalId)) ===
          undefined
        ) {
          const sealedHandle = await handleSealer.seal(
            handle,
            handleAad(workflow, stepId, role, handle.id),
          );
          const aad = handleAad(workflow, stepId, role, handle.id);
          await dependencies.repository.createExternalSession({
            id: externalId,
            runId: persistenceId('run', workflow.runId),
            stepRunId: stepId,
            provider: 'runtime',
            externalId: handle.id,
            status: 'active',
            state: {
              version: 'sealed-runtime-handle-state-v1',
              sealedHandle,
              aad,
              role,
            },
            createdAt: at(dependencies.clock()),
          });
        }
      } else {
        externalSessionId = persistenceId(
          'externalSession',
          `runtime:${started.externalRef}`,
        );
        const external =
          await dependencies.repository.getExternalSession(externalSessionId);
        if (
          external === undefined ||
          !isJsonObject(external.state) ||
          external.state.version !== 'sealed-runtime-handle-state-v1' ||
          typeof external.state.sealedHandle !== 'string'
        ) {
          throw new WorkflowPermanentError(
            'persisted runtime handle is unavailable',
          );
        }
        handle = await handleSealer.open(
          external.state.sealedHandle,
          handleAad(workflow, stepId, role, started.externalRef),
        );
        if (handle.id !== started.externalRef)
          throw new WorkflowPermanentError('persisted runtime handle mismatch');
      }
      const runtimeOutput: RuntimeOutput = await withTimeout(
        (async () => {
          await consumeEvents(dependencies, workflow.runId, handle!);
          return dependencies.runtime.collectOutput(handle!);
        })(),
        Math.max(
          1,
          Math.min(
            FEATURE_WORKFLOW_DEFAULTS.sessionTimeoutMs,
            deadlineMs - Date.parse(dependencies.clock()),
          ),
        ),
      );
      await settleUsage(handle);
      const parsed = schema.safeParse(runtimeOutput.data);
      if (!parsed.success)
        throw new WorkflowPermanentError(
          `runtime output for ${stepKey} is invalid`,
        );
      await dependencies.checkpoints.completeEffect(
        claim.lease,
        asJson(parsed.data),
        dependencies.clock(),
      );
      await dependencies.repository.upsertStepRun({
        ...step,
        status: 'succeeded',
        output: asJson(parsed.data),
        externalSessionId: persistenceId(
          'externalSession',
          `runtime:${handle.id}`,
        ),
        updatedAt: at(dependencies.clock()),
        completedAt: at(dependencies.clock()),
      });
      if (externalSessionId !== undefined) {
        await dependencies.repository.updateExternalSession(externalSessionId, {
          status: 'completed',
          updatedAt: at(dependencies.clock()),
        });
      }
      return parsed.data;
    } catch (rawError) {
      if (rawError instanceof RuntimeStartPendingError) {
        await dependencies.checkpoints.renewEffect(
          claim.lease,
          dependencies.clock(),
          dependencies.clock(),
        );
        throw rawError;
      }
      let failure = rawError;
      try {
        await settleUsage(handle);
      } catch (settlementError) {
        failure = settlementError;
      }
      const error = classifiedRuntimeError(failure);
      lastError = error;
      const transient = error instanceof WorkflowTransientError;
      if (handle !== undefined) {
        try {
          await dependencies.runtime.cancel(handle, safeError(error));
        } catch {
          // Durable cancellation/cleanup reconciliation owns a failed cancel.
        }
      }
      await dependencies.checkpoints.failEffect(
        claim.lease,
        safeError(error),
        !transient,
        dependencies.clock(),
      );
      await dependencies.repository.upsertStepRun({
        ...step,
        status: 'failed',
        error: {
          code: transient ? 'transient' : 'permanent',
          message: safeError(error),
        },
        updatedAt: at(dependencies.clock()),
        completedAt: at(dependencies.clock()),
      });
      if (externalSessionId !== undefined) {
        await dependencies.repository.updateExternalSession(externalSessionId, {
          status: safeError(error) === 'run_cancelled' ? 'cancelled' : 'failed',
          updatedAt: at(dependencies.clock()),
        });
      }
      if (!transient) throw error;
    } finally {
      let cleaned = false;
      if (handle !== undefined) {
        try {
          await dependencies.runtime.cleanup(handle);
          cleaned = true;
        } catch {
          // Reconciliation owns retrying cleanup; do not replace the primary result.
        }
      }
      if (externalSessionId !== undefined && cleaned) {
        await dependencies.repository.updateExternalSession(externalSessionId, {
          cleanupAt: at(dependencies.clock()),
          updatedAt: at(dependencies.clock()),
        });
      }
      if (usageSettled)
        await dependencies.checkpoints.releaseSession(workflow.runId, stepKey);
    }
  }
  throw lastError ?? new WorkflowPermanentError(`step ${stepKey} failed`);
}

async function getAuthoritativeApproval(
  dependencies: DurableFeatureWorkflowDependencies,
  workflow: FeatureWorkflowInput,
  approvalId: string,
  scopeHash: string,
): Promise<'approve' | 'reject' | 'expired'> {
  const approval = await dependencies.repository.getApproval(
    persistenceId('approval', approvalId),
  );
  if (
    approval === undefined ||
    approval.runId !== workflow.runId ||
    approval.scope !== 'feature-spec-and-dod' ||
    approval.fingerprint !== scopeHash
  ) {
    throw new WorkflowPermanentError('approval binding mismatch');
  }
  if (approval.status === 'expired') return 'expired';
  if (approval.status !== 'consumed')
    throw new WorkflowPermanentError(
      'waitpoint woke without an authoritative approval',
    );
  const events = await dependencies.repository.listEvents(
    persistenceId('run', workflow.runId),
    { limit: 1_000 },
  );
  const event = events.find(
    (candidate) =>
      (candidate.type === 'approval.approved' ||
        candidate.type === 'approval.rejected') &&
      isJsonObject(candidate.payload) &&
      candidate.payload.approvalId === approvalId &&
      candidate.payload.scopeHash === scopeHash,
  );
  if (event === undefined)
    throw new WorkflowPermanentError('approval decision event is missing');
  return event.type === 'approval.approved' ? 'approve' : 'reject';
}

export function createDurableFeatureWorkflow(
  dependencies: DurableFeatureWorkflowDependencies,
): { run(input: unknown): Promise<FeatureWorkflowResult> } {
  assertRoleIsolation(dependencies.roles);
  const executionOwner = `workflow:${randomUUID()}`;
  const handleSealer =
    dependencies.handleSealer ?? createAesWorkflowHandleSealer(randomBytes(32));
  return Object.freeze({
    async run(rawInput: unknown): Promise<FeatureWorkflowResult> {
      const parsed = featureWorkflowInputSchema.safeParse(rawInput);
      if (!parsed.success)
        throw new WorkflowPermanentError('invalid workflow input');
      const workflow = parsed.data;
      const runId = persistenceId('run', workflow.runId);
      const run = await dependencies.repository.getRun(runId);
      if (run === undefined)
        throw new WorkflowPermanentError('workflow run does not exist');
      if (isTerminalRun(run.status)) return terminalResult(run);
      const deadlineMs =
        Date.parse(run.createdAt) + FEATURE_WORKFLOW_DEFAULTS.workflowTimeoutMs;
      const started = await dependencies.repository.transitionRun(
        runId,
        ['pending', 'running', 'waiting'],
        {
          status: 'running',
          updatedAt: at(dependencies.clock()),
          startedAt: run.startedAt ?? at(dependencies.clock()),
        },
        run.stateVersion ?? 0,
      );
      if (started === undefined) {
        const latest = await dependencies.repository.getRun(runId);
        if (latest === undefined)
          throw new WorkflowPermanentError('workflow run disappeared');
        return terminalResult(latest);
      }
      try {
        const specification = await runAgentStep(
          dependencies,
          workflow,
          deadlineMs,
          'specification',
          'specification',
          asJson({
            version: 'specification-request-v1',
            feature: workflow.feature,
            source: workflow.source,
            digests: workflow.digests,
            outputContract: 'specification-output-v1',
          }),
          specificationOutputSchema,
          executionOwner,
          handleSealer,
        );
        await parseArtifact(
          dependencies,
          workflow,
          specification.specification,
          { stepId: 'specification', artifactId: 'specification' },
          featureSpecificationSchema,
        );
        const dodBody = await parseArtifact(
          dependencies,
          workflow,
          specification.definitionOfDone,
          { stepId: 'specification', artifactId: 'dod' },
          definitionOfDoneSchema,
        );
        const scopeHash = hash({
          runId: workflow.runId,
          scope: 'feature-spec-and-dod',
          repositorySha: workflow.source.repositorySha,
          sourceSnapshotDigest: workflow.source.sourceSnapshotDigest,
          digests: workflow.digests,
          specificationDigest: specification.specification.digest,
          definitionOfDoneDigest: specification.definitionOfDone.digest,
        });
        const approvalId = `approval_${scopeHash.slice(0, 32)}`;
        if (
          (await dependencies.repository.getApproval(
            persistenceId('approval', approvalId),
          )) === undefined
        ) {
          await dependencies.repository.createApproval({
            id: persistenceId('approval', approvalId),
            runId,
            scope: 'feature-spec-and-dod',
            fingerprint: scopeHash,
            status: 'pending',
            createdAt: at(dependencies.clock()),
            expiresAt: at(new Date(deadlineMs).toISOString()),
          });
        }
        const waitEffectKey = `waitpoint:${workflow.runId}:${approvalId}`;
        const waitDraft = effectDraft(
          workflow.runId,
          waitEffectKey,
          'approval-waitpoint',
          {
            approvalId,
            scopeHash,
            deadline: new Date(deadlineMs).toISOString(),
          },
          dependencies.clock(),
        );
        const waitClaim = await claimEffect(
          dependencies,
          executionOwner,
          waitDraft,
          2 * 60_000,
        );
        const waitEffect = waitClaim.effect;
        let waitpointId = waitEffect.externalRef;
        if (waitpointId === undefined) {
          await dependencies.checkpoints.markEffectStarted(
            waitClaim.lease,
            dependencies.clock(),
          );
          const waitpoint = await dependencies.approval.create({
            idempotencyKey: waitEffectKey,
            timeout: triggerWaitDuration(deadlineMs, dependencies.clock()),
            tags: [`run:${workflow.runId}`, `approval:${approvalId}`],
          });
          waitpointId = waitpoint.id;
          await dependencies.checkpoints.attachExternalRef(
            waitClaim.lease,
            waitpoint.id,
            dependencies.clock(),
          );
        }
        if (
          (await transitionCurrentRun(dependencies, runId, ['running'], {
            status: 'waiting',
            updatedAt: at(dependencies.clock()),
          })) === undefined
        ) {
          await assertContinuable(dependencies, workflow, deadlineMs);
          throw new WorkflowPermanentError(
            'run state changed before approval wait',
          );
        }
        const wake = await dependencies.approval.wait(waitpointId);
        if (wake.status === 'timed_out') {
          await dependencies.repository.expireApproval(
            persistenceId('approval', approvalId),
            {
              runId,
              scope: 'feature-spec-and-dod',
              fingerprint: scopeHash,
              at: at(new Date(deadlineMs).toISOString()),
            },
          );
          const result: FeatureWorkflowResult = { status: 'expired' };
          await transitionCurrentRun(dependencies, runId, ['waiting'], {
            status: 'failed',
            output: asJson(result),
            error: { code: 'approval_expired' },
            updatedAt: at(dependencies.clock()),
            completedAt: at(dependencies.clock()),
          });
          return result;
        }
        const decision = await getAuthoritativeApproval(
          dependencies,
          workflow,
          approvalId,
          scopeHash,
        );
        const waitCompletionClaim = await claimEffect(
          dependencies,
          executionOwner,
          waitDraft,
          2 * 60_000,
        );
        await dependencies.checkpoints.completeEffect(
          waitCompletionClaim.lease,
          { approvalId, decision },
          dependencies.clock(),
        );
        if (decision !== 'approve') {
          const result: FeatureWorkflowResult = {
            status: decision === 'expired' ? 'expired' : 'rejected',
          };
          await transitionCurrentRun(dependencies, runId, ['waiting'], {
            status: 'failed',
            output: asJson(result),
            error: { code: `approval_${decision}` },
            updatedAt: at(dependencies.clock()),
            completedAt: at(dependencies.clock()),
          });
          return result;
        }
        if (
          (await transitionCurrentRun(dependencies, runId, ['waiting'], {
            status: 'running',
            updatedAt: at(dependencies.clock()),
          })) === undefined
        ) {
          await assertContinuable(dependencies, workflow, deadlineMs);
          throw new WorkflowPermanentError('run state changed after approval');
        }
        const plan = await runAgentStep(
          dependencies,
          workflow,
          deadlineMs,
          'planning',
          'planning',
          asJson({
            version: 'plan-request-v1',
            approvedScopeHash: scopeHash,
            specificationDigest: specification.specification.digest,
            definitionOfDoneDigest: specification.definitionOfDone.digest,
            digests: workflow.digests,
          }),
          planOutputSchema,
          executionOwner,
          handleSealer,
        );
        await parseArtifact(
          dependencies,
          workflow,
          plan.plan,
          { stepId: 'planning', artifactId: 'plan' },
          implementationPlanSchema,
        );
        let implementation = await runAgentStep(
          dependencies,
          workflow,
          deadlineMs,
          'implementation',
          'implementation',
          asJson({
            version: 'implementation-request-v1',
            planDigest: plan.plan.digest,
            approvedScopeHash: scopeHash,
            source: workflow.source,
            digests: workflow.digests,
          }),
          implementationOutputSchema,
          executionOwner,
          handleSealer,
        );
        let producingStepId = 'implementation';
        let changeSet = await parseArtifact(
          dependencies,
          workflow,
          implementation.changeSet,
          { stepId: 'implementation', artifactId: 'changes' },
          changeSetSchema,
        );
        let testEvidence = await parseArtifact(
          dependencies,
          workflow,
          implementation.testEvidence,
          { stepId: 'implementation', artifactId: 'tests' },
          testEvidenceSchema,
        );
        const review = await runAgentStep(
          dependencies,
          workflow,
          deadlineMs,
          'review',
          'review',
          asJson({
            version: 'review-request-v1',
            changeSetDigest: implementation.changeSet.digest,
            testEvidenceDigest: implementation.testEvidence.digest,
            definitionOfDoneDigest: specification.definitionOfDone.digest,
            digests: workflow.digests,
          }),
          reviewOutputSchema,
          executionOwner,
          handleSealer,
        );
        let reviewBody = await parseArtifact(
          dependencies,
          workflow,
          review.review,
          { stepId: 'review', artifactId: 'review' },
          reviewArtifactSchema,
        );
        if (review.decision !== reviewBody.decision)
          throw new WorkflowPermanentError('review decision mismatch');
        if (review.decision === 'changes_requested') {
          implementation = await runAgentStep(
            dependencies,
            workflow,
            deadlineMs,
            'fix',
            'implementation',
            asJson({
              version: 'fix-request-v1',
              priorChangeSetDigest: implementation.changeSet.digest,
              reviewDigest: review.review.digest,
              planDigest: plan.plan.digest,
              digests: workflow.digests,
            }),
            implementationOutputSchema,
            executionOwner,
            handleSealer,
          );
          producingStepId = 'fix';
          changeSet = await parseArtifact(
            dependencies,
            workflow,
            implementation.changeSet,
            { stepId: 'fix', artifactId: 'changes' },
            changeSetSchema,
          );
          testEvidence = await parseArtifact(
            dependencies,
            workflow,
            implementation.testEvidence,
            { stepId: 'fix', artifactId: 'tests' },
            testEvidenceSchema,
          );
          const finalReview = await runAgentStep(
            dependencies,
            workflow,
            deadlineMs,
            'review-after-fix',
            'review',
            asJson({
              version: 'review-request-v1',
              changeSetDigest: implementation.changeSet.digest,
              testEvidenceDigest: implementation.testEvidence.digest,
              definitionOfDoneDigest: specification.definitionOfDone.digest,
              digests: workflow.digests,
            }),
            reviewOutputSchema,
            executionOwner,
            handleSealer,
          );
          reviewBody = await parseArtifact(
            dependencies,
            workflow,
            finalReview.review,
            { stepId: 'review-after-fix', artifactId: 'review' },
            reviewArtifactSchema,
          );
          if (
            finalReview.decision !== 'approved' ||
            reviewBody.decision !== 'approved'
          ) {
            throw new WorkflowPermanentError(
              'final review after fix must be approved',
            );
          }
        }
        await assertContinuable(dependencies, workflow, deadlineMs);
        const verification = await dependencies.verifier.verify({
          runId: workflow.runId,
          workflow,
          producingStepId,
          definitionOfDone: asJson(dodBody),
          changeSet: asJson(changeSet),
          testEvidence: asJson(testEvidence),
          review: asJson(reviewBody),
        });
        if (!verification.passed) {
          throw new WorkflowPermanentError(
            `trusted verification failed: ${(verification.findings ?? []).join('; ').slice(0, 500)}`,
          );
        }
        if (!/^[0-9a-f]{64}$/.test(verification.evidenceDigest))
          throw new WorkflowPermanentError(
            'trusted verifier returned an invalid digest',
          );
        await assertContinuable(dependencies, workflow, deadlineMs);
        const publicationRequest =
          await dependencies.publicationAuthority.authorize({
            workflow,
            changeSet: asJson(changeSet),
            testEvidence: asJson(testEvidence),
            verification,
            artifacts: [
              implementation.changeSet,
              implementation.testEvidence,
              specification.definitionOfDone,
            ],
          });
        const publicationKey = `publisher:${workflow.runId}`;
        const publicationClaim = await claimEffect(
          dependencies,
          executionOwner,
          effectDraft(
            workflow.runId,
            publicationKey,
            'trusted-draft-publication',
            publicationRequest,
            dependencies.clock(),
          ),
          2 * 60_000,
        );
        const publicationEffect = publicationClaim.effect;
        let publication: {
          status: 'succeeded';
          draft: true;
          pullRequestUrl: string;
        };
        if (publicationEffect.status === 'succeeded') {
          const replay = draftPublicationResultSchema.safeParse(
            publicationEffect.output,
          );
          if (!replay.success)
            throw new WorkflowPermanentError(
              'stored publisher result is invalid',
            );
          publication = replay.data;
        } else {
          if (publicationEffect.status === 'dead_letter') {
            throw new WorkflowPermanentError(
              publicationEffect.error ?? 'publisher call was dead-lettered',
            );
          }
          await dependencies.checkpoints.markEffectStarted(
            publicationClaim.lease,
            dependencies.clock(),
          );
          await assertContinuable(dependencies, workflow, deadlineMs);
          let rawPublication: unknown;
          try {
            rawPublication =
              await dependencies.publisher.publish(publicationRequest);
          } catch (error) {
            const transient = isTransientPublisherError(error);
            await dependencies.checkpoints.failEffect(
              publicationClaim.lease,
              safeError(error),
              !transient,
              dependencies.clock(),
            );
            if (transient) throw new WorkflowTransientError(safeError(error));
            throw new WorkflowPermanentError(safeError(error));
          }
          const parsedPublication =
            draftPublicationResultSchema.safeParse(rawPublication);
          if (!parsedPublication.success) {
            await dependencies.checkpoints.failEffect(
              publicationClaim.lease,
              'publisher returned an invalid result',
              true,
              dependencies.clock(),
            );
            throw new WorkflowPermanentError(
              'publisher returned an invalid result',
            );
          }
          publication = parsedPublication.data;
          await dependencies.checkpoints.completeEffect(
            publicationClaim.lease,
            asJson(publication),
            dependencies.clock(),
          );
        }
        const result: FeatureWorkflowResult = {
          status: 'succeeded',
          draftPullRequestUrl: publication.pullRequestUrl,
        };
        if (
          (await transitionCurrentRun(dependencies, runId, ['running'], {
            status: 'succeeded',
            output: asJson(result),
            updatedAt: at(dependencies.clock()),
            completedAt: at(dependencies.clock()),
            cleanupAt: at(
              new Date(
                Date.parse(dependencies.clock()) + 24 * 60 * 60 * 1_000,
              ).toISOString(),
            ),
          })) === undefined
        ) {
          const latest = await dependencies.repository.getRun(runId);
          if (latest === undefined)
            throw new WorkflowPermanentError('workflow run disappeared');
          return terminalResult(latest);
        }
        return result;
      } catch (error) {
        const latest = await dependencies.repository.getRun(runId);
        if (latest?.status === 'cancelled') return { status: 'cancelled' };
        if (error instanceof WorkflowTransientError)
          throw new FeatureWorkflowTaskTransientError(safeError(error));
        const result: FeatureWorkflowResult =
          error instanceof WorkflowBudgetExhaustedError
            ? { status: 'budget_exhausted', reason: error.reason }
            : { status: 'failed', reason: safeError(error) };
        if (latest !== undefined && !isTerminalRun(latest.status)) {
          await transitionCurrentRun(
            dependencies,
            runId,
            ['pending', 'running', 'waiting'],
            {
              status: 'failed',
              output: asJson(result),
              error: {
                code:
                  error instanceof WorkflowBudgetExhaustedError
                    ? 'budget_exhausted'
                    : 'workflow_failed',
                message: safeError(error),
              },
              updatedAt: at(dependencies.clock()),
              completedAt: at(dependencies.clock()),
            },
          );
        }
        return result;
      }
    },
  });
}
