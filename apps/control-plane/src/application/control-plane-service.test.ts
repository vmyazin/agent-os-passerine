import { InMemoryDomainRepository } from '@agentos/adapters';
import {
  canonicalConfigHash,
  canonicalConfigJson,
  loadAgentOsConfig,
  persistenceId,
  isoTimestamp,
} from '@agentos/core';
import { describe, expect, it, vi } from 'vitest';

import { ControlPlaneService, ServiceError } from './control-plane-service';

const now = isoTimestamp('2026-08-17T12:00:00.000Z');
const ids = (kind: string, key: string) =>
  persistenceId(kind as never, `${kind}-${key}`);
const createService = (repository: InMemoryDomainRepository) =>
  new ControlPlaneService(repository, () => now, ids);

const feature = {
  projectId: 'project-1',
  title: 'Ship approval inbox',
  description: 'Add scoped approvals.',
  repositorySha: 'a'.repeat(40),
  configDigest: 'cfg',
  modelDigest: 'model',
  promptDigest: 'prompt',
  environmentDigest: 'env',
  policyDigest: 'policy',
};

const goalCriteria = [
  {
    id: 'tests',
    type: 'command' as const,
    description: 'Tests pass',
    required: true,
    command: 'pnpm test',
  },
  {
    id: 'typecheck',
    type: 'command' as const,
    description: 'Typecheck passes',
    required: true,
    command: 'pnpm typecheck',
  },
];

async function applyGoalConfiguration(
  service: ControlPlaneService,
  key: string,
) {
  const config = loadAgentOsConfig(`
version: 1
project: { name: Goal Project }
models: { standard: { provider: local, model: test } }
agents: { implementer: { model: standard } }
environments: { default: { runtime: process } }
pipelines: { feature: { steps: [{ id: implement, agent: implementer }] } }
policies: {}
budgets: { workflowMicrodollars: 1, dailyMicrodollars: 2, concurrency: 1 }
goals: { maxSteps: 3, maxRetries: 1, timeoutMs: 1000 }
runtime: { provider: local }
`);
  return service.applyConfiguration(key, {
    canonicalConfig: canonicalConfigJson(config),
    digest: canonicalConfigHash(config),
    expectedRevision: null,
    expectedDigest: null,
  });
}

describe('ControlPlaneService', () => {
  it('binds an applied workflow configuration to the trusted selected-repository head', async () => {
    const repository = new InMemoryDomainRepository();
    const resolve = vi.fn(async () => 'b'.repeat(40));
    const requestStart = vi.fn();
    const service = new ControlPlaneService(
      repository,
      () => now,
      ids,
      {
        requestStart,
        requestApprovalResume: vi.fn(),
      },
      { resolve },
    );
    const config = loadAgentOsConfig(`
version: 1
project: { name: Passerine, repository: https://github.com/team/repo, defaultBranch: main }
models: { standard: { provider: local, model: test } }
agents: { implementer: { model: standard } }
environments: { default: { runtime: process } }
pipelines: { feature: { steps: [{ id: implement, agent: implementer }] } }
policies: {}
budgets: { workflowMicrodollars: 1, dailyMicrodollars: 2, concurrency: 1 }
goals: { maxSteps: 2, maxRetries: 1, timeoutMs: 1000 }
runtime: { provider: local }
`);
    const applied = await service.applyConfiguration('trusted-head', {
      canonicalConfig: canonicalConfigJson(config),
      digest: canonicalConfigHash(config),
      expectedRevision: null,
      expectedDigest: null,
    });

    expect(resolve).toHaveBeenCalledWith(config);
    const projects = await repository.listProjects();
    const revisions = await repository.listConfigRevisions(projects[0]!.id);
    expect(revisions).toEqual([
      expect.objectContaining({ repositorySha: 'b'.repeat(40) }),
    ]);
    await expect(
      service.createFeatureRun('trusted-head-feature', {
        projectId: applied.projectId,
        title: 'Use the real selected head',
        description: 'Snapshot the exact applied revision.',
        ...applied.provenance,
      }),
    ).resolves.toMatchObject({ repositorySha: 'b'.repeat(40) });
    expect(requestStart).toHaveBeenCalledOnce();
  });

  it('replays a config apply before consulting a mutable repository head', async () => {
    const repository = new InMemoryDomainRepository();
    const resolve = vi
      .fn()
      .mockResolvedValueOnce('b'.repeat(40))
      .mockResolvedValueOnce('c'.repeat(40));
    const service = new ControlPlaneService(
      repository,
      () => now,
      ids,
      undefined,
      { resolve },
    );
    const config = loadAgentOsConfig(`
version: 1
project: { name: Passerine, repository: https://github.com/team/repo, defaultBranch: main }
models: { standard: { provider: local, model: test } }
agents: { implementer: { model: standard } }
environments: { default: { runtime: process } }
pipelines: { feature: { steps: [{ id: implement, agent: implementer }] } }
policies: {}
budgets: { workflowMicrodollars: 1, dailyMicrodollars: 2, concurrency: 1 }
goals: { maxSteps: 2, maxRetries: 1, timeoutMs: 1000 }
runtime: { provider: local }
`);
    const request = {
      canonicalConfig: canonicalConfigJson(config),
      digest: canonicalConfigHash(config),
      expectedRevision: null,
      expectedDigest: null,
    };

    const first = await service.applyConfiguration('stable-key', request);
    const replay = await service.applyConfiguration('stable-key', request);
    expect(replay).toEqual(first);
    expect(resolve).toHaveBeenCalledOnce();

    const changed = { ...config, project: { ...config.project, name: 'Next' } };
    const next = await service.applyConfiguration('next-key', {
      canonicalConfig: canonicalConfigJson(changed),
      digest: canonicalConfigHash(changed),
      expectedRevision: first.revision,
      expectedDigest: first.digest,
    });
    expect(next.provenance.repositorySha).toBe('c'.repeat(40));
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('records configuration immutably and replays the same apply key', async () => {
    const repository = new InMemoryDomainRepository();
    const service = createService(repository);
    const config = loadAgentOsConfig(`
version: 1
project: { name: Passerine }
models: { standard: { provider: local, model: test } }
agents: { implementer: { model: standard } }
environments: { default: { runtime: process } }
pipelines: { feature: { steps: [{ id: implement, agent: implementer }] } }
policies: {}
budgets: { workflowMicrodollars: 1, dailyMicrodollars: 2, concurrency: 1 }
goals: { maxSteps: 2, maxRetries: 1, timeoutMs: 1000 }
runtime: { provider: local }
`);
    const input = {
      canonicalConfig: canonicalConfigJson(config),
      digest: canonicalConfigHash(config),
      expectedRevision: null,
      expectedDigest: null,
    };

    const first = await service.applyConfiguration('apply-key', input);
    const replay = await createService(repository).applyConfiguration(
      'apply-key',
      input,
    );

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      digest: input.digest,
      projectId: expect.stringMatching(/^project-/),
      revision: 1,
    });
    expect(await service.getConfiguration()).toEqual({ active: first });
    expect(await service.getConfiguration(false)).toEqual({
      active: {
        projectId: first.projectId,
        digest: first.digest,
        revision: first.revision,
        appliedAt: first.appliedAt,
        provenance: first.provenance,
      },
    });
    const projects = await repository.listProjects();
    expect(projects).toHaveLength(1);
    await expect(
      repository.listConfigRevisions(projects[0]!.id),
    ).resolves.toHaveLength(1);
  });

  it('rejects changed configuration under a used apply key and invalid digests', async () => {
    const repository = new InMemoryDomainRepository();
    const service = createService(repository);
    const config = loadAgentOsConfig(`
version: 1
project: { name: Passerine }
models: { standard: { provider: local, model: test } }
agents: { implementer: { model: standard } }
environments: { default: { runtime: process } }
pipelines: { feature: { steps: [{ id: implement, agent: implementer }] } }
policies: {}
budgets: { workflowMicrodollars: 1, dailyMicrodollars: 2, concurrency: 1 }
goals: { maxSteps: 2, maxRetries: 1, timeoutMs: 1000 }
runtime: { provider: local }
`);
    const canonicalConfig = canonicalConfigJson(config);
    await service.applyConfiguration('apply-key', {
      canonicalConfig,
      digest: canonicalConfigHash(config),
      expectedRevision: null,
      expectedDigest: null,
    });

    await expect(
      service.applyConfiguration('apply-key', {
        canonicalConfig: canonicalConfig.replace(
          '"concurrency":1',
          '"concurrency":2',
        ),
        digest: '0'.repeat(64),
        expectedRevision: null,
        expectedDigest: null,
      }),
    ).rejects.toMatchObject({
      code: 'configuration_digest_mismatch',
      status: 422,
    });
    const changed = loadAgentOsConfig(
      canonicalConfig.replace('"maxSteps":2', '"maxSteps":3'),
    );
    await expect(
      service.applyConfiguration('apply-key', {
        canonicalConfig: canonicalConfigJson(changed),
        digest: canonicalConfigHash(changed),
        expectedRevision: null,
        expectedDigest: null,
      }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict', status: 409 });
  });

  it('returns the newest active configuration beyond one page of revisions', async () => {
    const repository = new InMemoryDomainRepository();
    const projectId = persistenceId('project', 'many-revisions');
    await repository.createProject({
      id: projectId,
      name: 'Many revisions',
      createdAt: now,
      updatedAt: now,
    });
    for (let revision = 1; revision <= 1_001; revision += 1) {
      await repository.createConfigRevision({
        id: persistenceId('configRevision', `revision-${String(revision)}`),
        projectId,
        revision,
        config: { version: revision },
        configDigest: `config-${String(revision)}`,
        modelDigest: 'model',
        promptDigest: 'prompt',
        environmentDigest: 'environment',
        policyDigest: 'policy',
        repositorySha: '0'.repeat(40),
        createdAt: now,
      });
    }

    await expect(
      createService(repository).getConfiguration(),
    ).resolves.toMatchObject({
      active: { digest: 'config-1001', revision: 1_001 },
    });
  });

  it('creates successive and concurrent immutable revisions as the clock advances', async () => {
    const repository = new InMemoryDomainRepository();
    let clock = isoTimestamp('2026-08-17T12:00:00.000Z');
    const service = new ControlPlaneService(repository, () => clock, ids);
    const config = loadAgentOsConfig(`
version: 1
project: { name: Advancing Project, repository: https://example.com/one.git }
models: { standard: { provider: local, model: test } }
agents: { implementer: { model: standard } }
environments: { default: { runtime: process } }
pipelines: { feature: { steps: [{ id: implement, agent: implementer }] } }
policies: {}
budgets: { workflowMicrodollars: 1, dailyMicrodollars: 2, concurrency: 1 }
goals: { maxSteps: 2, maxRetries: 1, timeoutMs: 1000 }
runtime: { provider: local }
`);
    const first = await service.applyConfiguration('revision-1', {
      canonicalConfig: canonicalConfigJson(config),
      digest: canonicalConfigHash(config),
      expectedRevision: null,
      expectedDigest: null,
    });
    clock = isoTimestamp('2026-08-17T12:01:00.000Z');
    const changed = {
      ...config,
      project: {
        ...config.project,
        name: 'Renamed Project',
        repository: 'https://example.com/two.git',
      },
      budgets: { ...config.budgets, concurrency: 2 },
    };
    const second = await service.applyConfiguration('revision-2', {
      canonicalConfig: canonicalConfigJson(changed),
      digest: canonicalConfigHash(changed),
      expectedRevision: first.revision,
      expectedDigest: first.digest,
    });

    expect(second).toMatchObject({ projectId: first.projectId, revision: 2 });
    await expect(
      repository.getProject(persistenceId('project', first.projectId)),
    ).resolves.toMatchObject({
      createdAt: '2026-08-17T12:00:00.000Z',
      updatedAt: '2026-08-17T12:01:00.000Z',
      name: 'Renamed Project',
      repository: 'https://example.com/two.git',
    });

    clock = isoTimestamp('2026-08-17T12:02:00.000Z');
    const candidates = [3, 4].map((concurrency) => ({
      ...changed,
      budgets: { ...changed.budgets, concurrency },
    }));
    const concurrent = await Promise.allSettled(
      candidates.map((candidate, index) =>
        service.applyConfiguration(`concurrent-${String(index)}`, {
          canonicalConfig: canonicalConfigJson(candidate),
          digest: canonicalConfigHash(candidate),
          expectedRevision: second.revision,
          expectedDigest: second.digest,
        }),
      ),
    );
    expect(
      concurrent.filter((entry) => entry.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      concurrent.filter((entry) => entry.status === 'rejected'),
    ).toHaveLength(1);
    expect(
      concurrent.find((entry) => entry.status === 'rejected'),
    ).toMatchObject({
      reason: { code: 'configuration_stale', status: 409 },
    });
    const revisions = await repository.listConfigRevisions(
      persistenceId('project', first.projectId),
      { limit: 100 },
    );
    expect(revisions).toHaveLength(3);
    expect(new Set(revisions.map((entry) => entry.id))).toHaveProperty(
      'size',
      3,
    );
  });

  it('allows only one concurrent first configuration apply', async () => {
    const repository = new InMemoryDomainRepository();
    const service = createService(repository);
    const firstConfig = loadAgentOsConfig(`
version: 1
project: { name: First Project }
models: { standard: { provider: local, model: test } }
agents: { implementer: { model: standard } }
environments: { default: { runtime: process } }
pipelines: { feature: { steps: [{ id: implement, agent: implementer }] } }
policies: {}
budgets: { workflowMicrodollars: 1, dailyMicrodollars: 2, concurrency: 1 }
goals: { maxSteps: 2, maxRetries: 1, timeoutMs: 1000 }
runtime: { provider: local }
`);
    const secondConfig = {
      ...firstConfig,
      project: { ...firstConfig.project, name: 'Second Project' },
    };
    const applied = await Promise.allSettled(
      [firstConfig, secondConfig].map((entry, index) =>
        service.applyConfiguration(`first-${String(index)}`, {
          canonicalConfig: canonicalConfigJson(entry),
          digest: canonicalConfigHash(entry),
          expectedRevision: null,
          expectedDigest: null,
        }),
      ),
    );

    expect(
      applied.filter((entry) => entry.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(applied.find((entry) => entry.status === 'rejected')).toMatchObject({
      reason: { code: 'configuration_stale', status: 409 },
    });
    await expect(repository.listProjects()).resolves.toHaveLength(1);
  });

  it('creates a feature idempotently across service restarts', async () => {
    const repository = new InMemoryDomainRepository();
    await repository.createProject({
      id: persistenceId('project', 'project-1'),
      name: 'Passerine',
      createdAt: now,
      updatedAt: now,
    });

    const first = await createService(repository).createFeatureRun(
      'feature-key',
      feature,
    );
    const replay = await createService(repository).createFeatureRun(
      'feature-key',
      feature,
    );

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      pipeline: 'feature',
      repositorySha: 'a'.repeat(40),
    });
  });

  it('rejects reuse of an idempotency key with another payload', async () => {
    const repository = new InMemoryDomainRepository();
    await repository.createProject({
      id: persistenceId('project', 'project-1'),
      name: 'Passerine',
      createdAt: now,
      updatedAt: now,
    });
    const service = createService(repository);
    await service.createFeatureRun('same-key', feature);

    await expect(
      service.createFeatureRun('same-key', { ...feature, title: 'Different' }),
    ).rejects.toBeInstanceOf(ServiceError);
  });

  it('binds goals to one snapshot and deterministic immutable criteria before dispatch', async () => {
    const repository = new InMemoryDomainRepository();
    const requestStart = vi.fn(async ({ runId }: { runId: string }) => {
      await expect(
        repository.listConfigSnapshots(persistenceId('run', runId)),
      ).resolves.toHaveLength(1);
      await expect(
        repository.listGoalCriteria(persistenceId('run', runId)),
      ).resolves.toHaveLength(2);
    });
    const service = new ControlPlaneService(
      repository,
      () => now,
      ids,
      {
        requestStart,
        requestApprovalResume: vi.fn(),
      },
      { resolve: vi.fn(async () => 'a'.repeat(40)) },
    );
    const applied = await applyGoalConfiguration(service, 'goal-config');
    const input = {
      projectId: applied.projectId,
      title: 'Finish the bounded goal',
      description: 'Run trusted checks after each feature attempt.',
      ...applied.provenance,
      criteria: goalCriteria,
    };

    const created = await service.createGoalRun('goal-key', input);
    const runId = persistenceId('run', created.id);
    const raw = await repository.getRun(runId);
    const snapshots = await repository.listConfigSnapshots(runId);
    const persistedCriteria = await repository.listGoalCriteria(runId);

    expect(raw).toMatchObject({
      pipeline: 'goal',
      configRevisionId: expect.any(String),
      input: { criteria: goalCriteria },
    });
    expect(snapshots).toHaveLength(1);
    expect(persistedCriteria.map((criterion) => criterion.definition)).toEqual(
      goalCriteria,
    );
    expect(
      new Set(persistedCriteria.map((criterion) => criterion.id)),
    ).toHaveProperty('size', 2);
    expect(requestStart).toHaveBeenCalledWith({
      idempotencyKey: `workflow-start:${created.id}`,
      runId: created.id,
    });

    await expect(service.createGoalRun('goal-key', input)).resolves.toEqual(
      created,
    );
    await expect(repository.listConfigSnapshots(runId)).resolves.toHaveLength(
      1,
    );
    await expect(repository.listGoalCriteria(runId)).resolves.toEqual(
      persistedCriteria,
    );
  });

  it('uses one immutable goal request snapshot across asynchronous persistence', async () => {
    const repository = new InMemoryDomainRepository();
    const service = createService(repository);
    const applied = await applyGoalConfiguration(service, 'immutable-input');
    const originalCriteria = goalCriteria.map((criterion) => ({
      ...criterion,
    }));
    const input = {
      projectId: applied.projectId,
      title: 'Immutable goal input',
      description: 'Caller mutation must not split persisted records.',
      ...applied.provenance,
      criteria: originalCriteria.map((criterion) => ({ ...criterion })),
    };
    const listConfigRevisions = repository.listConfigRevisions.bind(repository);
    let mutated = false;
    vi.spyOn(repository, 'listConfigRevisions').mockImplementation(
      async (...arguments_) => {
        const revisions = await listConfigRevisions(...arguments_);
        if (!mutated) {
          mutated = true;
          input.projectId = 'mutated-project';
          input.configDigest = 'mutated-config';
          input.criteria[0]!.command = 'pnpm compromised';
        }
        return revisions;
      },
    );

    const created = await service.createGoalRun('immutable-input', input);
    const runId = persistenceId('run', created.id);

    await expect(repository.getRun(runId)).resolves.toMatchObject({
      projectId: persistenceId('project', applied.projectId),
      input: { criteria: originalCriteria },
    });
    await expect(repository.listGoalCriteria(runId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ definition: originalCriteria[0] }),
      ]),
    );
  });

  it('rejects goal provenance that does not match an applied revision', async () => {
    const repository = new InMemoryDomainRepository();
    const requestStart = vi.fn();
    const service = new ControlPlaneService(
      repository,
      () => now,
      ids,
      {
        requestStart,
        requestApprovalResume: vi.fn(),
      },
      { resolve: vi.fn(async () => 'a'.repeat(40)) },
    );
    const applied = await applyGoalConfiguration(service, 'mismatch-config');

    await expect(
      service.createGoalRun('mismatched-goal', {
        projectId: applied.projectId,
        title: 'Mismatched goal',
        description: 'This must not start.',
        ...applied.provenance,
        repositorySha: 'f'.repeat(40),
        criteria: goalCriteria,
      }),
    ).rejects.toMatchObject({
      code: 'config_snapshot_required',
      status: 409,
    });
    expect(requestStart).not.toHaveBeenCalled();
  });

  it('finds exact goal provenance beyond the first revision page', async () => {
    const repository = new InMemoryDomainRepository();
    const projectId = persistenceId('project', 'many-goal-revisions');
    await repository.createProject({
      id: projectId,
      name: 'Many goal revisions',
      createdAt: now,
      updatedAt: now,
    });
    for (let revision = 1; revision <= 101; revision += 1) {
      await repository.createConfigRevision({
        id: persistenceId(
          'configRevision',
          `goal-revision-${String(revision)}`,
        ),
        projectId,
        revision,
        config: null,
        configDigest: `config-${String(revision)}`,
        modelDigest: 'model',
        promptDigest: 'prompt',
        environmentDigest: 'environment',
        policyDigest: 'policy',
        repositorySha: 'a'.repeat(40),
        createdAt: now,
      });
    }

    await expect(
      createService(repository).createGoalRun('deep-revision-goal', {
        projectId,
        title: 'Use revision 101',
        description: 'Provenance lookup must paginate.',
        repositorySha: 'a'.repeat(40),
        configDigest: 'config-101',
        modelDigest: 'model',
        promptDigest: 'prompt',
        environmentDigest: 'environment',
        policyDigest: 'policy',
        criteria: goalCriteria,
      }),
    ).resolves.toMatchObject({ pipeline: 'goal' });
  });

  it('does not dispatch a goal until every deterministic criterion is durable', async () => {
    const repository = new InMemoryDomainRepository();
    const requestStart = vi.fn();
    const service = new ControlPlaneService(
      repository,
      () => now,
      ids,
      {
        requestStart,
        requestApprovalResume: vi.fn(),
      },
      { resolve: vi.fn(async () => 'a'.repeat(40)) },
    );
    const applied = await applyGoalConfiguration(service, 'partial-config');
    const original =
      repository.createGoalCriterionIdempotently.bind(repository);
    vi.spyOn(repository, 'createGoalCriterionIdempotently').mockImplementation(
      async (criterion) => {
        if (criterion.ordinal === 1)
          throw new Error('injected criterion failure');
        return original(criterion);
      },
    );

    await expect(
      service.createGoalRun('partial-goal', {
        projectId: applied.projectId,
        title: 'Partially persisted goal',
        description: 'Dispatch waits for all records.',
        ...applied.provenance,
        criteria: goalCriteria,
      }),
    ).rejects.toThrow('injected criterion failure');
    expect(requestStart).not.toHaveBeenCalled();
  });

  it('redacts secrets and hidden reasoning from run projections', async () => {
    const repository = new InMemoryDomainRepository();
    await repository.createProject({
      id: persistenceId('project', 'project-1'),
      name: 'Passerine',
      createdAt: now,
      updatedAt: now,
    });
    await repository.createRun({
      id: persistenceId('run', 'run-secret'),
      projectId: persistenceId('project', 'project-1'),
      pipeline: 'feature',
      status: 'failed',
      input: {
        apiToken: 's3cr3t-value',
        title: 'Visible',
        chainOfThought: 'hidden',
      },
      error: { message: 'safe', stack: 'private stack' },
      createdAt: now,
      updatedAt: now,
    });

    const projection = await createService(repository).getRun('run-secret');
    expect(JSON.stringify(projection)).not.toContain('s3cr3t-value');
    expect(JSON.stringify(projection)).not.toContain('hidden');
    expect(JSON.stringify(projection)).not.toContain('private stack');
    expect(JSON.stringify(projection)).toContain('Visible');
  });

  it('uses allowlisted projection DTOs and redacts secret-bearing values', async () => {
    const repository = new InMemoryDomainRepository();
    await repository.createProject({
      id: persistenceId('project', 'project-1'),
      name: 'Passerine',
      createdAt: now,
      updatedAt: now,
    });
    const runId = persistenceId('run', 'run-value-secrets');
    await repository.createRun({
      id: runId,
      projectId: persistenceId('project', 'project-1'),
      pipeline: 'feature',
      status: 'failed',
      input: {
        title: 'Deploy with Bearer eyJhbGciOiJIUzI1Ni.secret.signature',
        description:
          'credential https://operator:super-secret@example.com and api_key=sk-abcdefghijklmnop123456',
        providerRequest: { arbitrary: 'must never escape' },
      },
      output: {
        providerPayload: 'must never expose provider output',
        accessToken: 'ghp_abcdefghijklmnopqrstuvwxyz1234567890',
      },
      error: {
        code: 'provider_failure',
        message: 'GitHub token github_pat_abcdefghijklmnopqrstuvwxyz_123456',
        details: [
          'Authorization: Bearer opaque-cli-token-1234567890',
          'password=hunter2',
        ],
        raw: { response: 'must never expose raw error payload' },
      },
      createdAt: now,
      updatedAt: now,
    });
    await repository.appendEvent({
      runId,
      eventId: persistenceId('event', 'secret-event'),
      fingerprint: 'sha256:secret-event',
      type: 'provider.completed',
      payload: {
        message: 'used token ghp_abcdefghijklmnopqrstuvwxyz1234567890',
        details: ['Bearer opaque-provider-token-1234567890'],
        providerResponse: {
          arbitrary: 'must never expose event provider data',
        },
      },
      occurredAt: now,
    });

    const serialized = JSON.stringify(
      await createService(repository).getRun('run-value-secrets'),
    );
    for (const secret of [
      'eyJhbGciOiJIUzI1Ni.secret.signature',
      'super-secret',
      'sk-abcdefghijklmnop123456',
      'github_pat_',
      'ghp_',
      'opaque-cli-token',
      'opaque-provider-token',
      'hunter2',
      'must never escape',
      'must never expose provider output',
      'must never expose raw error payload',
      'must never expose event provider data',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).toContain('provider_failure');
    expect(serialized).not.toContain('"output"');
  });

  it('replays scoped approval creation after a service restart', async () => {
    const repository = new InMemoryDomainRepository();
    const runId = persistenceId('run', 'approval-run');
    await repository.createProject({
      id: persistenceId('project', 'project-1'),
      name: 'Passerine',
      createdAt: now,
      updatedAt: now,
    });
    await repository.createRun({
      id: runId,
      projectId: persistenceId('project', 'project-1'),
      pipeline: 'feature',
      status: 'waiting',
      createdAt: now,
      updatedAt: now,
    });
    const expiresAt = isoTimestamp('2026-08-18T12:00:00.000Z');
    const first = await createService(repository).createApproval(
      'approval-key',
      {
        runId,
        scope: 'merge:pull-request:42',
        expiresAt,
      },
    );
    const restarted = new ControlPlaneService(
      repository,
      () => isoTimestamp('2026-08-17T12:05:00.000Z'),
      ids,
    );

    await expect(
      restarted.createApproval('approval-key', {
        runId,
        scope: 'merge:pull-request:42',
        expiresAt,
      }),
    ).resolves.toEqual(first);
  });

  it('projects approval scope as a redacted preview and never returns raw scope', async () => {
    const repository = new InMemoryDomainRepository();
    const runId = persistenceId('run', 'approval-redaction-run');
    await repository.createProject({
      id: persistenceId('project', 'project-1'),
      name: 'Passerine',
      createdAt: now,
      updatedAt: now,
    });
    await repository.createRun({
      id: runId,
      projectId: persistenceId('project', 'project-1'),
      pipeline: 'feature',
      status: 'waiting',
      createdAt: now,
      updatedAt: now,
    });
    const rawScope =
      'Deploy {"token":"plain-json-secret"} Authorization: Basic dXNlcjpwYXNz ghp_abcdefghijklmnopqrstuvwxyz1234567890';

    const projected = await createService(repository).createApproval(
      'redacted-approval-key',
      {
        runId,
        scope: rawScope,
        expiresAt: isoTimestamp('2026-08-18T12:00:00.000Z'),
      },
    );
    const listed = await createService(repository).listPendingApprovals();
    const serialized = JSON.stringify([projected, listed]);

    expect(projected).toMatchObject({
      scopeHash: expect.any(String),
      scopePreview: expect.stringContaining('[REDACTED]'),
    });
    expect(projected).not.toHaveProperty('scope');
    expect(projected).not.toHaveProperty('fingerprint');
    expect(serialized).not.toContain('plain-json-secret');
    expect(serialized).not.toContain('dXNlcjpwYXNz');
    expect(serialized).not.toContain('ghp_');
  });

  it('records a rejected approval as a sanitized domain event', async () => {
    const repository = new InMemoryDomainRepository();
    const runId = persistenceId('run', 'rejected-run');
    await repository.createProject({
      id: persistenceId('project', 'project-1'),
      name: 'Passerine',
      createdAt: now,
      updatedAt: now,
    });
    await repository.createRun({
      id: runId,
      projectId: persistenceId('project', 'project-1'),
      pipeline: 'feature',
      status: 'waiting',
      createdAt: now,
      updatedAt: now,
    });
    await repository.createApproval({
      id: persistenceId('approval', 'reject-me'),
      runId,
      scope: 'merge:42',
      fingerprint: 'scope-hash',
      status: 'pending',
      createdAt: now,
      expiresAt: isoTimestamp('2026-08-18T12:00:00.000Z'),
    });

    await createService(repository).consumeApproval(
      'reject-me',
      'reject',
      'decision-key',
    );

    const events = await repository.listEvents(runId);
    expect(events[0]?.type).toBe('approval.rejected');
  });

  it('replays an approval decision after restart beyond 1,000 prior events', async () => {
    const repository = new InMemoryDomainRepository();
    const runId = persistenceId('run', 'deep-event-run');
    await repository.createProject({
      id: persistenceId('project', 'project-1'),
      name: 'Passerine',
      createdAt: now,
      updatedAt: now,
    });
    await repository.createRun({
      id: runId,
      projectId: persistenceId('project', 'project-1'),
      pipeline: 'feature',
      status: 'waiting',
      createdAt: now,
      updatedAt: now,
    });
    for (let index = 0; index < 1_001; index += 1) {
      await repository.appendEvent({
        runId,
        eventId: persistenceId('event', `prior-${String(index)}`),
        fingerprint: `prior-${String(index)}`,
        type: 'run.updated',
        occurredAt: now,
      });
    }
    await repository.createApproval({
      id: persistenceId('approval', 'deep-approval'),
      runId,
      scope: 'merge:42',
      fingerprint: 'deep-scope-hash',
      status: 'pending',
      createdAt: now,
      expiresAt: isoTimestamp('2026-08-18T12:00:00.000Z'),
    });

    const first = await createService(repository).consumeApproval(
      'deep-approval',
      'approve',
      'deep-decision-key',
    );
    const replay = await createService(repository).consumeApproval(
      'deep-approval',
      'approve',
      'deep-decision-key',
    );

    expect(replay).toEqual(first);
    await expect(
      repository.getEvent(
        runId,
        ids('event', `event:${runId}:approval:deep-decision-key`) as never,
      ),
    ).resolves.toMatchObject({ sequence: 1_002 });
  });

  it('rejects a reused inbox idempotency key before mutating another item', async () => {
    const repository = new InMemoryDomainRepository();
    const runId = persistenceId('run', 'inbox-run');
    await repository.createProject({
      id: persistenceId('project', 'project-1'),
      name: 'Passerine',
      createdAt: now,
      updatedAt: now,
    });
    await repository.createRun({
      id: runId,
      projectId: persistenceId('project', 'project-1'),
      pipeline: 'feature',
      status: 'waiting',
      createdAt: now,
      updatedAt: now,
    });
    for (const id of ['question-1', 'question-2']) {
      await repository.createInboxMessage({
        id: persistenceId('inboxMessage', id),
        runId,
        status: 'pending',
        body: { question: id },
        createdAt: now,
      });
    }
    const service = createService(repository);
    await service.replyInbox('question-1', 'first', 'reply-key');

    await expect(
      service.replyInbox('question-2', 'second', 'reply-key'),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(
      repository.getInboxMessage(persistenceId('inboxMessage', 'question-2')),
    ).resolves.toMatchObject({ status: 'pending' });
  });

  it('does not record a second approval decision under another key', async () => {
    const repository = new InMemoryDomainRepository();
    const runId = persistenceId('run', 'single-decision-run');
    await repository.createProject({
      id: persistenceId('project', 'project-1'),
      name: 'Passerine',
      createdAt: now,
      updatedAt: now,
    });
    await repository.createRun({
      id: runId,
      projectId: persistenceId('project', 'project-1'),
      pipeline: 'feature',
      status: 'waiting',
      createdAt: now,
      updatedAt: now,
    });
    await repository.createApproval({
      id: persistenceId('approval', 'single-decision'),
      runId,
      scope: 'merge:42',
      fingerprint: 'scope-hash',
      status: 'pending',
      createdAt: now,
      expiresAt: isoTimestamp('2026-08-18T12:00:00.000Z'),
    });
    const service = createService(repository);
    await service.consumeApproval('single-decision', 'approve', 'approve-key');

    await expect(
      service.consumeApproval('single-decision', 'reject', 'reject-key'),
    ).rejects.toMatchObject({ code: 'approval_already_decided' });
    await expect(repository.listEvents(runId)).resolves.toHaveLength(1);
  });

  it('rejects an approval decision when the supplied scope hash is stale', async () => {
    const repository = new InMemoryDomainRepository();
    const runId = persistenceId('run', 'stale-scope-run');
    await repository.createProject({
      id: persistenceId('project', 'project-1'),
      name: 'Passerine',
      createdAt: now,
      updatedAt: now,
    });
    await repository.createRun({
      id: runId,
      projectId: persistenceId('project', 'project-1'),
      pipeline: 'feature',
      status: 'waiting',
      createdAt: now,
      updatedAt: now,
    });
    await repository.createApproval({
      id: persistenceId('approval', 'stale-scope'),
      runId,
      scope: 'merge:42',
      fingerprint: 'current-scope-hash',
      status: 'pending',
      createdAt: now,
      expiresAt: isoTimestamp('2026-08-18T12:00:00.000Z'),
    });

    await expect(
      createService(repository).consumeApproval(
        'stale-scope',
        'approve',
        'decision-key',
        'stale-scope-hash',
      ),
    ).rejects.toMatchObject({ code: 'approval_scope_mismatch', status: 409 });
    await expect(
      repository.getApproval(persistenceId('approval', 'stale-scope')),
    ).resolves.toMatchObject({ status: 'pending' });
  });
});
