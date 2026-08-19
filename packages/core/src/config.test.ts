import { describe, expect, it, vi } from 'vitest';

import {
  AgentOsConfigSchema,
  canonicalConfigJson,
  canonicalConfigHash,
  loadAgentOsConfig,
  canonicalJsonValue,
  semanticConfigDiff,
} from './config.js';

const validYaml = `
version: 1
project:
  name: passerine
models:
  standard:
    provider: local
    model: test-model
agents:
  implementer:
    model: standard
environments:
  default:
    runtime: process
pipelines:
  feature:
    steps:
      - id: implement
        agent: implementer
policies: {}
budgets:
  workflowMicrodollars: 1000000
  dailyMicrodollars: 10000000
  concurrency: 2
goals:
  maxSteps: 3
  maxRetries: 2
  timeoutMs: 3600000
runtime:
  provider: local
  routing: {}
`;

describe('Agent OS configuration', () => {
  it('loads version 1 YAML and applies safe defaults', () => {
    const config = loadAgentOsConfig(validYaml);

    expect(config.version).toBe(1);
    expect(config.policies.protectedPaths).toContain('.github/workflows/**');
    expect(config.budgets.admissionReservePercent).toBe(80);
  });

  it('rejects unknown keys at every schema level', () => {
    const parsed = AgentOsConfigSchema.safeParse({
      ...loadAgentOsConfig(validYaml),
      surprise: true,
    });

    expect(parsed.success).toBe(false);
  });

  it.each([1, 2, 3])('accepts goals.maxSteps of %i', (maxSteps) => {
    expect(
      AgentOsConfigSchema.safeParse({
        ...loadAgentOsConfig(validYaml),
        goals: {
          ...loadAgentOsConfig(validYaml).goals,
          maxSteps,
        },
      }).success,
    ).toBe(true);
  });

  it('rejects goals.maxSteps greater than three', () => {
    expect(
      AgentOsConfigSchema.safeParse({
        ...loadAgentOsConfig(validYaml),
        goals: {
          ...loadAgentOsConfig(validYaml).goals,
          maxSteps: 4,
        },
      }).success,
    ).toBe(false);
  });

  it('produces the same canonical hash for reordered mappings', () => {
    const config = loadAgentOsConfig(validYaml);
    const reordered = {
      runtime: config.runtime,
      goals: config.goals,
      budgets: config.budgets,
      policies: config.policies,
      pipelines: config.pipelines,
      environments: config.environments,
      agents: config.agents,
      models: config.models,
      project: config.project,
      version: config.version,
    };

    expect(canonicalConfigHash(reordered)).toBe(canonicalConfigHash(config));
  });

  it('orders non-ASCII keys by code unit without consulting the locale', () => {
    const localeCompare = vi
      .spyOn(String.prototype, 'localeCompare')
      .mockImplementation(() => {
        throw new Error('locale-dependent ordering used');
      });
    try {
      expect(canonicalJsonValue({ ä: 1, z: 2, a: 3 })).toBe(
        '{"a":3,"z":2,"ä":1}',
      );
    } finally {
      localeCompare.mockRestore();
    }
  });

  it('returns deterministic semantic changes without reporting key order', () => {
    const current = loadAgentOsConfig(validYaml);
    const next = loadAgentOsConfig(
      validYaml.replace('concurrency: 2', 'concurrency: 3'),
    );

    expect(semanticConfigDiff(current, next)).toEqual([
      { kind: 'changed', path: 'budgets.concurrency', before: 2, after: 3 },
    ]);
  });

  it('sorts canonical keys by code unit without consulting the host locale', () => {
    const config = loadAgentOsConfig(validYaml);
    const profile = config.models.standard;
    if (profile === undefined) throw new Error('fixture profile is missing');
    const localeCompare = vi
      .spyOn(String.prototype, 'localeCompare')
      .mockImplementation(() => {
        throw new Error('locale-dependent comparator used');
      });

    try {
      const json = canonicalConfigJson({
        ...config,
        models: { standard: profile, ä: profile, z: profile },
      });
      expect(json.indexOf('"z"')).toBeLessThan(json.indexOf('"ä"'));
    } finally {
      localeCompare.mockRestore();
    }
  });

  it.each([
    {
      invariant: 'agent model reference',
      yaml: validYaml.replace('model: standard', 'model: missing'),
    },
    {
      invariant: 'agent environment reference',
      yaml: validYaml.replace(
        '    model: standard',
        '    model: standard\n    environment: missing',
      ),
    },
    {
      invariant: 'pipeline agent reference',
      yaml: validYaml.replace(
        '        agent: implementer',
        '        agent: missing',
      ),
    },
    {
      invariant: 'pipeline environment reference',
      yaml: validYaml.replace(
        '        agent: implementer',
        '        agent: implementer\n        environment: missing',
      ),
    },
    {
      invariant: 'pipeline dependency reference',
      yaml: validYaml.replace(
        '        agent: implementer',
        '        agent: implementer\n        dependsOn: [missing]',
      ),
    },
    {
      invariant: 'pipeline self dependency',
      yaml: validYaml.replace(
        '        agent: implementer',
        '        agent: implementer\n        dependsOn: [implement]',
      ),
    },
    {
      invariant: 'pipeline dependency cycle',
      yaml: validYaml.replace(
        '      - id: implement\n        agent: implementer',
        '      - id: implement\n        agent: implementer\n        dependsOn: [review]\n      - id: review\n        agent: implementer\n        dependsOn: [implement]',
      ),
    },
  ])('rejects a broken $invariant', ({ yaml }) => {
    expect(() => loadAgentOsConfig(yaml)).toThrow();
  });

  it.each([
    ['model', 'toString'],
    ['agent-environment', 'constructor'],
    ['pipeline-agent', '__proto__'],
    ['pipeline-environment', 'toString'],
  ] as const)('rejects inherited %s reference %s', (kind, inheritedName) => {
    const config = loadAgentOsConfig(validYaml);
    const implementer = config.agents.implementer;
    const feature = config.pipelines.feature;
    if (implementer === undefined || feature === undefined)
      throw new Error('fixture is incomplete');
    const step = feature.steps[0];
    if (step === undefined) throw new Error('fixture step is missing');
    const candidate = {
      ...config,
      agents: {
        ...config.agents,
        implementer:
          kind === 'model'
            ? { ...implementer, model: inheritedName }
            : kind === 'agent-environment'
              ? { ...implementer, environment: inheritedName }
              : implementer,
      },
      pipelines: {
        ...config.pipelines,
        feature: {
          steps: [
            kind === 'pipeline-agent'
              ? { ...step, agent: inheritedName }
              : kind === 'pipeline-environment'
                ? { ...step, environment: inheritedName }
                : step,
          ],
        },
      },
    };

    expect(AgentOsConfigSchema.safeParse(candidate).success).toBe(false);
  });
});

describe('local experiment projects', () => {
  it('accepts an absolute localPath without a repository', () => {
    const config = loadAgentOsConfig(`
version: 1
project: { name: exp, localPath: /workspaces/exp }
models: { standard: { provider: local, model: test } }
agents: { implementer: { model: standard } }
environments: { default: { runtime: process } }
pipelines: { feature: { steps: [{ id: implement, agent: implementer }] } }
policies: {}
budgets: { workflowMicrodollars: 1, dailyMicrodollars: 2, concurrency: 1 }
goals: { maxSteps: 2, maxRetries: 1, timeoutMs: 1000 }
runtime: { provider: local }
`);
    expect(config.project.localPath).toBe('/workspaces/exp');
  });

  it('rejects a relative or traversing localPath', () => {
    for (const bad of ['relative/path', '/workspaces/../etc', '/a/./b']) {
      expect(() =>
        loadAgentOsConfig(`
version: 1
project: { name: exp, localPath: ${JSON.stringify(bad)} }
models: { standard: { provider: local, model: test } }
agents: { implementer: { model: standard } }
environments: { default: { runtime: process } }
pipelines: { feature: { steps: [{ id: implement, agent: implementer }] } }
policies: {}
budgets: { workflowMicrodollars: 1, dailyMicrodollars: 2, concurrency: 1 }
goals: { maxSteps: 2, maxRetries: 1, timeoutMs: 1000 }
runtime: { provider: local }
`),
      ).toThrow();
    }
  });

  it('rejects repository and localPath together', () => {
    expect(() =>
      loadAgentOsConfig(`
version: 1
project: { name: exp, repository: https://github.com/o/r, localPath: /w/exp }
models: { standard: { provider: local, model: test } }
agents: { implementer: { model: standard } }
environments: { default: { runtime: process } }
pipelines: { feature: { steps: [{ id: implement, agent: implementer }] } }
policies: {}
budgets: { workflowMicrodollars: 1, dailyMicrodollars: 2, concurrency: 1 }
goals: { maxSteps: 2, maxRetries: 1, timeoutMs: 1000 }
runtime: { provider: local }
`),
    ).toThrow(/localPath|repository/);
  });
});
