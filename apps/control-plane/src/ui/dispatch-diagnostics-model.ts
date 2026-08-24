// src/ui/dispatch-diagnostics-model.ts

/** What the control plane recorded when it tried to hand the run off. */
export interface DispatchRecord {
  readonly kind: 'source-snapshot-ingest' | 'trigger-workflow-start';
  readonly status: string;
  readonly externalRef?: string;
  readonly error?: string;
  readonly updatedAt?: string;
}

/** What the executor says about the handed-off run, when it can be asked. */
export interface ExternalRunState {
  readonly status: string;
  readonly error?: string;
  readonly url?: string;
}

export interface DispatchDiagnosis {
  readonly headline: string;
  readonly detail?: string;
  /** The move that unblocks it, when this diagnosis knows one. */
  readonly remedy?: string;
  readonly externalRef?: string;
  readonly url?: string;
  /** True when the operator has to do something outside this app. */
  readonly actionable: boolean;
  /**
   * Whether the executor answered. When it did not, the page still shows its
   * generic "nothing picked it up" guidance; when it did, that guidance would
   * only repeat -- or contradict -- a specific answer.
   */
  readonly fromExecutor: boolean;
}

// Plain prose: this is rendered as text, so backticks would show as
// backticks. An em dash, not the two hyphens the code comments here use.
const WORKER_REMEDY =
  'Start a worker — npx trigger.dev@latest dev locally, or pnpm trigger:deploy for a deployment. A worker that is running but not executing still registers its version, so restart it rather than assuming it is fine.';

/**
 * Trigger's own vocabulary, in the terms of the question being asked: why
 * has this run not started?
 *
 * These statuses are the difference between "wait" and "go fix something",
 * and the names do not say which. `PENDING_VERSION` in particular reads like
 * a deployment detail; it means no connected worker advertises the task, and
 * the run dies at its TTL if none arrives.
 */
function explainExternalStatus(state: ExternalRunState): {
  readonly detail: string;
  readonly remedy?: string;
  readonly actionable: boolean;
} {
  switch (state.status.toUpperCase()) {
    case 'PENDING_VERSION':
    case 'WAITING_FOR_DEPLOY':
      return {
        detail:
          'Trigger is holding it for a worker that advertises this task. No connected worker does, and the run expires if none arrives.',
        remedy: WORKER_REMEDY,
        actionable: true,
      };
    case 'QUEUED':
      return {
        detail: 'Trigger has it queued, behind the concurrency limit.',
        actionable: false,
      };
    case 'DEQUEUED':
    case 'EXECUTING':
      return {
        detail:
          'A worker has it and is executing. Steps appear here as they finish.',
        actionable: false,
      };
    case 'DELAYED':
      return { detail: 'Trigger is holding it until its delay elapses.', actionable: false };
    case 'EXPIRED':
      return {
        detail:
          'It waited past its time-to-live without a worker taking it, and Trigger gave up. Start it again once a worker is running.',
        remedy: WORKER_REMEDY,
        actionable: true,
      };
    case 'SYSTEM_FAILURE':
    case 'CRASHED':
      return {
        detail:
          state.error === undefined
            ? 'The worker failed before the task could run.'
            : `The worker failed before the task could run: ${state.error}`,
        remedy: WORKER_REMEDY,
        actionable: true,
      };
    case 'TIMED_OUT':
      return { detail: 'The attempt exceeded its maximum duration.', actionable: true };
    case 'CANCELED':
    case 'CANCELLED':
      return { detail: 'The Trigger run was cancelled.', actionable: false };
    case 'FAILED':
      return {
        detail:
          state.error === undefined
            ? 'The task ran and failed.'
            : `The task ran and failed: ${state.error}`,
        actionable: true,
      };
    case 'COMPLETED':
      return {
        detail:
          'Trigger finished this run. If the page still shows no progress, the failure is between the task and this database.',
        actionable: true,
      };
    default:
      return { detail: `Trigger reports ${state.status}.`, actionable: false };
  }
}

/**
 * Why a run has not started, told from the two places that know: what this
 * control plane recorded when it dispatched, and what the executor did with
 * it afterwards.
 *
 * These are genuinely different failures with one appearance. A run that was
 * never dispatched, one dispatched to nobody, and one whose worker died all
 * show "Pending" and three empty sections.
 */
export function diagnoseDispatch({
  records,
  external,
}: {
  readonly records: readonly DispatchRecord[];
  readonly external?: ExternalRunState;
}): DispatchDiagnosis | undefined {
  const source = records.find(
    (record) => record.kind === 'source-snapshot-ingest',
  );
  const start = records.find(
    (record) => record.kind === 'trigger-workflow-start',
  );

  // Source ingestion runs before dispatch, so its failure is the reason
  // nothing was ever handed off.
  if (source?.status === 'failed' || source?.status === 'dead-letter')
    return {
      headline: 'Reading the repository failed, so the run was never dispatched.',
      ...(source.error === undefined ? {} : { detail: source.error }),
      actionable: true,
      fromExecutor: false,
    };

  if (start === undefined || start.status === 'pending')
    return {
      headline: 'Not handed off yet.',
      detail:
        'The run exists and is durable; the dispatch to Trigger has not been recorded. Reconciliation retries it.',
      actionable: false,
      fromExecutor: false,
    };

  if (start.status === 'failed' || start.status === 'dead-letter')
    return {
      headline: 'Dispatch to Trigger failed.',
      ...(start.error === undefined ? {} : { detail: start.error }),
      actionable: true,
      fromExecutor: false,
    };

  const base = {
    headline: 'Handed off to Trigger.',
    ...(start.externalRef === undefined
      ? {}
      : { externalRef: start.externalRef }),
  };
  if (external === undefined)
    return {
      ...base,
      detail:
        'What happened after that is only visible in Trigger; this deployment cannot query it.',
      actionable: false,
      fromExecutor: false,
    };
  const explained = explainExternalStatus(external);
  return {
    ...base,
    detail: explained.detail,
    ...(explained.remedy === undefined ? {} : { remedy: explained.remedy }),
    ...(external.url === undefined ? {} : { url: external.url }),
    actionable: explained.actionable,
    fromExecutor: true,
  };
}
