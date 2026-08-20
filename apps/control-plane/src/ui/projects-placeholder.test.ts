// src/ui/projects-placeholder.test.ts
import { describe, expect, it } from 'vitest';

import { PLACEHOLDER_PROJECTS } from './projects-placeholder';

describe('placeholder projects', () => {
  it('provides a directory of named workspaces', () => {
    expect(PLACEHOLDER_PROJECTS).toHaveLength(5);
    expect(PLACEHOLDER_PROJECTS.map((project) => project.name)).toContain(
      'Agent OS Passerine',
    );
    expect(
      new Set(PLACEHOLDER_PROJECTS.map((project) => project.id)).size,
    ).toBe(PLACEHOLDER_PROJECTS.length);
  });
});
