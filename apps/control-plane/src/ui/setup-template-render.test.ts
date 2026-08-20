// src/ui/setup-template-render.test.ts
import { describe, expect, it } from 'vitest';

import { renderSetupConfig } from './setup-template-render';

describe('renderSetupConfig', () => {
  it('parameterizes github project fields', () => {
    const yaml = renderSetupConfig('github', {
      name: 'passerine',
      repository: 'https://github.com/team-zork/agent-os-passerine',
      defaultBranch: 'main',
    });
    expect(yaml).toContain('name: passerine');
    expect(yaml).toContain(
      'repository: https://github.com/team-zork/agent-os-passerine',
    );
    expect(yaml).toContain('defaultBranch: main');
  });

  it('parameterizes local project fields', () => {
    const yaml = renderSetupConfig('local', {
      name: 'todo-app-01',
      localPath: '/tmp/workspaces/todo-app-01',
    });
    expect(yaml).toContain('name: todo-app-01');
    expect(yaml).toContain('localPath: /tmp/workspaces/todo-app-01');
    expect(yaml).not.toContain('repository:');
  });
});
