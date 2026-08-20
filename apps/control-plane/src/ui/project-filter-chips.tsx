// src/ui/project-filter-chips.tsx
import type { ProjectListProjection } from '../application/control-plane-service';

export function ProjectFilterChips({
  projects,
  activeProjectId,
  basePath,
}: {
  readonly projects: readonly Pick<ProjectListProjection, 'id' | 'name'>[];
  readonly activeProjectId?: string | undefined;
  readonly basePath: '/runs' | '/inbox' | '/configuration';
}) {
  if (projects.length === 0) return null;
  return (
    <nav aria-label="Project filters" className="project-filter-chips">
      <a
        aria-current={activeProjectId === undefined ? 'page' : undefined}
        href={basePath}
      >
        All projects
      </a>
      {projects.map((project) => (
        <a
          aria-current={activeProjectId === project.id ? 'page' : undefined}
          href={`${basePath}?projectId=${encodeURIComponent(project.id)}`}
          key={project.id}
        >
          {project.name}
        </a>
      ))}
    </nav>
  );
}
