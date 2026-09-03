import {
  loadRunDispatch,
  loadRunPageModel,
} from '../../../src/application/run-page-model';
import { controlPlaneService } from '../../../src/application/runtime';
import { requirePageSession } from '../../../src/auth/page-session';
import {
  EmptyState,
  RunStatusBadge,
  RunStepTimeline,
} from '../../../src/ui/components';
import { isAwaitingDispatch } from '../../../src/ui/dispatch-stall';
import { isRunPreviewAvailable } from '../../../src/local-system/run-preview';
import {
  CancelRunAction,
  OverrideRunBudgetAction,
  PreviewRunAction,
  RestartRunAction,
  ResumeRunAction,
} from '../../../src/ui/mutation-forms';
import { diagnoseDispatch } from '../../../src/ui/dispatch-diagnostics-model';
import { RunLiveRefresh } from '../../../src/ui/run-live-refresh';
import { explainRunStatus } from '../../../src/ui/run-status-model';
import { StartRunForm } from '../../../src/ui/start-run-form';
import { UndispatchedRunNotice } from '../../../src/ui/undispatched-run-notice';
import { formatDisplayDateTime } from '../../../src/ui/format-timestamp';
import { loadUserTimeZone } from '../../../src/ui/user-time-zone';

export const dynamic = 'force-dynamic';

// A run that has already stopped has nothing to cancel; the endpoint rejects
// it with 409, so the button must not be offered in the first place.
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

/**
 * URL paths a feature request mentions, as written. The request is the only
 * place that reliably says where a delivered API answers, and a preview link
 * to a root that returns 404 tells the operator nothing.
 */
function pathsNamedBy(description: unknown): readonly string[] {
  if (typeof description !== 'string') return [];
  const seen = new Set<string>();
  for (const match of description.matchAll(
    /(?:^|[\s(`'"])(\/[A-Za-z0-9_./:-]*[A-Za-z0-9_-])/g,
  )) {
    const path = match[1]!;
    // A file path carries an extension; a route seldom does.
    if (/\.[a-z]{1,5}$/i.test(path) || path.length > 64) continue;
    seen.add(path);
    if (seen.size === 6) break;
  }
  return [...seen];
}

export default async function RunPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requirePageSession();
  const { id } = await params;
  const run = await loadRunPageModel(id);
  const timeZone = await loadUserTimeZone(session.login);
  const now = new Date().toISOString();
  const awaitingDispatch = isAwaitingDispatch({
    status: run.status,
    stepCount: run.steps.length,
    createdAt: run.createdAt,
    now,
  });
  // Only for a run that has produced nothing yet: once steps exist, the
  // steps are the better answer to "what is happening", and asking the
  // executor on every render would be a request nobody reads.
  const dispatch =
    run.steps.length === 0 && !TERMINAL_STATUSES.has(run.status)
      ? await loadRunDispatch(run.id)
      : undefined;
  const diagnosis =
    dispatch === undefined ? undefined : diagnoseDispatch(dispatch);
  // Review is advisory and runs after the gate, so a succeeded run can carry
  // findings too; those are notes for whoever merges.
  const review = TERMINAL_STATUSES.has(run.status)
    ? await controlPlaneService().reviewOutcome(run.id)
    : undefined;
  const criteria =
    run.status === 'succeeded'
      ? await controlPlaneService().doneCriteria(run.id)
      : [];
  const explanation = explainRunStatus({
    status: run.status,
    stepCount: run.steps.length,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    now,
  });
  return (
    <div className="page-stack">
      <section className="page-heading" aria-labelledby="run-title">
        <p className="eyebrow">{run.pipeline} run</p>
        <h1 id="run-title">{run.input?.title ?? run.id}</h1>
        <div className="run-status-line">
          <RunStatusBadge status={run.status} />
          <RunLiveRefresh live={explanation.live} timeZone={timeZone} />
        </div>
        {run.input?.description === undefined ? null : (
          <details className="run-request">
            <summary>The request</summary>
            {/* Verbatim, and pre-wrapped: this is what the operator typed,
                and a description whose line breaks separate requirements
                reads as one paragraph without them. */}
            <p className="run-request-text">{run.input.description}</p>
          </details>
        )}
        <p className="run-status-explanation">
          {explanation.summary}
          {explanation.next === undefined ? null : (
            <>
              {' '}
              <span className="run-status-next">{explanation.next}</span>
            </>
          )}
        </p>
        {/* A budget is the one blocker an operator can lift from here, and it
            blocks a queued run exactly as it blocked the one that stopped, so
            this is offered on any run a budget is holding back -- not only on
            a finished one. */}
        {run.error?.code === 'budget_exhausted' ? (
          <>
            <p className="run-status-explanation">
              A budget stopped this run, so continuing it as it stands would
              stop at the same place. Allowing more raises this run&apos;s caps
              by that amount; it does not change the project&apos;s budget or
              start anything.
            </p>
            <OverrideRunBudgetAction runId={run.id} />
          </>
        ) : null}
        {TERMINAL_STATUSES.has(run.status) ? (
          run.pipeline === 'feature' || run.pipeline === 'goal' ? (
            <>
              {run.status === 'failed' || run.status === 'cancelled' ? (
                <>
                  <p className="run-status-explanation">
                    Resume continues this run from the step that stopped it,
                    keeping the steps it already finished and the configuration
                    and commit it started from. Start again re-runs the whole
                    request against the configuration applied now.
                  </p>
                  <ResumeRunAction runId={run.id} />
                </>
              ) : null}
              <RestartRunAction runId={run.id} />
            </>
          ) : null
        ) : (
          <CancelRunAction
            {...(run.status === 'waiting'
              ? {
                  inboxHref: `/inbox?runId=${encodeURIComponent(run.id)}`,
                }
              : {})}
            runId={run.id}
          />
        )}
      </section>
      {run.error === undefined ? null : (
        <section
          aria-labelledby="failure-title"
          className="dispatch-diagnosis dispatch-diagnosis-actionable"
        >
          <h2 className="dispatch-heading" id="failure-title">
            Why it failed
          </h2>
          <p>{run.error.message ?? 'No reason was recorded.'}</p>
          {review === undefined || review.findings.length === 0 ? null : (
            <>
              <p>
                {review.stepId === 'review-after-fix'
                  ? 'The final review asked for these changes:'
                  : 'The review asked for these changes:'}
              </p>
              <ul>
                {review.findings.map((finding: string) => (
                  <li key={finding}>{finding}</li>
                ))}
              </ul>
              <p className="dispatch-remedy">
                Findings come from the reviewing model. Check one before acting
                on it: a review can be wrong about working code.
              </p>
            </>
          )}
          {run.error.details === undefined ||
          run.error.details.length === 0 ? null : (
            <ul>
              {run.error.details.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          )}
          {run.error.code === undefined ? null : (
            <p className="dispatch-ref">
              <code>{run.error.code}</code>
            </p>
          )}
        </section>
      )}
      {diagnosis === undefined ? null : (
        <section
          aria-labelledby="dispatch-title"
          className={`dispatch-diagnosis${diagnosis.actionable ? ' dispatch-diagnosis-actionable' : ''}`}
        >
          <h2 className="dispatch-heading" id="dispatch-title">
            {diagnosis.headline}
          </h2>
          {diagnosis.detail === undefined ? null : <p>{diagnosis.detail}</p>}
          {diagnosis.remedy === undefined ? null : (
            <p className="dispatch-remedy">{diagnosis.remedy}</p>
          )}
          {diagnosis.externalRef === undefined ? null : (
            <p className="dispatch-ref">
              Execution <code>{diagnosis.externalRef}</code>
            </p>
          )}
        </section>
      )}
      {awaitingDispatch && diagnosis?.fromExecutor !== true ? (
        <UndispatchedRunNotice />
      ) : null}
      {awaitingDispatch ? (
        <ResumeRunAction runId={run.id} label="Retry" />
      ) : null}
      {/* Progressive disclosure for machine-oriented evidence: these pin what
          the run was bound to and are read when something needs proving, not
          while watching it work. */}
      <details className="run-provenance">
        <summary>Provenance</summary>
        <dl className="metadata">
          <div>
            <dt>Repository SHA</dt>
            <dd>
              <code>{run.repositorySha || 'Not recorded'}</code>
            </dd>
          </div>
          <div>
            <dt>Config digest</dt>
            <dd>
              <code>{run.configDigest || 'Not recorded'}</code>
            </dd>
          </div>
          <div>
            <dt>Policy digest</dt>
            <dd>
              <code>{run.policyDigest || 'Not recorded'}</code>
            </dd>
          </div>
        </dl>
      </details>
      {run.goal === undefined ? null : (
        <section aria-labelledby="goal-title">
          <h2 id="goal-title">Bounded goal progress</h2>
          <p>
            Step {run.goal.currentStep} of {run.goal.maxSteps}
            {run.goal.children.length === 0
              ? ' · no attempt has started yet'
              : ''}
          </p>
          <ol className="timeline">
            {run.goal.criteria.map((criterion) => {
              const result = run.goal?.latestResults.find(
                (candidate) => candidate.criterionId === criterion.id,
              );
              return (
                <li key={criterion.id}>
                  <strong>{criterion.description}</strong>
                  <span>
                    {result?.status ?? 'pending'}
                    {result?.code === undefined ? '' : ` (${result.code})`}
                  </span>
                </li>
              );
            })}
          </ol>
          {run.goal.children.length === 0 ? null : (
            <ol className="timeline" aria-label="Goal feature attempts">
              {run.goal.children.map((child) => (
                <li key={child.runId}>
                  <strong>Attempt {child.step}</strong>
                  <span>{child.status ?? 'pending'}</span>
                  {child.draftPullRequestUrl === undefined ? null : (
                    <a href={child.draftPullRequestUrl}>Draft pull request</a>
                  )}
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
      <section aria-labelledby="steps-title">
        <h2 id="steps-title">Steps</h2>
        {run.steps.length === 0 ? (
          <EmptyState
            title={awaitingDispatch ? 'Never started' : 'No steps recorded'}
          >
            {awaitingDispatch
              ? 'No worker claimed this run, so no step ever ran.'
              : 'Step state will appear as the run progresses.'}
          </EmptyState>
        ) : (
          <RunStepTimeline steps={run.steps} timeZone={timeZone} />
        )}
      </section>
      {run.status !== 'succeeded' || run.pipeline !== 'feature' ? null : (
        <section aria-labelledby="follow-up-title">
          <h2 id="follow-up-title">Build on this</h2>
          {run.outcome?.publishedBranch === undefined ||
          run.outcome.publishedCommitSha === undefined ? (
            <p>
              This run recorded no published commit, so nothing can be started
              on top of it. Start the next feature from the project instead, and
              it will build on the default branch.
            </p>
          ) : (
            <>
              <p>
                A follow-up starts from{' '}
                <code>{run.outcome.publishedCommitSha.slice(0, 12)}</code> on{' '}
                <code>{run.outcome.publishedBranch}</code>, so it sees this
                run&apos;s work without waiting for you to merge.
              </p>
              <StartRunForm
                baseRunId={run.id}
                configured
                label="Start a follow-up"
                projectId={run.projectId}
              />
            </>
          )}
        </section>
      )}
      {run.chain === undefined ? null : (
        <section aria-labelledby="chain-title">
          <h2 id="chain-title">Builds on</h2>
          <p>
            This run started from{' '}
            <a href={`/runs/${run.chain.baseRunId}`}>
              run {run.chain.baseRunId}
            </a>
            , at <code>{run.chain.baseCommitSha.slice(0, 12)}</code> on{' '}
            <code>{run.chain.baseBranch}</code> — not from the default branch.
            Merging this run&apos;s branch takes that work with it.
          </p>
        </section>
      )}
      {run.outcome === undefined ? null : (
        <section aria-labelledby="outcome-title">
          <h2 id="outcome-title">Outcome</h2>
          {review === undefined || review.findings.length === 0 ? null : (
            <>
              <p>
                {review.decision === 'changes_requested'
                  ? 'Review notes. The reviewer would have asked for changes; verification passed, so this is published and these are for you to weigh before merging:'
                  : 'Review notes:'}
              </p>
              <ul>
                {review.findings.map((finding: string) => (
                  <li key={finding}>{finding}</li>
                ))}
              </ul>
              <p className="dispatch-remedy">
                Findings come from the reviewing model and can be wrong about
                working code.
              </p>
            </>
          )}
          {run.outcome.draftPullRequestUrl === undefined ? null : (
            <p>
              <a href={run.outcome.draftPullRequestUrl}>Draft pull request</a>
            </p>
          )}
          {run.outcome.localBranch === undefined ? null : (
            <p>
              Local branch <code>{run.outcome.localBranch}</code>
              {run.outcome.localRepositoryUrl === undefined ? null : (
                <>
                  {' '}
                  in <code>{run.outcome.localRepositoryUrl}</code>
                </>
              )}
              {' — inspect with '}
              <code>git log {run.outcome.localBranch}</code>
            </p>
          )}
          {run.status === 'succeeded' &&
          run.outcome.localBranch !== undefined &&
          run.outcome.localRepositoryUrl !== undefined &&
          isRunPreviewAvailable() ? (
            <>
              <p>
                Preview it: this checks the branch out in a scratch worktree and
                runs the delivered code on this machine.
              </p>
              {criteria.length === 0 ? null : (
                <>
                  <p>
                    How to smoke test it. These are the acceptance criteria the
                    specifier froze before implementation, and each one already
                    passed in sealed verification; this is you seeing it with
                    your own eyes.
                  </p>
                  <ol>
                    {criteria.map((criterion) => (
                      <li key={criterion.id}>{criterion.description}</li>
                    ))}
                  </ol>
                </>
              )}
              <PreviewRunAction
                runId={run.id}
                suggestedPaths={pathsNamedBy(run.input?.description)}
              />
            </>
          ) : null}
        </section>
      )}
      <section aria-labelledby="timeline-title">
        <h2 id="timeline-title">Sanitized timeline</h2>
        {run.timeline.length === 0 ? (
          <EmptyState title="No events recorded">
            Safe operational events will appear here.
          </EmptyState>
        ) : (
          <ol className="timeline">
            {run.timeline.map((event) => (
              <li key={event.eventId}>
                <strong>{event.type}</strong>
                <time dateTime={event.occurredAt}>
                  {formatDisplayDateTime(event.occurredAt, timeZone)}
                </time>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
