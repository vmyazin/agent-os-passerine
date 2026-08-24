// src/ui/run-status-model.test.ts
import { describe, expect, it } from 'vitest';

import { elapsedLabel, explainRunStatus } from './run-status-model';

const created = '2026-08-24T03:23:13.000Z';

describe('elapsedLabel', () => {
  it('uses the coarsest unit that is still honest', () => {
    expect(elapsedLabel(created, '2026-08-24T03:23:40.000Z')).toBe(
      'less than a minute',
    );
    expect(elapsedLabel(created, '2026-08-24T03:24:20.000Z')).toBe('1 minute');
    expect(elapsedLabel(created, '2026-08-24T03:26:20.000Z')).toBe('3 minutes');
    expect(elapsedLabel(created, '2026-08-24T05:00:00.000Z')).toBe('1 hour');
    expect(elapsedLabel(created, '2026-08-24T09:00:00.000Z')).toBe('5 hours');
  });

  it('never reports a negative age from a clock that disagrees', () => {
    expect(elapsedLabel(created, '2026-08-24T03:00:00.000Z')).toBe(
      'less than a minute',
    );
    expect(elapsedLabel('not a date', created)).toBe('an unknown time');
  });
});

describe('explainRunStatus', () => {
  const pending = (now: string) =>
    explainRunStatus({
      status: 'pending',
      stepCount: 0,
      createdAt: created,
      updatedAt: created,
      now,
    });

  it('says how long pending has been true, and what has to happen', () => {
    // The case that prompted this: a bare "Pending" looks the same two
    // seconds in as it does when the worker will never arrive.
    expect(pending('2026-08-24T03:24:20.000Z')).toEqual({
      summary: 'Queued 1 minute ago. Nothing has run yet.',
      next: 'A Trigger.dev worker has to claim it before the first step runs.',
      live: true,
    });
  });

  it('escalates once nothing has claimed it for long enough', () => {
    expect(pending('2026-08-24T03:26:20.000Z').next).toBe(
      'A worker should have claimed this by now — see below.',
    );
  });

  it('points a waiting run at the decision it is waiting on', () => {
    const waiting = explainRunStatus({
      status: 'waiting',
      stepCount: 2,
      createdAt: created,
      updatedAt: '2026-08-24T03:30:00.000Z',
      now: '2026-08-24T04:30:00.000Z',
    });
    expect(waiting.summary).toBe('Waiting for you since 1 hour ago.');
    expect(waiting.next).toMatch(/Inbox/);
    expect(waiting.live).toBe(true);
  });

  it('stops refreshing once the run is over', () => {
    for (const status of ['succeeded', 'failed', 'cancelled']) {
      expect(
        explainRunStatus({
          status,
          stepCount: 5,
          createdAt: created,
          updatedAt: '2026-08-24T04:00:00.000Z',
          now: '2026-08-24T04:05:00.000Z',
        }).live,
      ).toBe(false);
    }
  });
});
