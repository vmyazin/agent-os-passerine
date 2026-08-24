// src/ui/run-status-model.ts
import { DISPATCH_STALL_MS } from './dispatch-stall';

export interface RunStatusExplanation {
  /** What is true right now, in one sentence. */
  readonly summary: string;
  /** What has to happen before anything changes, when the operator can act. */
  readonly next?: string;
  /** Whether the page should keep refreshing itself. */
  readonly live: boolean;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * How long something has been true, in the coarsest unit that is still
 * honest. "3 minutes" is what an operator compares against a deadline; "184
 * seconds" makes them do the arithmetic.
 */
export function elapsedLabel(fromIso: string, nowIso: string): string {
  const from = Date.parse(fromIso);
  const now = Date.parse(nowIso);
  if (Number.isNaN(from) || Number.isNaN(now)) return 'an unknown time';
  const ms = Math.max(0, now - from);
  if (ms < MINUTE_MS) return 'less than a minute';
  if (ms < HOUR_MS) {
    const minutes = Math.floor(ms / MINUTE_MS);
    return minutes === 1 ? '1 minute' : `${String(minutes)} minutes`;
  }
  const hours = Math.floor(ms / HOUR_MS);
  return hours === 1 ? '1 hour' : `${String(hours)} hours`;
}

/**
 * What a run's status means, for someone looking at the page and wondering
 * whether to wait or to act.
 *
 * A bare "Pending" is the worst of these: it looks identical whether the run
 * was created two seconds ago, is queued behind another, or was enqueued to a
 * worker that will never arrive. The page cannot distinguish the last case
 * before the stall threshold, but it can always say how long it has been
 * true and what has to happen next -- which is the difference between waiting
 * and wondering.
 */
export function explainRunStatus({
  status,
  stepCount,
  createdAt,
  updatedAt,
  now,
}: {
  readonly status: string;
  readonly stepCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly now: string;
}): RunStatusExplanation {
  const age = elapsedLabel(createdAt, now);
  const since = elapsedLabel(updatedAt, now);
  switch (status) {
    case 'pending': {
      if (stepCount > 0)
        return {
          summary: `Started ${age} ago, between steps.`,
          next: 'The next step begins when a worker picks it up.',
          live: true,
        };
      const stalled =
        Date.parse(now) - Date.parse(createdAt) >= DISPATCH_STALL_MS;
      return {
        summary: `Queued ${age} ago. Nothing has run yet.`,
        next: stalled
          ? 'A worker should have claimed this by now — see below.'
          : 'A Trigger.dev worker has to claim it before the first step runs.',
        live: true,
      };
    }
    case 'running':
      return {
        summary: `Running for ${age}.`,
        next: 'Steps appear here as each one finishes.',
        live: true,
      };
    case 'waiting':
      return {
        summary: `Waiting for you since ${since} ago.`,
        next: 'Answer it in the Inbox; the run continues from there, and the execution clock starts when you decide.',
        live: true,
      };
    case 'succeeded':
      return { summary: `Finished ${since} ago.`, live: false };
    case 'failed':
      return {
        summary: `Failed ${since} ago.`,
        next: 'The reason is below, where one was recorded.',
        live: false,
      };
    case 'cancelled':
      return { summary: `Cancelled ${since} ago.`, live: false };
    default:
      return { summary: `${status} since ${since} ago.`, live: false };
  }
}
