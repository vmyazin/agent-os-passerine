import { describe, expect, it } from 'vitest';

import {
  createApprovalState,
  createLifecycleState,
  reduceApproval,
  reduceRunState,
  reduceStepState,
} from './lifecycle.js';

describe('run and step state machines', () => {
  it('applies legal run and step transitions', () => {
    const queued = createLifecycleState();
    const running = reduceRunState(queued, { id: '1', type: 'start' });
    const awaiting = reduceStepState(running, {
      id: '2',
      type: 'request_approval',
    });

    expect(running.status).toBe('running');
    expect(awaiting.status).toBe('awaiting_approval');
  });

  it('rejects illegal transitions', () => {
    expect(() =>
      reduceRunState(createLifecycleState(), { id: '1', type: 'succeed' }),
    ).toThrow(/illegal transition/i);
  });

  it.each(['succeeded', 'failed', 'cancelled', 'budget_exhausted'] as const)(
    'keeps terminal state %s terminal',
    (status) => {
      expect(() =>
        reduceStepState(
          { status, processedEventIds: [] },
          { id: 'later', type: 'cancel' },
        ),
      ).toThrow(/terminal/i);
    },
  );

  it('ignores duplicate event IDs idempotently', () => {
    const running = reduceRunState(createLifecycleState(), {
      id: 'same',
      type: 'start',
    });

    expect(reduceRunState(running, { id: 'same', type: 'fail' })).toBe(running);
  });
});

describe('approval state machine', () => {
  const approval = () =>
    createApprovalState({
      id: 'approval-1',
      scopeHash: 'sha256:scope',
      requestedAt: new Date('2026-01-01T00:00:00Z'),
      expiresAt: new Date('2026-01-02T00:00:00Z'),
    });

  it('supports approval and rejection', () => {
    expect(
      reduceApproval(approval(), {
        id: 'event-1',
        type: 'approve',
        actorId: 'operator',
        occurredAt: new Date('2026-01-01T01:00:00Z'),
      }).status,
    ).toBe('approved');
    expect(
      reduceApproval(approval(), {
        id: 'event-2',
        type: 'reject',
        actorId: 'operator',
        reason: 'unsafe',
        occurredAt: new Date('2026-01-01T01:00:00Z'),
      }).status,
    ).toBe('rejected');
  });

  it('expires approvals and treats later duplicate events idempotently', () => {
    const expired = reduceApproval(approval(), {
      id: 'expiry',
      type: 'expire',
      occurredAt: new Date('2026-01-02T00:00:00Z'),
    });

    expect(expired.status).toBe('expired');
    expect(
      reduceApproval(expired, {
        id: 'expiry',
        type: 'approve',
        actorId: 'operator',
        occurredAt: new Date('2026-01-02T01:00:00Z'),
      }),
    ).toBe(expired);
  });
});
