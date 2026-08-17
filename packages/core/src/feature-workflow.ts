import { isDuplicateEvent, recordProcessedEvent } from './events.js';
import type { AttestationVerifier } from './attestation.js';
import type {
  DraftPublication,
  RepositoryPublisherAttestationClaims,
} from './ports.js';

export type FeatureWorkflowPhase =
  | 'specification'
  | 'specification_approval'
  | 'planning'
  | 'implementation'
  | 'testing'
  | 'review'
  | 'fixing'
  | 'policy_validation'
  | 'draft_publication';

export type FeatureWorkflowStatus =
  | 'running'
  | 'awaiting_approval'
  | 'blocked'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'budget_exhausted';

export interface FeatureWorkflowState {
  readonly phase: FeatureWorkflowPhase;
  readonly status: FeatureWorkflowStatus;
  readonly maxRetries: number;
  readonly retryCount: number;
  readonly processedEventIds: readonly string[];
  readonly processedEventFingerprints?: Readonly<Record<string, string>>;
  readonly publication?: DraftPublication;
  readonly failureReason?: string;
  readonly blockedFromStatus?: 'running' | 'awaiting_approval';
  readonly publicationBinding?: Omit<
    RepositoryPublisherAttestationClaims,
    'source'
  >;
}

interface WorkflowEventBase {
  readonly id: string;
}

export type FeatureWorkflowEvent =
  | (WorkflowEventBase & { readonly type: 'specification_completed' })
  | (WorkflowEventBase & { readonly type: 'specification_approved' })
  | (WorkflowEventBase & {
      readonly type: 'specification_rejected';
      readonly reason?: string;
    })
  | (WorkflowEventBase & { readonly type: 'plan_completed' })
  | (WorkflowEventBase & { readonly type: 'implementation_completed' })
  | (WorkflowEventBase & { readonly type: 'tests_passed' })
  | (WorkflowEventBase & {
      readonly type: 'tests_failed';
      readonly reason?: string;
    })
  | (WorkflowEventBase & { readonly type: 'review_passed' })
  | (WorkflowEventBase & {
      readonly type: 'review_changes_requested';
      readonly reason?: string;
    })
  | (WorkflowEventBase & { readonly type: 'fix_completed' })
  | (WorkflowEventBase & { readonly type: 'policy_passed' })
  | (WorkflowEventBase & {
      readonly type: 'policy_failed';
      readonly reason?: string;
    })
  | (WorkflowEventBase & {
      readonly type: 'draft_published';
      readonly publication: DraftPublication;
    })
  | (WorkflowEventBase & { readonly type: 'crashed'; readonly reason?: string })
  | (WorkflowEventBase & { readonly type: 'resume' })
  | (WorkflowEventBase & { readonly type: 'cancel'; readonly reason?: string })
  | (WorkflowEventBase & { readonly type: 'exhaust_budget' });

export interface FeatureWorkflowOptions {
  readonly maxRetries: number;
  readonly publicationBinding?: Omit<
    RepositoryPublisherAttestationClaims,
    'source'
  >;
}

export interface FeatureWorkflowContext {
  readonly publisherAttestationVerifier?: AttestationVerifier<RepositoryPublisherAttestationClaims>;
}

export function createFeatureWorkflow(
  options: FeatureWorkflowOptions,
): FeatureWorkflowState {
  if (!Number.isSafeInteger(options.maxRetries) || options.maxRetries < 0) {
    throw new Error('maxRetries must be a non-negative safe integer');
  }
  return {
    phase: 'specification',
    status: 'running',
    maxRetries: options.maxRetries,
    retryCount: 0,
    processedEventIds: [],
    processedEventFingerprints: {},
    ...(options.publicationBinding === undefined
      ? {}
      : { publicationBinding: options.publicationBinding }),
  };
}

const terminalStatuses = new Set<FeatureWorkflowStatus>([
  'succeeded',
  'failed',
  'cancelled',
  'budget_exhausted',
]);

function withProcessed(
  state: FeatureWorkflowState,
  event: FeatureWorkflowEvent,
  changes: Partial<FeatureWorkflowState>,
): FeatureWorkflowState {
  return {
    ...state,
    ...changes,
    ...recordProcessedEvent(state, event),
  };
}

function retryOrFail(
  state: FeatureWorkflowState,
  event: FeatureWorkflowEvent,
  phase: FeatureWorkflowPhase,
): FeatureWorkflowState {
  const retryCount = state.retryCount + 1;
  if (retryCount > state.maxRetries) {
    return withProcessed(state, event, {
      status: 'failed',
      retryCount,
      failureReason: 'retry_limit',
    });
  }
  return withProcessed(state, event, { phase, status: 'running', retryCount });
}

function assertPhase(
  state: FeatureWorkflowState,
  expectedPhase: FeatureWorkflowPhase,
  event: FeatureWorkflowEvent,
): void {
  if (state.phase !== expectedPhase || state.status === 'blocked') {
    throw new Error(
      `Illegal feature workflow transition from ${state.phase}/${state.status} using ${event.type}`,
    );
  }
}

export function reduceFeatureWorkflow(
  state: FeatureWorkflowState,
  event: FeatureWorkflowEvent,
  context: FeatureWorkflowContext = {},
): FeatureWorkflowState {
  if (isDuplicateEvent(state, event)) return state;
  if (terminalStatuses.has(state.status)) {
    throw new Error(
      `Terminal feature workflow state ${state.status} cannot transition`,
    );
  }

  if (event.type === 'cancel') {
    return withProcessed(state, event, {
      status: 'cancelled',
      ...(event.reason === undefined ? {} : { failureReason: event.reason }),
    });
  }
  if (event.type === 'exhaust_budget') {
    return withProcessed(state, event, {
      status: 'budget_exhausted',
      failureReason: 'budget_exhausted',
    });
  }
  if (event.type === 'crashed') {
    if (state.status === 'blocked') return withProcessed(state, event, {});
    const retryCount = state.retryCount + 1;
    if (retryCount > state.maxRetries) {
      return withProcessed(state, event, {
        status: 'failed',
        retryCount,
        failureReason: 'retry_limit',
      });
    }
    return withProcessed(state, event, {
      status: 'blocked',
      retryCount,
      blockedFromStatus:
        state.status === 'awaiting_approval' ? 'awaiting_approval' : 'running',
      ...(event.reason === undefined ? {} : { failureReason: event.reason }),
    });
  }
  if (event.type === 'resume') {
    if (state.status !== 'blocked')
      throw new Error(
        `Illegal feature workflow transition from ${state.status} using resume`,
      );
    return {
      phase: state.phase,
      status: state.blockedFromStatus ?? 'running',
      maxRetries: state.maxRetries,
      retryCount: state.retryCount,
      ...recordProcessedEvent(state, event),
      ...(state.publication === undefined
        ? {}
        : { publication: state.publication }),
      ...(state.publicationBinding === undefined
        ? {}
        : { publicationBinding: state.publicationBinding }),
    };
  }
  if (state.status === 'blocked') {
    throw new Error(
      `Illegal feature workflow transition from blocked using ${event.type}`,
    );
  }

  switch (event.type) {
    case 'specification_completed':
      assertPhase(state, 'specification', event);
      return withProcessed(state, event, {
        phase: 'specification_approval',
        status: 'awaiting_approval',
      });
    case 'specification_approved':
      assertPhase(state, 'specification_approval', event);
      if (state.status !== 'awaiting_approval')
        throw new Error('Specification approval is not pending');
      return withProcessed(state, event, {
        phase: 'planning',
        status: 'running',
      });
    case 'specification_rejected':
      assertPhase(state, 'specification_approval', event);
      if (state.status !== 'awaiting_approval')
        throw new Error('Specification approval is not pending');
      return withProcessed(state, event, {
        status: 'failed',
        failureReason: event.reason ?? 'specification_rejected',
      });
    case 'plan_completed':
      assertPhase(state, 'planning', event);
      return withProcessed(state, event, { phase: 'implementation' });
    case 'implementation_completed':
      assertPhase(state, 'implementation', event);
      return withProcessed(state, event, { phase: 'testing' });
    case 'tests_passed':
      assertPhase(state, 'testing', event);
      return withProcessed(state, event, { phase: 'review' });
    case 'tests_failed':
      assertPhase(state, 'testing', event);
      return retryOrFail(state, event, 'fixing');
    case 'review_passed':
      assertPhase(state, 'review', event);
      return withProcessed(state, event, { phase: 'policy_validation' });
    case 'review_changes_requested':
      assertPhase(state, 'review', event);
      return retryOrFail(state, event, 'fixing');
    case 'fix_completed':
      assertPhase(state, 'fixing', event);
      return withProcessed(state, event, { phase: 'testing' });
    case 'policy_passed':
      assertPhase(state, 'policy_validation', event);
      return withProcessed(state, event, { phase: 'draft_publication' });
    case 'policy_failed':
      assertPhase(state, 'policy_validation', event);
      return retryOrFail(state, event, 'fixing');
    case 'draft_published': {
      assertPhase(state, 'draft_publication', event);
      if (event.publication.draft !== true)
        throw new Error('Only draft publications may complete the workflow');
      const publisherClaims = context.publisherAttestationVerifier?.verify(
        event.publication.attestation,
        {
          subject: event.publication.id,
        },
      );
      if (publisherClaims === undefined)
        throw new Error('A trusted publisher attestation is required');
      if (
        state.publicationBinding === undefined ||
        publisherClaims.source !== 'repository-publisher' ||
        publisherClaims.scopeHash !== state.publicationBinding.scopeHash ||
        publisherClaims.actionHash !== state.publicationBinding.actionHash ||
        publisherClaims.baseSha !== state.publicationBinding.baseSha ||
        publisherClaims.patchHash !== state.publicationBinding.patchHash
      )
        throw new Error(
          'Publisher attestation does not match workflow binding',
        );
      return withProcessed(state, event, {
        status: 'succeeded',
        publication: event.publication,
      });
    }
  }
}

export function replayFeatureWorkflow(
  events: readonly FeatureWorkflowEvent[],
  options: FeatureWorkflowOptions,
  context: FeatureWorkflowContext = {},
): FeatureWorkflowState {
  return events.reduce(
    (state, event) => reduceFeatureWorkflow(state, event, context),
    createFeatureWorkflow(options),
  );
}

export const featureWorkflowReducer = reduceFeatureWorkflow;
