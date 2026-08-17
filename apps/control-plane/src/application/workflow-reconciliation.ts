import { createHash } from 'node:crypto';

import {
  isoTimestamp,
  persistenceId,
  type ApprovalId,
  type DomainRepository,
  type JsonValue,
  type TimestampListCursor,
  type WorkflowRunId,
} from '@agentos/core';
import type { WorkflowDispatchOutbox } from './control-plane-service';

export interface WorkflowReconciliationCursorStore {
  load(): Promise<TimestampListCursor<WorkflowRunId> | undefined>;
  save(cursor: TimestampListCursor<WorkflowRunId> | undefined): Promise<void>;
}

function isObject(value: JsonValue | undefined): value is {
  readonly [key: string]: JsonValue;
} {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function reconcileWorkflowOutbox(
  repository: DomainRepository,
  outbox: WorkflowDispatchOutbox,
  clock: () => string = () => new Date().toISOString(),
  cursorStore?: WorkflowReconciliationCursorStore,
): Promise<{ scannedRuns: number; delivered: number; failed: number }> {
  let scannedRuns = 0;
  let delivered = 0;
  let failed = 0;
  let after = await cursorStore?.load();
  let completedCycle = false;
  // Persist progress after each run. A terminated cron invocation resumes
  // strictly after that run instead of rescanning the oldest page forever.
  for (let page = 0; page < 10_000; page += 1) {
    const runs = await repository.listRuns({
      limit: 100,
      ...(after === undefined ? {} : { after }),
    });
    if (runs.length === 0) {
      completedCycle = true;
      break;
    }
    for (const listedRun of runs) {
      scannedRuns += 1;
      const deliver = async (operation: () => Promise<void>) => {
        try {
          await operation();
          delivered += 1;
        } catch {
          failed += 1;
        }
      };
      let run = listedRun;
      const now = clock();
      if (
        run.pipeline === 'feature' &&
        outbox.requestOrphanReconciliation !== undefined
      ) {
        await deliver(() =>
          outbox.requestOrphanReconciliation!({
            idempotencyKey: `workflow-orphan-reconcile:${run.id}`,
            runId: run.id,
          }),
        );
        const refreshed = await repository.getRun(run.id);
        if (refreshed !== undefined) run = refreshed;
      }
      if (
        run.pipeline === 'feature' &&
        ['pending', 'running', 'waiting'].includes(run.status) &&
        Date.parse(now) >= Date.parse(run.createdAt) + 60 * 60_000
      ) {
        const failed = await repository.transitionRun(
          run.id,
          ['pending', 'running', 'waiting'],
          {
            status: 'failed',
            output: {
              status: 'failed',
              reason: 'workflow_deadline_exceeded',
            },
            error: { code: 'workflow_deadline_exceeded' },
            updatedAt: isoTimestamp(now),
            completedAt: isoTimestamp(now),
            cleanupAt: isoTimestamp(
              new Date(Date.parse(now) + 24 * 60 * 60_000).toISOString(),
            ),
          },
          run.stateVersion ?? 0,
        );
        if (failed !== undefined) {
          run = failed;
          let approvalAfter: TimestampListCursor<ApprovalId> | undefined;
          for (let approvalPage = 0; approvalPage < 10; approvalPage += 1) {
            const approvals = await repository.listApprovals(run.id, {
              status: 'pending',
              limit: 100,
              ...(approvalAfter === undefined ? {} : { after: approvalAfter }),
            });
            for (const approval of approvals) {
              await repository.expireApproval(approval.id, {
                runId: run.id,
                scope: approval.scope,
                fingerprint: approval.fingerprint,
                at: isoTimestamp(now),
              });
            }
            if (approvals.length < 100) break;
            const lastApproval = approvals.at(-1)!;
            approvalAfter = {
              at: lastApproval.createdAt,
              id: lastApproval.id,
            };
          }
        }
      }
      if (
        run.status === 'failed' &&
        isObject(run.error) &&
        run.error.code === 'workflow_deadline_exceeded'
      ) {
        if (outbox.requestCancel !== undefined) {
          await deliver(() =>
            outbox.requestCancel!({
              idempotencyKey: `workflow-cancel:${run.id}`,
              runId: run.id,
            }),
          );
        }
        if (outbox.requestCleanup !== undefined) {
          await deliver(() =>
            outbox.requestCleanup!({
              idempotencyKey: `workflow-cleanup:${run.id}`,
              runId: run.id,
            }),
          );
        }
        after = { at: listedRun.createdAt, id: listedRun.id };
        await cursorStore?.save(after);
        continue;
      }
      if (run.pipeline === 'feature' && run.status === 'pending') {
        let snapshots = await repository.listConfigSnapshots(run.id, {
          limit: 2,
        });
        if (snapshots.length === 0 && run.configRevisionId !== undefined) {
          const revision = await repository.getConfigRevision(
            run.configRevisionId,
          );
          if (revision !== undefined) {
            await deliver(async () => {
              await repository.createConfigSnapshot({
                id: persistenceId(
                  'configSnapshot',
                  `config_snapshot_${createHash('sha256').update(`feature:${run.id}`).digest('hex').slice(0, 32)}`,
                ),
                runId: run.id,
                configRevisionId: revision.id,
                config: revision.config,
                configDigest: revision.configDigest,
                modelDigest: revision.modelDigest,
                promptDigest: revision.promptDigest,
                environmentDigest: revision.environmentDigest,
                policyDigest: revision.policyDigest,
                repositorySha: revision.repositorySha,
                createdAt: run.createdAt,
              });
            });
            snapshots = await repository.listConfigSnapshots(run.id, {
              limit: 2,
            });
          }
        }
        if (snapshots.length !== 1) {
          failed += 1;
          after = { at: listedRun.createdAt, id: listedRun.id };
          await cursorStore?.save(after);
          continue;
        }
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
      if (
        run.pipeline === 'feature' &&
        ['succeeded', 'failed', 'cancelled'].includes(run.status) &&
        outbox.requestCleanup !== undefined
      ) {
        await deliver(() =>
          outbox.requestCleanup!({
            idempotencyKey: `workflow-cleanup:${run.id}`,
            runId: run.id,
          }),
        );
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
      after = { at: listedRun.createdAt, id: listedRun.id };
      await cursorStore?.save(after);
    }
    if (runs.length < 100) {
      completedCycle = true;
      break;
    }
  }
  if (completedCycle) await cursorStore?.save(undefined);
  return { scannedRuns, delivered, failed };
}
