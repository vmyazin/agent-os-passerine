import { loadAgentOsConfig, type ConfigSnapshot } from '@agentos/core';
import { describe, expect, it } from 'vitest';

import { resolveFeatureRolesFromSnapshot } from './production-composition.js';

function snapshot(verificationEnvironment: string): ConfigSnapshot {
  const config = loadAgentOsConfig(`
version: 1
project: { name: test }
models: { standard: { provider: anthropic, model: sonnet } }
agents:
  specification: { model: standard, environment: specification, mcps: [artifacts] }
  planning: { model: standard, environment: planning, mcps: [artifacts] }
  implementation: { model: standard, environment: implementation, mcps: [artifacts] }
  review: { model: standard, environment: review, mcps: [artifacts] }
  verification: { model: standard, environment: verification, tools: [bash] }
environments:
  specification: { runtime: managed, mcps: [artifacts] }
  planning: { runtime: managed, mcps: [artifacts] }
  implementation: { runtime: managed, mcps: [artifacts] }
  review: { runtime: managed, mcps: [artifacts] }
  verification: ${verificationEnvironment}
pipelines:
  feature:
    steps:
      - { id: specification, agent: specification }
      - { id: planning, agent: planning }
      - { id: implementation, agent: implementation }
      - { id: review, agent: review }
      - { id: verification, agent: verification }
policies: {}
budgets: { workflowMicrodollars: 2000000, dailyMicrodollars: 5000000, concurrency: 1 }
goals: { maxSteps: 3, maxRetries: 1, timeoutMs: 3600000 }
runtime: { provider: managed }
`);
  return { config } as unknown as ConfigSnapshot;
}

describe('production feature role isolation', () => {
  it.each([
    '{ runtime: managed, variables: { SECRET: hostile } }',
    '{ runtime: managed, networking: { type: limited, allowedHosts: [evil.test] } }',
    '{ runtime: managed, networking: { type: limited, allowMcpServers: true } }',
    '{ runtime: managed, networking: { type: limited, allowPackageManagers: true } }',
    '{ runtime: managed, packages: { npm: [hostile] } }',
  ])(
    'rejects a verification environment with ambient capability: %s',
    (yaml) => {
      expect(() =>
        resolveFeatureRolesFromSnapshot(snapshot(yaml), {
          artifactMcpUrl: 'https://artifacts.test/mcp',
        }),
      ).toThrow(/verification.*secretless|verification.*isolated/i);
    },
  );

  it('forces the accepted verification environment to secretless no-network mode', () => {
    const roles = resolveFeatureRolesFromSnapshot(
      snapshot('{ runtime: managed }'),
      { artifactMcpUrl: 'https://artifacts.test/mcp' },
    );
    expect(roles.verification.environment).toMatchObject({
      variables: {},
      networking: {
        type: 'limited',
        allowedHosts: [],
        allowMcpServers: false,
        allowPackageManagers: false,
      },
    });
  });
});
