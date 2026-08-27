// app/page.tsx
import { controlPlaneService } from '../src/application/runtime';
import { requirePageSession } from '../src/auth/page-session';
import { EmptyState, MetricCard, RunStatusBadge } from '../src/ui/components';
import { countWaitingRuns } from '../src/ui/rail-status-model';
import { timeOfDayGreeting } from '../src/ui/time-of-day-greeting';
import { loadUserTimeZone } from '../src/ui/user-time-zone';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const session = await requirePageSession();
  const service = controlPlaneService();
  const [runs, projects, timeZone] = await Promise.all([
    service.listRuns(6),
    service.listProjects(),
    loadUserTimeZone(session.login),
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
          {timeOfDayGreeting(new Date(), timeZone)}, {session.login}.
        </h1>
        <p>
          Monitor active work and answer the questions that need your judgment.
        </p>
      </section>
      <section aria-label="Workspace summary" className="metric-grid">
        <MetricCard
          detail={activeProjectsLabel}
          href="/projects"
          label="Projects"
          value={projectCount}
        />
        <MetricCard
          detail={waitingLabel}
          label="Recent runs"
          value={runs.length}
        />
        <MetricCard detail="Not configured" label="Budget" value="—" />
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
