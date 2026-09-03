import { z } from 'zod';

import type {
  ArtifactMetadata,
  ArtifactStore,
  CommandCriterion,
  ConfigSnapshot,
  DomainRepository,
  EvidenceSubmission,
  IsoTimestamp,
  JsonValue,
  RuntimeAgent,
  RuntimeEnvironment,
  RuntimeProvider,
  RuntimeHandle,
  RuntimeFileResource,
  RuntimeUsage,
  VerifierRegistry,
} from '@agentos/core';

export const FEATURE_WORKFLOW_TASK_ID = 'agentos-feature-workflow-v1';
export const GOAL_WORKFLOW_TASK_ID = 'agentos-goal-workflow-v1';
export const FEATURE_WORKFLOW_VERSION = 'feature-workflow-v1';
export const FEATURE_WORKFLOW_DEFAULTS = Object.freeze({
  concurrency: 1,
  maxStepAttempts: 2,
  sessionTimeoutMs: 20 * 60 * 1_000,
  workflowTimeoutMs: 60 * 60 * 1_000,
  approvalTtlMs: 24 * 60 * 60 * 1_000,
  workflowMicrodollars: 2_000_000,
  dailyMicrodollars: 5_000_000,
  admissionNumerator: 80,
  admissionDenominator: 100,
  defaultSessionReservationMicrodollars: 700_000,
});

/** Explicitly opts a task-bootstrap failure into Trigger's single retry. */
export class FeatureWorkflowTaskTransientError extends Error {
  constructor(message = 'transient feature workflow task failure') {
    super(message);
    this.name = 'FeatureWorkflowTaskTransientError';
  }
}

/** Explicitly opts a goal-task delivery into Trigger's bounded retry. */
export class GoalWorkflowTaskTransientError extends Error {
  constructor(message = 'transient goal workflow task failure') {
    super(message);
    this.name = 'GoalWorkflowTaskTransientError';
  }
}

export type FeatureRole =
  'specification' | 'planning' | 'implementation' | 'review' | 'verification';

export interface FeatureRoleDefinition {
  readonly agent: RuntimeAgent;
  readonly environment: RuntimeEnvironment;
  readonly maxReservationMicrodollars?: number;
}

/** The roles a feature run needs: three always, two when the project asks. */
export type RequiredFeatureRole =
  'specification' | 'implementation' | 'verification';
export type OptionalFeatureRole = 'planning' | 'review';

/**
 * A step is present when the project's feature pipeline declares it. Planning
 * and review are optional: four real runs showed planning re-derived by the
 * implementer and review vetoing code the acceptance tests then passed. A
 * project that wants either keeps it by declaring the step.
 */
export type FeatureWorkflowRoles = Readonly<
  Record<RequiredFeatureRole, FeatureRoleDefinition> &
    Partial<Record<OptionalFeatureRole, FeatureRoleDefinition>>
>;

export interface FeatureWorkflowInput {
  readonly version: 'feature-workflow-input-v1';
  readonly runId: string;
  readonly projectId: string;
  readonly feature: { readonly title: string; readonly description: string };
  /**
   * Set when this run builds on an earlier run's publication: the source is
   * read at `baseCommitSha` and the publication expects `baseBranch` as its
   * base, instead of the project's default branch.
   */
  readonly chain?:
    | {
        readonly baseRunId: string;
        readonly baseBranch: string;
        readonly baseCommitSha: string;
      }
    | undefined;
  readonly source: {
    readonly repositorySha: string;
    readonly sourceSnapshotDigest: string;
    readonly sourceArtifactKey?: string | undefined;
  };
  readonly digests: {
    readonly config: string;
    readonly model: string;
    readonly prompt: string;
    readonly environment: string;
    readonly policy: string;
  };
}

export interface FeatureWorkflowResult {
  readonly status:
    | 'succeeded'
    | 'rejected'
    | 'expired'
    | 'cancelled'
    | 'budget_exhausted'
    | 'failed';
  readonly draftPullRequestUrl?: string;
  readonly localBranch?: string;
  readonly localRepositoryUrl?: string;
  /**
   * Where the publication actually landed. The publisher reports both, and
   * a later run that chains onto this one needs them to name its base --
   * the run outcome is the only place the control plane can read them, so
   * dropping them here makes the commit unrecoverable. A draft-PR publisher
   * reports `commitSha` optionally, so a run published without one is
   * simply unchainable rather than guessed at.
   */
  readonly publishedBranch?: string;
  readonly publishedCommitSha?: string;
  readonly reason?: string;
}

export interface GoalFailureSummary {
  readonly criterionId: string;
  readonly code: string;
}

export interface GoalStepRequest {
  readonly parentRunId: string;
  readonly projectId: string;
  readonly childRunId: string;
  readonly step: number;
  readonly criteria: readonly CommandCriterion[];
  readonly snapshot: ConfigSnapshot;
  readonly priorFailures: readonly GoalFailureSummary[];
}

export interface GoalStepResult {
  readonly childRunId: string;
  readonly status: FeatureWorkflowResult['status'];
  readonly evidence: readonly EvidenceSubmission[];
  readonly draftPullRequestUrl?: string;
  readonly reason?: string;
}

export interface GoalStepRunner {
  run(request: GoalStepRequest): Promise<GoalStepResult>;
}

export interface GoalWorkflowResult {
  readonly status: 'succeeded' | 'failed' | 'cancelled';
  readonly completedSteps: number;
  readonly maxSteps: number;
  readonly reason?: 'stuck' | 'step_limit' | 'crashed' | 'cancelled' | 'failed';
  readonly criteria: readonly {
    readonly id: string;
    readonly status: 'pending' | 'passed' | 'failed';
    readonly code?: string;
  }[];
  readonly children: readonly {
    readonly step: number;
    readonly runId: string;
    readonly status?: string;
    readonly draftPullRequestUrl?: string;
  }[];
}

export interface DurableGoalWorkflowDependencies {
  readonly repository: DomainRepository;
  readonly stepRunner: GoalStepRunner;
  readonly verifierRegistry: VerifierRegistry;
  readonly clock: () => IsoTimestamp;
}

export interface WorkflowApprovalWaiter {
  create(request: {
    readonly idempotencyKey: string;
    readonly timeout: string;
    readonly tags: readonly string[];
  }): Promise<{ readonly id: string }>;
  wait(
    id: string,
  ): Promise<
    { readonly status: 'completed' } | { readonly status: 'timed_out' }
  >;
}

export interface WorkflowVerificationResult {
  readonly passed: boolean;
  readonly evidenceDigest: string;
  readonly evidenceArtifact?: ArtifactMetadata;
  readonly findings?: readonly string[];
}

export interface WorkflowVerifier {
  verify(input: {
    readonly runId: string;
    readonly workflow: FeatureWorkflowInput;
    readonly producingStepId: string;
    readonly definitionOfDone: JsonValue;
    readonly changeSet: JsonValue;
    readonly testEvidence: JsonValue;
    /**
     * Present only for callers that still pass one. Verification no longer
     * reads it: review is advisory and runs after this gate, so a review
     * cannot be a precondition of the check it is supposed to follow.
     */
    readonly review?: JsonValue;
    readonly trustedCommandObservation: TrustedCommandObservation;
  }): Promise<WorkflowVerificationResult>;
}

export interface TrustedCommandObservation {
  readonly runId: string;
  readonly stepId: string;
  readonly command: string;
  readonly exitCode: number;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly repositorySha: string;
  readonly sourceSnapshotDigest: string;
  readonly changeSetDigest: string;
  readonly configDigest: string;
  /** Diagnostic tail of what the command printed; never attested. */
  readonly output?: string | undefined;
}

export interface WorkflowHandleSealer {
  seal(handle: RuntimeHandle, aad: JsonValue): Promise<string>;
  open(sealed: string, aad: JsonValue): Promise<RuntimeHandle>;
}

export interface RuntimeHandleVault {
  store(input: {
    readonly handle: RuntimeHandle;
    readonly runId: string;
    readonly stepRunId: string;
    readonly role: FeatureRole;
    readonly aad: JsonValue;
    readonly at: string;
  }): Promise<void>;
  load(externalId: string, runId: string): Promise<RuntimeHandle>;
  markCancelled(externalId: string, at: string): Promise<void>;
  markCleaned(externalId: string, at: string): Promise<void>;
}

export interface WorkflowPublicationAuthority {
  authorize(input: {
    readonly workflow: FeatureWorkflowInput;
    readonly changeSet: JsonValue;
    readonly testEvidence: JsonValue;
    readonly verification: WorkflowVerificationResult;
    readonly artifacts: readonly ArtifactMetadata[];
  }): Promise<unknown>;
}

export interface WorkflowPublisher {
  // The GitHub-backed publisher resolves a draft-PR result; the local-git
  // publisher (packages/adapters/src/local-git/publisher.ts) resolves a
  // structurally different `{ local: true, ... }` shape. workflow.ts
  // re-validates whatever comes back against `publicationResultSchema`
  // (the union of both) before trusting any field on it, so the type here
  // stays loose and the schema is the actual contract.
  publish(input: unknown): Promise<unknown>;
}

export type WorkflowEffectStatus =
  'pending' | 'started' | 'succeeded' | 'failed' | 'dead_letter';

export interface WorkflowEffect {
  readonly key: string;
  readonly runId: string;
  readonly kind: string;
  readonly inputFingerprint: string;
  readonly status: WorkflowEffectStatus;
  readonly externalRef?: string;
  readonly output?: JsonValue;
  readonly error?: string;
  readonly ownerId?: string;
  readonly leaseVersion: number;
  readonly leaseExpiresAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkflowEffectLease {
  readonly key: string;
  readonly ownerId: string;
  readonly leaseVersion: number;
}

export interface WorkflowEffectClaim {
  readonly ownerId: string;
  readonly now: string;
  readonly leaseExpiresAt: string;
}

export interface WorkflowSessionAdmission {
  readonly reservationKey: string;
  readonly projectId: string;
  readonly runId: string;
  readonly stepKey: string;
  readonly workflowSpentMicrodollars: number;
  readonly dailySpentMicrodollars: number;
  readonly workflowLimitMicrodollars: number;
  readonly dailyLimitMicrodollars: number;
  readonly admissionNumerator: number;
  readonly admissionDenominator: number;
  readonly deploymentDailyLimitMicrodollars?: number;
  readonly deploymentSpentMicrodollars?: number;
  readonly now: string;
  readonly leaseExpiresAt: string;
  readonly estimatedMicrodollars: number;
}

export interface WorkflowSessionSettlement {
  readonly reservationKey: string;
  readonly runId: string;
  readonly stepKey: string;
  readonly actualMicrodollars: number;
  readonly workflowSpentMicrodollars: number;
  readonly dailySpentMicrodollars: number;
  readonly workflowLimitMicrodollars: number;
  readonly dailyLimitMicrodollars: number;
  readonly now: string;
}

export interface WorkflowBudgetReservation {
  readonly reservationKey: string;
  readonly projectId: string;
  readonly runId: string;
  readonly stepKey: string;
  readonly estimatedMicrodollars: number;
  readonly expiresAt: string;
}

export interface WorkflowCheckpointStore {
  claimEffect(
    effect: Omit<
      WorkflowEffect,
      'status' | 'ownerId' | 'leaseVersion' | 'leaseExpiresAt'
    >,
    claim: WorkflowEffectClaim,
  ): Promise<WorkflowEffect>;
  markEffectStarted(
    lease: WorkflowEffectLease,
    now: string,
  ): Promise<WorkflowEffect>;
  attachExternalRef(
    lease: WorkflowEffectLease,
    externalRef: string,
    now: string,
  ): Promise<WorkflowEffect>;
  completeEffect(
    lease: WorkflowEffectLease,
    output: JsonValue,
    now: string,
  ): Promise<WorkflowEffect>;
  failEffect(
    lease: WorkflowEffectLease,
    error: string,
    deadLetter: boolean,
    now: string,
  ): Promise<WorkflowEffect>;
  renewEffect(
    lease: WorkflowEffectLease,
    now: string,
    leaseExpiresAt: string,
  ): Promise<WorkflowEffect>;
  getEffect(key: string): Promise<WorkflowEffect | undefined>;
  listEffects(runId: string): Promise<readonly WorkflowEffect[]>;
  admitSession(request: WorkflowSessionAdmission): Promise<
    | { readonly admitted: true }
    | {
        readonly admitted: false;
        readonly reason: 'workflow_budget' | 'daily_budget' | 'concurrency';
      }
  >;
  releaseSession(
    projectId: string,
    runId: string,
    stepKey: string,
  ): Promise<void>;
  settleSession(request: WorkflowSessionSettlement): Promise<
    | { readonly settled: true }
    | {
        readonly settled: false;
        readonly reason: 'workflow_budget' | 'daily_budget';
      }
  >;
  listExpiredReservations(
    runId: string,
    now: string,
  ): Promise<readonly WorkflowBudgetReservation[]>;
  /**
   * Clears the checkpoints that would otherwise make a finished run refuse to
   * continue, so an operator can resume it instead of paying to redo every
   * step from the start.
   *
   * Succeeded effects are deliberately kept: they carry the approval that was
   * already granted and the source snapshot that was already taken, and a
   * succeeded step replays from its stored step run without ever reaching its
   * effects. Only the unfinished ones -- including the dead-lettered effect
   * whose whole purpose is to refuse a replay -- are released, together with
   * the run's budget reservations and session lease, which a crash between
   * settlement and cleanup can otherwise strand.
   */
  releaseRunForResume(runId: string): Promise<{ readonly released: number }>;
}

export interface DurableFeatureWorkflowDependencies {
  readonly repository: DomainRepository;
  readonly checkpoints: WorkflowCheckpointStore;
  readonly artifacts: ArtifactStore;
  readonly runtime: RuntimeProvider;
  readonly runtimeAccess?: {
    prepare(input: {
      readonly workflow: FeatureWorkflowInput;
      readonly stepId: string;
      readonly logicalStepId: string;
      readonly role: FeatureRole;
      readonly stepInput: JsonValue;
      readonly idempotencyKey: string;
    }): Promise<{
      readonly resources: readonly RuntimeFileResource[];
      readonly credentialRefs: readonly string[];
      /**
       * True when the references live in this worker process's memory: the
       * checkpoint then records that access was granted, but a replay in
       * another process must prepare fresh instead of reusing them.
       */
      readonly ephemeral?: boolean;
    }>;
  };
  readonly approval: WorkflowApprovalWaiter;
  readonly roles: FeatureWorkflowRoles;
  readonly clock: () => string;
  readonly priceUsage: (usage: RuntimeUsage, model: string) => number;
  readonly budgetLimits?: {
    readonly workflowLimitMicrodollars: number;
    readonly dailyLimitMicrodollars: number;
    readonly admissionNumerator: number;
    readonly admissionDenominator: number;
  };
  readonly projectDailyUsageMicrodollars?: (
    at: string,
    projectId: string,
  ) => Promise<number>;
  readonly deploymentDailyLimitMicrodollars?: number;
  readonly deploymentDailyUsageMicrodollars?: (at: string) => Promise<number>;
  readonly dailyUsageMicrodollars?: (
    at: string,
    projectId: string,
  ) => Promise<number>;
  readonly verifier: WorkflowVerifier;
  /**
   * Refuses a Definition of Done whose acceptance tests cannot parse, before
   * the approval is created. Injectable so a test can stub the subprocess;
   * production uses `assertAcceptanceTestsParse`.
   */
  readonly checkAcceptanceTests?: (
    tests: readonly { readonly path: string; readonly content: string }[],
  ) => Promise<void>;
  /**
   * Paths already present in the run's source bundle. The acceptance-test
   * overlay must be published as `modify`, not `add`, for a path the base
   * repository already carries (the publisher rejects an `add` whose target
   * exists), which happens as soon as an earlier run's acceptance file is
   * merged and a later run reuses that criterion id.
   */
  readonly sourcePaths?: (input: {
    readonly runId: string;
    readonly sourceSnapshotDigest: string;
  }) => ReadonlySet<string> | undefined;
  readonly resolveTestCommand?: (commandKey: string) => string;
  readonly publicationAuthority: WorkflowPublicationAuthority;
  readonly publisher: WorkflowPublisher;
  readonly execution?: {
    readonly taskVersion: string;
    readonly deploymentVersion: string;
    readonly triggerRunId?: string;
  };
  readonly handleSealer?: WorkflowHandleSealer;
}

// --- executor ports -----------------------------------------------------
//
// These described a Trigger.dev deployment until 2026-09-03. They are ports,
// not bindings: the workflow engine never imported the SDK, and the executor
// behind them is now the in-process one. Names are unchanged for this change
// so the removal stays reviewable; renaming them is its own follow-up (see
// docs/superpowers/specs/2026-09-03-remove-trigger-design.md).

export const featureTaskPayloadSchema = z
  .object({
    version: z.literal('feature-task-payload-v1'),
    runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  })
  .strict();

export type FeatureTaskPayload = z.infer<typeof featureTaskPayloadSchema>;

export const goalTaskPayloadSchema = z
  .object({
    version: z.literal('goal-task-payload-v1'),
    runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  })
  .strict();

export type GoalTaskPayload = z.infer<typeof goalTaskPayloadSchema>;

/**
 * How an execution identifies itself to the workflow. `triggerRunId` is the
 * executor's own reference for this attempt; the workflow only ever uses it
 * to build the owner string that fences its side effects.
 */
export interface WorkflowExecutionContext {
  readonly taskVersion: string;
  readonly deploymentVersion: string;
  readonly triggerRunId?: string;
}

export interface FeatureWorkflowTaskHandler {
  run(
    payload: FeatureTaskPayload,
    execution?: WorkflowExecutionContext,
  ): Promise<unknown>;
}

export interface GoalWorkflowTaskHandler {
  run(
    payload: GoalTaskPayload,
    execution?: WorkflowExecutionContext,
  ): Promise<unknown>;
}

/**
 * What the outbox hands a run to. `retrieve` is read-only and best effort: an
 * unknown reference answers `undefined` rather than throwing, because it
 * exists to explain a page and must never be why one fails to render.
 */
export interface TriggerWorkflowDispatcher {
  startFeature(
    runId: string,
    projectId: string,
    attempt?: 0 | 1,
    resumeGeneration?: number,
  ): Promise<{ readonly externalRunRef: string }>;
  startGoal(
    runId: string,
    projectId: string,
    attempt?: 0 | 1,
    resumeGeneration?: number,
  ): Promise<{ readonly externalRunRef: string }>;
  retrieve(
    externalRunRef: string,
  ): Promise<{ readonly status: string; readonly error?: string } | undefined>;
  cancel(externalRunRef: string): Promise<void>;
}

/**
 * The approval gate's wake signal. It reports only that something changed;
 * the decision itself is always re-read from Postgres, so a waiter cannot
 * approve anything.
 */
export interface TriggerApprovalWaiter extends WorkflowApprovalWaiter {
  wake(id: string): Promise<void>;
}
