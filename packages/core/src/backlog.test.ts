// packages/core/src/backlog.test.ts
import { describe, expect, it } from 'vitest';

import {
  advanceBacklog,
  type Backlog,
  type BacklogItem,
  type BacklogItemRun,
  type BacklogItemStatus,
} from './backlog.js';
import { isoTimestamp, persistenceId } from './persistence.js';

const at = isoTimestamp('2026-08-23T12:00:00.000Z');

const backlog = (status: Backlog['status'] = 'active'): Backlog => ({
  id: persistenceId('backlog', 'backlog-1'),
  projectId: persistenceId('project', 'project-1'),
  title: 'Todo app',
  status,
  createdAt: at,
  updatedAt: at,
});

const item = (
  ordinal: number,
  status: BacklogItemStatus = 'pending',
  runId?: string,
): BacklogItem => ({
  id: persistenceId('backlogItem', `item-${String(ordinal)}`),
  backlogId: persistenceId('backlog', 'backlog-1'),
  ordinal,
  title: `Feature ${String(ordinal)}`,
  description: `Build feature ${String(ordinal)}.`,
  status,
  ...(runId === undefined ? {} : { runId }),
  createdAt: at,
  updatedAt: at,
});

const published = (runId: string): BacklogItemRun => ({
  runId,
  status: 'succeeded',
  publishedBranch: `agentos/${runId}-abcdef01`,
  publishedCommitSha: 'd'.repeat(40),
});

const runs = (...entries: BacklogItemRun[]) =>
  new Map(entries.map((entry) => [entry.runId, entry]));

describe('advanceBacklog', () => {
  it('dispatches the first item unchained', () => {
    expect(advanceBacklog(backlog(), [item(1)], runs())).toEqual({
      kind: 'dispatch',
      item: item(1),
    });
  });

  it('chains the next item onto the last succeeded run', () => {
    expect(
      advanceBacklog(
        backlog(),
        [item(1, 'succeeded', 'run-1'), item(2)],
        runs(published('run-1')),
      ),
    ).toEqual({ kind: 'dispatch', item: item(2), baseRunId: 'run-1' });
  });

  it('reads items in ordinal order, not storage order', () => {
    expect(
      advanceBacklog(
        backlog(),
        [item(2), item(1, 'succeeded', 'run-1')],
        runs(published('run-1')),
      ),
    ).toMatchObject({ kind: 'dispatch', baseRunId: 'run-1' });
  });

  it('waits while an item is in flight', () => {
    for (const status of ['pending', 'running', 'waiting'] as const) {
      expect(
        advanceBacklog(
          backlog(),
          [item(1, 'running', 'run-1'), item(2)],
          runs({ runId: 'run-1', status }),
        ),
      ).toEqual({ kind: 'idle' });
    }
  });

  it('pauses on a run that did not succeed', () => {
    for (const status of ['failed', 'cancelled'] as const) {
      expect(
        advanceBacklog(
          backlog(),
          [item(1, 'running', 'run-1'), item(2)],
          runs({ runId: 'run-1', status }),
        ),
      ).toEqual({ kind: 'pause', reason: `item_run_${status}` });
    }
  });

  it('pauses when the base run published nothing to build on', () => {
    // A draft PR whose publisher reported no commit: the next item has no
    // base, and guessing one would put the work on the wrong commit.
    expect(
      advanceBacklog(
        backlog(),
        [item(1, 'succeeded', 'run-1'), item(2)],
        runs({ runId: 'run-1', status: 'succeeded' }),
      ),
    ).toEqual({ kind: 'pause', reason: 'base_run_unpublished' });
  });

  it('pauses when a run the item names has vanished', () => {
    expect(
      advanceBacklog(backlog(), [item(1, 'running', 'run-1')], runs()),
    ).toEqual({ kind: 'pause', reason: 'item_run_missing' });
  });

  it('pauses on an item marked failed with no run of its own', () => {
    expect(
      advanceBacklog(backlog(), [item(1, 'failed'), item(2)], runs()),
    ).toEqual({ kind: 'pause', reason: 'item_failed' });
  });

  it('skips a skipped item and chains past it', () => {
    expect(
      advanceBacklog(
        backlog(),
        [item(1, 'succeeded', 'run-1'), item(2, 'skipped'), item(3)],
        runs(published('run-1')),
      ),
    ).toEqual({ kind: 'dispatch', item: item(3), baseRunId: 'run-1' });
  });

  it('completes when every item is done', () => {
    expect(
      advanceBacklog(
        backlog(),
        [item(1, 'succeeded', 'run-1'), item(2, 'skipped')],
        runs(published('run-1')),
      ),
    ).toEqual({ kind: 'complete' });
  });

  it('does nothing for a paused or completed backlog, or an empty one', () => {
    expect(advanceBacklog(backlog('paused'), [item(1)], runs())).toEqual({
      kind: 'idle',
    });
    expect(advanceBacklog(backlog('completed'), [item(1)], runs())).toEqual({
      kind: 'idle',
    });
    expect(advanceBacklog(backlog(), [], runs())).toEqual({ kind: 'idle' });
  });

  it('waits for the caller to settle an item whose run already succeeded', () => {
    // The run is done but the item still says running: settling it is the
    // caller's next write, and dispatching now would chain onto an item the
    // durable state has not yet accepted.
    expect(
      advanceBacklog(
        backlog(),
        [item(1, 'running', 'run-1'), item(2)],
        runs(published('run-1')),
      ),
    ).toEqual({ kind: 'idle' });
  });
});
