import { describe, expect, it } from 'vitest';

import { projectFilterWindow } from './project-filter-chips-model';

const projects = Array.from({ length: 12 }, (_, index) => ({
  id: `project-${index + 1}`,
  name: `Project ${index + 1}`,
}));

describe('ProjectFilterChips', () => {
  it('shows at most nine named projects before expansion', () => {
    const window = projectFilterWindow(projects, undefined, false);

    expect(window.visibleProjects.map((project) => project.id)).toEqual(
      projects.slice(0, 9).map((project) => project.id),
    );
    expect(window.hiddenCount).toBe(3);
  });

  it('keeps an active project visible within the nine-project limit', () => {
    const { visibleProjects } = projectFilterWindow(
      projects,
      'project-12',
      false,
    );

    expect(visibleProjects).toHaveLength(9);
    expect(visibleProjects.slice(0, 8).map((project) => project.id)).toEqual(
      projects.slice(0, 8).map((project) => project.id),
    );
    expect(visibleProjects[8]?.id).toBe('project-12');
  });

  it('reveals every project when expanded', () => {
    const window = projectFilterWindow(projects, undefined, true);

    expect(window.visibleProjects).toEqual(projects);
    expect(window.hiddenCount).toBe(0);
  });
});
