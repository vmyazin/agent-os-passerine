import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET as getReadiness } from '../../app/api/setup/readiness/route';
import { POST as setupApply } from '../../app/api/setup/apply/route';
import { GET as getRepositoryHead } from '../../app/api/setup/repository-head/route';
import {
  GET as getLocalRepositoryDisallowed,
  POST as createLocalRepository,
} from '../../app/api/setup/local-repository/route';
import { setupReadiness, projectSetupReadinessFromYaml } from '../application/setup-readiness';
import { resetControlPlaneServiceForTests } from '../application/runtime';
import { resetRepositoryForTests } from '../persistence/repository-factory';

/**
 * Every readiness-item environment variable except the ones in the
 * `github` and `local` groups, all present -- so `readiness.ready` (which
 * excludes those two groups) is true and only `readyForGitHub` /
 * `readyForLocal` vary with the github/local-specific values a test adds.
 */
const GREEN_NON_GITHUB_LOCAL_ENV = {
  DATABASE_URL: 'postgresql://user:pass@host/db',
  AGENTOS_REPOSITORY: 'neon',
  TRIGGER_SECRET_KEY: 'trigger-secret',
  TRIGGER_PROJECT_REF: 'proj_ref',
  ANTHROPIC_API_KEY: 'anthropic-key',
  CLOUDFLARE_R2_ACCOUNT_ID: 'account',
  CLOUDFLARE_R2_ARTIFACT_BUCKET: 'bucket',
  CLOUDFLARE_R2_ARTIFACT_ACCESS_KEY_ID: 'access-key',
  CLOUDFLARE_R2_ARTIFACT_SECRET_ACCESS_KEY: 'secret-key',
  AGENTOS_ARTIFACT_MCP_URL: 'https://mcp.example',
  ARTIFACT_MCP_ALLOWED_ORIGINS: 'https://control.example',
  ARTIFACT_CAPABILITY_KEYS_JSON: '{"k1":"v1"}',
  AGENTOS_RUNTIME_OWNERSHIP_SECRET: 'ownership-secret',
  AGENTOS_RUNTIME_HANDLE_KEY: 'handle-key',
  AGENTOS_TEST_REPORT_KEYS_JSON: '{"k1":"v1"}',
  GITHUB_PUBLICATION_KEYS_JSON: '{"k1":"v1"}',
  AGENTOS_TRUSTED_TEST_COMMANDS_JSON: '{"pnpm test":true}',
};

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
    expect(readiness.repositories).toEqual(['octo/repo']);
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

  it('omits repositories for malformed bindings', () => {
    expect(
      setupReadiness({ GITHUB_SELECTED_REPOSITORIES_JSON: 'not-json' })
        .repositories,
    ).toBeUndefined();
    expect(
      setupReadiness({ GITHUB_SELECTED_REPOSITORIES_JSON: '[]' }).repositories,
    ).toBeUndefined();
  });

  it('lists every publisher allowlist entry', () => {
    const readiness = setupReadiness({
      GITHUB_SELECTED_REPOSITORIES_JSON: JSON.stringify([
        { owner: 'octo', name: 'one', installationId: 1, repositoryId: 2 },
        { owner: 'octo', name: 'two', installationId: 1, repositoryId: 3 },
      ]),
    });
    expect(readiness.repositories).toEqual(['octo/one', 'octo/two']);
  });

  it('reports per-project readiness against the GitHub allowlist', () => {
    const env = {
      GITHUB_SELECTED_REPOSITORIES_JSON: JSON.stringify([
        { owner: 'octo', name: 'repo', installationId: 1, repositoryId: 2 },
      ]),
      GITHUB_READER_SELECTED_REPOSITORIES_JSON: JSON.stringify([
        { owner: 'octo', name: 'repo', installationId: 1, repositoryId: 2 },
      ]),
    };
    const allowed = projectSetupReadinessFromYaml(
      env,
      `
version: 1
project:
  name: Demo
  repository: https://github.com/octo/repo
  defaultBranch: main
models: { standard: { provider: local, model: test } }
agents: { implementer: { model: standard } }
environments: { default: { runtime: process } }
pipelines: { feature: { steps: [{ id: implement, agent: implementer }] } }
policies: {}
budgets: { workflowMicrodollars: 1, dailyMicrodollars: 2, concurrency: 1 }
goals: { maxSteps: 2, maxRetries: 1, timeoutMs: 1000 }
runtime: { provider: local }
`,
    );
    expect(allowed.ready).toBe(true);
    expect(allowed.repository).toBe('octo/repo');

    const blocked = projectSetupReadinessFromYaml(
      env,
      `
version: 1
project:
  name: Demo
  repository: https://github.com/octo/other
  defaultBranch: main
models: { standard: { provider: local, model: test } }
agents: { implementer: { model: standard } }
environments: { default: { runtime: process } }
pipelines: { feature: { steps: [{ id: implement, agent: implementer }] } }
policies: {}
budgets: { workflowMicrodollars: 1, dailyMicrodollars: 2, concurrency: 1 }
goals: { maxSteps: 2, maxRetries: 1, timeoutMs: 1000 }
runtime: { provider: local }
`,
    );
    expect(blocked.ready).toBe(false);
  });

  it('relabels the GitHub group and reports readyForLocal once local workspaces are configured', () => {
    const readiness = setupReadiness({
      ...GREEN_NON_GITHUB_LOCAL_ENV,
      AGENTOS_LOCAL_WORKSPACES_ROOT: '/workspaces/experiments',
    });
    const github = readiness.groups.find((entry) => entry.id === 'github');
    expect(github?.title).toBe('GitHub Apps (GitHub projects)');
    expect(github?.ready).toBe(false);
    const local = readiness.groups.find((entry) => entry.id === 'local');
    expect(local?.title).toBe('Local workspaces (experiments)');
    expect(local?.ready).toBe(true);

    expect(readiness.ready).toBe(true);
    expect(readiness.readyForLocal).toBe(true);
    expect(readiness.readyForGitHub).toBe(false);
  });

  it('treats a blank local workspaces root as not ready', () => {
    const readiness = setupReadiness({
      ...GREEN_NON_GITHUB_LOCAL_ENV,
      AGENTOS_LOCAL_WORKSPACES_ROOT: '   ',
    });
    const local = readiness.groups.find((entry) => entry.id === 'local');
    expect(local?.ready).toBe(false);
    expect(readiness.readyForLocal).toBe(false);
    // Overall readiness still excludes the local/github groups.
    expect(readiness.ready).toBe(true);
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

  it('returns 404 for an unknown project on repository-head', async () => {
    const response = await getRepositoryHead(
      request('/api/setup/repository-head?projectId=project-unknown'),
    );
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code)
      .toBe('project_not_found');
  });

  describe('local-repository route', () => {
    let workspacesRoot: string | undefined;

    afterEach(async () => {
      if (workspacesRoot !== undefined) {
        await rm(workspacesRoot, { recursive: true, force: true });
        workspacesRoot = undefined;
      }
    });

    it('requires authentication', async () => {
      const response = await createLocalRepository(
        new Request('https://control.example/api/setup/local-repository', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'exp-one' }),
        }),
      );
      expect(response.status).toBe(401);
    });

    it('rejects GET with 405', () => {
      const response = getLocalRepositoryDisallowed();
      expect(response.status).toBe(405);
    });

    it('reports 409 when the local workspaces root is not configured', async () => {
      const response = await createLocalRepository(
        request('/api/setup/local-repository', {
          method: 'POST',
          body: JSON.stringify({ name: 'exp-one' }),
        }),
      );
      expect(response.status).toBe(409);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('local_workspaces_unconfigured');
    });

    it('rejects names outside the allowed schema', async () => {
      workspacesRoot = await mkdtemp(join(tmpdir(), 'agentos-setup-local-'));
      vi.stubEnv('AGENTOS_LOCAL_WORKSPACES_ROOT', workspacesRoot);

      for (const name of ['..', 'UPPER', '']) {
        const response = await createLocalRepository(
          request('/api/setup/local-repository', {
            method: 'POST',
            body: JSON.stringify({ name }),
          }),
        );
        expect(response.status).toBe(422);
      }
    });

    it('auto-increments repository names from a prefix', async () => {
      workspacesRoot = await mkdtemp(join(tmpdir(), 'agentos-setup-local-'));
      vi.stubEnv('AGENTOS_LOCAL_WORKSPACES_ROOT', workspacesRoot);

      const first = await createLocalRepository(
        request('/api/setup/local-repository', {
          method: 'POST',
          body: JSON.stringify({ namePrefix: 'test-proj' }),
        }),
      );
      expect([200, 201]).toContain(first.status);
      const firstBody = (await first.json()) as {
        name: string;
        localPath: string;
      };
      expect(firstBody.name).toBe('test-proj-01');
      expect(firstBody.localPath).toBe(join(workspacesRoot, 'test-proj-01'));

      const second = await createLocalRepository(
        request('/api/setup/local-repository', {
          method: 'POST',
          body: JSON.stringify({ namePrefix: 'test-proj' }),
        }),
      );
      expect([200, 201]).toContain(second.status);
      expect(((await second.json()) as { name: string }).name).toBe(
        'test-proj-02',
      );

      const invalidPrefix = await createLocalRepository(
        request('/api/setup/local-repository', {
          method: 'POST',
          body: JSON.stringify({ namePrefix: 'Bad_Prefix' }),
        }),
      );
      expect(invalidPrefix.status).toBe(422);
    });

    it('creates a seeded repository and rejects a duplicate name', async () => {
      workspacesRoot = await mkdtemp(join(tmpdir(), 'agentos-setup-local-'));
      vi.stubEnv('AGENTOS_LOCAL_WORKSPACES_ROOT', workspacesRoot);

      const created = await createLocalRepository(
        request('/api/setup/local-repository', {
          method: 'POST',
          body: JSON.stringify({ name: 'exp-one' }),
        }),
      );
      expect([200, 201]).toContain(created.status);
      const body = (await created.json()) as {
        localPath: string;
        branch: string;
        headSha: string;
      };
      expect(body.branch).toBe('main');
      expect(body.headSha).toMatch(/^[0-9a-f]{40}$/);
      expect(body.localPath).toBe(join(workspacesRoot, 'exp-one'));

      const gitDir = await stat(join(body.localPath, '.git'));
      expect(gitDir.isDirectory()).toBe(true);
      const packageJson = await stat(join(body.localPath, 'package.json'));
      expect(packageJson.isFile()).toBe(true);
      const smokeTest = await stat(
        join(body.localPath, 'test', 'smoke.test.mjs'),
      );
      expect(smokeTest.isFile()).toBe(true);

      const duplicate = await createLocalRepository(
        request('/api/setup/local-repository', {
          method: 'POST',
          body: JSON.stringify({ name: 'exp-one' }),
        }),
      );
      expect(duplicate.status).toBe(409);
      const duplicateBody = (await duplicate.json()) as {
        error: { code: string };
      };
      expect(duplicateBody.error.code).toBe('already_exists');
    });
  });
});
