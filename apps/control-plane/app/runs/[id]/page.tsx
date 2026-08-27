import {
  loadRunDispatch,
  loadRunPageModel,
} from '../../../src/application/run-page-model';
import { requirePageSession } from '../../../src/auth/page-session';
import {
  EmptyState,
  RunStatusBadge,
  RunStepTimeline,
} from '../../../src/ui/components';
import { isAwaitingDispatch } from '../../../src/ui/dispatch-stall';
import {
  CancelRunAction,
  RestartRunAction,
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
        <p className="run-status-explanation">
          {explanation.summary}
          {explanation.next === undefined ? null : (
            <>
              {' '}
              <span className="run-status-next">{explanation.next}</span>
            </>
          )}
        </p>
        {TERMINAL_STATUSES.has(run.status) ? (
          run.pipeline === 'feature' || run.pipeline === 'goal' ? (
            <RestartRunAction runId={run.id} />
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
              Trigger run <code>{diagnosis.externalRef}</code>
            </p>
          )}
        </section>
      )}
      {awaitingDispatch && diagnosis?.fromExecutor !== true ? (
        <UndispatchedRunNotice />
      ) : null}
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
