// app/page.tsx
import { controlPlaneService } from '../src/application/runtime';
import { requirePageSession } from '../src/auth/page-session';
import { EmptyState, RunStatusBadge } from '../src/ui/components';
import { countWaitingRuns } from '../src/ui/rail-status-model';
import { timeOfDayGreeting } from '../src/ui/time-of-day-greeting';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const session = await requirePageSession();
  const service = controlPlaneService();
  const [runs, projects] = await Promise.all([
    service.listRuns(6),
    service.listProjects(),
  ]);
  const waitingCount = countWaitingRuns(runs);
  const projectCount = projects.length;
  const activeProjectsLabel =
    projectCount === 1 ? '1 project' : `${projectCount} projects`;
  const waitingLabel =
    waitingCount === 1 ? '1 run waiting' : `${waitingCount} runs waiting`;

  return (
    <div className="page-stack">
      <section aria-labelledby="page-title" className="page-heading">
        <p className="eyebrow">Overview</p>
        <h1 id="page-title">
          {timeOfDayGreeting()}, {session.login}.
        </h1>
        <p>
          Monitor active work and answer the questions that need your judgment.
        </p>
      </section>
      <section aria-label="Workspace summary" className="metric-grid">
        <article>
          <span className="metric-label">Projects</span>
          <strong className="metric-value">{projectCount}</strong>
          <span className="metric-detail">{activeProjectsLabel}</span>
        </article>
        <article>
          <span className="metric-label">Recent runs</span>
          <strong className="metric-value">{runs.length}</strong>
          <span className="metric-detail">{waitingLabel}</span>
        </article>
        <article>
          <span className="metric-label">Budget</span>
          <strong className="metric-value">—</strong>
          <span className="metric-detail">Not configured</span>
        </article>
      </section>
      <section aria-labelledby="recent-runs">
        <div className="section-heading">
          <h2 id="recent-runs">Recent runs</h2>
          <a href="/runs">View all</a>
        </div>
        {runs.length === 0 ? (
          <EmptyState title="No runs yet">
            Feature and goal runs will appear here.
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
                      {run.pipeline} · {run.projectId}
                    </small>
                  </span>
                  <RunStatusBadge status={run.status} />
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
