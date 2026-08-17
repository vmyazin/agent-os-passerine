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

    expect(reduceRunState(running, { id: 'same', type: 'start' })).toBe(
      running,
    );
  });

  it('rejects empty event IDs and colliding event payloads', () => {
    expect(() =>
      reduceRunState(createLifecycleState(), { id: '', type: 'start' }),
    ).toThrow(/event id/i);
    const running = reduceRunState(createLifecycleState(), {
      id: 'collision',
      type: 'start',
    });
    expect(() =>
      reduceRunState(running, { id: 'collision', type: 'fail' }),
    ).toThrow(/different/i);
  });

  it('does not confuse inherited object names with processed event IDs', () => {
    expect(
      reduceRunState(createLifecycleState(), { id: 'toString', type: 'start' })
        .status,
    ).toBe('running');
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
        scopeHash: 'sha256:scope',
        occurredAt: new Date('2026-01-01T01:00:00Z'),
      }).status,
    ).toBe('approved');
    expect(
      reduceApproval(approval(), {
        id: 'event-2',
        type: 'reject',
        actorId: 'operator',
        scopeHash: 'sha256:scope',
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
        type: 'expire',
        occurredAt: new Date('2026-01-02T00:00:00Z'),
      }),
    ).toBe(expired);
  });

  it('rejects approval before it was requested', () => {
    expect(() =>
      reduceApproval(approval(), {
        id: 'early-approve',
        type: 'approve',
        actorId: 'operator',
        scopeHash: 'sha256:scope',
        occurredAt: new Date('2025-12-31T23:59:59Z'),
      }),
    ).toThrow(/before.*request/i);
  });

  it('rejects rejection before approval was requested', () => {
    expect(() =>
      reduceApproval(approval(), {
        id: 'early-reject',
        type: 'reject',
        actorId: 'operator',
        scopeHash: 'sha256:scope',
        reason: 'impossible chronology',
        occurredAt: new Date('2025-12-31T23:59:59Z'),
      }),
    ).toThrow(/before.*request/i);
  });

  it.each([
    ['request', new Date(Number.NaN), new Date('2026-01-02T00:00:00Z')],
    ['expiry', new Date('2026-01-01T00:00:00Z'), new Date(Number.NaN)],
  ])('rejects invalid %s timestamp', (_label, requestedAt, expiresAt) => {
    expect(() =>
      createApprovalState({
        id: 'approval-invalid-time',
        scopeHash: 'sha256:scope',
        requestedAt,
        expiresAt,
      }),
    ).toThrow(/timestamp/i);
  });

  it('rejects invalid event timestamps', () => {
    expect(() =>
      reduceApproval(approval(), {
        id: 'invalid-time',
        type: 'expire',
        occurredAt: new Date(Number.NaN),
      }),
    ).toThrow(/timestamp/i);
  });

  it('rejects a reused approval event ID with a different decision', () => {
    const approved = reduceApproval(approval(), {
      id: 'decision',
      type: 'approve',
      actorId: 'operator',
      scopeHash: 'sha256:scope',
      occurredAt: new Date('2026-01-01T01:00:00Z'),
    });
    expect(() =>
      reduceApproval(approved, {
        id: 'decision',
        type: 'reject',
        actorId: 'operator',
        scopeHash: 'sha256:scope',
        occurredAt: new Date('2026-01-01T01:00:00Z'),
      }),
    ).toThrow(/different/i);
  });

  it('binds approval decisions to the requested scope hash', () => {
    expect(() =>
      reduceApproval(approval(), {
        id: 'wrong-scope',
        type: 'approve',
        actorId: 'operator',
        scopeHash: 'sha256:different',
        occurredAt: new Date('2026-01-01T01:00:00Z'),
      }),
    ).toThrow(/scope/i);
  });
});
