// src/ui/backlog-view-model.test.ts
import { describe, expect, it } from 'vitest';

import { backlogView } from './backlog-view-model';
import type { BacklogProjection } from '../application/control-plane-service';

const backlog = (
  overrides: Partial<BacklogProjection> = {},
): BacklogProjection => ({
  id: 'backlog-1',
  projectId: 'project-1',
  title: 'Todo app',
  status: 'active',
  items: [
    {
      id: 'i1',
      ordinal: 1,
      title: 'Add the store',
      status: 'succeeded',
      runId: 'run-1',
    },
    {
      id: 'i2',
      ordinal: 2,
      title: 'List by due date',
      status: 'running',
      runId: 'run-2',
    },
    { id: 'i3', ordinal: 3, title: 'Filter completed', status: 'pending' },
  ],
  createdAt: '2026-08-23T12:00:00.000Z' as BacklogProjection['createdAt'],
  updatedAt: '2026-08-23T12:00:00.000Z' as BacklogProjection['updatedAt'],
  ...overrides,
});

describe('backlogView', () => {
  it('names the state a backlog actually spends its time in', () => {
    // The run is waiting on the operator's approval, not on a machine.
    const view = backlogView(backlog(), {
      waitingRunIds: new Set(['run-2']),
    });
    expect(view.items[1]).toMatchObject({
      state: 'waiting for your approval',
      emphasis: 'attention',
    });
    expect(view.progress).toBe(
      '1 of 3 done · waiting for your approval: List by due date',
    );
  });

  it('says running only when something is actually running', () => {
    const view = backlogView(backlog());
    expect(view.items[1]).toMatchObject({
      state: 'running',
      emphasis: 'active',
    });
    expect(view.items[2]).toMatchObject({ state: 'waiting its turn' });
    expect(view.progress).toBe('1 of 3 done · running: List by due date');
  });

  it('turns each pause reason into a sentence and its next move', () => {
    const depth = backlogView(
      backlog({ status: 'paused', pausedReason: 'chain_too_deep' }),
      { publishedBranch: 'agentos/run-3-abcdef01' },
    );
    expect(depth.paused?.sentence).toMatch(/as deep as the project allows/);
    expect(depth.paused?.action).toBe(
      'Merge agentos/run-3-abcdef01, then resume.',
    );

    const changed = backlogView(
      backlog({
        status: 'paused',
        pausedReason: 'chain_configuration_changed',
      }),
    );
    expect(changed.paused?.sentence).toMatch(/different rules/);

    // An operator pause is not a refusal and must not read like one.
    const manual = backlogView(backlog({ status: 'paused' }));
    expect(manual.paused).toEqual({ sentence: 'You paused this backlog.' });

    // An unrecognized code still says something true rather than nothing.
    const unknown = backlogView(
      backlog({ status: 'paused', pausedReason: 'dispatch_failed' }),
    );
    expect(unknown.paused?.sentence).toBe(
      'The scheduler stopped on dispatch_failed.',
    );
  });

  it('reports completion without inventing a current item', () => {
    const view = backlogView(
      backlog({
        status: 'completed',
        items: [
          {
            id: 'i1',
            ordinal: 1,
            title: 'One',
            status: 'succeeded',
            runId: 'r1',
          },
          {
            id: 'i2',
            ordinal: 2,
            title: 'Two',
            status: 'succeeded',
            runId: 'r2',
          },
        ],
      }),
    );
    expect(view.progress).toBe('2 of 2 done');
    expect(view.paused).toBeUndefined();
  });
});
