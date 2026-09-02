import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  executorFromEnv,
  localCancellationRuntime,
  workflowDispatchFromEnv,
} from './runtime';
import { deploymentSetupReadiness } from './setup-readiness';
import { resetRepositoryForTests } from '../persistence/repository-factory';

/**
 * The selection is pure environment reading, so every case is exercised
 * without a database, a Trigger project or a model key. The one case that
 * builds an outbox uses the memory repository and a syntactically valid
 * connection string: nothing in the composition opens a socket until a run is
 * actually dispatched.
 */
describe('executorFromEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('selects the local executor when AGENTOS_EXECUTOR names it', () => {
    vi.stubEnv('AGENTOS_EXECUTOR', 'local-direct');
    vi.stubEnv('TRIGGER_SECRET_KEY', '');

    expect(executorFromEnv()).toBe('local-direct');
  });

  it('selects Trigger when AGENTOS_EXECUTOR names it, secret key or not', () => {
    vi.stubEnv('AGENTOS_EXECUTOR', 'trigger');
    vi.stubEnv('TRIGGER_SECRET_KEY', '');

    expect(executorFromEnv()).toBe('trigger');

    vi.stubEnv('TRIGGER_SECRET_KEY', 'trigger-secret');
    expect(executorFromEnv()).toBe('trigger');
  });

  it('defaults to Trigger when unset but a Trigger secret key is present', () => {
    vi.stubEnv('AGENTOS_EXECUTOR', '');
    vi.stubEnv('TRIGGER_SECRET_KEY', 'trigger-secret');

    expect(executorFromEnv()).toBe('trigger');
  });

  it('selects no executor when neither the variable nor a secret key is set', () => {
    vi.stubEnv('AGENTOS_EXECUTOR', '');
    vi.stubEnv('TRIGGER_SECRET_KEY', '');

    expect(executorFromEnv()).toBeUndefined();
  });

  it('treats a blank value as unset rather than as a name', () => {
    vi.stubEnv('AGENTOS_EXECUTOR', '   ');
    vi.stubEnv('TRIGGER_SECRET_KEY', '');

    expect(executorFromEnv()).toBeUndefined();
  });

  it('refuses local-direct alongside TRIGGER_SECRET_KEY so one run is never claimed twice', () => {
    vi.stubEnv('AGENTOS_EXECUTOR', 'local-direct');
    vi.stubEnv('TRIGGER_SECRET_KEY', 'trigger-secret');

    expect(() => executorFromEnv()).toThrow(
      /AGENTOS_EXECUTOR=local-direct cannot be combined with TRIGGER_SECRET_KEY/,
    );
    expect(() => executorFromEnv()).toThrow(/only one executor may be active/);
  });

  it('names the accepted values when the variable holds something else', () => {
    vi.stubEnv('AGENTOS_EXECUTOR', 'kubernetes');
    vi.stubEnv('TRIGGER_SECRET_KEY', '');

    expect(() => executorFromEnv()).toThrow(
      /AGENTOS_EXECUTOR must be "trigger" or "local-direct"/,
    );
  });
});

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

describe('setup readiness executor reporting', () => {
  it('reports the Trigger executor and its dispatch group by default', () => {
    const readiness = deploymentSetupReadiness({
      TRIGGER_SECRET_KEY: 'trigger-secret',
    });

    expect(readiness.executor).toBe('trigger');
    expect(readiness.groups.map((entry) => entry.id)).toContain('dispatch');
    expect(readiness.groups.map((entry) => entry.id)).not.toContain('executor');
  });

  it('reports the local executor and names every variable it is missing', () => {
    const readiness = deploymentSetupReadiness({
      AGENTOS_EXECUTOR: 'local-direct',
    });

    expect(readiness.executor).toBe('local-direct');
    const executor = readiness.groups.find((entry) => entry.id === 'executor');
    expect(executor?.ready).toBe(false);
    const missing = (executor?.items ?? [])
      .filter((entry) => !entry.ready)
      .map((entry) => entry.key);
    expect(missing).toContain('AGENTOS_LOCAL_STATE_DIR');
    expect(missing).toContain('AGENTOS_LOCAL_WORKSPACES_ROOT');
    expect(missing).toContain('ANTHROPIC_API_KEY or KIMI_API_KEY');
    // Cloud-only requirements are not reported against a local deployment.
    expect(readiness.groups.map((entry) => entry.id)).not.toContain('storage');
    expect(readiness.groups.map((entry) => entry.id)).not.toContain(
      'artifactMcp',
    );
  });

  it('flags the local executor as unready while a Trigger secret key is also set', () => {
    const readiness = deploymentSetupReadiness({
      AGENTOS_EXECUTOR: 'local-direct',
      TRIGGER_SECRET_KEY: 'trigger-secret',
    });

    const selection = readiness.groups
      .find((entry) => entry.id === 'executor')
      ?.items.find((entry) => entry.key === 'AGENTOS_EXECUTOR');
    expect(selection?.ready).toBe(false);
    expect(selection?.hint).toMatch(/only one executor may be active/);
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
