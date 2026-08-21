import { createHash } from 'node:crypto';

import {
  deterministicGoalCriterionId,
  parseGoalRunInput,
  validateDurableGoalInputs,
} from '@agentos/adapters';
import {
  canonicalJsonValue,
  isoTimestamp,
  parseAgentOsConfig,
  persistenceId,
  type ApprovalId,
  type DomainRepository,
  type JsonValue,
  type ProjectId,
  type TimestampListCursor,
  type WorkflowRun,
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
  return parseGoalRunInput(input).criteria.map((candidate) => {
    return {
      description: candidate.description,
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

export function deterministicGoalChildRunId(parentRunId: string, step: number) {
  return persistenceId(
    'run',
    `goal-child-${createHash('sha256')
      .update(`${parentRunId}\u0000${String(step)}`)
      .digest('hex')}`,
  );
}

const TERMINAL = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'rejected',
  'expired',
]);

async function specDodApproval(
  repository: DomainRepository,
  runId: WorkflowRunId,
): Promise<
  | {
      readonly id: ApprovalId;
      readonly status: 'pending' | 'consumed';
      readonly scope: string;
      readonly fingerprint: string;
      readonly expiresAt: string;
      readonly consumedAt?: string;
    }
  | undefined
> {
  const pending = await repository.listApprovals(runId, {
    status: 'pending',
    limit: 100,
  });
  const consumed = await repository.listApprovals(runId, {
    status: 'consumed',
    limit: 100,
  });
  return [...pending, ...consumed].find(
    (approval) => approval.scope === 'feature-spec-and-dod',
  );
}

async function goalChildRuns(
  repository: DomainRepository,
  parent: WorkflowRun,
): Promise<readonly WorkflowRun[]> {
  const progress = await repository.listGoalProgress(parent.id, { limit: 100 });
  const children: WorkflowRun[] = [];
  for (const record of progress) {
    if (record.criterionId !== undefined || !isObject(record.payload)) continue;
    const childRunId = record.payload.childRunId;
    if (typeof childRunId !== 'string') continue;
    const expected = deterministicGoalChildRunId(parent.id, record.step);
    if (childRunId !== expected) continue;
    const child = await repository.getRun(expected);
    if (child !== undefined) children.push(child);
  }
  return children;
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

async function isGoalOwnedFeatureChild(
  repository: DomainRepository,
  run: WorkflowRun,
): Promise<boolean> {
  if (run.pipeline !== 'feature') return false;
  if (!isObject(run.input)) return false;
  const key = run.input.idempotencyKey;
  if (typeof key !== 'string') return false;
  const match = /^goal:(.+):step:([1-3])$/.exec(key);
  if (match === null) return false;
  const parentRunId = persistenceId('run', match[1]!);
  const step = Number(match[2]);
  if (deterministicGoalChildRunId(parentRunId, step) !== run.id) return false;
  const parent = await repository.getRun(parentRunId);
  if (
    parent === undefined ||
    parent.pipeline !== 'goal' ||
    parent.projectId !== run.projectId
  )
    return false;
  const checkpointId = persistenceId(
    'goalProgress',
    `goal:${parentRunId}:step:${String(step)}:child`,
  );
  const progress = await repository.listGoalProgress(parentRunId, {
    limit: 100,
  });
  const checkpoint = progress.find(
    (candidate) => candidate.id === checkpointId,
  );
  if (
    checkpoint === undefined ||
    checkpoint.criterionId !== undefined ||
    checkpoint.step !== step ||
    checkpoint.status !== 'pending' ||
    !isObject(checkpoint.payload)
  )
    return false;
  return checkpoint.payload.childRunId === run.id;
}

export async function reconcileWorkflowOutbox(
  repository: DomainRepository,
  outbox: WorkflowDispatchOutbox,
  clock: () => string = () => new Date().toISOString(),
  cursorStore?: WorkflowReconciliationCursorStore,
  options?: { readonly projectId?: ProjectId },
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
      ...(options?.projectId === undefined
        ? {}
        : { projectId: options.projectId }),
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
      const nowMs = Date.parse(now);
      let failCode: 'workflow_deadline_exceeded' | 'approval_expired' | undefined;

      if (active && (run.pipeline === 'feature' || run.pipeline === 'goal')) {
        if (run.status === 'waiting') {
          const approval = await specDodApproval(repository, run.id);
          if (
            approval?.status === 'pending' &&
            Date.parse(approval.expiresAt) <= nowMs
          ) {
            failCode = 'approval_expired';
            await repository.expireApproval(approval.id, {
              runId: run.id,
              scope: approval.scope,
              fingerprint: approval.fingerprint,
              at: isoTimestamp(now),
            });
          }
        } else if (run.pipeline === 'feature') {
          const approval = await specDodApproval(repository, run.id);
          const startMs =
            approval?.status === 'consumed' && approval.consumedAt !== undefined
              ? Date.parse(approval.consumedAt)
              : Date.parse(run.createdAt);
          if (nowMs >= startMs + MAX_WORKFLOW_TIMEOUT_MS) {
            failCode = 'workflow_deadline_exceeded';
          }
        } else {
          const children = await goalChildRuns(repository, run);
          const live = children.filter((child) => !TERMINAL.has(child.status));
          if (live.length === 0) {
            const cap = await workflowTimeoutMs(repository, run);
            if (nowMs >= Date.parse(run.createdAt) + cap) {
              failCode = 'workflow_deadline_exceeded';
            }
          }
        }
      }

      if (failCode !== undefined) {
        const failedTransition = await repository.transitionRun(
          run.id,
          ['pending', 'running', 'waiting'],
          {
            status: 'failed',
            output: {
              status: 'failed',
              reason: failCode,
            },
            error: { code: failCode },
            updatedAt: isoTimestamp(now),
            completedAt: isoTimestamp(now),
            cleanupAt: isoTimestamp(
              new Date(Date.parse(now) + 24 * 60 * 60_000).toISOString(),
            ),
          },
          run.stateVersion ?? 0,
        );
        if (failedTransition !== undefined) {
          run = failedTransition;
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
        if (
          run.pipeline === 'feature' &&
          (await isGoalOwnedFeatureChild(repository, run))
        ) {
          after = { at: listedRun.createdAt, id: listedRun.id };
          await cursorStore?.save(after);
          continue;
        }
        let goalDefinitions:
          ReturnType<typeof goalDefinitionsFromInput> | undefined;
        if (run.pipeline === 'goal') {
          try {
            goalDefinitions = goalDefinitionsFromInput(run.input);
          } catch {
            failed += 1;
            after = { at: listedRun.createdAt, id: listedRun.id };
            await cursorStore?.save(after);
            continue;
          }
        }
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
          const definitions = goalDefinitions!;
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
                id: deterministicGoalCriterionId(run.id, ordinal),
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
          try {
            validateDurableGoalInputs(run, snapshots, criteria);
          } catch {
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
