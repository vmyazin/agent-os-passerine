import { isDuplicateEvent, recordProcessedEvent } from './events.js';

export const lifecycleStatuses = [
  'queued',
  'running',
  'awaiting_approval',
  'blocked',
  'succeeded',
  'failed',
  'cancelled',
  'budget_exhausted',
] as const;

export type LifecycleStatus = (typeof lifecycleStatuses)[number];
export type TerminalStatus =
  'succeeded' | 'failed' | 'cancelled' | 'budget_exhausted';

export interface LifecycleState {
  readonly status: LifecycleStatus;
  readonly processedEventIds: readonly string[];
  readonly processedEventFingerprints?: Readonly<Record<string, string>>;
}

export type LifecycleEvent =
  | { readonly id: string; readonly type: 'start' }
  | { readonly id: string; readonly type: 'request_approval' }
  | { readonly id: string; readonly type: 'resume' }
  | { readonly id: string; readonly type: 'block' }
  | { readonly id: string; readonly type: 'unblock' }
  | { readonly id: string; readonly type: 'succeed' }
  | { readonly id: string; readonly type: 'fail' }
  | { readonly id: string; readonly type: 'cancel' }
  | { readonly id: string; readonly type: 'exhaust_budget' };

const terminalStatuses = new Set<LifecycleStatus>([
  'succeeded',
  'failed',
  'cancelled',
  'budget_exhausted',
]);

const transitions: Readonly<
  Record<
    Exclude<LifecycleStatus, TerminalStatus>,
    Partial<Record<LifecycleEvent['type'], LifecycleStatus>>
  >
> = {
  queued: {
    start: 'running',
    cancel: 'cancelled',
    exhaust_budget: 'budget_exhausted',
    block: 'blocked',
  },
  running: {
    request_approval: 'awaiting_approval',
    block: 'blocked',
    succeed: 'succeeded',
    fail: 'failed',
    cancel: 'cancelled',
    exhaust_budget: 'budget_exhausted',
  },
  awaiting_approval: {
    resume: 'running',
    block: 'blocked',
    fail: 'failed',
    cancel: 'cancelled',
    exhaust_budget: 'budget_exhausted',
  },
  blocked: {
    unblock: 'queued',
    resume: 'running',
    fail: 'failed',
    cancel: 'cancelled',
    exhaust_budget: 'budget_exhausted',
  },
};

export function createLifecycleState(): LifecycleState {
  return {
    status: 'queued',
    processedEventIds: [],
    processedEventFingerprints: {},
  };
}

export function reduceLifecycleState(
  state: LifecycleState,
  event: LifecycleEvent,
): LifecycleState {
  if (isDuplicateEvent(state, event)) return state;
  if (terminalStatuses.has(state.status)) {
    throw new Error(`Terminal state ${state.status} cannot transition`);
  }
  const nextStatus =
    transitions[state.status as Exclude<LifecycleStatus, TerminalStatus>][
      event.type
    ];
  if (nextStatus === undefined) {
    throw new Error(
      `Illegal transition from ${state.status} using ${event.type}`,
    );
  }
  return { status: nextStatus, ...recordProcessedEvent(state, event) };
}

export const reduceRunState = reduceLifecycleState;
export const reduceStepState = reduceLifecycleState;

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface ApprovalState {
  readonly id: string;
  readonly scopeHash: string;
  readonly status: ApprovalStatus;
  readonly requestedAt: Date;
  readonly expiresAt: Date;
  readonly processedEventIds: readonly string[];
  readonly processedEventFingerprints?: Readonly<Record<string, string>>;
  readonly actorId?: string;
  readonly reason?: string;
  readonly decidedAt?: Date;
}

export interface CreateApprovalRequest {
  readonly id: string;
  readonly scopeHash: string;
  readonly requestedAt: Date;
  readonly expiresAt: Date;
}

export type ApprovalEvent =
  | {
      readonly id: string;
      readonly type: 'approve';
      readonly actorId: string;
      readonly scopeHash: string;
      readonly occurredAt: Date;
    }
  | {
      readonly id: string;
      readonly type: 'reject';
      readonly actorId: string;
      readonly scopeHash: string;
      readonly reason?: string;
      readonly occurredAt: Date;
    }
  | { readonly id: string; readonly type: 'expire'; readonly occurredAt: Date };

export function createApprovalState(
  request: CreateApprovalRequest,
): ApprovalState {
  if (
    !Number.isFinite(request.requestedAt.getTime()) ||
    !Number.isFinite(request.expiresAt.getTime())
  )
    throw new Error('Approval timestamps must be valid');
  if (request.id.trim() === '' || request.scopeHash.trim() === '')
    throw new Error('Approval ID and scope hash must be non-empty');
  if (request.expiresAt <= request.requestedAt)
    throw new Error('Approval expiry must be after request time');
  return {
    ...request,
    status: 'pending',
    processedEventIds: [],
    processedEventFingerprints: {},
  };
}

export function reduceApproval(
  state: ApprovalState,
  event: ApprovalEvent,
): ApprovalState {
  if (!Number.isFinite(event.occurredAt.getTime()))
    throw new Error('Approval event timestamp must be valid');
  if (
    (event.type === 'approve' || event.type === 'reject') &&
    event.scopeHash !== state.scopeHash
  )
    throw new Error('Approval decision scope hash does not match request');
  if (isDuplicateEvent(state, event)) return state;
  if (state.status !== 'pending')
    throw new Error(
      `Terminal approval state ${state.status} cannot transition`,
    );
  if (event.occurredAt < state.requestedAt) {
    throw new Error('Approval decision cannot occur before its request time');
  }
  if (event.type === 'expire' && event.occurredAt < state.expiresAt) {
    throw new Error('Approval cannot expire before its expiry time');
  }
  const processed = recordProcessedEvent(state, event);
  if (event.type === 'expire' || event.occurredAt >= state.expiresAt) {
    return {
      ...state,
      status: 'expired',
      decidedAt: event.occurredAt,
      ...processed,
    };
  }
  if (event.type === 'approve') {
    return {
      ...state,
      status: 'approved',
      actorId: event.actorId,
      decidedAt: event.occurredAt,
      ...processed,
    };
  }
  return {
    ...state,
    status: 'rejected',
    actorId: event.actorId,
    ...(event.reason === undefined ? {} : { reason: event.reason }),
    decidedAt: event.occurredAt,
    ...processed,
  };
}
