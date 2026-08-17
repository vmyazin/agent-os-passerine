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
export const FEATURE_WORKFLOW_VERSION = 'feature-workflow-v1';
export const FEATURE_WORKFLOW_DEFAULTS = Object.freeze({
  concurrency: 1,
  maxStepAttempts: 2,
  sessionTimeoutMs: 20 * 60 * 1_000,
  workflowTimeoutMs: 60 * 60 * 1_000,
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

export type FeatureRole =
  'specification' | 'planning' | 'implementation' | 'review' | 'verification';

export interface FeatureRoleDefinition {
  readonly agent: RuntimeAgent;
  readonly environment: RuntimeEnvironment;
  readonly maxReservationMicrodollars?: number;
}

export type FeatureWorkflowRoles = Readonly<
  Record<FeatureRole, FeatureRoleDefinition>
>;

export interface FeatureWorkflowInput {
  readonly version: 'feature-workflow-input-v1';
  readonly runId: string;
  readonly projectId: string;
  readonly feature: { readonly title: string; readonly description: string };
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
    readonly review: JsonValue;
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
  publish(input: unknown): Promise<{
    readonly status: 'succeeded';
    readonly draft: true;
    readonly pullRequestUrl: string;
  }>;
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
  releaseSession(runId: string, stepKey: string): Promise<void>;
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
    }>;
  };
  readonly approval: WorkflowApprovalWaiter;
  readonly roles: FeatureWorkflowRoles;
  readonly clock: () => string;
  readonly priceUsage: (usage: RuntimeUsage, model: string) => number;
  readonly dailyUsageMicrodollars?: (
    at: string,
    projectId: string,
  ) => Promise<number>;
  readonly verifier: WorkflowVerifier;
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
