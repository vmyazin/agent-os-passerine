import { loadRunPageModel } from '../../../src/application/run-page-model';
import { requirePageSession } from '../../../src/auth/page-session';
import { EmptyState, RunStatusBadge } from '../../../src/ui/components';
import { isAwaitingDispatch } from '../../../src/ui/dispatch-stall';
import { CancelRunAction } from '../../../src/ui/mutation-forms';
import { StartRunForm } from '../../../src/ui/start-run-form';
import { UndispatchedRunNotice } from '../../../src/ui/undispatched-run-notice';

export const dynamic = 'force-dynamic';

// A run that has already stopped has nothing to cancel; the endpoint rejects
// it with 409, so the button must not be offered in the first place.
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

export default async function RunPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePageSession();
  const { id } = await params;
  const run = await loadRunPageModel(id);
  const awaitingDispatch = isAwaitingDispatch({
    status: run.status,
    stepCount: run.steps.length,
    createdAt: run.createdAt,
    now: new Date().toISOString(),
  });
  return (
    <div className="page-stack">
      <section className="page-heading" aria-labelledby="run-title">
        <p className="eyebrow">{run.pipeline} run</p>
        <h1 id="run-title">{run.input?.title ?? run.id}</h1>
        <RunStatusBadge status={run.status} />
        {TERMINAL_STATUSES.has(run.status) ? null : (
          <CancelRunAction runId={run.id} />
        )}
      </section>
      {awaitingDispatch ? <UndispatchedRunNotice /> : null}
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
          <ol className="timeline">
            {run.steps.map((step) => (
              <li key={step.id}>
                <strong>{step.stepKey}</strong>
                <span>
                  {step.status}
                  {step.model === undefined ? null : (
                    <>
                      {' · '}
                      <code>{step.model}</code>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
      {run.status !== 'succeeded' || run.pipeline !== 'feature' ? null : (
        <section aria-labelledby="follow-up-title">
          <h2 id="follow-up-title">Build on this</h2>
          {run.outcome?.publishedBranch === undefined ||
          run.outcome.publishedCommitSha === undefined ? (
            <p>
              This run recorded no published commit, so nothing can be started
              on top of it. Start the next feature from the project instead,
              and it will build on the default branch.
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
            <code>{run.chain.baseBranch}</code> — not from the default
            branch. Merging this run&apos;s branch takes that work with it.
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
                <time>{event.occurredAt}</time>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
