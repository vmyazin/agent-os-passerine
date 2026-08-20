// src/ui/rail-status-model.ts
import type {
  ApprovalProjection,
  InboxProjection,
  RunProjection,
} from '../application/control-plane-service';

export function countInboxAttention(
  approvals: readonly ApprovalProjection[],
  messages: readonly InboxProjection[],
): number {
  return (
    approvals.length +
    messages.filter((message) => message.status === 'pending').length
  );
}

export function countWaitingRuns(
  runs: readonly Pick<RunProjection, 'status'>[],
): number {
  return runs.filter((run) => run.status === 'waiting').length;
}
