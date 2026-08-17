import { describe, expect, it, vi } from 'vitest';

import {
  configurationYaml,
  loadConfigurationMetadata,
} from './configuration-loader';

const configuredYaml = `
version: 1
project:
  name: passerine
  repository: https://github.com/example/passerine
  defaultBranch: main
models:
  standard:
    provider: anthropic
    model: claude-secret-model-name
agents:
  implementer:
    model: standard
    environment: default
    prompt: "PRIVATE SYSTEM PROMPT"
environments:
  default:
    runtime: process
    variables:
      GITHUB_TOKEN: ghp_abcdefghijklmnopqrstuvwxyz1234567890
pipelines:
  feature:
    steps:
      - id: implement
        agent: implementer
policies:
  protectedPaths: []
  allowBinary: false
  allowSymlinks: false
  maxFileBytes: 1000000
  tools: { allow: [], deny: [] }
  mcp: { allow: [], deny: [] }
budgets:
  workflowMicrodollars: 1000
  dailyMicrodollars: 5000
  concurrency: 2
goals:
  maxSteps: 3
  maxRetries: 2
  timeoutMs: 3600000
runtime:
  provider: local
`;

describe('configuration metadata loader', () => {
  it('requires an explicit authoritative path in production', async () => {
    await expect(
      loadConfigurationMetadata({
        env: { NODE_ENV: 'production' },
        cwd: '/workspace',
        readFile: vi.fn(),
      }),
    ).rejects.toThrow('AGENTOS_CONFIG_PATH is required');
  });

  it('loads the configured YAML through the core parser and emits only safe metadata', async () => {
    const readFile = vi.fn().mockResolvedValue(configuredYaml);
    const metadata = await loadConfigurationMetadata({
      env: {
        NODE_ENV: 'production',
        AGENTOS_CONFIG_PATH: 'config/production.yaml',
      },
      cwd: '/workspace',
      readFile,
    });
    const rendered = configurationYaml(metadata);

    expect(readFile).toHaveBeenCalledWith(
      '/workspace/config/production.yaml',
      'utf8',
    );
    expect(metadata).toMatchObject({
      version: 1,
      project: {
        name: 'passerine',
        defaultBranch: 'main',
      },
      provenance: {
        configuredPath: 'config/production.yaml',
        parser: '@agentos/core',
      },
      counts: { models: 1, agents: 1, environments: 1, pipelines: 1, steps: 1 },
    });
    expect(metadata.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(rendered).not.toContain('PRIVATE SYSTEM PROMPT');
    expect(rendered).not.toContain('ghp_');
    expect(rendered).not.toContain('claude-secret-model-name');
    expect(rendered).not.toContain('GITHUB_TOKEN');
  });

  it('uses agentos/example.yaml only outside production', async () => {
    const readFile = vi.fn().mockResolvedValue(configuredYaml);
    await loadConfigurationMetadata({
      env: { NODE_ENV: 'test' },
      cwd: '/workspace',
      readFile,
    });
    expect(readFile).toHaveBeenCalledWith(
      '/workspace/agentos/example.yaml',
      'utf8',
    );
  });
});
