import type { RunStatus } from '@agentos/core';

/**
 * Statuses where execution is moving without operator input. `waiting` is
 * deliberately absent: it is actionable in the Inbox, not active work.
 */
export const ACTIVE_RUN_STATUSES = [
  'pending',
  'running',
] as const satisfies readonly RunStatus[];

const ACTIVE_RUN_STATUS_SET: ReadonlySet<string> = new Set(
  ACTIVE_RUN_STATUSES,
);

export function isRunActive(status: string): boolean {
  return ACTIVE_RUN_STATUS_SET.has(status);
}
