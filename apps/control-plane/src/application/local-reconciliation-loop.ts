// src/application/local-reconciliation-loop.ts
import { runConfiguredWorkflowReconciliation } from './workflow-reconciliation-runtime';

/**
 * Production reconciles the workflow outbox from the Vercel cron declared in
 * vercel.json. Nothing plays that role on localhost, so runs whose worker
 * vanished stayed 'running' or 'waiting' forever instead of failing at their
 * deadline, and their approvals stayed 'pending' long past expiry. Local
 * development then behaved unlike production in the one way that matters
 * most: it never told the truth about work that had stopped.
 */

/**
 * Tighter than the 5-minute production cron. Nothing here is sweep-driven --
 * reconciliation compares each run against its own deadline -- so a shorter
 * period changes only how soon the answer appears, not what the answer is.
 */
const SWEEP_INTERVAL_MS = 60_000;

/** Let the server finish starting before the first (uncached) sweep. */
const FIRST_SWEEP_DELAY_MS = 10_000;

export interface LocalReconciliationLoop {
  readonly stop: () => void;
}

/**
 * Schedules reconciliation sweeps. Never throws and never awaits a sweep:
 * this is called from `register()`, which blocks the server from serving
 * requests until it returns.
 */
export function startLocalReconciliationLoop({
  run = runConfiguredWorkflowReconciliation,
  log = (message: string) => console.info(message),
  intervalMs = SWEEP_INTERVAL_MS,
  firstDelayMs = FIRST_SWEEP_DELAY_MS,
  setTimer = setInterval,
  clearTimer = clearInterval,
  setDelay = setTimeout,
  clearDelay = clearTimeout,
}: {
  readonly run?: () => Promise<unknown>;
  readonly log?: (message: string) => void;
  readonly intervalMs?: number;
  readonly firstDelayMs?: number;
  readonly setTimer?: typeof setInterval;
  readonly clearTimer?: typeof clearInterval;
  readonly setDelay?: typeof setTimeout;
  readonly clearDelay?: typeof clearTimeout;
} = {}): LocalReconciliationLoop {
  // A sweep walks every project and can outlast the interval on a busy
  // database. Overlapping sweeps would fight over the same cursor rows, so a
  // late one simply skips its turn.
  let sweeping = false;
  let reported = false;

  const sweep = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      await run();
    } catch (error) {
      // One-shot: an unconfigured or unreachable dispatch fails every single
      // sweep, and a message every minute would bury the dev server's output.
      if (!reported) {
        reported = true;
        log(
          `[agentos] local workflow reconciliation is not running: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    } finally {
      sweeping = false;
    }
  };

  const timers: {
    delay?: ReturnType<typeof setTimeout>;
    interval?: ReturnType<typeof setInterval>;
  } = {};
  timers.delay = setDelay(() => {
    void sweep();
    timers.interval = setTimer(() => void sweep(), intervalMs);
    timers.interval.unref?.();
  }, firstDelayMs);
  timers.delay.unref?.();

  return {
    stop: () => {
      if (timers.delay !== undefined) clearDelay(timers.delay);
      if (timers.interval !== undefined) clearTimer(timers.interval);
    },
  };
}
