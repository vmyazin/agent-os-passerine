import { loadRunPageModel } from '../../../src/application/run-page-model';
import { requirePageSession } from '../../../src/auth/page-session';
import { EmptyState, RunStatusBadge } from '../../../src/ui/components';

export const dynamic = 'force-dynamic';

export default async function RunPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePageSession();
  const { id } = await params;
  const run = await loadRunPageModel(id);
  return (
    <div className="page-stack">
      <section className="page-heading" aria-labelledby="run-title">
        <p className="eyebrow">{run.pipeline} run</p>
        <h1 id="run-title">{run.input?.title ?? run.id}</h1>
        <RunStatusBadge status={run.status} />
      </section>
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
          <EmptyState title="No steps recorded">
            Step state will appear as the run progresses.
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
