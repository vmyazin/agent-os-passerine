// src/ui/rail-status-model.test.ts
import { describe, expect, it } from 'vitest';

import type {
  ApprovalProjection,
  InboxProjection,
  RunProjection,
} from '../application/control-plane-service';
import { countInboxAttention, countWaitingRuns } from './rail-status-model';

describe('rail status model', () => {
  it('counts pending approvals and unreplied inbox messages', () => {
    const approvals = [
      { id: 'a1' },
    ] as unknown as readonly ApprovalProjection[];
    const messages = [
      { status: 'pending' },
      { status: 'replied' },
    ] as unknown as readonly InboxProjection[];

    expect(countInboxAttention(approvals, messages)).toBe(2);
  });

  it('counts waiting runs only', () => {
    const runs = [
      { status: 'waiting' },
      { status: 'running' },
      { status: 'waiting' },
    ] as readonly Pick<RunProjection, 'status'>[];

    expect(countWaitingRuns(runs)).toBe(2);
  });
});
