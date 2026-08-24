import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { isoTimestamp, persistenceId } from '@agentos/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET as commits } from '../../app/api/projects/[id]/commits/route';
import { POST as importProject } from '../../app/api/projects/import/route';
import { POST as inspect } from '../../app/api/projects/import/inspect/route';
import { resetControlPlaneServiceForTests } from '../application/runtime';
import {
  repositoryFromEnv,
  resetRepositoryForTests,
} from '../persistence/repository-factory';

const execute = promisify(execFile);

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

async function localRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agentos-route-source-'));
  const repository = join(root, 'existing-project');
  await mkdir(repository);
  const git = (...args: string[]) =>
    execute('git', ['-C', repository, ...args]);
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'Route Author');
  await git('config', 'user.email', 'route@example.test');
  await git('commit', '--allow-empty', '-m', 'Existing project commit');
  return repository;
}

describe('project source API routes', () => {
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

  it('authenticates inspection and requires import idempotency', async () => {
    const repository = await localRepository();
    const unauthorized = await inspect(
      new Request('https://control.example/api/projects/import/inspect', {
        method: 'POST',
        body: JSON.stringify({ kind: 'local', localPath: repository }),
      }),
    );
    expect(unauthorized.status).toBe(401);

    const inspected = await inspect(
      request('/api/projects/import/inspect', {
        method: 'POST',
        body: JSON.stringify({ kind: 'local', localPath: repository }),
      }),
    );
    expect(inspected.status).toBe(200);
    await expect(inspected.json()).resolves.toMatchObject({
      kind: 'local',
      canonicalLocation: await realpath(repository),
      defaultBranch: 'main',
      headSha: expect.stringMatching(/^[0-9a-f]{40}$/),
    });

    const missingKey = await importProject(
      request('/api/projects/import', {
        method: 'POST',
        body: JSON.stringify({
          kind: 'local',
          localPath: repository,
          defaultBranch: 'main',
        }),
      }),
    );
    expect(missingKey.status).toBe(400);
    await expect(missingKey.json()).resolves.toMatchObject({
      error: { code: 'idempotency_key_required' },
    });
  });

  it('imports repeatedly and returns live commit history', async () => {
    const repository = await localRepository();
    const body = JSON.stringify({
      kind: 'local',
      localPath: repository,
      defaultBranch: 'main',
    });
    const first = await importProject(
      request('/api/projects/import', {
        method: 'POST',
        headers: { 'idempotency-key': 'local-import-1' },
        body,
      }),
    );
    expect(first.status).toBe(201);
    const imported = await first.json();
    expect(imported).toMatchObject({
      created: true,
      project: { name: 'existing-project' },
      source: { kind: 'local', defaultBranch: 'main' },
    });

    const replay = await importProject(
      request('/api/projects/import', {
        method: 'POST',
        headers: { 'idempotency-key': 'local-import-1' },
        body,
      }),
    );
    await expect(replay.json()).resolves.toMatchObject({
      created: false,
      project: { id: imported.project.id },
    });

    const history = await commits(
      request(`/api/projects/${imported.project.id}/commits`),
      { params: Promise.resolve({ id: imported.project.id }) },
    );
    expect(history.status).toBe(200);
    await expect(history.json()).resolves.toMatchObject({
      items: [
        {
          subject: 'Existing project commit',
          authorName: 'Route Author',
        },
      ],
    });

    const invalidCursor = await commits(
      request(`/api/projects/${imported.project.id}/commits?cursor=bad`),
      { params: Promise.resolve({ id: imported.project.id }) },
    );
    expect(invalidCursor.status).toBe(422);
  });

  it('returns a conflict when an import key is reused for another source', async () => {
    const firstRepository = await localRepository();
    const secondRepository = await localRepository();
    const importWithPath = (localPath: string) =>
      importProject(
        request('/api/projects/import', {
          method: 'POST',
          headers: { 'idempotency-key': 'reused-import-key' },
          body: JSON.stringify({
            kind: 'local',
            localPath,
            defaultBranch: 'main',
          }),
        }),
      );
    expect((await importWithPath(firstRepository)).status).toBe(201);

    const conflict = await importWithPath(secondRepository);
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: 'idempotency_conflict' },
    });
  });

  it('returns a source-less state without breaking the project', async () => {
    const projectId = persistenceId('project', 'legacy-route-project');
    await repositoryFromEnv().createProject({
      id: projectId,
      name: 'Legacy',
      createdAt: isoTimestamp('2026-08-24T12:00:00.000Z'),
      updatedAt: isoTimestamp('2026-08-24T12:00:00.000Z'),
    });
    const response = await commits(
      request(`/api/projects/${projectId}/commits`),
      { params: Promise.resolve({ id: projectId }) },
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'project_source_not_found' },
    });
  });
});
