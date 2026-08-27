import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET } from '../../app/api/inbox/count/route';
import { resetControlPlaneServiceForTests } from '../application/runtime';
import {
  repositoryFromEnv,
  resetRepositoryForTests,
} from '../persistence/repository-factory';

function authenticatedRequest(): Request {
  return new Request('https://control.example/api/inbox/count', {
    headers: { authorization: 'Bearer route-token' },
  });
}

describe('inbox count API route', () => {
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

  it('authenticates and counts pending approvals plus unanswered messages', async () => {
    const unauthorized = await GET(
      new Request('https://control.example/api/inbox/count'),
    );
    expect(unauthorized.status).toBe(401);

    const repository = repositoryFromEnv();
    const now = '2026-08-27T12:00:00.000Z' as never;
    const projectId = 'project_inbox_count' as never;
    const runId = 'run_inbox_count' as never;
    await repository.createProject({
      id: projectId,
      name: 'Inbox count',
      createdAt: now,
      updatedAt: now,
    });
    await repository.createRun({
      id: runId,
      projectId,
      pipeline: 'feature',
      status: 'waiting',
      createdAt: now,
      updatedAt: now,
    });
    await repository.createInboxMessage({
      id: 'inbox_pending' as never,
      runId,
      status: 'pending',
      body: { question: 'Continue?' },
      createdAt: now,
    });
    await repository.createInboxMessage({
      id: 'inbox_replied' as never,
      runId,
      status: 'replied',
      body: { question: 'Which window?' },
      reply: { answer: 'Tuesday' },
      createdAt: now,
      repliedAt: now,
    });
    await repository.createApproval({
      id: 'approval_pending' as never,
      runId,
      scope: 'merge:42',
      fingerprint: 'scope-hash-42',
      status: 'pending',
      createdAt: now,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() as never,
    });
    await repository.createApproval({
      id: 'approval_consumed' as never,
      runId,
      scope: 'deploy:42',
      fingerprint: 'scope-hash-consumed',
      status: 'consumed',
      createdAt: now,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() as never,
      consumedAt: now,
    });

    const response = await GET(authenticatedRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({ count: 2 });
  });

  it('keeps service failures private and non-cacheable', async () => {
    const repository = repositoryFromEnv();
    vi.spyOn(repository, 'listRuns').mockRejectedValue(
      new Error('database connection included a private host'),
    );

    const response = await GET(authenticatedRequest());

    expect(response.status).toBe(500);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = await response.json();
    expect(body).toEqual({
      error: {
        code: 'internal_error',
        message: 'an unexpected error occurred',
      },
    });
    expect(JSON.stringify(body)).not.toContain('private host');
  });

  it('counts beyond both run and per-run listing page limits', async () => {
    const repository = repositoryFromEnv();
    const now = '2026-08-27T12:00:00.000Z' as never;
    const projectId = 'project_large_inbox' as never;
    await repository.createProject({
      id: projectId,
      name: 'Large inbox',
      createdAt: now,
      updatedAt: now,
    });

    for (let index = 0; index <= 100; index += 1) {
      const suffix = String(index).padStart(3, '0');
      const runId = `run_large_${suffix}` as never;
      await repository.createRun({
        id: runId,
        projectId,
        pipeline: 'feature',
        status: 'waiting',
        createdAt: now,
        updatedAt: now,
      });
      await repository.createInboxMessage({
        id: `inbox_large_${suffix}` as never,
        runId,
        status: 'pending',
        body: { question: 'Continue?' },
        createdAt: now,
      });
      await repository.createApproval({
        id: `approval_large_${suffix}` as never,
        runId,
        scope: `scope:${suffix}`,
        fingerprint: `scope-hash-${suffix}`,
        status: 'pending',
        createdAt: now,
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() as never,
      });
    }

    const firstRunId = 'run_large_000' as never;
    for (let index = 1; index <= 100; index += 1) {
      const suffix = String(index).padStart(3, '0');
      await repository.createInboxMessage({
        id: `inbox_large_extra_${suffix}` as never,
        runId: firstRunId,
        status: 'pending',
        body: { question: 'Continue?' },
        createdAt: now,
      });
      await repository.createApproval({
        id: `approval_large_extra_${suffix}` as never,
        runId: firstRunId,
        scope: `extra:${suffix}`,
        fingerprint: `extra-scope-hash-${suffix}`,
        status: 'pending',
        createdAt: now,
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() as never,
      });
    }

    const response = await GET(authenticatedRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ count: 402 });
  });
});
