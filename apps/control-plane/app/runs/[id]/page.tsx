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
                <span>{step.status}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
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
