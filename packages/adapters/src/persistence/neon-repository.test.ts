import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  createNeonDomainRepository,
  createNeonDomainRepositoryFromEnv,
  NeonDomainRepository,
} from './neon-repository.js';

const source = readFileSync(
  new URL('./neon-repository.ts', import.meta.url),
  'utf8',
);

describe('NeonDomainRepository', () => {
  it('does not require or connect to a database during import', () => {
    expect(NeonDomainRepository).toBeTypeOf('function');
  });

  it('constructs the adapter without making a network request', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      expect(
        createNeonDomainRepository(
          'postgresql://user:secret@example.neon.tech/agentos?sslmode=require',
        ),
      ).toBeInstanceOf(NeonDomainRepository);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it('fails closed before constructing a client when database configuration is absent', () => {
    expect(() => createNeonDomainRepositoryFromEnv({})).toThrow(
      'DATABASE_URL is required',
    );
  });

  it('uses conflict-safe writes for idempotency keys', () => {
    expect(source.match(/onConflictDoNothing/g)?.length).toBeGreaterThanOrEqual(
      3,
    );
    expect(source).toContain('onConflictDoUpdate');
    expect(source).toContain(
      'target: [stepRuns.runId, stepRuns.stepKey, stepRuns.attempt]',
    );
  });

  it('consumes approvals and replies with conditional updates', () => {
    const consumeApproval = source.slice(
      source.indexOf('async consumeApproval'),
      source.indexOf('async createInboxMessage'),
    );
    expect(source).toContain("eq(approvals.status, 'pending')");
    expect(source).toContain('gt(approvals.expiresAt, request.consumedAt)');
    expect(source).toContain('eq(approvals.fingerprint, request.fingerprint)');
    expect(source).toContain("eq(inboxMessages.status, 'pending')");
    expect(consumeApproval).not.toContain('.select(');
  });
});
