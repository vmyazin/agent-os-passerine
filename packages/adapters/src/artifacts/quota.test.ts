import { describe, expect, it } from 'vitest';

import type { ArtifactCapabilityClaims } from '@agentos/core';

import { InMemoryDomainRepository } from '../persistence/in-memory.js';
import { createDomainArtifactCapabilityQuotaStore } from './quota.js';

const now = new Date('2026-08-17T00:00:00.000Z');
const claims: ArtifactCapabilityClaims = {
  purpose: 'agent-artifact-access',
  audience: 'artifact-mcp',
  methods: ['artifact.list'],
  projectId: 'project-1',
  runId: 'run-1',
  stepId: 'step-1',
  maxBytes: 1024,
  maxCalls: 1,
  maxCumulativeBytes: 1024,
  notBefore: now.toISOString(),
  expiresAt: '2026-08-17T00:10:00.000Z',
  nonce: 'quota-store-123456',
};

describe('domain artifact capability quota store', () => {
  it('admits and replays an identical operation but denies a second call', async () => {
    const quota = createDomainArtifactCapabilityQuotaStore(
      new InMemoryDomainRepository(),
    );
    await expect(
      quota.consume(claims, { operationId: 'one', bytes: 0, now }),
    ).resolves.toBeUndefined();
    await expect(
      quota.consume(claims, { operationId: 'one', bytes: 0, now }),
    ).resolves.toBeUndefined();
    await expect(
      quota.consume(claims, { operationId: 'two', bytes: 0, now }),
    ).rejects.toMatchObject({ code: 'artifact_quota_exhausted' });
  });
});
