// src/ui/rail-counts.ts
import { controlPlaneService } from '../application/runtime';
import { ACTIVE_RUN_STATUSES } from './active-run-status';

export interface RailCounts {
  readonly inboxCount: number;
  readonly waitingCount: number;
  readonly projectCount: number;
  readonly activeRunCount: number;
}

export async function fetchInboxAttentionCount(): Promise<number> {
  return controlPlaneService().countInboxAttention();
}

export async function fetchActiveRunCount(): Promise<number> {
  const service = controlPlaneService();
  const counts = await Promise.all(
    ACTIVE_RUN_STATUSES.map((status) => service.countRunsByStatus(status)),
  );
  return counts.reduce((total, count) => total + count, 0);
}

/**
 * One shared fetch for every rail badge (nav count + status banner), so the
 * layout shares these cheap aggregate queries no matter how many badges
 * consume them. Uses no projections or approval summaries and
 * fails soft — a badge must never take the page down with it.
 */
export async function fetchRailCounts(): Promise<RailCounts | undefined> {
  try {
    const service = controlPlaneService();
    const [inboxCount, waiting, projectCount, activeRunCount] =
      await Promise.all([
        fetchInboxAttentionCount(),
        service.countRunsByStatus('waiting'),
        service.countProjects(),
        fetchActiveRunCount(),
      ]);
    return {
      inboxCount,
      waitingCount: waiting,
      projectCount,
      activeRunCount,
    };
  } catch {
    return undefined;
  }
}
