import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET } from '../../app/api/runs/active-count/route';
import { resetControlPlaneServiceForTests } from '../application/runtime';
import {
  repositoryFromEnv,
  resetRepositoryForTests,
} from '../persistence/repository-factory';

function authenticatedRequest(): Request {
  return new Request('https://control.example/api/runs/active-count', {
    headers: { authorization: 'Bearer route-token' },
  });
}

describe('active run count API route', () => {
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

  it('authenticates and exactly counts pending plus running runs only', async () => {
    const unauthorized = await GET(
      new Request('https://control.example/api/runs/active-count'),
    );
    expect(unauthorized.status).toBe(401);

    const repository = repositoryFromEnv();
    const now = '2026-08-27T12:00:00.000Z' as never;
    const projectId = 'project_active_count' as never;
    await repository.createProject({
      id: projectId,
      name: 'Active count',
      createdAt: now,
      updatedAt: now,
    });

    for (const [suffix, status] of [
      ['pending', 'pending'],
      ['running', 'running'],
      ['waiting', 'waiting'],
      ['succeeded', 'succeeded'],
    ] as const) {
      await repository.createRun({
        id: `run_active_${suffix}` as never,
        projectId,
        pipeline: 'feature',
        status,
        createdAt: now,
        updatedAt: now,
      });
    }

    // Cross the former list-page ceiling so a count implemented by listing
    // cannot silently stop at 100.
    for (let index = 0; index < 100; index += 1) {
      await repository.createRun({
        id: `run_active_pending_${String(index).padStart(3, '0')}` as never,
        projectId,
        pipeline: 'feature',
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      });
    }

    const response = await GET(authenticatedRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({ count: 102 });
  });
});
