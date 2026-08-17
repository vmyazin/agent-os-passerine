import { controlPlaneService } from '../../src/application/runtime';
import { requirePageSession } from '../../src/auth/page-session';
import { EmptyState, RunStatusBadge } from '../../src/ui/components';

export const dynamic = 'force-dynamic';

export default async function RunsPage() {
  await requirePageSession();
  const runs = await controlPlaneService().listRuns();
  return (
    <div className="page-stack">
      <section className="page-heading" aria-labelledby="runs-title">
        <p className="eyebrow">Operations</p>
        <h1 id="runs-title">Runs</h1>
        <p>Track durable feature and goal workflows.</p>
      </section>
      {runs.length === 0 ? (
        <EmptyState title="No runs found">
          Create a feature or goal through the API to start work.
        </EmptyState>
      ) : (
        <ul className="run-list">
          {runs.map((run) => (
            <li key={run.id}>
              <a href={`/runs/${run.id}`}>
                <span>
                  <strong>
                    {String(
                      (run.input as { title?: unknown } | undefined)?.title ??
                        run.pipeline,
                    )}
                  </strong>
                  <small>
                    {run.id} · updated {run.updatedAt}
                  </small>
                </span>
                <RunStatusBadge status={run.status} />
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
