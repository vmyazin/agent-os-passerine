import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET as getReadiness } from '../../app/api/setup/readiness/route';
import { POST as setupApply } from '../../app/api/setup/apply/route';
import { setupReadiness } from '../application/setup-readiness';
import { resetControlPlaneServiceForTests } from '../application/runtime';
import { resetRepositoryForTests } from '../persistence/repository-factory';

const VALID_YAML = `
version: 1
project: { name: Wizard Test }
models: { standard: { provider: local, model: test } }
agents: { implementer: { model: standard } }
environments: { default: { runtime: process } }
pipelines: { feature: { steps: [{ id: implement, agent: implementer }] } }
policies: {}
budgets: { workflowMicrodollars: 1, dailyMicrodollars: 2, concurrency: 1 }
goals: { maxSteps: 2, maxRetries: 1, timeoutMs: 1000 }
runtime: { provider: local }
`;

function request(path: string, options: RequestInit = {}) {
  return new Request(`https://control.example${path}`, {
    ...options,
    headers: {
      authorization: 'Bearer route-token',
      'content-type': 'application/json',
      ...options.headers,
    },
  });
}

describe('setup readiness model', () => {
  it('reports groups as booleans and never echoes environment values', () => {
    const readiness = setupReadiness({
      DATABASE_URL: 'postgresql://user:hunter2@host/db',
      AGENTOS_REPOSITORY: 'neon',
      GITHUB_SELECTED_REPOSITORIES_JSON: JSON.stringify([
        { owner: 'octo', name: 'repo', installationId: 1, repositoryId: 2 },
      ]),
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.repository).toBe('octo/repo');
    const database = readiness.groups.find((group) => group.id === 'database');
    expect(database?.ready).toBe(true);
    const trust = readiness.groups.find((group) => group.id === 'trust');
    expect(trust?.ready).toBe(false);
    expect(JSON.stringify(readiness)).not.toContain('hunter2');
  });

  it('treats blank values as absent', () => {
    const readiness = setupReadiness({ DATABASE_URL: '   ' });
    const database = readiness.groups.find((group) => group.id === 'database');
    expect(database?.items.find((entry) => entry.key === 'DATABASE_URL')?.ready).toBe(
      false,
    );
  });

  it('omits the repository for malformed bindings', () => {
    expect(
      setupReadiness({ GITHUB_SELECTED_REPOSITORIES_JSON: 'not-json' })
        .repository,
    ).toBeUndefined();
    expect(
      setupReadiness({ GITHUB_SELECTED_REPOSITORIES_JSON: '[]' }).repository,
    ).toBeUndefined();
  });
});

describe('setup API routes', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('AGENTOS_REPOSITORY', 'memory');
    vi.stubEnv('AGENTOS_PUBLIC_URL', 'https://control.example');
    vi.stubEnv('AGENTOS_SESSION_SECRET', 'x'.repeat(32));
    vi.stubEnv('GITHUB_CLIENT_ID', 'client');
    vi.stubEnv('GITHUB_CLIENT_SECRET', 'secret');
    vi.stubEnv('GITHUB_ALLOWED_LOGIN', 'operator');
    vi.stubEnv('AGENTOS_CLI_TOKEN', 'route-token');
    resetRepositoryForTests();
    resetControlPlaneServiceForTests();
  });

  afterEach(() => vi.unstubAllEnvs());

  it('requires authentication for readiness and returns the report', async () => {
    const unauthorized = await getReadiness(
      new Request('https://control.example/api/setup/readiness'),
    );
    expect(unauthorized.status).toBe(401);

    const response = await getReadiness(request('/api/setup/readiness'));
    expect(response.status).toBe(200);
    const readiness = (await response.json()) as {
      ready: boolean;
      groups: readonly { id: string }[];
    };
    expect(typeof readiness.ready).toBe('boolean');
    expect(readiness.groups.length).toBeGreaterThan(3);
  });

  it('applies YAML through the session-facing route', async () => {
    const unauthorized = await setupApply(
      new Request('https://control.example/api/setup/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ yaml: VALID_YAML }),
      }),
    );
    expect(unauthorized.status).toBe(401);

    const applied = await setupApply(
      request('/api/setup/apply', {
        method: 'POST',
        headers: { 'idempotency-key': 'wizard-apply' },
        body: JSON.stringify({ yaml: VALID_YAML }),
      }),
    );
    expect(applied.status).toBe(201);
    const projection = (await applied.json()) as {
      projectId: string;
      revision: number;
    };
    expect(projection.revision).toBe(1);
    expect(projection.projectId).toMatch(/^project_/);

    // A second apply of the same YAML carries the active revision as its
    // concurrency expectation and stays on revision 1 (idempotent content).
    const repeat = await setupApply(
      request('/api/setup/apply', {
        method: 'POST',
        headers: { 'idempotency-key': 'wizard-apply-2' },
        body: JSON.stringify({ yaml: VALID_YAML }),
      }),
    );
    expect([200, 201]).toContain(repeat.status);
  });

  it('rejects invalid YAML with a bounded validation error', async () => {
    const response = await setupApply(
      request('/api/setup/apply', {
        method: 'POST',
        headers: { 'idempotency-key': 'wizard-bad' },
        body: JSON.stringify({ yaml: 'version: 99\n' }),
      }),
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      error: { code: string };
    };
    expect(body.error.code).toBe('invalid_configuration');
  });
});
