// instrumentation.ts

/**
 * Runs once per server instance, before requests are served.
 *
 * Its only job here is local fidelity: production reconciles the workflow
 * outbox from the Vercel cron in vercel.json, and without an equivalent,
 * `next dev` cannot reproduce how a stalled run actually ends -- runs whose
 * worker vanished sit in 'running' or 'waiting' forever instead of failing at
 * their deadline.
 */
export async function register(): Promise<void> {
  // register() is also called for the edge runtime, which cannot open a
  // database connection.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // A deployment reconciles from the cron. Sweeping from inside request
  // instances too would have every instance competing for the same
  // reconciliation cursors.
  if (process.env.NODE_ENV === 'production') return;

  // The end-to-end suite runs `next dev` against a seeded fixture whose run
  // is deliberately older than any deadline. Reconciling it would fail that
  // run out from under the tests within the first sweep.
  if (process.env.AGENTOS_E2E_SEED === 'enabled') return;

  // Next calls register() more than once in dev (once per server compilation
  // pass). Each call would otherwise start another interval, and the sweeps
  // would multiply on every reload.
  const started = Symbol.for('agentos.local-reconciliation-loop');
  const globals = globalThis as Record<symbol, unknown>;
  if (globals[started] !== undefined) return;

  // Imported lazily so the edge and build passes never pull the database and
  // dispatch runtime in through this file.
  const { startLocalReconciliationLoop } =
    await import('./src/application/local-reconciliation-loop');
  globals[started] = startLocalReconciliationLoop();
}
