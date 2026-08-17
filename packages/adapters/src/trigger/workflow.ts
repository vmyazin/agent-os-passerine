import { createHash } from 'node:crypto';

import {
  canonicalJsonValue,
  isoTimestamp,
  persistenceId,
  type ArtifactMetadata,
  type JsonValue,
  type RuntimeHandle,
  type RuntimeOutput,
  type StepRun,
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
import {
  FEATURE_WORKFLOW_DEFAULTS,
  type DurableFeatureWorkflowDependencies,
  type FeatureRole,
  type FeatureWorkflowInput,
  type FeatureWorkflowResult,
  type WorkflowEffect,
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

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : 'workflow operation failed')
    .replace(
      /((?:token|secret|password|private.?key))\s*[:=]\s*\S+/gi,
      '$1=[REDACTED]',
    )
    .slice(0, 1_000);
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
  schema: ZodType<T>,
): Promise<T> {
  if (
    metadata.projectId !== workflow.projectId ||
    metadata.runId !== workflow.runId
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
): Omit<WorkflowEffect, 'status'> {
  return {
    key,
    runId,
    kind,
    inputFingerprint: hash(input),
    createdAt: now,
    updatedAt: now,
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
  if (
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 429 ||
    code === 502 ||
    code === 503 ||
    code === 504
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
          role,
          agentId: roleDefinition.agent.id,
          model: roleDefinition.agent.model,
          environmentId: roleDefinition.environment.id,
          environmentRuntime: roleDefinition.environment.runtime,
          repositorySha: workflow.source.repositorySha,
          sourceSnapshotDigest: workflow.source.sourceSnapshotDigest,
          digests: workflow.digests,
        },
      }),
      createdAt: now,
      updatedAt: now,
    };
    const effectKey = `runtime:${workflow.runId}:${stepKey}:${String(attempt)}`;
    const claimed = await dependencies.checkpoints.claimEffect(
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
        },
        now,
      ),
    );
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
    const admission = await dependencies.checkpoints.admitSession({
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
    });
    if (!admission.admitted) {
      if (admission.reason === 'concurrency')
        throw new WorkflowTransientError('global workflow session is busy');
      throw new WorkflowBudgetExhaustedError(admission.reason);
    }

    let handle: RuntimeHandle | undefined;
    try {
      await dependencies.runtime.syncAgent(roleDefinition.agent);
      await dependencies.runtime.syncEnvironment(roleDefinition.environment);
      const started = await dependencies.checkpoints.markEffectStarted(
        effectKey,
        dependencies.clock(),
      );
      if (
        started.status === 'started' &&
        started.externalRef === undefined &&
        claimed.status === 'started'
      ) {
        await dependencies.checkpoints.failEffect(
          effectKey,
          'ambiguous runtime start requires operator reconciliation',
          true,
          dependencies.clock(),
        );
        throw new WorkflowPermanentError(
          'ambiguous runtime start requires operator reconciliation',
        );
      }
      if (started.externalRef === undefined) {
        await dependencies.repository.upsertStepRun({
          ...step,
          status: 'running',
          updatedAt: at(dependencies.clock()),
          startedAt: at(dependencies.clock()),
        });
        handle = await dependencies.runtime.start({
          runId: workflow.runId,
          stepId,
          agentId: roleDefinition.agent.id,
          environmentId: roleDefinition.environment.id,
          input,
          timeoutMs: FEATURE_WORKFLOW_DEFAULTS.sessionTimeoutMs,
        });
        await dependencies.checkpoints.attachExternalRef(
          effectKey,
          handle.id,
          dependencies.clock(),
        );
        const externalId = persistenceId(
          'externalSession',
          `runtime:${handle.id}`,
        );
        if (
          (await dependencies.repository.getExternalSession(externalId)) ===
          undefined
        ) {
          await dependencies.repository.createExternalSession({
            id: externalId,
            runId: persistenceId('run', workflow.runId),
            stepRunId: stepId,
            provider: 'runtime',
            externalId: handle.id,
            status: 'active',
            state: { handleId: handle.id, role },
            createdAt: at(dependencies.clock()),
          });
        }
      } else {
        handle = { id: started.externalRef };
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
      const parsed = schema.safeParse(runtimeOutput.data);
      if (!parsed.success)
        throw new WorkflowPermanentError(
          `runtime output for ${stepKey} is invalid`,
        );
      const usage = await dependencies.runtime.usage(handle);
      const microdollars = dependencies.priceUsage(
        usage,
        roleDefinition.agent.model,
      );
      if (!Number.isSafeInteger(microdollars) || microdollars < 0)
        throw new WorkflowPermanentError(
          'usage price must be integer microdollars',
        );
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
      // Re-enter the serialized admission boundary after the idempotent ledger
      // append. Postgres ignores the supplied snapshots and recomputes both
      // totals from usage_records while the global session lease is held.
      // Adding one microdollar makes an exact cap value valid and any value
      // above it terminal.
      const settlement = await dependencies.checkpoints.admitSession({
        runId: workflow.runId,
        stepKey,
        workflowSpentMicrodollars: workflowSpent + microdollars,
        dailySpentMicrodollars: dailySpent + microdollars,
        workflowLimitMicrodollars:
          FEATURE_WORKFLOW_DEFAULTS.workflowMicrodollars + 1,
        dailyLimitMicrodollars: FEATURE_WORKFLOW_DEFAULTS.dailyMicrodollars + 1,
        admissionNumerator: 1,
        admissionDenominator: 1,
        now: dependencies.clock(),
        leaseExpiresAt: new Date(
          Date.parse(dependencies.clock()) +
            FEATURE_WORKFLOW_DEFAULTS.sessionTimeoutMs +
            60_000,
        ).toISOString(),
      });
      if (!settlement.admitted) {
        if (settlement.reason === 'concurrency')
          throw new WorkflowPermanentError(
            'workflow session lease changed during usage settlement',
          );
        throw new WorkflowBudgetExhaustedError(settlement.reason);
      }
      await dependencies.checkpoints.completeEffect(
        effectKey,
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
      return parsed.data;
    } catch (rawError) {
      const error = classifiedRuntimeError(rawError);
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
        effectKey,
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
      if (!transient) throw error;
    } finally {
      if (handle !== undefined) {
        try {
          await dependencies.runtime.cleanup(handle);
        } catch {
          // Reconciliation owns retrying cleanup; do not replace the primary result.
        }
      }
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
      if (run.status === 'succeeded')
        return run.output as unknown as FeatureWorkflowResult;
      if (run.status === 'cancelled') return { status: 'cancelled' };
      const deadlineMs =
        Date.parse(run.createdAt) + FEATURE_WORKFLOW_DEFAULTS.workflowTimeoutMs;
      await dependencies.repository.updateRun(runId, {
        status: 'running',
        updatedAt: at(dependencies.clock()),
        startedAt: run.startedAt ?? at(dependencies.clock()),
      });
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
        );
        await parseArtifact(
          dependencies,
          workflow,
          specification.specification,
          featureSpecificationSchema,
        );
        const dodBody = await parseArtifact(
          dependencies,
          workflow,
          specification.definitionOfDone,
          definitionOfDoneSchema,
        );
        const scopeHash = hash({
          runId: workflow.runId,
          scope: 'feature-spec-and-dod',
          configDigest: workflow.digests.config,
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
        const waitEffect = await dependencies.checkpoints.claimEffect(
          effectDraft(
            workflow.runId,
            waitEffectKey,
            'approval-waitpoint',
            {
              approvalId,
              scopeHash,
              deadline: new Date(deadlineMs).toISOString(),
            },
            dependencies.clock(),
          ),
        );
        let waitpointId = waitEffect.externalRef;
        if (waitpointId === undefined) {
          if (waitEffect.status === 'started') {
            await dependencies.checkpoints.failEffect(
              waitEffectKey,
              'ambiguous waitpoint creation requires reconciliation',
              true,
              dependencies.clock(),
            );
            throw new WorkflowPermanentError(
              'ambiguous waitpoint creation requires reconciliation',
            );
          }
          await dependencies.checkpoints.markEffectStarted(
            waitEffectKey,
            dependencies.clock(),
          );
          const waitpoint = await dependencies.approval.create({
            idempotencyKey: waitEffectKey,
            timeout: new Date(deadlineMs).toISOString(),
            tags: [`run:${workflow.runId}`, `approval:${approvalId}`],
          });
          waitpointId = waitpoint.id;
          await dependencies.checkpoints.attachExternalRef(
            waitEffectKey,
            waitpoint.id,
            dependencies.clock(),
          );
        }
        await dependencies.repository.updateRun(runId, {
          status: 'waiting',
          updatedAt: at(dependencies.clock()),
        });
        const wake = await dependencies.approval.wait(waitpointId);
        if (wake.status === 'timed_out') {
          const result: FeatureWorkflowResult = { status: 'expired' };
          await dependencies.repository.updateRun(runId, {
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
        await dependencies.checkpoints.completeEffect(
          waitEffectKey,
          { approvalId, decision },
          dependencies.clock(),
        );
        if (decision !== 'approve') {
          const result: FeatureWorkflowResult = {
            status: decision === 'expired' ? 'expired' : 'rejected',
          };
          await dependencies.repository.updateRun(runId, {
            status: 'failed',
            output: asJson(result),
            error: { code: `approval_${decision}` },
            updatedAt: at(dependencies.clock()),
            completedAt: at(dependencies.clock()),
          });
          return result;
        }
        await dependencies.repository.updateRun(runId, {
          status: 'running',
          updatedAt: at(dependencies.clock()),
        });
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
        );
        await parseArtifact(
          dependencies,
          workflow,
          plan.plan,
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
        );
        let changeSet = await parseArtifact(
          dependencies,
          workflow,
          implementation.changeSet,
          changeSetSchema,
        );
        let testEvidence = await parseArtifact(
          dependencies,
          workflow,
          implementation.testEvidence,
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
        );
        const reviewBody = await parseArtifact(
          dependencies,
          workflow,
          review.review,
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
          );
          changeSet = await parseArtifact(
            dependencies,
            workflow,
            implementation.changeSet,
            changeSetSchema,
          );
          testEvidence = await parseArtifact(
            dependencies,
            workflow,
            implementation.testEvidence,
            testEvidenceSchema,
          );
        }
        await assertContinuable(dependencies, workflow, deadlineMs);
        const verification = await dependencies.verifier.verify({
          runId: workflow.runId,
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
        const publicationEffect = await dependencies.checkpoints.claimEffect(
          effectDraft(
            workflow.runId,
            publicationKey,
            'trusted-draft-publication',
            publicationRequest,
            dependencies.clock(),
          ),
        );
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
          if (publicationEffect.status === 'started') {
            await dependencies.checkpoints.failEffect(
              publicationKey,
              'ambiguous publisher call requires reconciliation',
              true,
              dependencies.clock(),
            );
            throw new WorkflowPermanentError(
              'ambiguous publisher call requires reconciliation',
            );
          }
          if (
            publicationEffect.status === 'failed' ||
            publicationEffect.status === 'dead_letter'
          ) {
            throw new WorkflowPermanentError(
              publicationEffect.error ?? 'publisher call was dead-lettered',
            );
          }
          await dependencies.checkpoints.markEffectStarted(
            publicationKey,
            dependencies.clock(),
          );
          await assertContinuable(dependencies, workflow, deadlineMs);
          let rawPublication: unknown;
          try {
            rawPublication =
              await dependencies.publisher.publish(publicationRequest);
          } catch (error) {
            await dependencies.checkpoints.failEffect(
              publicationKey,
              safeError(error),
              true,
              dependencies.clock(),
            );
            throw error;
          }
          const parsedPublication =
            draftPublicationResultSchema.safeParse(rawPublication);
          if (!parsedPublication.success) {
            await dependencies.checkpoints.failEffect(
              publicationKey,
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
            publicationKey,
            asJson(publication),
            dependencies.clock(),
          );
        }
        const result: FeatureWorkflowResult = {
          status: 'succeeded',
          draftPullRequestUrl: publication.pullRequestUrl,
        };
        await dependencies.repository.updateRun(runId, {
          status: 'succeeded',
          output: asJson(result),
          updatedAt: at(dependencies.clock()),
          completedAt: at(dependencies.clock()),
          cleanupAt: at(
            new Date(
              Date.parse(dependencies.clock()) + 24 * 60 * 60 * 1_000,
            ).toISOString(),
          ),
        });
        return result;
      } catch (error) {
        const latest = await dependencies.repository.getRun(runId);
        if (latest?.status === 'cancelled') return { status: 'cancelled' };
        const result: FeatureWorkflowResult =
          error instanceof WorkflowBudgetExhaustedError
            ? { status: 'budget_exhausted', reason: error.reason }
            : { status: 'failed', reason: safeError(error) };
        if (latest !== undefined && !isTerminalRun(latest.status)) {
          await dependencies.repository.updateRun(runId, {
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
          });
        }
        return result;
      }
    },
  });
}
