// src/ui/setup-template-render.test.ts
import { describe, expect, it } from 'vitest';

import { renderSetupConfig } from './setup-template-render';
import { SETUP_CONFIG_TEMPLATE } from './setup-template';
import { SETUP_CONFIG_TEMPLATE_LOCAL } from './setup-template-local';

describe('renderSetupConfig', () => {
  it('renders the untouched template when given its own defaults', () => {
    // The wizard's first render passes only a name, so every other field
    // falls back to the template's own placeholder and the output is
    // byte-identical to the template. That is a correct render, not a
    // failed match, and it must not throw.
    expect(() => renderSetupConfig('github', { name: 'my-project' })).not.toThrow();
    expect(renderSetupConfig('github', { name: 'my-project' })).toBe(
      SETUP_CONFIG_TEMPLATE,
    );
    expect(() => renderSetupConfig('local', { name: 'my-project' })).not.toThrow();
    expect(renderSetupConfig('local', { name: 'my-project' })).toBe(
      SETUP_CONFIG_TEMPLATE_LOCAL,
    );
  });

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
