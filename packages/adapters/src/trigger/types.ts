import type {
  ArtifactMetadata,
  ArtifactStore,
  DomainRepository,
  JsonValue,
  RuntimeAgent,
  RuntimeEnvironment,
  RuntimeProvider,
  RuntimeUsage,
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
});

/** Explicitly opts a task-bootstrap failure into Trigger's single retry. */
export class FeatureWorkflowTaskTransientError extends Error {
  constructor(message = 'transient feature workflow task failure') {
    super(message);
    this.name = 'FeatureWorkflowTaskTransientError';
  }
}

export type FeatureRole =
  'specification' | 'planning' | 'implementation' | 'review';

export interface FeatureRoleDefinition {
  readonly agent: RuntimeAgent;
  readonly environment: RuntimeEnvironment;
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
  readonly findings?: readonly string[];
}

export interface WorkflowVerifier {
  verify(input: {
    readonly runId: string;
    readonly definitionOfDone: JsonValue;
    readonly changeSet: JsonValue;
    readonly testEvidence: JsonValue;
    readonly review: JsonValue;
  }): Promise<WorkflowVerificationResult>;
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
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkflowSessionAdmission {
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
}

export interface WorkflowCheckpointStore {
  claimEffect(effect: Omit<WorkflowEffect, 'status'>): Promise<WorkflowEffect>;
  markEffectStarted(key: string, now: string): Promise<WorkflowEffect>;
  attachExternalRef(
    key: string,
    externalRef: string,
    now: string,
  ): Promise<WorkflowEffect>;
  completeEffect(
    key: string,
    output: JsonValue,
    now: string,
  ): Promise<WorkflowEffect>;
  failEffect(
    key: string,
    error: string,
    deadLetter: boolean,
    now: string,
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
}

export interface DurableFeatureWorkflowDependencies {
  readonly repository: DomainRepository;
  readonly checkpoints: WorkflowCheckpointStore;
  readonly artifacts: ArtifactStore;
  readonly runtime: RuntimeProvider;
  readonly approval: WorkflowApprovalWaiter;
  readonly roles: FeatureWorkflowRoles;
  readonly clock: () => string;
  readonly priceUsage: (usage: RuntimeUsage, model: string) => number;
  readonly dailyUsageMicrodollars?: (
    at: string,
    projectId: string,
  ) => Promise<number>;
  readonly verifier: WorkflowVerifier;
  readonly publicationAuthority: WorkflowPublicationAuthority;
  readonly publisher: WorkflowPublisher;
}
