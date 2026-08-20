import { controlPlaneService } from '../../src/application/runtime';
import { requirePageSession } from '../../src/auth/page-session';
import { EmptyState, RunStatusBadge } from '../../src/ui/components';
import { PageToolbar } from '../../src/ui/page-toolbar';

export const dynamic = 'force-dynamic';

export default async function RunsPage() {
  await requirePageSession();
  const runs = await controlPlaneService().listRuns();
  return (
    <div className="page-stack">
      <PageToolbar
        description="Track durable feature and goal workflows."
        title="Runs"
        titleId="runs-title"
      />
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
