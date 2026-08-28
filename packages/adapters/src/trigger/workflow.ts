import { createHash, randomBytes } from 'node:crypto';

import {
  AcceptancePathReservedError,
  canonicalJsonValue,
  isRuntimeEventType,
  isoTimestamp,
  persistenceId,
  sealChangeSet,
  USAGE_PRICING_VERSION,
  type ArtifactMetadata,
  type ExternalSessionId,
  type JsonValue,
  type RunStatus,
  type RuntimeEvent,
  type RuntimeHandle,
  type RuntimeOutput,
  type RuntimeUsage,
  type StepRun,
  type UsageRecordEntry,
  type WorkflowRun,
  type WorkflowRunUpdate,
} from '@agentos/core';
import type { ZodType } from 'zod';

import {
  artifactSchemaFailureMessage,
  changeSetSchema,
  definitionOfDoneSchema,
  featureSpecificationSchema,
  featureWorkflowInputSchema,
  implementationOutputSchema,
  implementationPlanSchema,
  planOutputSchema,
  publicationResultSchema,
  reviewArtifactSchema,
  reviewOutputSchema,
  specificationOutputSchema,
  testEvidenceSchema,
  trustedCommandObservationSchema,
  type WorkflowPublicationResult,
} from './schemas.js';
import { createAesWorkflowHandleSealer } from './handle-sealer.js';
import {
  FEATURE_WORKFLOW_DEFAULTS,
  FEATURE_WORKFLOW_TASK_ID,
  FeatureWorkflowTaskTransientError,
  type DurableFeatureWorkflowDependencies,
  type FeatureRole,
  type FeatureWorkflowInput,
  type FeatureWorkflowResult,
  type WorkflowEffect,
  type WorkflowEffectLease,
} from './types.js';
import {
  resolveProjectDailyUsageMicrodollars,
  resolveWorkflowBudgetLimits,
} from './workflow-budget.js';

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

function parseRuntimeAccess(value: JsonValue | undefined): {
  readonly resources: readonly {
    readonly type: 'file';
    readonly fileId: string;
    readonly mountPath?: string;
  }[];
  readonly credentialRefs: readonly string[];
} {
  if (
    !isJsonObject(value) ||
    !Array.isArray(value.resources) ||
    !Array.isArray(value.credentialRefs)
  )
    throw new WorkflowPermanentError('runtime access checkpoint is invalid');
  const resources = value.resources.map((resource) => {
    if (
      !isJsonObject(resource) ||
      resource.type !== 'file' ||
      typeof resource.fileId !== 'string' ||
      resource.fileId.length < 1 ||
      resource.fileId.length > 256 ||
      (resource.mountPath !== undefined &&
        (typeof resource.mountPath !== 'string' ||
          resource.mountPath.length > 1_024))
    )
      throw new WorkflowPermanentError('runtime access checkpoint is invalid');
    return {
      type: 'file' as const,
      fileId: resource.fileId,
      ...(resource.mountPath === undefined
        ? {}
        : { mountPath: resource.mountPath }),
    };
  });
  const credentialRefs = value.credentialRefs.map((credential) => {
    if (
      typeof credential !== 'string' ||
      credential.length < 1 ||
      credential.length > 256
    )
      throw new WorkflowPermanentError('runtime access checkpoint is invalid');
    return credential;
  });
  if (resources.length > 32 || credentialRefs.length > 4)
    throw new WorkflowPermanentError('runtime access checkpoint is invalid');
  return { resources, credentialRefs };
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
    remainingSeconds > FEATURE_WORKFLOW_DEFAULTS.approvalTtlMs / 1_000
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
      artifactSchemaFailureMessage(expected, result.error.issues),
    );
  return result.data;
}

/**
 * Why a session produced no structured output, in the two shapes that mean
 * different things.
 *
 * "no structured output" alone sent three real runs' worth of investigation
 * after a protocol bug that was not there. A session that ran to its
 * deadline in silence was cut off -- usually the agent is stuck, often on an
 * instruction it cannot carry out. A session that ended early having said
 * something ignored its output contract instead. The text itself is
 * agent-authored and stays out of this durable message; whether it exists is
 * the part that distinguishes the two.
 */
function noStructuredOutputDetail({
  hasText,
  elapsedMs,
}: {
  readonly hasText: boolean;
  readonly elapsedMs: number;
}): string {
  const seconds = Math.max(0, Math.round(elapsedMs / 1_000));
  const elapsed =
    seconds < 60
      ? `${String(seconds)}s`
      : `${String(Math.floor(seconds / 60))}m${String(seconds % 60)}s`;
  return hasText
    ? `no structured output: the session ended after ${elapsed} having sent text instead of the required JSON message`
    : `no structured output: the session ran ${elapsed} and ended silently, which is what a session cut off at its deadline looks like`;
}

async function putSealedChanges(
  dependencies: DurableFeatureWorkflowDependencies,
  workflow: FeatureWorkflowInput,
  producingStepId: string,
  changeSet: {
    readonly version: 'change-set-v1';
    readonly changes: ReturnType<typeof sealChangeSet>;
  },
): Promise<ArtifactMetadata> {
  return dependencies.artifacts.put({
    scope: {
      projectId: workflow.projectId,
      runId: workflow.runId,
      stepId: producingStepId,
    },
    artifactId: 'sealed-changes',
    version: 1,
    bytes: new TextEncoder().encode(canonicalJsonValue(asJson(changeSet))),
    mediaType: 'application/json',
    retentionClass: 'working',
  });
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

/**
 * An operator can grant a run a one-time allowance to carry it past a budget
 * that stopped it. The grant is an append-only event on the run, so it is
 * auditable, it cannot be applied to a different run, and re-reading it is
 * what makes it survive a worker restart.
 *
 * The allowance raises the limits used for both admission and settlement, so
 * a run admitted under an override is also allowed to settle under it -- a
 * grant that only moved the admission gate would let a step run and then fail
 * for spending what it was just permitted to spend.
 */
export const BUDGET_OVERRIDE_EVENT = 'run.budget_override_granted';

/** Appended by the control plane when an operator resumes a finished run. */
export const RUN_RESUMED_EVENT = 'run.resumed';

async function latestResumeMs(
  dependencies: DurableFeatureWorkflowDependencies,
  runId: string,
): Promise<number> {
  const events = await dependencies.repository.listEvents(
    persistenceId('run', runId),
    { limit: 1_000 },
  );
  let latest = 0;
  for (const event of events) {
    if (event.type !== RUN_RESUMED_EVENT) continue;
    const at = Date.parse(event.occurredAt);
    if (Number.isFinite(at) && at > latest) latest = at;
  }
  return latest;
}

/**
 * How many times an operator has resumed this run. Attempt numbering restarts
 * on resume, so anything keyed by (step, attempt) that must survive across
 * executions -- the usage ledger -- needs the generation in its identity: the
 * previous execution's attempt 1 is money already spent, this execution's
 * attempt 1 is new money, and one may never overwrite the other.
 */
async function resumeGenerationOf(
  dependencies: DurableFeatureWorkflowDependencies,
  runId: string,
): Promise<number> {
  const events = await dependencies.repository.listEvents(
    persistenceId('run', runId),
    { limit: 1_000 },
  );
  let generation = 0;
  for (const event of events) {
    if (event.type !== RUN_RESUMED_EVENT) continue;
    const value = payloadField(event.payload, 'generation');
    generation =
      typeof value === 'number' && Number.isSafeInteger(value)
        ? Math.max(generation, value)
        : generation + 1;
  }
  return generation;
}

async function grantedBudgetOverride(
  dependencies: DurableFeatureWorkflowDependencies,
  runId: string,
): Promise<number> {
  const events = await dependencies.repository.listEvents(
    persistenceId('run', runId),
    { limit: 1_000 },
  );
  let granted = 0;
  for (const event of events) {
    if (event.type !== BUDGET_OVERRIDE_EVENT) continue;
    const amount = payloadField(event.payload, 'microdollars');
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount)) continue;
    if (amount <= 0) continue;
    granted += amount;
  }
  return granted;
}

async function budgetLimitsWithOverrides(
  dependencies: DurableFeatureWorkflowDependencies,
  runId: string,
): Promise<ReturnType<typeof resolveWorkflowBudgetLimits>> {
  const base = resolveWorkflowBudgetLimits(dependencies);
  const granted = await grantedBudgetOverride(dependencies, runId);
  if (granted === 0) return base;
  return {
    ...base,
    workflowLimitMicrodollars: base.workflowLimitMicrodollars + granted,
    dailyLimitMicrodollars: base.dailyLimitMicrodollars + granted,
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

type StepProgressPhase =
  | 'preparing'
  | 'sending'
  | 'waiting'
  | 'working'
  | 'tool'
  | 'validating'
  | 'retrying'
  | 'completed'
  | 'failed';

interface StepProgressContext {
  readonly stepRunId: StepRun['id'];
  readonly stepKey: string;
  readonly attempt: number;
}

async function recordStepProgress(
  dependencies: DurableFeatureWorkflowDependencies,
  runId: string,
  step: StepProgressContext,
  eventKey: string,
  phase: StepProgressPhase,
  message: string,
  occurredAt = dependencies.clock(),
): Promise<void> {
  const type = 'step.progress';
  const payload = asJson({
    stepRunId: step.stepRunId,
    stepKey: step.stepKey,
    attempt: step.attempt,
    phase,
    message,
  });
  await dependencies.repository.appendEvent({
    runId: persistenceId('run', runId),
    eventId: persistenceId(
      'event',
      `step-progress:${runId}:${step.stepKey}:${String(step.attempt)}:${eventKey}`,
    ),
    fingerprint: hash({ type, payload }),
    type,
    payload,
    occurredAt: at(occurredAt),
  });
}

/**
 * A tool name reaches us on the provider event stream, so it is rendered only
 * when it still looks like a tool identifier. Anything else keeps the unnamed
 * wording instead of putting provider-controlled text in front of the
 * operator, and no other part of a runtime payload is ever persisted.
 */
const RUNTIME_TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/;

/**
 * Runtime error codes are a closed set the providers normalize into, so the
 * operator can be told which failure this was. A provider's own free-text
 * error message is never rendered.
 */
const RUNTIME_ERROR_NOTES = new Map<string, string>([
  ['model_rate_limited_error', 'Model provider rate limited the session'],
  ['model_overloaded_error', 'Model provider was overloaded'],
  ['model_request_failed_error', 'Model request failed'],
  ['mcp_connection_failed_error', 'Tool server connection failed'],
  ['mcp_authentication_failed_error', 'Tool server rejected authentication'],
  ['billing_error', 'Model provider rejected the request for billing'],
  ['credential_host_unreachable_error', 'Credential host was unreachable'],
  ['turn_limit', 'Model used up its turns without finishing'],
]);

const MAX_PROGRESS_SAMPLES_PER_NOTE = 3;
/** Distinct notes are bounded, but keep one attempt's feed readable anyway. */
const MAX_PROGRESS_NOTES_PER_ATTEMPT = 60;
const MAX_TRACKED_TOOL_CALLS = 64;

function payloadField(payload: unknown, key: string): unknown {
  return typeof payload === 'object' && payload !== null
    ? Reflect.get(payload, key)
    : undefined;
}

function runtimeToolName(payload: unknown, key: string): string | undefined {
  const value = payloadField(payload, key);
  return typeof value === 'string' && RUNTIME_TOOL_NAME.test(value)
    ? value
    : undefined;
}

function runtimeToolUseId(payload: unknown): string | undefined {
  const value = payloadField(payload, 'toolUseId');
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    ? value
    : undefined;
}

interface RuntimeProgressNote {
  readonly phase: StepProgressPhase;
  readonly message: string;
  /**
   * Distinguishes notes that share an event type -- one per tool, and a
   * failing tool apart from a succeeding one -- so each is sampled on its
   * own instead of the first three events of a type hiding the rest.
   */
  readonly variant: string;
}

function runtimeProgress(
  event: RuntimeEvent,
  toolCalls: ReadonlyMap<string, string>,
): RuntimeProgressNote | undefined {
  const note = (
    phase: StepProgressPhase,
    message: string,
    variant = '',
  ): RuntimeProgressNote => ({ phase, message, variant });
  switch (event.type) {
    case 'message':
      return note('working', 'Model sent a message');
    case 'thread_message':
      return note('working', 'Subagent exchanged a message');
    case 'message_summary':
      return note('working', 'Model compacted its context');
    case 'progress':
      return note('working', 'Model is thinking');
    case 'tool_call': {
      const tool = runtimeToolName(event.payload, 'name');
      if (tool === undefined) return note('tool', 'Model is using a tool');
      const server = runtimeToolName(event.payload, 'mcpServerName');
      return note(
        'tool',
        server === undefined
          ? `Model is using ${tool}`
          : `Model is using ${tool} via ${server}`,
        tool,
      );
    }
    case 'tool_result': {
      const failed = payloadField(event.payload, 'isError') === true;
      const linked = runtimeToolUseId(event.payload);
      const tool =
        runtimeToolName(event.payload, 'name') ??
        (linked === undefined ? undefined : toolCalls.get(linked));
      if (tool === undefined)
        return note(
          'tool',
          failed ? 'A tool reported an error' : 'Tool finished',
          failed ? 'failed' : '',
        );
      return note(
        'tool',
        failed ? `${tool} reported an error` : `${tool} finished`,
        failed ? `${tool}:failed` : tool,
      );
    }
    case 'input_acknowledged':
      return note('waiting', 'Model received the request');
    case 'running':
    case 'thread_running':
      return note('working', 'Model is working');
    case 'rescheduling':
    case 'thread_rescheduling':
      return note('waiting', 'Model session is rescheduling');
    case 'requires_action':
      return note('waiting', 'Model requested an action');
    case 'retries_exhausted':
      return note('failed', 'Model session ran out of provider retries');
    case 'error': {
      const code =
        payloadField(event.payload, 'code') ??
        payloadField(event.payload, 'reason');
      const named =
        typeof code === 'string' ? RUNTIME_ERROR_NOTES.get(code) : undefined;
      return named === undefined
        ? note('failed', 'Model session reported an error')
        : note('failed', named, named);
    }
    case 'idle':
    case 'terminated':
    case 'thread_idle':
    case 'thread_terminated':
      return note('working', 'Model response received');
    default:
      return undefined;
  }
}

async function consumeEvents(
  dependencies: DurableFeatureWorkflowDependencies,
  runId: string,
  handle: RuntimeHandle,
  step: StepProgressContext,
): Promise<void> {
  let count = 0;
  let notes = 0;
  const progressCounts = new Map<string, number>();
  const toolCalls = new Map<string, string>();
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
      !isRuntimeEventType(event.type) ||
      !(event.occurredAt instanceof Date) ||
      !Number.isFinite(event.occurredAt.getTime())
    ) {
      throw new WorkflowPermanentError('runtime emitted a malformed event');
    }
    if (event.type === 'tool_call' && toolCalls.size < MAX_TRACKED_TOOL_CALLS) {
      // Result events carry the id of the call they answer but not its name,
      // so remember the mapping to name the tool that just finished.
      const toolUseId = runtimeToolUseId(event.payload);
      const toolName = runtimeToolName(event.payload, 'name');
      if (toolUseId !== undefined && toolName !== undefined)
        toolCalls.set(toolUseId, toolName);
    }
    const progress = runtimeProgress(event, toolCalls);
    if (progress !== undefined && notes < MAX_PROGRESS_NOTES_PER_ATTEMPT) {
      const variantKey = `${event.type}:${progress.variant}`;
      const occurrence = (progressCounts.get(variantKey) ?? 0) + 1;
      progressCounts.set(variantKey, occurrence);
      // Provider streams can emit thousands of repetitive message/tool
      // updates. Sampling each distinct note -- so every tool the model
      // reaches for is named at least once -- preserves the operational story
      // without letting progress crowd newer run events out of the page read.
      if (occurrence <= MAX_PROGRESS_SAMPLES_PER_NOTE) {
        notes += 1;
        await recordStepProgress(
          dependencies,
          runId,
          step,
          `runtime:${variantKey}:${String(occurrence)}`,
          progress.phase,
          progress.message,
          event.occurredAt.toISOString(),
        );
      }
    }
    // Managed sessions do not self-terminate when the agent finishes: they
    // park in idle awaiting further input. Idle/terminated is the completion
    // signal for a single-shot step; waiting for the stream itself to close
    // would burn the entire session deadline on an already-finished agent.
    if (event.type === 'idle' || event.type === 'terminated') return;
  }
}

const TRANSIENT_ERROR_CODES = new Set<unknown>([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'timeout_error',
  'overloaded_error',
  'rate_limit_error',
  'runtime_session_missing',
  '40001',
  '40P01',
  429,
  502,
  503,
  504,
]);

function isTransientOperationError(error: unknown): boolean {
  let candidate = error;
  for (let depth = 0; depth < 6; depth += 1) {
    if (typeof candidate !== 'object' || candidate === null) return false;
    const code = Reflect.get(candidate, 'code');
    const status = Reflect.get(candidate, 'status');
    if (
      TRANSIENT_ERROR_CODES.has(code) ||
      TRANSIENT_ERROR_CODES.has(status) ||
      (typeof code === 'string' && code.startsWith('08'))
    )
      return true;
    candidate = Reflect.get(candidate, 'cause');
  }
  return false;
}

/**
 * Statuses that mean the provider refused the create request outright, so no
 * session exists and no model time was bought. Ambiguous outcomes -- a
 * timeout, throttling, a conflict, any server fault -- are deliberately
 * absent: those keep the conservative "charge the reservation" behaviour
 * because a session may well be running and spending.
 */
const DEFINITE_START_REJECTIONS = new Set([400, 401, 403, 404, 422]);

function isDefiniteStartRejection(error: unknown): boolean {
  let candidate = error;
  for (let depth = 0; depth < 6; depth += 1) {
    if (typeof candidate !== 'object' || candidate === null) return false;
    const status = Reflect.get(candidate, 'status');
    if (typeof status === 'number')
      return DEFINITE_START_REJECTIONS.has(status);
    candidate = Reflect.get(candidate, 'cause');
  }
  return false;
}

function classifiedRuntimeError(error: unknown): Error {
  if (
    error instanceof WorkflowPermanentError ||
    error instanceof WorkflowTransientError ||
    error instanceof WorkflowBudgetExhaustedError
  )
    return error;
  if (isTransientOperationError(error))
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
  finalizeOutput?: (
    handle: RuntimeHandle,
    output: RuntimeOutput,
  ) => Promise<unknown>,
): Promise<T> {
  const inputFingerprint = hash(input);
  const resumeGeneration = await resumeGenerationOf(
    dependencies,
    workflow.runId,
  );
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
    if (prior === undefined) {
      // Usage and external-session records reference the step. Persist the
      // pending row before setup so an early failure cannot mask its cause
      // with a missing-step foreign-key error during settlement.
      await dependencies.repository.upsertStepRun(step);
    }
    const progressContext: StepProgressContext = {
      stepRunId: stepId,
      stepKey,
      attempt,
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

    const budgetLimits = await budgetLimitsWithOverrides(
      dependencies,
      workflow.runId,
    );
    const projectDailyUsage = resolveProjectDailyUsageMicrodollars(dependencies);
    const workflowSpent = await sumWorkflowUsage(dependencies, workflow.runId);
    const dailySpent = await projectDailyUsage(
      dependencies.clock(),
      workflow.projectId,
    );
    const deploymentSpent =
      dependencies.deploymentDailyUsageMicrodollars === undefined
        ? undefined
        : await dependencies.deploymentDailyUsageMicrodollars(
            dependencies.clock(),
          );
    const estimatedMicrodollars =
      roleDefinition.maxReservationMicrodollars ??
      FEATURE_WORKFLOW_DEFAULTS.defaultSessionReservationMicrodollars;
    if (
      !Number.isSafeInteger(estimatedMicrodollars) ||
      estimatedMicrodollars < 1 ||
      estimatedMicrodollars > budgetLimits.workflowLimitMicrodollars
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
      workflowLimitMicrodollars: budgetLimits.workflowLimitMicrodollars,
      dailyLimitMicrodollars: budgetLimits.dailyLimitMicrodollars,
      admissionNumerator: budgetLimits.admissionNumerator,
      admissionDenominator: budgetLimits.admissionDenominator,
      ...(dependencies.deploymentDailyLimitMicrodollars === undefined ||
      deploymentSpent === undefined
        ? {}
        : {
            deploymentDailyLimitMicrodollars:
              dependencies.deploymentDailyLimitMicrodollars,
            deploymentSpentMicrodollars: deploymentSpent,
          }),
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
    let usageRecorded = false;
    let recordedMicrodollars = 0;
    let usageDraft: UsageRecordEntry | undefined;
    let usageFailure: unknown;
    let runtimeStartAttempted = false;
    let completedResult: T | undefined;
    let settlementFailure: WorkflowBudgetExhaustedError | undefined;
    let runtimeAccess:
      | {
          readonly resources: readonly {
            readonly type: 'file';
            readonly fileId: string;
            readonly mountPath?: string;
          }[];
          readonly credentialRefs: readonly string[];
        }
      | undefined;
    const recordUsage = async (candidate?: RuntimeHandle): Promise<void> => {
      if (usageRecorded) return;
      if (usageFailure !== undefined) throw usageFailure;
      if (usageDraft === undefined) {
        let usage: RuntimeUsage = {
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
        usageDraft = {
          // Attempt numbering restarts on resume, but the previous
          // execution's records are money already spent: this attempt's
          // record needs its own identity or the append conflicts with
          // history and kills the run. Generation zero renders the exact id
          // every record before resume existed was written under.
          idempotencyId: persistenceId(
            'usage',
            `usage:${workflow.runId}:${stepKey}:${String(attempt)}${
              resumeGeneration === 0
                ? ''
                : `:resume:${String(resumeGeneration)}`
            }`,
          ),
          runId: persistenceId('run', workflow.runId),
          stepRunId: stepId,
          model: roleDefinition.agent.model,
          pricingVersion: `${USAGE_PRICING_VERSION}:${workflow.digests.config}`,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
          cacheCreation5mInputTokens: usage.cacheCreation5mInputTokens ?? 0,
          cacheCreation1hInputTokens: usage.cacheCreation1hInputTokens ?? 0,
          runtimeMs: usage.runtimeMs,
          microdollars,
          recordedAt: at(dependencies.clock()),
        };
      }
      for (let appendAttempt = 1; appendAttempt <= 2; appendAttempt += 1) {
        try {
          await dependencies.repository.appendUsage(usageDraft);
          recordedMicrodollars = usageDraft.microdollars;
          usageRecorded = true;
          return;
        } catch (error) {
          if (appendAttempt < 2 && isTransientOperationError(error)) continue;
          usageFailure = error;
          throw error;
        }
      }
    };
    try {
      await recordStepProgress(
        dependencies,
        workflow.runId,
        progressContext,
        'preparing',
        'preparing',
        'Preparing workspace',
      );
      if (dependencies.runtimeAccess !== undefined) {
        const accessKey = `runtime-access:${workflow.runId}:${stepKey}:${String(attempt)}`;
        const accessClaim = await claimEffect(
          dependencies,
          ownerId,
          effectDraft(
            workflow.runId,
            accessKey,
            'runtime-session-access',
            { stepKey, attempt, inputFingerprint },
            dependencies.clock(),
          ),
          2 * 60_000,
        );
        if (accessClaim.effect.status === 'succeeded') {
          runtimeAccess = parseRuntimeAccess(accessClaim.effect.output);
        } else {
          await dependencies.checkpoints.markEffectStarted(
            accessClaim.lease,
            dependencies.clock(),
          );
          runtimeAccess = await dependencies.runtimeAccess.prepare({
            workflow,
            stepId,
            logicalStepId: stepKey,
            role,
            stepInput: input,
            idempotencyKey: accessKey,
          });
          runtimeAccess = parseRuntimeAccess(asJson(runtimeAccess));
          await dependencies.checkpoints.completeEffect(
            accessClaim.lease,
            asJson(runtimeAccess),
            dependencies.clock(),
          );
        }
      }
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
        ...(runtimeAccess === undefined
          ? {}
          : {
              resources: runtimeAccess.resources,
              credentialRefs: runtimeAccess.credentialRefs,
            }),
      };
      await recordStepProgress(
        dependencies,
        workflow.runId,
        progressContext,
        'sending',
        'sending',
        'Sending request to the model',
      );
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
            if (startError instanceof WorkflowTransientError) {
              // The stable provider contract uses WorkflowTransientError only
              // when it knows no remote session was created. Ambiguous create
              // failures are reconciled below and retain the reservation.
              runtimeStartAttempted = false;
              throw startError;
            }
            const classified = classifiedRuntimeError(startError);
            if (!(classified instanceof WorkflowTransientError)) {
              // A refused create request bought nothing, so releasing the
              // attempt keeps a rejection from being billed as a full session.
              if (isDefiniteStartRejection(startError))
                runtimeStartAttempted = false;
              throw classified;
            }
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
        // The sealed restart handle is authoritative recovery state. Persist it
        // before exposing the remote reference on the effect so a crash cannot
        // leave an unrecoverable paid session.
        await dependencies.checkpoints.attachExternalRef(
          claim.lease,
          handle.id,
          dependencies.clock(),
        );
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
          if (dependencies.runtime.reconcileStart === undefined)
            throw new WorkflowPermanentError(
              'persisted runtime handle is unavailable',
            );
          runtimeStartAttempted = true;
          const repaired =
            await dependencies.runtime.reconcileStart(startRequest);
          if (repaired === undefined || repaired.id !== started.externalRef)
            throw new RuntimeStartPendingError(
              'runtime handle repair is pending reconciliation',
            );
          handle = repaired;
          const aad = handleAad(workflow, stepId, role, started.externalRef);
          const sealedHandle = await handleSealer.seal(repaired, aad);
          await dependencies.repository.createExternalSession({
            id: externalSessionId,
            runId: persistenceId('run', workflow.runId),
            stepRunId: stepId,
            provider: 'runtime',
            externalId: repaired.id,
            status: 'active',
            state: {
              version: 'sealed-runtime-handle-state-v1',
              sealedHandle,
              aad,
              role,
            },
            createdAt: at(dependencies.clock()),
          });
        } else {
          handle = await handleSealer.open(
            external.state.sealedHandle,
            handleAad(workflow, stepId, role, started.externalRef),
          );
        }
        if (handle.id !== started.externalRef)
          throw new WorkflowPermanentError('persisted runtime handle mismatch');
      }
      const sessionStartedMs = Date.parse(dependencies.clock());
      await recordStepProgress(
        dependencies,
        workflow.runId,
        progressContext,
        'waiting',
        'waiting',
        'Waiting on response',
      );
      const runtimeOutput: RuntimeOutput = await withTimeout(
        (async () => {
          await consumeEvents(
            dependencies,
            workflow.runId,
            handle!,
            progressContext,
          );
          await recordStepProgress(
            dependencies,
            workflow.runId,
            progressContext,
            'collecting',
            'working',
            'Collecting model response',
          );
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
      await recordUsage(handle);
      await recordStepProgress(
        dependencies,
        workflow.runId,
        progressContext,
        'validating',
        'validating',
        'Validating model response',
      );
      const candidate =
        finalizeOutput === undefined
          ? runtimeOutput.data
          : await finalizeOutput(handle, runtimeOutput);
      const parsed = schema.safeParse(candidate);
      if (!parsed.success) {
        // Carry the schema issues (paths and codes only, no values) so a
        // failed run explains which field of the output contract broke.
        const issues = parsed.error.issues
          .slice(0, 8)
          .map((issue) => `${issue.path.join('.')}: ${issue.code}`)
          .join('; ')
          .slice(0, 700);
        throw new WorkflowPermanentError(
          `runtime output for ${stepKey} is invalid (${
            candidate === undefined
              ? noStructuredOutputDetail({
                  hasText: (runtimeOutput.text ?? '').trim() !== '',
                  elapsedMs:
                    Date.parse(dependencies.clock()) - sessionStartedMs,
                })
              : issues
          })`,
        );
      }
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
      await recordStepProgress(
        dependencies,
        workflow.runId,
        progressContext,
        'completed',
        'completed',
        'Step completed',
      );
      completedResult = parsed.data;
    } catch (rawError) {
      if (rawError instanceof RuntimeStartPendingError) {
        await recordStepProgress(
          dependencies,
          workflow.runId,
          progressContext,
          'start-pending',
          'waiting',
          'Waiting for the model session',
        );
        await dependencies.checkpoints.renewEffect(
          claim.lease,
          dependencies.clock(),
          dependencies.clock(),
        );
        throw rawError;
      }
      let failure = rawError;
      try {
        await recordUsage(handle);
      } catch (settlementError) {
        failure = settlementError;
      }
      const error = classifiedRuntimeError(failure);
      lastError = error;
      const transient = error instanceof WorkflowTransientError;
      await recordStepProgress(
        dependencies,
        workflow.runId,
        progressContext,
        transient && attempt < FEATURE_WORKFLOW_DEFAULTS.maxStepAttempts
          ? 'retrying'
          : 'failed',
        transient && attempt < FEATURE_WORKFLOW_DEFAULTS.maxStepAttempts
          ? 'retrying'
          : 'failed',
        transient && attempt < FEATURE_WORKFLOW_DEFAULTS.maxStepAttempts
          ? 'Step interrupted; retrying'
          : 'Step failed',
      );
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
      // A wall-clock-expired lease may still own a paid remote session. Keep
      // both the reservation and global fence until cleanup confirms the
      // session stopped. Ambiguous starts (attempted without a handle) are
      // deliberately left for start/orphan reconciliation.
      const safeToSettle =
        !runtimeStartAttempted || (handle !== undefined && cleaned);
      if (safeToSettle) {
        if (!usageRecorded) await recordUsage(handle);
        const settlement = await dependencies.checkpoints.settleSession({
          reservationKey,
          runId: workflow.runId,
          stepKey,
          actualMicrodollars: recordedMicrodollars,
          workflowSpentMicrodollars: workflowSpent + recordedMicrodollars,
          dailySpentMicrodollars: dailySpent + recordedMicrodollars,
          workflowLimitMicrodollars: budgetLimits.workflowLimitMicrodollars,
          dailyLimitMicrodollars: budgetLimits.dailyLimitMicrodollars,
          now: dependencies.clock(),
        });
        await dependencies.checkpoints.releaseSession(
          workflow.projectId,
          workflow.runId,
          stepKey,
        );
        if (!settlement.settled)
          settlementFailure = new WorkflowBudgetExhaustedError(
            settlement.reason,
          );
      }
    }
    if (settlementFailure !== undefined) throw settlementFailure;
    if (completedResult !== undefined) return completedResult;
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
  const handleSealer =
    dependencies.handleSealer ?? createAesWorkflowHandleSealer(randomBytes(32));
  return Object.freeze({
    async run(rawInput: unknown): Promise<FeatureWorkflowResult> {
      const parsed = featureWorkflowInputSchema.safeParse(rawInput);
      if (!parsed.success)
        throw new WorkflowPermanentError('invalid workflow input');
      const workflow = parsed.data;
      const executionOwner = `workflow:${dependencies.execution?.triggerRunId ?? workflow.runId}:${dependencies.execution?.taskVersion ?? FEATURE_WORKFLOW_TASK_ID}`;
      const runId = persistenceId('run', workflow.runId);
      const run = await dependencies.repository.getRun(runId);
      if (run === undefined)
        throw new WorkflowPermanentError('workflow run does not exist');
      if (isTerminalRun(run.status)) return terminalResult(run);
      // The execution clock starts when an operator decides, not when the run
      // was first created: an approval already re-anchors it below, and a
      // resume is the same kind of decision. Anchoring a resumed run at its
      // original creation would hand it a deadline that had already passed --
      // it would fail on the clock while replaying work it had already paid
      // for.
      let deadlineMs =
        Math.max(
          Date.parse(run.createdAt),
          await latestResumeMs(dependencies, workflow.runId),
        ) + FEATURE_WORKFLOW_DEFAULTS.workflowTimeoutMs;
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
        const approvalExpiresAt = new Date(
          Date.parse(run.createdAt) + FEATURE_WORKFLOW_DEFAULTS.approvalTtlMs,
        );
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
            expiresAt: at(approvalExpiresAt.toISOString()),
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
            deadline: approvalExpiresAt.toISOString(),
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
          let waitpoint: { readonly id: string };
          try {
            waitpoint = await dependencies.approval.create({
              idempotencyKey: waitEffectKey,
              timeout: triggerWaitDuration(
                approvalExpiresAt.getTime(),
                dependencies.clock(),
              ),
              tags: [`run:${workflow.runId}`, `approval:${approvalId}`],
            });
          } catch {
            // Trigger token creation is retried with the exact deterministic
            // idempotency key. An ambiguous transport response is not terminal.
            throw new WorkflowTransientError(
              'approval waitpoint creation is pending reconciliation',
            );
          }
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
              at: at(approvalExpiresAt.toISOString()),
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

        const consumed = await dependencies.repository.getApproval(
          persistenceId('approval', approvalId),
        );
        if (consumed?.consumedAt === undefined) {
          throw new WorkflowPermanentError('approval_consumed_at_missing');
        }
        // Never backwards: on a resumed run the approval was consumed before
        // the resume, and re-anchoring to it would hand the run a deadline
        // that already passed while it was replaying paid-for work.
        deadlineMs = Math.max(
          deadlineMs,
          Date.parse(consumed.consumedAt) +
            FEATURE_WORKFLOW_DEFAULTS.workflowTimeoutMs,
        );

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
            specificationArtifact: specification.specification,
            definitionOfDoneArtifact: specification.definitionOfDone,
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
            planArtifact: plan.plan,
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
            changeSetArtifact: implementation.changeSet,
            testEvidenceArtifact: implementation.testEvidence,
            definitionOfDoneArtifact: specification.definitionOfDone,
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
              priorChangeSetArtifact: implementation.changeSet,
              reviewArtifact: review.review,
              planArtifact: plan.plan,
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
              changeSetArtifact: implementation.changeSet,
              testEvidenceArtifact: implementation.testEvidence,
              definitionOfDoneArtifact: specification.definitionOfDone,
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
        let sealedChanges;
        try {
          sealedChanges = {
            version: 'change-set-v1' as const,
            changes: sealChangeSet(
              changeSet.changes,
              dodBody.acceptanceTests,
              dependencies.sourcePaths?.({
                runId: workflow.runId,
                sourceSnapshotDigest: workflow.source.sourceSnapshotDigest,
              }) ?? new Set<string>(),
            ),
          };
        } catch (error) {
          if (error instanceof AcceptancePathReservedError) {
            throw new WorkflowPermanentError(error.message);
          }
          throw error;
        }
        const parsedSealed = changeSetSchema.safeParse(sealedChanges);
        if (!parsedSealed.success) {
          throw new WorkflowPermanentError('sealed change set is invalid');
        }
        changeSet = parsedSealed.data;
        const sealedMeta = await putSealedChanges(
          dependencies,
          workflow,
          producingStepId,
          changeSet,
        );
        await assertContinuable(dependencies, workflow, deadlineMs);
        if (
          dependencies.resolveTestCommand === undefined ||
          dependencies.runtime.observeCommand === undefined
        )
          throw new WorkflowPermanentError(
            'isolated trusted verification runtime is not configured',
          );
        const exactCommand = dependencies.resolveTestCommand(
          testEvidence.command,
        );
        if (exactCommand.length < 1 || exactCommand.length > 8_000)
          throw new WorkflowPermanentError('trusted test command is invalid');
        const changeSetDigest = hash(asJson(changeSet));
        const trustedCommandObservation = await runAgentStep(
          dependencies,
          workflow,
          deadlineMs,
          'verification',
          'verification',
          asJson({
            version: 'trusted-verification-request-v1',
            exactCommand,
            instruction:
              'Run exactly this command once with Bash. Do not invoke any other tool or command.',
            sourceSnapshotDigest: workflow.source.sourceSnapshotDigest,
            changeSetDigest,
            changeSetArtifact: sealedMeta,
            configDigest: workflow.digests.config,
          }),
          trustedCommandObservationSchema,
          executionOwner,
          handleSealer,
          async (handle) => {
            const observed = await dependencies.runtime.observeCommand!(
              handle,
              exactCommand,
            );
            return {
              ...observed,
              runId: workflow.runId,
              stepId: 'verification',
              repositorySha: workflow.source.repositorySha,
              sourceSnapshotDigest: workflow.source.sourceSnapshotDigest,
              changeSetDigest,
              configDigest: workflow.digests.config,
            };
          },
        );
        const verification = await dependencies.verifier.verify({
          runId: workflow.runId,
          workflow,
          producingStepId,
          definitionOfDone: asJson(dodBody),
          changeSet: asJson(changeSet),
          testEvidence: asJson(testEvidence),
          review: asJson(reviewBody),
          trustedCommandObservation,
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
        if (
          verification.evidenceArtifact === undefined ||
          verification.evidenceArtifact.projectId !== workflow.projectId ||
          verification.evidenceArtifact.runId !== workflow.runId ||
          verification.evidenceArtifact.stepId !== 'verification' ||
          verification.evidenceArtifact.artifactId !== 'trusted-test-report' ||
          verification.evidenceArtifact.digest !== verification.evidenceDigest
        )
          throw new WorkflowPermanentError(
            'trusted verifier evidence artifact binding is invalid',
          );
        await assertContinuable(dependencies, workflow, deadlineMs);
        const publicationRequest =
          await dependencies.publicationAuthority.authorize({
            workflow,
            changeSet: asJson(changeSet),
            testEvidence: asJson(testEvidence),
            verification,
            artifacts: [
              sealedMeta,
              implementation.changeSet,
              implementation.testEvidence,
              specification.definitionOfDone,
              verification.evidenceArtifact,
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
        let publication: WorkflowPublicationResult;
        if (publicationEffect.status === 'succeeded') {
          const replay = publicationResultSchema.safeParse(
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
            publicationResultSchema.safeParse(rawPublication);
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
        const result: FeatureWorkflowResult =
          'local' in publication
            ? {
                status: 'succeeded',
                localBranch: publication.branch,
                localRepositoryUrl: publication.repositoryUrl,
                publishedBranch: publication.branch,
                publishedCommitSha: publication.commitSha,
              }
            : {
                status: 'succeeded',
                draftPullRequestUrl: publication.pullRequestUrl,
                ...(publication.branch === undefined
                  ? {}
                  : { publishedBranch: publication.branch }),
                ...(publication.commitSha === undefined
                  ? {}
                  : { publishedCommitSha: publication.commitSha }),
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
