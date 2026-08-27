export const COLLAPSED_PROJECT_LIMIT = 9;

export interface ProjectFilterOption {
  readonly id: string;
  readonly name: string;
}

export function projectFilterWindow<T extends ProjectFilterOption>(
  projects: readonly T[],
  activeProjectId: string | undefined,
  expanded: boolean,
): {
  readonly visibleProjects: readonly T[];
  readonly hiddenCount: number;
} {
  if (expanded || projects.length <= COLLAPSED_PROJECT_LIMIT) {
    return { visibleProjects: projects, hiddenCount: 0 };
  }

  const visibleProjects = projects.slice(0, COLLAPSED_PROJECT_LIMIT);
  const activeProject = projects.find(
    (project) => project.id === activeProjectId,
  );
  if (
    activeProject !== undefined &&
    !visibleProjects.some((project) => project.id === activeProject.id)
  ) {
    visibleProjects[COLLAPSED_PROJECT_LIMIT - 1] = activeProject;
  }

  return {
    visibleProjects,
    hiddenCount: projects.length - visibleProjects.length,
  };
}
