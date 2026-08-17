import type {
  DomainRepository,
  JsonValue,
  TimestampListCursor,
  WorkflowRunId,
} from '@agentos/core';

import type { WorkflowDispatchOutbox } from './control-plane-service';

function isObject(value: JsonValue | undefined): value is {
  readonly [key: string]: JsonValue;
} {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function reconcileWorkflowOutbox(
  repository: DomainRepository,
  outbox: WorkflowDispatchOutbox,
): Promise<{ scannedRuns: number; delivered: number; failed: number }> {
  let scannedRuns = 0;
  let delivered = 0;
  let failed = 0;
  let after: TimestampListCursor<WorkflowRunId> | undefined;
  // A bounded sweep avoids an accidental infinite poll; the next cron continues.
  for (let page = 0; page < 10; page += 1) {
    const runs = await repository.listRuns({
      limit: 100,
      ...(after === undefined ? {} : { after }),
    });
    if (runs.length === 0) break;
    for (const run of runs) {
      scannedRuns += 1;
      const deliver = async (operation: () => Promise<void>) => {
        try {
          await operation();
          delivered += 1;
        } catch {
          failed += 1;
        }
      };
      if (run.pipeline === 'feature' && run.status === 'pending') {
        await deliver(() =>
          outbox.requestStart({
            idempotencyKey: `workflow-start:${run.id}`,
            runId: run.id,
          }),
        );
      }
      if (run.pipeline === 'feature' && run.status === 'cancelled') {
        if (outbox.requestCancel !== undefined) {
          await deliver(() =>
            outbox.requestCancel!({
              idempotencyKey: `workflow-cancel:${run.id}`,
              runId: run.id,
            }),
          );
        }
      }
      const events = await repository.listEvents(run.id, { limit: 1_000 });
      for (const event of events) {
        if (
          event.type !== 'approval.approved' &&
          event.type !== 'approval.rejected'
        )
          continue;
        if (!isObject(event.payload)) continue;
        const approvalId = event.payload.approvalId;
        const scopeHash = event.payload.scopeHash;
        if (typeof approvalId !== 'string' || typeof scopeHash !== 'string')
          continue;
        const decision =
          event.type === 'approval.approved' ? 'approve' : 'reject';
        await deliver(() =>
          outbox.requestApprovalResume({
            idempotencyKey: `workflow-resume:${approvalId}:${decision}`,
            runId: run.id,
            approvalId,
            decision,
            scopeHash,
          }),
        );
      }
    }
    const last = runs.at(-1)!;
    after = { at: last.createdAt, id: last.id };
    if (runs.length < 100) break;
  }
  return { scannedRuns, delivered, failed };
}
