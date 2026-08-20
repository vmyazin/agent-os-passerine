// app/runs/page.tsx
import { controlPlaneService } from '../../src/application/runtime';
import { requirePageSession } from '../../src/auth/page-session';
import { EmptyState, RunStatusBadge } from '../../src/ui/components';
import { formatDisplayDate } from '../../src/ui/format-timestamp';
import { PageToolbar } from '../../src/ui/page-toolbar';
import { ProjectFilterChips } from '../../src/ui/project-filter-chips';

export const dynamic = 'force-dynamic';

export default async function RunsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ projectId?: string }>;
}) {
  await requirePageSession();
  const { projectId } = await searchParams;
  const service = controlPlaneService();
  const [runs, projects] = await Promise.all([
    service.listRuns(50, projectId),
    service.listProjects(),
  ]);
  const projectNameById = new Map(projects.map((project) => [project.id, project.name]));

  return (
    <div className="page-stack">
      <PageToolbar
        description="Track durable feature and goal workflows."
        title="Runs"
        titleId="runs-title"
      />
      <ProjectFilterChips
        activeProjectId={projectId}
        basePath="/runs"
        projects={projects}
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
                    {projectNameById.get(run.projectId) ?? run.projectId} ·{' '}
                    {run.id} · updated {formatDisplayDate(run.updatedAt)}
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
