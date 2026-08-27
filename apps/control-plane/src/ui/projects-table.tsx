// src/ui/projects-table.tsx
import type { ProjectListProjection } from '../application/control-plane-service';
import { formatDisplayDate } from './format-timestamp';
import { RunStatusBadge } from './components';

export function ProjectsTable({
  projects,
  timeZone,
}: {
  readonly projects: readonly ProjectListProjection[];
  readonly timeZone: string;
}) {
  return (
    <div className="projects-table-wrap">
      <table className="projects-table" aria-label="Projects">
        <thead>
          <tr>
            <th scope="col">Project</th>
            <th scope="col">Binding</th>
            <th scope="col">Revision</th>
            <th scope="col">Last run</th>
            <th scope="col">Updated</th>
          </tr>
        </thead>
        <tbody>
          {projects.map((project) => (
            <tr key={project.id}>
              <th className="project-name-cell" scope="row">
                <a
                  className="project-name-link"
                  href={`/projects/${project.id}`}
                >
                  <strong className="project-name">{project.name}</strong>
                  <small className="project-id">{project.id}</small>
                </a>
              </th>
              <td className="project-repository">{project.binding}</td>
              <td className="project-revision">
                {project.latestRevision === undefined ? (
                  '—'
                ) : (
                  <>
                    r{project.latestRevision}
                    {project.configDigest === undefined ? null : (
                      <>
                        {' '}
                        <code>{project.configDigest.slice(0, 8)}…</code>
                      </>
                    )}
                  </>
                )}
              </td>
              <td>
                {project.lastRunStatus === undefined ? (
                  '—'
                ) : (
                  <RunStatusBadge status={project.lastRunStatus} />
                )}
              </td>
              <td className="project-updated">
                {formatDisplayDate(project.updatedAt, timeZone)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
