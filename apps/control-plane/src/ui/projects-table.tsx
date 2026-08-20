// src/ui/projects-table.tsx
import { RunStatusBadge } from './components';
import type { PlaceholderProject } from './projects-placeholder';

export function ProjectsTable({
  projects,
}: {
  readonly projects: readonly PlaceholderProject[];
}) {
  return (
    <div className="projects-table-wrap">
      <table className="projects-table" aria-label="Placeholder projects">
        <thead>
          <tr>
            <th scope="col">Project</th>
            <th scope="col">Repository</th>
            <th scope="col">Last run</th>
            <th scope="col">Updated</th>
          </tr>
        </thead>
        <tbody>
          {projects.map((project) => (
            <tr key={project.id}>
              <th className="project-name-cell" scope="row">
                <strong className="project-name">{project.name}</strong>
                <small className="project-id">{project.id}</small>
              </th>
              <td className="project-repository">{project.repository}</td>
              <td>
                <RunStatusBadge status={project.lastRunStatus} />
              </td>
              <td className="project-updated">{project.updatedAt}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
