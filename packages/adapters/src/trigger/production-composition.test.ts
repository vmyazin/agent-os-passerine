import { generateKeyPairSync } from 'node:crypto';

import {
  createHmacAttestationIssuer,
  createHmacAttestationVerifier,
  loadAgentOsConfig,
  type AgentOsConfig,
  type ConfigSnapshot,
  type PublicationAuthorizationClaims,
} from '@agentos/core';
import { describe, expect, it } from 'vitest';

import {
  composePublicationTarget,
  resolveFeatureRolesFromSnapshot,
} from './production-composition.js';
import {
  exactLocalTrustedCommand,
  exactTrustedCommand,
  kimiFromEnv,
  resolveRoleRuntimeKeys,
  resolveRuntimeKey,
} from './production-handler.js';

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

  it('resolves the legacy starter value `local` to a runtime key outside the built provider set (fail-closed)', () => {
    // agentos/example.yaml used to ship `runtime: { provider: local }`.
    // `local` was never one of the runtimes the production composition
    // actually builds, so resolving it here documents that the starter's
    // old value hits the same fail-closed `unknown runtime '<key>' routed
    // for agent '<agent>'` guard as any other unbuilt/typo'd provider.
    const config = configWithRouting('runtime: { provider: local }');
    const runtimeKey = resolveRuntimeKey(config, { id: 'planning' });
    const builtRuntimeKeys = new Set(['managed']); // kimi not built (no KIMI_API_KEY)
    expect(runtimeKey).toBe('local');
    expect(builtRuntimeKeys.has(runtimeKey)).toBe(false);
  });
});

function configWithUnknownRouting(): AgentOsConfig {
  return loadAgentOsConfig(`
version: 1
project: { name: test }
models:
  standard: { provider: anthropic, model: sonnet }
  custom: { provider: openai, model: gpt }
agents:
  specification: { model: standard }
  planning: { model: custom }
environments: {}
pipelines:
  feature:
    steps:
      - { id: specification, agent: specification }
      - { id: planning, agent: planning }
policies: {}
budgets: { workflowMicrodollars: 2000000, dailyMicrodollars: 5000000, concurrency: 1 }
goals: { maxSteps: 3, maxRetries: 1, timeoutMs: 3600000 }
runtime: { provider: managed, routing: { openai: not-a-real-provider } }
`);
}

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

describe('kimi fail-closed composition: unknown routing targets', () => {
  // production-handler.ts's workflowForSnapshot validates every role's
  // resolveRuntimeKey(config, role.agent) result against the set of
  // runtimes it actually built ({'managed'} plus {'kimi'} only when
  // KIMI_API_KEY is present), throwing
  // `unknown runtime '<key>' routed for agent '<agent>'` for anything
  // else -- not just a literal 'kimi' -- so a routing table naming an
  // unbuilt/typo'd provider fails closed instead of silently running that
  // role on the managed provider by default. This asserts the exact
  // predicate that check evaluates (same rationale as the KIMI_API_KEY
  // fail-closed tests above: no cheap fake-injection seam exists to drive
  // the full composition end-to-end).
  it('a config routing a model provider to an unbuilt runtime resolves a key outside the built provider set', () => {
    const config = configWithUnknownRouting();
    const runtimeKey = resolveRuntimeKey(config, { id: 'planning' });
    const builtRuntimeKeys = new Set(['managed']); // kimi not built (no KIMI_API_KEY)
    expect(runtimeKey).toBe('not-a-real-provider');
    expect(builtRuntimeKeys.has(runtimeKey)).toBe(false);
  });

  it('the same config resolves a runtime key inside the built provider set once that provider actually exists', () => {
    const config = configWithUnknownRouting();
    const runtimeKey = resolveRuntimeKey(config, { id: 'specification' });
    const builtRuntimeKeys = new Set(['managed']);
    expect(runtimeKey).toBe('managed');
    expect(builtRuntimeKeys.has(runtimeKey)).toBe(true);
  });
});

function routedSnapshot(options: {
  readonly implementationModel?: string;
  readonly verificationModel?: string;
  readonly runtimeYaml?: string;
}): ConfigSnapshot {
  const config = loadAgentOsConfig(`
version: 1
project: { name: test }
models:
  standard: { provider: anthropic, model: sonnet }
  fast: { provider: kimi, model: kimi-k2 }
agents:
  specification: { model: standard, environment: specification, mcps: [artifacts] }
  planning: { model: standard, environment: planning, mcps: [artifacts] }
  implementation: { model: ${options.implementationModel ?? 'standard'}, environment: implementation, mcps: [artifacts] }
  review: { model: standard, environment: review, mcps: [artifacts] }
  verification: { model: ${options.verificationModel ?? 'standard'}, environment: verification, tools: [bash] }
environments:
  specification: { runtime: managed, mcps: [artifacts] }
  planning: { runtime: managed, mcps: [artifacts] }
  implementation: { runtime: managed, mcps: [artifacts] }
  review: { runtime: managed, mcps: [artifacts] }
  verification: { runtime: managed }
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
${options.runtimeYaml ?? 'runtime: { provider: managed }'}
`);
  return { config } as unknown as ConfigSnapshot;
}

const ROLE_OPTIONS = {
  artifactMcpUrl: 'https://artifacts.test/mcp',
  verificationRegistryHosts: ['registry.npmjs.org'],
};

function resolveFor(snapshot: ConfigSnapshot, kimiConfigured: boolean) {
  const roles = resolveFeatureRolesFromSnapshot(snapshot, ROLE_OPTIONS);
  const builtRuntimeKeys = new Set(
    kimiConfigured ? ['managed', 'kimi'] : ['managed'],
  );
  return resolveRoleRuntimeKeys(
    snapshot.config as unknown as AgentOsConfig,
    roles,
    { builtRuntimeKeys, kimiConfigured },
  );
}

describe('resolveRoleRuntimeKeys', () => {
  const kimiRouting = 'runtime: { provider: managed, routing: { kimi: kimi } }';

  it('refuses to route the verification role to the kimi runtime', () => {
    // The trusted verification command bakes container-absolute paths
    // (`rm -rf /workspace/repo`); on the containerless kimi sandbox that
    // would run against the worker host's real filesystem.
    expect(() =>
      resolveFor(
        routedSnapshot({ verificationModel: 'fast', runtimeYaml: kimiRouting }),
        true,
      ),
    ).toThrow(
      'the verification role cannot route to the kimi runtime; route it to managed',
    );
  });

  it('allows a non-verification role on kimi and reports that the run needs the kimi provider', () => {
    const resolved = resolveFor(
      routedSnapshot({
        implementationModel: 'fast',
        runtimeYaml: kimiRouting,
      }),
      true,
    );
    expect(resolved.requiresKimi).toBe(true);
    expect(resolved.runtimeKeys.get('implementation')).toBe('kimi');
    expect(resolved.runtimeKeys.get('verification')).toBe('managed');
  });

  it('keeps a managed-only run off the routing facade entirely', () => {
    const resolved = resolveFor(routedSnapshot({}), false);
    expect(resolved.requiresKimi).toBe(false);
    expect([...resolved.runtimeKeys.values()]).toEqual([
      'managed',
      'managed',
      'managed',
      'managed',
      'managed',
    ]);
  });

  it('fails closed when a role routes to kimi without KIMI_API_KEY', () => {
    expect(() =>
      resolveFor(
        routedSnapshot({
          implementationModel: 'fast',
          runtimeYaml: kimiRouting,
        }),
        false,
      ),
    ).toThrow(
      "KIMI_API_KEY is required: config routes 'implementation' to the kimi runtime",
    );
  });

  it('fails closed on the legacy starter value `provider: local`', () => {
    expect(() =>
      resolveFor(
        routedSnapshot({ runtimeYaml: 'runtime: { provider: local }' }),
        false,
      ),
    ).toThrow(/unknown runtime 'local' routed for agent/);
  });
});

function projectConfig(projectYaml: string): AgentOsConfig {
  return loadAgentOsConfig(`
version: 1
project: ${projectYaml}
models:
  standard: { provider: anthropic, model: sonnet }
agents:
  specification: { model: standard }
environments: {}
pipelines:
  feature:
    steps:
      - { id: specification, agent: specification }
policies: {}
budgets: { workflowMicrodollars: 2000000, dailyMicrodollars: 5000000, concurrency: 1 }
goals: { maxSteps: 3, maxRetries: 1, timeoutMs: 3600000 }
runtime: { provider: managed }
`);
}

describe('composePublicationTarget', () => {
  const secret = 's'.repeat(32);
  const authorizationVerifier =
    createHmacAttestationVerifier<PublicationAuthorizationClaims>({
      kind: 'github-publication',
      keys: [{ keyId: 'publisher-1', secret }],
    });
  const issuer = createHmacAttestationIssuer<PublicationAuthorizationClaims>({
    keyId: 'publisher-1',
    secret,
    kind: 'github-publication',
  });
  const policyResolver = { resolve: async () => ({}) };

  function environment(
    overrides: Record<string, string | undefined> = {},
  ): Record<string, string | undefined> {
    return {
      DATABASE_URL: 'postgresql://agentos:agentos@localhost:5432/agentos',
      ...overrides,
    };
  }

  const localConfig = projectConfig(
    '{ name: exp, localPath: /workspaces/exp }',
  );
  const githubConfig = projectConfig(
    '{ name: exp, repository: https://github.com/team-zork/sandbox }',
  );
  const neitherConfig = projectConfig('{ name: exp }');

  it('composes a local-git publisher target without any GITHUB_* env, given AGENTOS_LOCAL_WORKSPACES_ROOT', () => {
    const target = composePublicationTarget(localConfig, {
      environment: environment({
        AGENTOS_LOCAL_WORKSPACES_ROOT: '/workspaces',
      }),
      authorizationVerifier,
      policy: {},
      policyResolver,
    });
    expect(target.audience).toBe('local-git-publisher');
    expect(target.repository).toEqual({
      kind: 'local',
      owner: 'local',
      name: 'exp',
    });
    expect(typeof target.publisher.publish).toBe('function');
  });

  it('requires AGENTOS_LOCAL_WORKSPACES_ROOT for a localPath project', () => {
    expect(() =>
      composePublicationTarget(localConfig, {
        environment: environment(),
        authorizationVerifier,
        policy: {},
        policyResolver,
      }),
    ).toThrow(/AGENTOS_LOCAL_WORKSPACES_ROOT/);
  });

  it('requires GitHub env for a repository project and stamps audience github-publisher', () => {
    expect(() =>
      composePublicationTarget(githubConfig, {
        environment: environment(),
        authorizationVerifier,
        policy: {},
        policyResolver,
      }),
    ).toThrow(/GITHUB_SELECTED_REPOSITORIES_JSON/);

    const privateKey = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey;
    const target = composePublicationTarget(githubConfig, {
      environment: environment({
        GITHUB_SELECTED_REPOSITORIES_JSON: JSON.stringify([
          {
            owner: 'team-zork',
            name: 'sandbox',
            installationId: 1,
            repositoryId: 2,
          },
        ]),
        GITHUB_APP_ID: '1',
        GITHUB_APP_PRIVATE_KEY: privateKey,
      }),
      authorizationVerifier,
      policy: {},
      policyResolver,
    });
    expect(target.audience).toBe('github-publisher');
    expect(target.repository).toEqual({
      owner: 'team-zork',
      name: 'sandbox',
      installationId: 1,
      repositoryId: 2,
    });
  });

  it('throws when the project configures neither repository nor localPath', () => {
    expect(() =>
      composePublicationTarget(neitherConfig, {
        environment: environment({
          AGENTOS_LOCAL_WORKSPACES_ROOT: '/workspaces',
        }),
        authorizationVerifier,
        policy: {},
        policyResolver,
      }),
    ).toThrow('project must configure exactly one of repository or localPath');
  });

  it('throws when the project configures both repository and localPath (defense-in-depth; the config schema already blocks this)', () => {
    const both: AgentOsConfig = {
      ...githubConfig,
      project: { ...githubConfig.project, localPath: '/workspaces/exp' },
    };
    expect(() =>
      composePublicationTarget(both, {
        environment: environment({
          AGENTOS_LOCAL_WORKSPACES_ROOT: '/workspaces',
        }),
        authorizationVerifier,
        policy: {},
        policyResolver,
      }),
    ).toThrow('project must configure exactly one of repository or localPath');
  });

  it('the local branch selects an audience the shared verifier accepts as local-git-publisher and not as github-publisher', () => {
    const target = composePublicationTarget(localConfig, {
      environment: environment({
        AGENTOS_LOCAL_WORKSPACES_ROOT: '/workspaces',
      }),
      authorizationVerifier,
      policy: {},
      policyResolver,
    });
    expect(target.audience).toBe('local-git-publisher');
    const claims: PublicationAuthorizationClaims = {
      purpose: 'publish-draft-pr',
      audience: target.audience,
      projectId: 'proj-1',
      runId: 'run-1',
      stepId: 'publication',
      repository: target.repository,
      expectedBase: { branch: 'main', sha: '0'.repeat(40) },
      configDigest: '0'.repeat(64),
      policyDigest: '0'.repeat(64),
      sourceSnapshotDigest: '0'.repeat(64),
      testEvidenceDigest: '0'.repeat(64),
      manifestDigest: '0'.repeat(64),
      nonce: 'publish-run-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const signed = issuer.issue({
      subject: `proj-1:run-1:${'0'.repeat(64)}`,
      issuedAt: new Date().toISOString(),
      claims,
    });
    const verified = authorizationVerifier.verify(signed, {
      subject: signed.subject,
    });
    expect(verified?.audience).toBe('local-git-publisher');
  });

  it('the github branch selects audience github-publisher', () => {
    const privateKey = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey;
    const target = composePublicationTarget(githubConfig, {
      environment: environment({
        GITHUB_SELECTED_REPOSITORIES_JSON: JSON.stringify([
          {
            owner: 'team-zork',
            name: 'sandbox',
            installationId: 1,
            repositoryId: 2,
          },
        ]),
        GITHUB_APP_ID: '1',
        GITHUB_APP_PRIVATE_KEY: privateKey,
      }),
      authorizationVerifier,
      policy: {},
      policyResolver,
    });
    expect(target.audience).toBe('github-publisher');
  });

  it('selects the configured repository from a multi-entry allowlist', () => {
    const privateKey = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey;
    const env = environment({
      GITHUB_SELECTED_REPOSITORIES_JSON: JSON.stringify([
        {
          owner: 'team-zork',
          name: 'other',
          installationId: 1,
          repositoryId: 9,
        },
        {
          owner: 'team-zork',
          name: 'sandbox',
          installationId: 1,
          repositoryId: 2,
        },
      ]),
      GITHUB_APP_ID: '1',
      GITHUB_APP_PRIVATE_KEY: privateKey,
    });
    const target = composePublicationTarget(githubConfig, {
      environment: env,
      authorizationVerifier,
      policy: {},
      policyResolver,
    });
    expect(target.repository).toEqual({
      owner: 'team-zork',
      name: 'sandbox',
      installationId: 1,
      repositoryId: 2,
    });
    expect(() =>
      composePublicationTarget(
        projectConfig(
          '{ name: exp, repository: https://github.com/team-zork/unlisted }',
        ),
        {
          environment: env,
          authorizationVerifier,
          policy: {},
          policyResolver,
        },
      ),
    ).toThrow(/allowlist/i);
  });
});

describe('local-direct runtime routing', () => {
  function resolveLocal(runtimeYaml: string) {
    const snapshotValue = routedSnapshot({ runtimeYaml });
    return resolveRoleRuntimeKeys(
      snapshotValue.config as unknown as AgentOsConfig,
      resolveFeatureRolesFromSnapshot(snapshotValue, ROLE_OPTIONS),
      {
        builtRuntimeKeys: new Set(['process']),
        kimiConfigured: false,
        verificationCapableKeys: new Set(['process']),
      },
    );
  }

  it('routes every role, verification included, to the process runtime', () => {
    const { runtimeKeys, requiresKimi } = resolveLocal(
      'runtime: { provider: process }',
    );
    expect(runtimeKeys.size).toBeGreaterThan(0);
    expect([...new Set(runtimeKeys.values())]).toEqual(['process']);
    // `requiresKimi` gates the routing facade; a single-provider run needs none.
    expect(requiresKimi).toBe(false);
  });

  it('refuses a runtime key the local profile did not build', () => {
    expect(() => resolveLocal('runtime: { provider: managed }')).toThrow(
      /unknown runtime 'managed'/,
    );
  });
});

describe('exactLocalTrustedCommand', () => {
  const definition = { executable: 'pnpm', arguments: ['test'] };

  it('roots materialization at the working directory, never at /workspace', () => {
    const command = exactLocalTrustedCommand(definition);
    expect(command).not.toContain('/workspace');
    expect(command).not.toContain('/mnt/session');
    expect(command).toContain('rm -rf repo');
    expect(command).toContain('cd repo');
  });

  it('keeps the managed command container-absolute', () => {
    // The two must not converge: a container command run in a process sandbox
    // would delete a real directory on the host.
    expect(exactTrustedCommand(definition)).toContain('rm -rf /workspace/repo');
  });

  it('runs the project suite and then the sealed acceptance tests, and reports the exit code', () => {
    const command = exactLocalTrustedCommand(definition);
    expect(command).toContain(
      'pnpm install --frozen-lockfile --ignore-scripts',
    );
    expect(command.indexOf("'pnpm' 'test'")).toBeLessThan(
      command.indexOf("node --test 'test/acceptance/*.test.mjs'"),
    );
    expect(command).toContain('AGENTOS_EXIT_CODE');
  });

  it('quotes an argument that tries to escape the invocation', () => {
    const command = exactLocalTrustedCommand({
      executable: 'pnpm',
      arguments: ["test'; rm -rf /"],
    });
    expect(command).toContain(`'test'"'"'; rm -rf /'`);
  });
});
