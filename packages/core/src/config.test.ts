import { describe, expect, it, vi } from 'vitest';

import {
  AgentOsConfigSchema,
  canonicalConfigJson,
  canonicalConfigHash,
  loadAgentOsConfig,
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
  maxSteps: 20
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
