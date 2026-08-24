import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

import { runs } from '@trigger.dev/sdk';

import { createTriggerWorkflowDispatcher } from '../dist/index.js';

/**
 * Proves that a dispatched run actually reaches a worker.
 *
 * This exists because the unit tests cannot see the failure it guards. They
 * assert what the dispatcher passes to a fake SDK, and every one of them
 * passed while dispatch overrode `queue` with a per-project name no task
 * declares. Trigger parks a run on a queue that does not exist in
 * PENDING_VERSION until its TTL expires, so for four days every run was
 * enqueued, never executed, and reported as dispatched.
 *
 * The probe names a workflow run that does not exist, so the task fails
 * immediately on input validation. What matters is that it *dequeues*: any
 * terminal state proves a worker took it, while PENDING_VERSION proves the
 * queue is wrong again.
 *
 * Needs a worker: `npx trigger.dev@latest dev` locally, or a deployment.
 */
if (process.env.AGENTOS_LIVE_TESTS !== '1') {
  process.stdout.write(
    'AGENTOS_LIVE_TESTS is not 1; skipping the Trigger dispatch smoke.\n',
  );
  process.exit(0);
}
if (!process.env.TRIGGER_SECRET_KEY) {
  throw new Error('TRIGGER_SECRET_KEY is required for the dispatch smoke');
}

const runId = `run_dispatch_smoke_${Date.now().toString(36)}`;
const projectId = process.argv[2] ?? 'project_dispatch_smoke';

const { externalRunRef } = await createTriggerWorkflowDispatcher().startFeature(
  runId,
  projectId,
);
process.stdout.write(`dispatched ${runId} -> ${externalRunRef}\n`);

const deadline = Date.now() + 60_000;
let last = 'UNKNOWN';
while (Date.now() < deadline) {
  const run = await runs.retrieve(externalRunRef);
  last = run.status;
  // Anything past the waiting states means a worker claimed it, which is the
  // whole question. The task itself is expected to fail: its run id is fake.
  if (!['PENDING_VERSION', 'QUEUED', 'DELAYED'].includes(last)) break;
  await delay(2_000);
}

if (last === 'PENDING_VERSION') {
  throw new Error(
    `dispatch is parked in PENDING_VERSION: the queue this run was sent to does not exist. Check that nothing overrides \`queue\` with a name no task declares (${externalRunRef})`,
  );
}
if (last === 'QUEUED' || last === 'DELAYED') {
  throw new Error(
    `dispatch never reached a worker within 60s (last status ${last}). Is one running? (${externalRunRef})`,
  );
}
process.stdout.write(
  `worker claimed it; final status ${last} - dispatch reaches execution\n`,
);
