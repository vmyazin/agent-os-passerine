import { describe, expect, it } from 'vitest';

import {
  AgentOsConfigSchema,
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
});
