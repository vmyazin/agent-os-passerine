// packages/core/src/backlog.ts
import type { BacklogId, BacklogItemId, IsoTimestamp, ProjectId } from './persistence.js';

export type BacklogStatus = 'active' | 'paused' | 'completed';

export type BacklogItemStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'skipped'
  | 'failed';

export interface Backlog {
  readonly id: BacklogId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly status: BacklogStatus;
  readonly pausedReason?: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface BacklogItem {
  readonly id: BacklogItemId;
  readonly backlogId: BacklogId;
  readonly ordinal: number;
  readonly title: string;
  readonly description: string;
  readonly status: BacklogItemStatus;
  readonly runId?: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

/**
 * What the scheduler needs to know about the run an item produced. Only
 * these four fields decide whether the next item may start, so the decision
 * stays a pure function over a small, explicit shape rather than over the
 * whole run record.
 */
export interface BacklogItemRun {
  readonly runId: string;
  readonly status:
    | 'pending'
    | 'running'
    | 'waiting'
    | 'succeeded'
    | 'failed'
    | 'cancelled';
  readonly publishedBranch?: string;
  readonly publishedCommitSha?: string;
}

export type BacklogAdvance =
  /** Something is in flight, or there is nothing to do right now. */
  | { readonly kind: 'idle' }
  /** Start this item, chained onto `baseRunId` when there is one. */
  | {
      readonly kind: 'dispatch';
      readonly item: BacklogItem;
      readonly baseRunId?: string;
    }
  /** Stop, with a reason the operator can act on. */
  | { readonly kind: 'pause'; readonly reason: string }
  /** Every item succeeded. */
  | { readonly kind: 'complete' };

const TERMINAL_FAILURE: ReadonlySet<BacklogItemRun['status']> = new Set([
  'failed',
  'cancelled',
]);

/**
 * The whole scheduler, as one decision over durable state: given a backlog,
 * its items in order, and the runs those items produced, is there an item to
 * start right now and on what base?
 *
 * It never retries, never skips an item to keep going, and never dispatches
 * past anything that is not a plain success -- a stalled backlog is a
 * question for the operator, and guessing at it is how a scheduler quietly
 * spends money on work nobody asked for.
 */
export function advanceBacklog(
  backlog: Backlog,
  items: readonly BacklogItem[],
  runs: ReadonlyMap<string, BacklogItemRun>,
): BacklogAdvance {
  if (backlog.status !== 'active') return { kind: 'idle' };

  const ordered = [...items].sort((a, b) => a.ordinal - b.ordinal);
  if (ordered.length === 0) return { kind: 'idle' };

  let previousRunId: string | undefined;
  for (const item of ordered) {
    if (item.status === 'skipped') continue;

    if (item.status === 'succeeded') {
      // A succeeded item is the base for whatever comes next, and it must
      // have published something for the next item to build on.
      previousRunId = item.runId ?? previousRunId;
      continue;
    }

    if (item.runId !== undefined) {
      const run = runs.get(item.runId);
      if (run === undefined)
        return { kind: 'pause', reason: 'item_run_missing' };
      if (
        run.status === 'pending' ||
        run.status === 'running' ||
        run.status === 'waiting'
      )
        return { kind: 'idle' };
      if (TERMINAL_FAILURE.has(run.status))
        return { kind: 'pause', reason: `item_run_${run.status}` };
      // Succeeded run whose item is not yet marked: the caller settles the
      // item before the next advance decides anything.
      return { kind: 'idle' };
    }

    if (item.status === 'failed')
      return { kind: 'pause', reason: 'item_failed' };

    if (previousRunId === undefined) return { kind: 'dispatch', item };

    const base = runs.get(previousRunId);
    if (base === undefined) return { kind: 'pause', reason: 'base_run_missing' };
    if (
      base.publishedBranch === undefined ||
      base.publishedCommitSha === undefined
    )
      return { kind: 'pause', reason: 'base_run_unpublished' };
    return { kind: 'dispatch', item, baseRunId: previousRunId };
  }

  return { kind: 'complete' };
}
