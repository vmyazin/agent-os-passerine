// src/ui/dispatch-stall.ts

/**
 * How long a run may sit `pending` with no steps before the UI stops calling
 * it "starting" and starts calling it undispatched.
 *
 * Dispatch itself is immediate (the outbox triggers on create), so a healthy
 * run leaves `pending` within seconds. The only slow path is the
 * reconciliation cron, which retries a swallowed dispatch every 5 minutes --
 * so this sits above the immediate path and below one reconciliation cycle.
 * Waiting for the cron before saying anything would leave an operator staring
 * at an unexplained "Pending" for five minutes, which is the exact failure
 * this exists to prevent.
 */
export const DISPATCH_STALL_MS = 120_000;

/**
 * True when a run looks like nothing ever picked it up: still `pending`, no
 * steps recorded, and older than {@link DISPATCH_STALL_MS}.
 *
 * The cause is always the same -- no Trigger.dev worker is connected to this
 * environment -- and it is invisible from the control plane alone, because
 * enqueueing succeeds whether or not a worker exists. Environment readiness
 * cannot detect it either: it checks that TRIGGER_SECRET_KEY is *set*, which
 * says nothing about whether a worker is listening. So the run itself is the
 * only honest place to report it.
 */
export function isAwaitingDispatch({
  status,
  stepCount,
  createdAt,
  now,
}: {
  readonly status: string;
  readonly stepCount: number;
  readonly createdAt: string;
  readonly now: string;
}): boolean {
  if (status !== 'pending' || stepCount > 0) return false;
  const created = Date.parse(createdAt);
  const current = Date.parse(now);
  if (Number.isNaN(created) || Number.isNaN(current)) return false;
  return current - created >= DISPATCH_STALL_MS;
}
