import { persistenceId, type DomainRepository } from '@agentos/core';

import type { TriggerApprovalWaiter } from '../trigger/trigger-adapter.js';

export interface LocalApprovalWaiterOptions {
  readonly repository: DomainRepository;
  /** Current time. Defaults to the wall clock. */
  readonly clock?: () => string | Date;
  /** How often the approval row is re-read when no wake arrives. */
  readonly pollIntervalMs?: number;
  /** Aborts every pending wait when the process is shutting down. */
  readonly signal?: AbortSignal;
}

const WAITER_ID_PREFIX = 'local-approval:';
const WAITPOINT_KEY_PREFIX = 'waitpoint:';
const DEFAULT_POLL_INTERVAL_MS = 5_000;

type WaitOutcome =
  { readonly status: 'completed' } | { readonly status: 'timed_out' };

/**
 * The approval id the workflow embedded in its effect key.
 *
 * The key is `waitpoint:<runId>:<approvalId>` (`trigger/workflow.ts`). A run id
 * may itself contain separators, so the approval id is the final segment.
 */
function approvalIdFromEffectKey(idempotencyKey: string): string {
  const separator = idempotencyKey.lastIndexOf(':');
  const approvalId =
    separator === -1 ? '' : idempotencyKey.slice(separator + 1).trim();
  if (!idempotencyKey.startsWith(WAITPOINT_KEY_PREFIX) || approvalId === '')
    throw new Error(
      'local approval waiter expects a waitpoint:<runId>:<approvalId> idempotency key',
    );
  return approvalId;
}

function approvalIdFromWaiterId(id: string): string {
  if (!id.startsWith(WAITER_ID_PREFIX))
    throw new Error('local approval waiter received an unknown waitpoint id');
  const approvalId = id.slice(WAITER_ID_PREFIX.length).trim();
  if (approvalId === '')
    throw new Error('local approval waiter received an unknown waitpoint id');
  return approvalId;
}

/**
 * An approval waiter that needs no external waitpoint service.
 *
 * It is a wake signal and nothing more: it reports that the approval row
 * reached a terminal shape, never which way it was decided. The workflow
 * re-reads the decision from the database itself, so a forged or mistimed wake
 * cannot approve anything.
 */
export function createLocalApprovalWaiter(
  options: LocalApprovalWaiterOptions,
): TriggerApprovalWaiter {
  const pollIntervalMs = Math.max(
    1,
    options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
  );
  const abortSignal = options.signal;
  // Keyed by the waiter id so a wake for an id nobody waits on is a no-op.
  const listeners = new Map<string, Set<() => void>>();

  const nowMs = (): number => {
    const value = options.clock?.() ?? new Date();
    return typeof value === 'string' ? Date.parse(value) : value.getTime();
  };

  const subscribe = (id: string, notify: () => void): (() => void) => {
    const existing = listeners.get(id) ?? new Set<() => void>();
    existing.add(notify);
    listeners.set(id, existing);
    return () => {
      const current = listeners.get(id);
      if (current === undefined) return;
      current.delete(notify);
      if (current.size === 0) listeners.delete(id);
    };
  };

  const evaluate = async (
    approvalId: string,
  ): Promise<WaitOutcome | undefined> => {
    const approval = await options.repository.getApproval(
      persistenceId('approval', approvalId),
    );
    // A row that is not there yet is not a decision. Keep waiting; the
    // deadline is only knowable from the row itself.
    if (approval === undefined) return undefined;
    if (approval.status === 'consumed') return { status: 'completed' };
    if (approval.status === 'expired') return { status: 'timed_out' };
    return Date.parse(approval.expiresAt) <= nowMs()
      ? { status: 'timed_out' }
      : undefined;
  };

  /**
   * One quiet interval: resolves on a wake, on the poll tick, or on shutdown.
   * `dispose` clears the timer and the listeners, so nothing outlives the wait.
   */
  const quietInterval = (id: string) => {
    let settle: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const timer = setTimeout(() => {
      settle();
    }, pollIntervalMs);
    const unsubscribe = subscribe(id, settle);
    const onAbort = () => {
      settle();
    };
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    return {
      promise,
      dispose: () => {
        clearTimeout(timer);
        unsubscribe();
        abortSignal?.removeEventListener('abort', onAbort);
        settle();
      },
    };
  };

  const waiter: TriggerApprovalWaiter = {
    async create(request) {
      return {
        id: `${WAITER_ID_PREFIX}${approvalIdFromEffectKey(request.idempotencyKey)}`,
      };
    },
    async wait(id) {
      const approvalId = approvalIdFromWaiterId(id);
      for (;;) {
        if (abortSignal?.aborted === true)
          throw new Error('local approval wait was aborted during shutdown');
        // Subscribed before the read so a wake that lands mid-read is not lost.
        const quiet = quietInterval(id);
        try {
          const outcome = await evaluate(approvalId);
          if (outcome !== undefined) return outcome;
          await quiet.promise;
        } finally {
          quiet.dispose();
        }
      }
    },
    async wake(id) {
      // Wake-only. The resumed workflow reads the authoritative decision.
      for (const notify of [...(listeners.get(id) ?? [])]) notify();
    },
  };
  return Object.freeze(waiter);
}
