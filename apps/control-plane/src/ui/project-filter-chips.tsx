// src/ui/project-filter-chips.tsx
'use client';

import { useState } from 'react';

import type { ProjectListProjection } from '../application/control-plane-service';
import {
  COLLAPSED_PROJECT_LIMIT,
  projectFilterWindow,
} from './project-filter-chips-model';

export function ProjectFilterChips({
  projects,
  activeProjectId,
  basePath,
}: {
  readonly projects: readonly Pick<ProjectListProjection, 'id' | 'name'>[];
  readonly activeProjectId?: string | undefined;
  readonly basePath: '/runs' | '/inbox' | '/configuration';
}) {
  const [expanded, setExpanded] = useState(false);
  if (projects.length === 0) return null;
  const { visibleProjects, hiddenCount } = projectFilterWindow(
    projects,
    activeProjectId,
    expanded,
  );
  const canToggle = projects.length > COLLAPSED_PROJECT_LIMIT;

  return (
    <nav aria-label="Project filters" className="project-filter-chips">
      <a
        aria-current={activeProjectId === undefined ? 'page' : undefined}
        href={basePath}
      >
        All projects
      </a>
      {visibleProjects.map((project) => (
        <a
          aria-current={activeProjectId === project.id ? 'page' : undefined}
          href={`${basePath}?projectId=${encodeURIComponent(project.id)}`}
          key={project.id}
        >
          {project.name}
        </a>
      ))}
      {canToggle ? (
        <button
          aria-expanded={expanded}
          aria-label={
            expanded
              ? 'Show fewer projects'
              : `Show ${hiddenCount} more projects`
          }
          className="project-filter-toggle"
          onClick={() => setExpanded((current) => !current)}
          type="button"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </nav>
  );
}
