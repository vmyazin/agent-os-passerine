// app/projects/[id]/page.tsx
import { notFound } from 'next/navigation';

import { controlPlaneService } from '../../../src/application/runtime';
import { ServiceError } from '../../../src/application/control-plane-service';
import { requirePageSession } from '../../../src/auth/page-session';
import { EmptyState, RunStatusBadge } from '../../../src/ui/components';
import { formatDisplayDate } from '../../../src/ui/format-timestamp';
import { PageToolbar } from '../../../src/ui/page-toolbar';
import {
  BacklogStatusAction,
  CreateBacklogForm,
  DeleteBacklogAction,
} from '../../../src/ui/backlog-forms';
import { backlogView } from '../../../src/ui/backlog-view-model';
import { StartRunForm } from '../../../src/ui/start-run-form';

export const dynamic = 'force-dynamic';

function formatBudgetMicrodollars(value: number | undefined): string {
  if (value === undefined) return '—';
  return `$${(value / 1_000_000).toFixed(2)}`;
}

export default async function ProjectDetailPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}) {
  await requirePageSession();
  const { id } = await params;
  let project;
  try {
    project = await controlPlaneService().getProjectDetail(id);
  } catch (error) {
    if (error instanceof ServiceError && error.code === 'project_not_found')
      notFound();
    throw error;
  }
  const backlogs = await controlPlaneService().listBacklogs(project.id);
  // An item's run that is `waiting` is waiting on the operator's approval,
  // which is the state a backlog spends most of its life in. The run list is
  // already loaded for this page, so naming it costs nothing.
  const waitingRunIds = new Set(
    project.recentRuns
      .filter((run) => run.status === 'waiting')
      .map((run) => run.id),
  );

  const runCountLabel =
    project.runCount === 1 ? '1 run' : `${project.runCount} runs`;

  return (
    <div className="page-stack">
      <PageToolbar
        action={
          <a className="secondary-link" href={`/configuration?projectId=${encodeURIComponent(project.id)}`}>
            View configuration
          </a>
        }
        description={project.binding}
        title={project.name}
        titleId="project-detail-title"
      />
      <section aria-labelledby="project-start">
        <div className="section-heading">
          <h2 id="project-start">Start work</h2>
        </div>
        <StartRunForm
          configured={project.latestRevision !== undefined}
          projectId={project.id}
          {...(project.drifted === true &&
          project.appliedSha !== undefined &&
          project.headSha !== undefined
            ? { drift: { appliedSha: project.appliedSha, headSha: project.headSha } }
            : {})}
          {...(project.workflowBudgetMicrodollars === undefined
            ? {}
            : { workflowBudgetMicrodollars: project.workflowBudgetMicrodollars })}
          {...(project.dailyBudgetMicrodollars === undefined
            ? {}
            : { dailyBudgetMicrodollars: project.dailyBudgetMicrodollars })}
        />
      </section>
      <section aria-label="Project summary" className="metric-grid">
        <article>
          <span className="metric-label">Runs</span>
          <strong className="metric-value">{project.runCount}</strong>
          <span className="metric-detail">{runCountLabel}</span>
        </article>
        <article>
          <span className="metric-label">Latest revision</span>
          <strong className="metric-value">
            {project.latestRevision === undefined ? '—' : `r${project.latestRevision}`}
          </strong>
          <span className="metric-detail">
            {project.configDigest === undefined
              ? 'No configuration applied'
              : `Digest ${project.configDigest.slice(0, 12)}…`}
          </span>
        </article>
        <article>
          <span className="metric-label">Budget</span>
          <strong className="metric-value">
            {project.workflowBudgetMicrodollars === undefined
              ? '—'
              : formatBudgetMicrodollars(project.workflowBudgetMicrodollars)}
          </strong>
          <span className="metric-detail">
            {project.dailyBudgetMicrodollars === undefined
              ? 'Not configured'
              : `${formatBudgetMicrodollars(project.dailyBudgetMicrodollars)} daily cap`}
          </span>
        </article>
      </section>
      <section aria-labelledby="project-provenance">
        <div className="section-heading">
          <h2 id="project-provenance">Provenance</h2>
        </div>
        <dl className="project-provenance-list">
          <div>
            <dt>Project id</dt>
            <dd>
              <code>{project.id}</code>
            </dd>
          </div>
          <div>
            <dt>Binding</dt>
            <dd>{project.binding}</dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>{formatDisplayDate(project.updatedAt)}</dd>
          </div>
          <div>
            <dt>Last run</dt>
            <dd>
              {project.lastRunStatus === undefined ? (
                'No runs yet'
              ) : (
                <>
                  <RunStatusBadge status={project.lastRunStatus} />
                  {project.lastRunAt === undefined
                    ? null
                    : ` · ${formatDisplayDate(project.lastRunAt)}`}
                </>
              )}
            </dd>
          </div>
        </dl>
      </section>
      <section aria-labelledby="project-backlogs">
        <div className="section-heading">
          <h2 id="project-backlogs">Backlogs</h2>
          {project.latestRevision === undefined ? null : (
            <CreateBacklogForm projectId={project.id} />
          )}
        </div>
        {backlogs.length === 0 ? (
          <EmptyState title="No backlogs yet">
            A backlog runs an ordered list of features one at a time, each
            building on the last.
          </EmptyState>
        ) : (
          backlogs.map((backlog) => {
            const view = backlogView(backlog, { waitingRunIds });
            return (
              <article className="backlog" key={backlog.id}>
                <div className="backlog-header">
                  <strong>{backlog.title}</strong>
                  <span className="backlog-header-controls">
                    <span
                      className={`backlog-status backlog-status-${backlog.status}`}
                    >
                      {backlog.status}
                    </span>
                    <BacklogStatusAction
                      backlogId={backlog.id}
                      status={backlog.status}
                    />
                    <DeleteBacklogAction
                      backlogId={backlog.id}
                      deletable={backlog.items.every(
                        (item) => item.runId === undefined,
                      )}
                    />
                  </span>
                </div>
                <p className="backlog-progress">{view.progress}</p>
                {view.paused === undefined ? null : (
                  <p className="backlog-paused">
                    {view.paused.sentence}{' '}
                    {view.paused.action ??
                      'Nothing else starts until you resume it, and the work already published stays where it is.'}
                  </p>
                )}
                <ol className="backlog-items">
                  {view.items.map((item) => (
                    <li key={item.id}>
                      <span className="backlog-item-ordinal">{item.ordinal}</span>
                      <span className="backlog-item-title">
                        {item.runId === undefined ? (
                          item.title
                        ) : (
                          <a href={`/runs/${item.runId}`}>{item.title}</a>
                        )}
                      </span>
                      <span
                        className={`backlog-item-status backlog-item-status-${item.emphasis}`}
                      >
                        {item.state}
                      </span>
                    </li>
                  ))}
                </ol>
              </article>
            );
          })
        )}
      </section>
      <section aria-labelledby="project-runs">
        <div className="section-heading">
          <h2 id="project-runs">Recent runs</h2>
          <a href={`/runs?projectId=${encodeURIComponent(project.id)}`}>View all</a>
        </div>
        {project.recentRuns.length === 0 ? (
          <EmptyState title="No runs yet">
            Start a feature from{' '}
            <a href="/setup">Setup</a> or the API to see activity here.
          </EmptyState>
        ) : (
          <ul className="run-list">
            {project.recentRuns.map((run) => (
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
                      {run.id} · updated {formatDisplayDate(run.updatedAt)}
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
