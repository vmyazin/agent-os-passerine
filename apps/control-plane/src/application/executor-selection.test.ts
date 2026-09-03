import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { localCancellationRuntime, workflowDispatchFromEnv } from './runtime';
import { resetRepositoryForTests } from '../persistence/repository-factory';

/**
 * The selection is pure environment reading, so every case is exercised
 * without a database, a Trigger project or a model key. The one case that
 * builds an outbox uses the memory repository and a syntactically valid
 * connection string: nothing in the composition opens a socket until a run is
 * actually dispatched.
 */

describe('workflowDispatchFromEnv', () => {
  afterEach(() => {
    resetRepositoryForTests();
    vi.unstubAllEnvs();
  });

  it('returns no dispatcher when no executor is configured', () => {
    vi.stubEnv('AGENTOS_EXECUTOR', '');
    vi.stubEnv('TRIGGER_SECRET_KEY', '');

    expect(workflowDispatchFromEnv()).toBeUndefined();
  });

  it('builds the durable outbox against local pieces when local-direct is selected', async () => {
    const stateDirectory = await mkdtemp(
      join(tmpdir(), 'agentos-local-state-'),
    );
    try {
      vi.stubEnv('NODE_ENV', 'test');
      vi.stubEnv('AGENTOS_EXECUTOR', 'local-direct');
      vi.stubEnv('TRIGGER_SECRET_KEY', '');
      vi.stubEnv('AGENTOS_REPOSITORY', 'memory');
      vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@host/db');
      vi.stubEnv('AGENTOS_LOCAL_STATE_DIR', stateDirectory);

      const dispatch = workflowDispatchFromEnv();

      expect(dispatch).toBeDefined();
      expect(typeof dispatch?.requestStart).toBe('function');
      expect(typeof dispatch?.requestApprovalResume).toBe('function');
      expect(typeof dispatch?.requestCancel).toBe('function');
      expect(typeof dispatch?.requestCleanup).toBe('function');
      expect(typeof dispatch?.requestOrphanReconciliation).toBe('function');
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it('requires an absolute local state directory before it will dispatch locally', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('AGENTOS_EXECUTOR', 'local-direct');
    vi.stubEnv('TRIGGER_SECRET_KEY', '');
    vi.stubEnv('AGENTOS_REPOSITORY', 'memory');
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@host/db');
    vi.stubEnv('AGENTOS_LOCAL_STATE_DIR', '');

    expect(() => workflowDispatchFromEnv()).toThrow(
      /AGENTOS_LOCAL_STATE_DIR is required/,
    );
  });
});

describe('localCancellationRuntime', () => {
  it('treats cancel and cleanup as already done', async () => {
    // A local session is an object in this process. If this instance cannot
    // see it, it no longer exists, because it could not have lived anywhere
    // else. The dispatcher's abort is what actually stops a live one.
    const runtime = localCancellationRuntime();
    await expect(runtime.cancel({ id: 'gone' })).resolves.toBeUndefined();
    await expect(runtime.cleanup({ id: 'gone' })).resolves.toBeUndefined();
    await expect(
      runtime.cleanupAccess!({ resources: [], credentialRefs: [] }),
    ).resolves.toBeUndefined();
  });

  it('refuses the methods it cannot honestly answer', () => {
    const runtime = localCancellationRuntime();
    expect(() => runtime.usage({ id: 'gone' })).toThrow(
      /does not implement usage/,
    );
    expect(() => runtime.collectOutput({ id: 'gone' })).toThrow(
      /does not implement collectOutput/,
    );
  });
});
