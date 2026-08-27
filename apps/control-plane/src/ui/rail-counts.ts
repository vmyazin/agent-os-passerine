// src/ui/rail-counts.ts
import { controlPlaneService } from '../application/runtime';

export interface RailCounts {
  readonly inboxCount: number;
  readonly waitingCount: number;
  readonly projectCount: number;
}

export async function fetchInboxAttentionCount(): Promise<number> {
  return controlPlaneService().countInboxAttention();
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
    const [inboxCount, waiting, projectCount] = await Promise.all([
      fetchInboxAttentionCount(),
      service.countRunsByStatus('waiting'),
      service.countProjects(),
    ]);
    return {
      inboxCount,
      waitingCount: waiting,
      projectCount,
    };
  } catch {
    return undefined;
  }
}
