import { describe, expect, it } from 'vitest';

import { DISPATCH_STALL_MS, isAwaitingDispatch } from './dispatch-stall';

const CREATED = '2026-08-20T22:00:00.000Z';
const at = (offsetMs: number) =>
  new Date(Date.parse(CREATED) + offsetMs).toISOString();

describe('isAwaitingDispatch', () => {
  it('stays quiet while a fresh pending run could still be starting', () => {
    expect(
      isAwaitingDispatch({
        status: 'pending',
        stepCount: 0,
        createdAt: CREATED,
        now: at(DISPATCH_STALL_MS - 1),
      }),
    ).toBe(false);
  });

  it('reports a pending run with no steps once the threshold passes', () => {
    expect(
      isAwaitingDispatch({
        status: 'pending',
        stepCount: 0,
        createdAt: CREATED,
        now: at(DISPATCH_STALL_MS),
      }),
    ).toBe(true);
  });

  it('stays quiet once any step exists, however old the run is', () => {
    expect(
      isAwaitingDispatch({
        status: 'pending',
        stepCount: 1,
        createdAt: CREATED,
        now: at(86_400_000),
      }),
    ).toBe(false);
  });

  it('only ever describes pending runs', () => {
    for (const status of [
      'running',
      'waiting',
      'succeeded',
      'failed',
      'cancelled',
    ])
      expect(
        isAwaitingDispatch({
          status,
          stepCount: 0,
          createdAt: CREATED,
          now: at(86_400_000),
        }),
      ).toBe(false);
  });

  it('says nothing when a timestamp cannot be parsed', () => {
    expect(
      isAwaitingDispatch({
        status: 'pending',
        stepCount: 0,
        createdAt: 'not-a-date',
        now: at(86_400_000),
      }),
    ).toBe(false);
  });
});
