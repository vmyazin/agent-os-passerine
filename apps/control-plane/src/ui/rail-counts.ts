// src/ui/rail-counts.ts
import { controlPlaneService } from '../application/runtime';
import { countInboxAttention } from './rail-status-model';

export interface RailCounts {
  readonly inboxCount: number;
  readonly waitingCount: number;
}

/**
 * One shared fetch for every rail badge (nav count + status banner), so the
 * layout costs three queries per render no matter how many badges consume
 * it. Uses the cheap primitives (no projections, no approval summaries) and
 * fails soft — a badge must never take the page down with it.
 */
export async function fetchRailCounts(): Promise<RailCounts | undefined> {
  try {
    const service = controlPlaneService();
    const [messages, approvals, waiting] = await Promise.all([
      service.listInbox(),
      service.listPendingApprovals(50, false),
      service.countRunsByStatus('waiting'),
    ]);
    return {
      inboxCount: countInboxAttention(approvals, messages),
      waitingCount: waiting,
    };
  } catch {
    return undefined;
  }
}
