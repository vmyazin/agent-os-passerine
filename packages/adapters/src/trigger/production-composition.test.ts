import {
  loadAgentOsConfig,
  type AgentOsConfig,
  type ConfigSnapshot,
} from '@agentos/core';
import { describe, expect, it } from 'vitest';

import { resolveFeatureRolesFromSnapshot } from './production-composition.js';
import { kimiFromEnv, resolveRuntimeKey } from './production-handler.js';

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

function configWithRouting(runtimeYaml: string): AgentOsConfig {
  return loadAgentOsConfig(`
version: 1
project: { name: test }
models:
  standard: { provider: anthropic, model: sonnet }
  fast: { provider: kimi, model: kimi-k2 }
agents:
  specification: { model: fast }
  planning: { model: standard }
environments: {}
pipelines:
  feature:
    steps:
      - { id: specification, agent: specification }
      - { id: planning, agent: planning }
policies: {}
budgets: { workflowMicrodollars: 2000000, dailyMicrodollars: 5000000, concurrency: 1 }
goals: { maxSteps: 3, maxRetries: 1, timeoutMs: 3600000 }
${runtimeYaml}
`);
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
          verificationRegistryHosts: ['registry.npmjs.org'],
        }),
      ).toThrow(/verification.*secretless|verification.*isolated/i);
    },
  );

  it('forces secretless verification with only the trusted registry allowlist', () => {
    const roles = resolveFeatureRolesFromSnapshot(
      snapshot('{ runtime: managed }'),
      {
        artifactMcpUrl: 'https://artifacts.test/mcp',
        verificationRegistryHosts: ['registry.npmjs.org'],
      },
    );
    expect(roles.verification.environment).toMatchObject({
      variables: {},
      networking: {
        type: 'limited',
        allowedHosts: ['registry.npmjs.org'],
        allowMcpServers: false,
        allowPackageManagers: false,
      },
    });
  });
});

describe('resolveRuntimeKey', () => {
  it('routes an agent to the runtime key named by config.runtime.routing for its model provider', () => {
    const config = configWithRouting(
      'runtime: { provider: managed, routing: { kimi: kimi } }',
    );
    expect(resolveRuntimeKey(config, { id: 'specification' })).toBe('kimi');
    expect(resolveRuntimeKey(config, { id: 'planning' })).toBe('managed');
  });

  it('falls back to config.runtime.provider when the model provider has no routing entry', () => {
    const config = configWithRouting('runtime: { provider: managed }');
    expect(resolveRuntimeKey(config, { id: 'specification' })).toBe('managed');
    expect(resolveRuntimeKey(config, { id: 'planning' })).toBe('managed');
  });

  it('throws for an agent id absent from config.agents', () => {
    const config = configWithRouting('runtime: { provider: managed }');
    expect(() => resolveRuntimeKey(config, { id: 'unknown-agent' })).toThrow(
      /no agent definition/i,
    );
  });
});

describe('kimi fail-closed composition (Step 5 preservation rule)', () => {
  it('kimiFromEnv is undefined when KIMI_API_KEY is absent, blank, or whitespace-only', () => {
    expect(kimiFromEnv({})).toBeUndefined();
    expect(kimiFromEnv({ KIMI_API_KEY: '' })).toBeUndefined();
    expect(kimiFromEnv({ KIMI_API_KEY: '   ' })).toBeUndefined();
  });

  it('kimiFromEnv returns the trimmed apiKey and baseUrl when present', () => {
    expect(
      kimiFromEnv({
        KIMI_API_KEY: '  secret-key  ',
        KIMI_BASE_URL: '  https://kimi.example.test  ',
      }),
    ).toEqual({ apiKey: 'secret-key', baseUrl: 'https://kimi.example.test' });
    expect(kimiFromEnv({ KIMI_API_KEY: 'secret-key' })).toEqual({
      apiKey: 'secret-key',
    });
  });

  it('a config that routes an agent to kimi with no KIMI_API_KEY resolves the exact fail-closed condition the composition throws on', () => {
    // production-handler.ts's workflowForSnapshot throws
    // `KIMI_API_KEY is required: config routes '<agent>' to the kimi runtime`
    // precisely when resolveRuntimeKey(config, role.agent) === 'kimi' and
    // kimiFromEnv(environment) is undefined. The full throw can't be driven
    // end-to-end here without a live Neon-backed ConfigSnapshot fetch (no
    // fake-injection seam exists for createProductionFeatureWorkflowFromEnv's
    // per-run workflowForSnapshot), so this asserts the exact predicate the
    // composition's fail-closed check evaluates.
    const config = configWithRouting(
      'runtime: { provider: managed, routing: { kimi: kimi } }',
    );
    const runtimeKey = resolveRuntimeKey(config, { id: 'specification' });
    const kimi = kimiFromEnv({});
    expect(runtimeKey).toBe('kimi');
    expect(kimi).toBeUndefined();
  });

  it('the same config resolves to a built runtime once KIMI_API_KEY is present', () => {
    const config = configWithRouting(
      'runtime: { provider: managed, routing: { kimi: kimi } }',
    );
    const runtimeKey = resolveRuntimeKey(config, { id: 'specification' });
    const kimi = kimiFromEnv({ KIMI_API_KEY: 'secret-key' });
    expect(runtimeKey).toBe('kimi');
    expect(kimi).toEqual({ apiKey: 'secret-key' });
  });

  it('a config with no kimi routing never requires KIMI_API_KEY', () => {
    const config = configWithRouting('runtime: { provider: managed }');
    for (const agentId of ['specification', 'planning']) {
      expect(resolveRuntimeKey(config, { id: agentId })).toBe('managed');
    }
  });
});
