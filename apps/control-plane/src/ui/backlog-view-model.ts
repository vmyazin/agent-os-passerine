// src/ui/backlog-view-model.ts
import type { BacklogProjection } from '../application/control-plane-service';

export interface BacklogItemView {
  readonly id: string;
  readonly ordinal: number;
  readonly title: string;
  readonly runId?: string;
  /** What the operator should understand this item to be doing. */
  readonly state: string;
  readonly emphasis: 'idle' | 'active' | 'attention' | 'done';
}

export interface BacklogView {
  readonly items: readonly BacklogItemView[];
  readonly progress: string;
  readonly paused?: { readonly sentence: string; readonly action?: string };
}

/**
 * "running" is the wrong word for the state a backlog spends most of its
 * time in. An item whose run is waiting on the spec/DoD approval is waiting
 * on *the operator*, and saying so is the difference between a page that
 * reports and a page that asks.
 */
function itemState(
  item: BacklogProjection['items'][number],
  waitingRunIds: ReadonlySet<string>,
): { readonly state: string; readonly emphasis: BacklogItemView['emphasis'] } {
  if (item.status === 'succeeded') return { state: 'done', emphasis: 'done' };
  if (item.status === 'failed') return { state: 'failed', emphasis: 'attention' };
  if (item.status === 'skipped') return { state: 'skipped', emphasis: 'idle' };
  if (item.status === 'running') {
    if (item.runId !== undefined && waitingRunIds.has(item.runId))
      return { state: 'waiting for your approval', emphasis: 'attention' };
    return { state: 'running', emphasis: 'active' };
  }
  return { state: 'waiting its turn', emphasis: 'idle' };
}

/**
 * A pause reason is a code the scheduler stopped on. Left as a code it is a
 * puzzle; each one has a plain reading and, where there is one, the move
 * that unblocks it.
 */
function pausedCopy(
  reason: string | undefined,
  publishedBranch: string | undefined,
): { readonly sentence: string; readonly action?: string } {
  if (reason === undefined)
    return { sentence: 'You paused this backlog.' };
  switch (reason) {
    case 'chain_too_deep':
      return {
        sentence:
          'This stack is as deep as the project allows, so the next item has nowhere to build.',
        action:
          publishedBranch === undefined
            ? 'Merge the published branch, then resume.'
            : `Merge ${publishedBranch}, then resume.`,
      };
    case 'chain_configuration_changed':
      return {
        sentence:
          'A configuration was applied after this backlog started, so the next item would run under different rules than the work it builds on.',
        action:
          'Merge what has published and start a new backlog from the new configuration.',
      };
    case 'base_run_unpublished':
      return {
        sentence:
          'The last item finished without recording where it published, so nothing can be built on it.',
        action: 'Check that run, then start the next item from the project.',
      };
    case 'item_run_failed':
    case 'item_failed':
      return {
        sentence: 'The item that was running did not finish successfully.',
        action: 'Read its run, then resume to try the next item.',
      };
    case 'item_run_cancelled':
      return { sentence: 'The item that was running was cancelled.' };
    case 'project_unconfigured':
      return {
        sentence:
          'This project has no applied configuration, so there is nothing to pin a run to.',
        action: 'Apply one in Setup, then resume.',
      };
    case 'chained_base_taken':
      return {
        sentence:
          'Another active run already builds on the same base, and a chain is a line rather than a tree.',
        action: 'Let that run finish, then resume.',
      };
    default:
      return { sentence: `The scheduler stopped on ${reason}.` };
  }
}

export function backlogView(
  backlog: BacklogProjection,
  context: {
    readonly waitingRunIds?: ReadonlySet<string>;
    readonly publishedBranch?: string;
  } = {},
): BacklogView {
  const waitingRunIds = context.waitingRunIds ?? new Set<string>();
  const items = backlog.items.map((item) => ({
    id: item.id,
    ordinal: item.ordinal,
    title: item.title,
    ...(item.runId === undefined ? {} : { runId: item.runId }),
    ...itemState(item, waitingRunIds),
  }));
  const done = items.filter((item) => item.emphasis === 'done').length;
  const active = items.find((item) => item.emphasis === 'active');
  const attention = items.find((item) => item.emphasis === 'attention');
  const current = attention ?? active;
  const progress =
    `${String(done)} of ${String(items.length)} done` +
    (current === undefined ? '' : ` · ${current.state}: ${current.title}`);
  return {
    items,
    progress,
    ...(backlog.status === 'paused'
      ? { paused: pausedCopy(backlog.pausedReason, context.publishedBranch) }
      : {}),
  };
}
