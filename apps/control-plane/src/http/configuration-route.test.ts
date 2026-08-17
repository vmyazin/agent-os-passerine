import {
  canonicalConfigHash,
  canonicalConfigJson,
  loadAgentOsConfig,
  MAX_AGENT_OS_CONFIG_SOURCE_BYTES,
  MAX_CANONICAL_CONFIG_BYTES,
  MAX_CONFIGURATION_APPLY_BODY_BYTES,
} from '@agentos/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET } from '../../app/api/configuration/route';
import { POST } from '../../app/api/configuration/apply/route';
import { POST as startFeature } from '../../app/api/features/route';
import { GET as getInbox } from '../../app/api/inbox/route';
import { authConfigFromEnv, issueSession, SESSION_COOKIE } from '../auth/auth';
import { resetControlPlaneServiceForTests } from '../application/runtime';
import {
  repositoryFromEnv,
  resetRepositoryForTests,
} from '../persistence/repository-factory';

const config = loadAgentOsConfig(`
version: 1
project: { name: Route Test }
models: { standard: { provider: local, model: test } }
agents: { implementer: { model: standard } }
environments: { default: { runtime: process } }
pipelines: { feature: { steps: [{ id: implement, agent: implementer }] } }
policies: {}
budgets: { workflowMicrodollars: 1, dailyMicrodollars: 2, concurrency: 1 }
goals: { maxSteps: 2, maxRetries: 1, timeoutMs: 1000 }
runtime: { provider: local }
`);
const body = {
  canonicalConfig: canonicalConfigJson(config),
  digest: canonicalConfigHash(config),
  expectedRevision: null,
  expectedDigest: null,
};

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

describe('configuration API routes', () => {
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

  it('authenticates GET and returns a safe empty/active projection', async () => {
    const unauthorized = await GET(
      new Request('https://control.example/api/configuration'),
    );
    expect(unauthorized.status).toBe(401);

    const empty = await GET(request('/api/configuration'));
    await expect(empty.json()).resolves.toEqual({ active: null });

    const applied = await POST(
      request('/api/configuration/apply', {
        method: 'POST',
        headers: { 'idempotency-key': 'route-apply' },
        body: JSON.stringify(body),
      }),
    );
    expect(applied.status).toBe(201);
    const projected = await applied.json();
    expect(projected).toMatchObject({
      canonicalConfig: body.canonicalConfig,
      digest: body.digest,
      projectId: expect.any(String),
      revision: 1,
    });
    expect(projected).not.toHaveProperty('id');
    expect(projected).not.toHaveProperty('repositorySha');
    expect(projected.provenance).toMatchObject({
      repositorySha: expect.stringMatching(/^[a-f0-9]{40}$/),
      configDigest: body.digest,
      modelDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      promptDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      environmentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      policyDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    const feature = await startFeature(
      request('/api/features', {
        method: 'POST',
        headers: { 'idempotency-key': 'feature-from-applied-config' },
        body: JSON.stringify({
          projectId: projected.projectId,
          title: 'Start from safe projection',
          description: 'Use the immutable provenance returned by apply.',
          ...projected.provenance,
        }),
      }),
    );
    expect(feature.status).toBe(201);
    await expect(feature.json()).resolves.toMatchObject({
      projectId: projected.projectId,
      repositorySha: projected.provenance.repositorySha,
    });

    const active = await GET(request('/api/configuration'));
    await expect(active.json()).resolves.toEqual({ active: projected });

    const session = issueSession(
      authConfigFromEnv(process.env),
      'operator',
      new Date(),
    );
    const browserHeaders = {
      cookie: `${SESSION_COOKIE}=${session}`,
      origin: 'https://control.example',
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
    };
    const browserGet = await GET(
      new Request('https://control.example/api/configuration', {
        headers: browserHeaders,
      }),
    );
    expect(browserGet.status).toBe(200);
    const browserProjection = await browserGet.json();
    expect(browserProjection.active).toMatchObject({
      projectId: projected.projectId,
      digest: projected.digest,
      revision: 1,
    });
    expect(browserProjection.active).not.toHaveProperty('canonicalConfig');

    const browserPost = await POST(
      new Request('https://control.example/api/configuration/apply', {
        method: 'POST',
        headers: {
          ...browserHeaders,
          'idempotency-key': 'browser-key',
        },
        body: JSON.stringify(body),
      }),
    );
    expect(browserPost.status).toBe(403);
    await expect(browserPost.json()).resolves.toMatchObject({
      error: { code: 'cli_authentication_required' },
    });
  });

  it('lists messages and pending approvals with their required scope hashes', async () => {
    const repository = repositoryFromEnv();
    const now = '2026-08-17T12:00:00.000Z' as never;
    const projectId = 'project_inbox' as never;
    const runId = 'run_inbox' as never;
    await repository.createProject({
      id: projectId,
      name: 'Inbox',
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
      id: 'inbox_message' as never,
      runId,
      status: 'pending',
      body: { question: 'Continue?' },
      createdAt: now,
    });
    await repository.createApproval({
      id: 'approval_inbox' as never,
      runId,
      scope: 'merge:42',
      fingerprint: 'scope-hash-42',
      status: 'pending',
      createdAt: now,
      expiresAt: '2026-08-18T12:00:00.000Z' as never,
    });

    const response = await getInbox(request('/api/inbox'));
    await expect(response.json()).resolves.toMatchObject({
      messages: [{ id: 'inbox_message' }],
      approvals: [{ id: 'approval_inbox', scopeHash: 'scope-hash-42' }],
    });
  });

  it('replays apply and rejects changed payloads, unknown fields, and missing keys', async () => {
    const apply = (requestBody: unknown, key = 'route-apply') =>
      POST(
        request('/api/configuration/apply', {
          method: 'POST',
          headers: key ? { 'idempotency-key': key } : {},
          body: JSON.stringify(requestBody),
        }),
      );
    const first = await apply(body);
    const replay = await apply(body);
    expect(await replay.json()).toEqual(await first.json());

    const unauthenticated = await POST(
      new Request('https://control.example/api/configuration/apply', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'unauthenticated',
        },
        body: JSON.stringify(body),
      }),
    );
    expect(unauthenticated.status).toBe(401);

    const missingKey = await apply(body, '');
    expect(missingKey.status).toBe(400);
    const unknown = await apply(
      { ...body, token: 'must-not-be-accepted' },
      'unknown',
    );
    expect(unknown.status).toBe(422);
  });

  it('accepts quote-heavy canonical configuration bodies above the ordinary API limit', async () => {
    const prompt = '"'.repeat(40_000);
    const largeConfig = {
      ...config,
      agents: {
        implementer: { ...config.agents.implementer!, prompt },
      },
    };
    const requestBody = {
      canonicalConfig: canonicalConfigJson(largeConfig),
      digest: canonicalConfigHash(largeConfig),
      expectedRevision: null,
      expectedDigest: null,
    };
    const encoded = JSON.stringify(requestBody);
    expect(Buffer.byteLength(requestBody.canonicalConfig)).toBeGreaterThan(
      MAX_AGENT_OS_CONFIG_SOURCE_BYTES,
    );
    expect(Buffer.byteLength(requestBody.canonicalConfig)).toBeLessThanOrEqual(
      MAX_CANONICAL_CONFIG_BYTES,
    );
    expect(Buffer.byteLength(encoded)).toBeGreaterThan(64 * 1024);
    expect(Buffer.byteLength(encoded)).toBeLessThan(
      MAX_CONFIGURATION_APPLY_BODY_BYTES,
    );

    const response = await POST(
      request('/api/configuration/apply', {
        method: 'POST',
        headers: { 'idempotency-key': 'large-config' },
        body: encoded,
      }),
    );
    expect(response.status).toBe(201);
  });

  it('rejects canonical configuration above its UTF-8 byte ceiling', async () => {
    const canonicalConfig = `"${'é'.repeat(MAX_CANONICAL_CONFIG_BYTES / 2)}"`;
    expect(Buffer.byteLength(canonicalConfig)).toBeGreaterThan(
      MAX_CANONICAL_CONFIG_BYTES,
    );
    const encoded = JSON.stringify({ ...body, canonicalConfig });
    expect(Buffer.byteLength(encoded)).toBeLessThan(
      MAX_CONFIGURATION_APPLY_BODY_BYTES,
    );

    const response = await POST(
      request('/api/configuration/apply', {
        method: 'POST',
        headers: { 'idempotency-key': 'oversized-canonical-config' },
        body: encoded,
      }),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'validation_error' },
    });
  });

  it('allows only one apply against the same active configuration', async () => {
    const initial = await POST(
      request('/api/configuration/apply', {
        method: 'POST',
        headers: { 'idempotency-key': 'concurrency-initial' },
        body: JSON.stringify(body),
      }),
    );
    const active = await initial.json();
    const candidates = [2, 3].map((concurrency) => {
      const changed = {
        ...config,
        budgets: { ...config.budgets, concurrency },
      };
      return {
        canonicalConfig: canonicalConfigJson(changed),
        digest: canonicalConfigHash(changed),
        expectedRevision: active.revision as number,
        expectedDigest: active.digest as string,
      };
    });
    const responses = await Promise.all(
      candidates.map((candidate, index) =>
        POST(
          request('/api/configuration/apply', {
            method: 'POST',
            headers: {
              'idempotency-key': `concurrency-${String(index)}`,
            },
            body: JSON.stringify(candidate),
          }),
        ),
      ),
    );

    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 409,
    ]);
    const stale = responses.find((response) => response.status === 409);
    await expect(stale?.json()).resolves.toMatchObject({
      error: { code: 'configuration_stale' },
    });
  });
});
