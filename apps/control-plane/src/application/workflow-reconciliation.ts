import { createHash } from 'node:crypto';

import {
  canonicalJsonValue,
  isoTimestamp,
  parseAgentOsConfig,
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

const MAX_WORKFLOW_TIMEOUT_MS = 60 * 60_000;

function goalDefinitionsFromInput(input: JsonValue | undefined): readonly {
  readonly description: string;
  readonly definition: JsonValue;
}[] {
  if (!isObject(input) || !Array.isArray(input.criteria))
    throw new Error('goal run input has no criterion set');
  if (input.criteria.length < 1 || input.criteria.length > 20)
    throw new Error('goal criterion set is outside its bounded size');
  const ids = new Set<string>();
  return input.criteria.map((candidate) => {
    if (!isObject(candidate)) throw new Error('goal criterion is invalid');
    const id = candidate.id;
    const type = candidate.type;
    const description = candidate.description;
    const command = candidate.command;
    if (
      type !== 'command' ||
      typeof id !== 'string' ||
      id.trim().length === 0 ||
      typeof description !== 'string' ||
      description.trim().length === 0 ||
      typeof command !== 'string' ||
      command.trim().length === 0 ||
      ids.has(id)
    )
      throw new Error('goal command criteria are invalid');
    ids.add(id);
    return {
      description,
      definition: JSON.parse(canonicalJsonValue(candidate)) as JsonValue,
    };
  });
}

async function workflowTimeoutMs(
  repository: DomainRepository,
  run: { readonly id: WorkflowRunId; readonly pipeline: string },
): Promise<number> {
  if (run.pipeline !== 'goal') return MAX_WORKFLOW_TIMEOUT_MS;
  const snapshots = await repository.listConfigSnapshots(run.id, { limit: 2 });
  if (snapshots.length !== 1) return MAX_WORKFLOW_TIMEOUT_MS;
  try {
    return Math.min(
      parseAgentOsConfig(snapshots[0]!.config).goals.timeoutMs,
      MAX_WORKFLOW_TIMEOUT_MS,
    );
  } catch {
    return MAX_WORKFLOW_TIMEOUT_MS;
  }
}

function deterministicGoalChildRunId(parentRunId: string, step: number) {
  return persistenceId(
    'run',
    `goal-child-${createHash('sha256')
      .update(`${parentRunId}\u0000${String(step)}`)
      .digest('hex')}`,
  );
}

async function cancelGoalChildren(
  repository: DomainRepository,
  run: { readonly id: WorkflowRunId; readonly projectId: string },
  now: string,
): Promise<readonly string[]> {
  const progress = await repository.listGoalProgress(run.id, { limit: 100 });
  const cancelled: string[] = [];
  for (const record of progress) {
    if (record.criterionId !== undefined || record.status !== 'pending')
      continue;
    if (!isObject(record.payload)) continue;
    const childRunId = record.payload.childRunId;
    const expectedId = deterministicGoalChildRunId(run.id, record.step);
    if (
      record.id !==
        persistenceId(
          'goalProgress',
          `goal:${run.id}:step:${String(record.step)}:child`,
        ) ||
      childRunId !== expectedId
    )
      continue;
    const child = await repository.getRun(expectedId);
    if (
      child === undefined ||
      child.projectId !== run.projectId ||
      child.pipeline !== 'feature' ||
      !['pending', 'running', 'waiting'].includes(child.status)
    )
      continue;
    const transitioned = await repository.transitionRun(
      child.id,
      ['pending', 'running', 'waiting'],
      { status: 'cancelled', updatedAt: isoTimestamp(now) },
      child.stateVersion,
    );
    if (transitioned !== undefined) cancelled.push(child.id);
  }
  return cancelled;
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
          return true;
        } catch {
          failed += 1;
          return false;
        }
      };
      let run = listedRun;
      const now = clock();
      if (
        run.pipeline === 'feature' &&
        outbox.requestOrphanReconciliation !== undefined
      ) {
        const orphanReconciled = await deliver(() =>
          outbox.requestOrphanReconciliation!({
            idempotencyKey: `workflow-orphan-reconcile:${run.id}`,
            runId: run.id,
          }),
        );
        if (!orphanReconciled) {
          after = { at: listedRun.createdAt, id: listedRun.id };
          await cursorStore?.save(after);
          continue;
        }
        const refreshed = await repository.getRun(run.id);
        if (refreshed !== undefined) run = refreshed;
      }
      const active = ['pending', 'running', 'waiting'].includes(run.status);
      const deadlineExceeded =
        (run.pipeline === 'feature' || run.pipeline === 'goal') &&
        active &&
        Date.parse(now) >=
          Date.parse(run.createdAt) +
            (await workflowTimeoutMs(repository, run));
      if (deadlineExceeded) {
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
        if (run.pipeline === 'goal') {
          const childRunIds = await cancelGoalChildren(repository, run, now);
          if (outbox.requestCancel !== undefined) {
            for (const childRunId of childRunIds) {
              await deliver(() =>
                outbox.requestCancel!({
                  idempotencyKey: `workflow-cancel:${childRunId}`,
                  runId: childRunId,
                }),
              );
            }
          }
        }
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
      if (
        (run.pipeline === 'feature' || run.pipeline === 'goal') &&
        run.status === 'pending'
      ) {
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
                  `config_snapshot_${createHash('sha256').update(`${run.pipeline}:${run.id}`).digest('hex').slice(0, 32)}`,
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
        if (run.pipeline === 'goal') {
          let definitions: ReturnType<typeof goalDefinitionsFromInput>;
          try {
            definitions = goalDefinitionsFromInput(run.input);
          } catch {
            failed += 1;
            after = { at: listedRun.createdAt, id: listedRun.id };
            await cursorStore?.save(after);
            continue;
          }
          let criteria = await repository.listGoalCriteria(run.id, {
            limit: 21,
          });
          let criteriaValid = true;
          for (const [ordinal, definition] of definitions.entries()) {
            const existing = criteria.find(
              (candidate) => candidate.ordinal === ordinal,
            );
            if (existing !== undefined) {
              if (
                existing.description !== definition.description ||
                canonicalJsonValue(existing.definition) !==
                  canonicalJsonValue(definition.definition)
              )
                criteriaValid = false;
              continue;
            }
            const repaired = await deliver(async () => {
              await repository.createGoalCriterionIdempotently({
                id: persistenceId(
                  'goalCriterion',
                  `goal_criterion_${createHash('sha256')
                    .update(`${run.id}\u0000${String(ordinal)}`)
                    .digest('hex')
                    .slice(0, 32)}`,
                ),
                runId: run.id,
                ordinal,
                description: definition.description,
                definition: definition.definition,
                status: 'pending',
                createdAt: run.createdAt,
              });
            });
            if (!repaired) criteriaValid = false;
          }
          criteria = await repository.listGoalCriteria(run.id, { limit: 21 });
          if (
            !criteriaValid ||
            criteria.length !== definitions.length ||
            criteria.some((candidate, ordinal) => {
              const definition = definitions[ordinal];
              return (
                definition === undefined ||
                candidate.ordinal !== ordinal ||
                candidate.description !== definition.description ||
                canonicalJsonValue(candidate.definition) !==
                  canonicalJsonValue(definition.definition)
              );
            })
          ) {
            failed += 1;
            after = { at: listedRun.createdAt, id: listedRun.id };
            await cursorStore?.save(after);
            continue;
          }
        }
        await deliver(() =>
          outbox.requestStart({
            idempotencyKey: `workflow-start:${run.id}`,
            runId: run.id,
            pipeline: run.pipeline === 'goal' ? 'goal' : 'feature',
          }),
        );
      }
      if (
        (run.pipeline === 'feature' || run.pipeline === 'goal') &&
        run.status === 'cancelled'
      ) {
        if (run.pipeline === 'goal') {
          const childRunIds = await cancelGoalChildren(repository, run, now);
          if (outbox.requestCancel !== undefined) {
            for (const childRunId of childRunIds) {
              await deliver(() =>
                outbox.requestCancel!({
                  idempotencyKey: `workflow-cancel:${childRunId}`,
                  runId: childRunId,
                }),
              );
            }
          }
        }
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
        (run.pipeline === 'feature' || run.pipeline === 'goal') &&
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
