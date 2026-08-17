import { createHash } from 'node:crypto';

import { InMemoryDomainRepository } from '../persistence/in-memory.js';
import { createInMemoryArtifactStorage } from '../artifacts/in-memory.js';
import {
  isoTimestamp,
  persistenceId,
  canonicalJsonValue,
  type ArtifactStore,
  type RuntimeAgent,
  type RuntimeEnvironment,
  type RuntimeHandle,
  type RuntimeOutput,
  type RuntimeProvider,
  type RuntimeEvent,
} from '@agentos/core';
import { describe, expect, it, vi } from 'vitest';

import {
  InMemoryWorkflowCheckpointStore,
  FeatureWorkflowTaskTransientError,
  WorkflowTransientError,
  createDurableFeatureWorkflow,
  type FeatureWorkflowRoles,
  type WorkflowApprovalWaiter,
} from './index.js';

const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const workflowHash = (value: unknown) =>
  createHash('sha256')
    .update(canonicalJsonValue(JSON.parse(JSON.stringify(value))))
    .digest('hex');
const now = isoTimestamp('2026-08-17T12:00:00.000Z');

class FakeRuntime implements RuntimeProvider {
  readonly starts: { request: unknown; handle: RuntimeHandle }[] = [];
  readonly cancelled: RuntimeHandle[] = [];
  readonly cleaned: RuntimeHandle[] = [];
  readonly agents: RuntimeAgent[] = [];
  readonly environments: RuntimeEnvironment[] = [];
  #outputs: RuntimeOutput[];
  reconciled: RuntimeHandle | undefined;

  constructor(outputs: RuntimeOutput[]) {
    this.#outputs = [...outputs];
  }
  async syncAgent(agent: RuntimeAgent) {
    this.agents.push(agent);
  }
  async syncEnvironment(environment: RuntimeEnvironment) {
    this.environments.push(environment);
  }
  async start(request: unknown) {
    const handle = { id: `session-${String(this.starts.length + 1)}` };
    this.starts.push({ request, handle });
    return handle;
  }
  async reconcileStart() {
    return this.reconciled;
  }
  async *events(): AsyncGenerator<RuntimeEvent> {
    yield {
      id: 'event-1',
      type: 'idle',
      occurredAt: new Date(now),
    };
  }
  async send() {}
  async resume() {}
  async cancel(handle: RuntimeHandle) {
    this.cancelled.push(handle);
  }
  async collectOutput() {
    const value = this.#outputs.shift();
    if (value === undefined) throw new Error('missing fake output');
    return value;
  }
  async usage() {
    return { inputTokens: 10, outputTokens: 5, runtimeMs: 100 };
  }
  async cleanup(handle: RuntimeHandle) {
    this.cleaned.push(handle);
  }
  async observeCommand(_handle: RuntimeHandle, expectedCommand: string) {
    return {
      command: expectedCommand,
      exitCode: 0,
      startedAt: now,
      completedAt: now,
    };
  }
}

const roles: FeatureWorkflowRoles = {
  specification: {
    agent: {
      id: 'spec-agent',
      model: 'sonnet',
      tools: [],
      mcps: ['artifacts'],
    },
    environment: {
      id: 'spec-env',
      runtime: 'managed',
      variables: { ARTIFACT_CAPABILITY: 'scoped' },
    },
  },
  planning: {
    agent: {
      id: 'plan-agent',
      model: 'sonnet',
      tools: [],
      mcps: ['artifacts'],
    },
    environment: {
      id: 'plan-env',
      runtime: 'managed',
      variables: { ARTIFACT_CAPABILITY: 'scoped' },
    },
  },
  implementation: {
    agent: {
      id: 'implement-agent',
      model: 'sonnet',
      tools: [],
      mcps: ['artifacts'],
    },
    environment: {
      id: 'implement-env',
      runtime: 'managed',
      variables: { ARTIFACT_CAPABILITY: 'scoped' },
    },
  },
  review: {
    agent: {
      id: 'review-agent',
      model: 'sonnet',
      tools: [],
      mcps: ['artifacts'],
    },
    environment: {
      id: 'review-env',
      runtime: 'managed',
      variables: { ARTIFACT_CAPABILITY: 'scoped' },
    },
  },
  verification: {
    agent: {
      id: 'verify-agent',
      model: 'sonnet',
      tools: ['bash'],
      mcps: [],
    },
    environment: {
      id: 'verify-env',
      runtime: 'managed',
      variables: {},
    },
  },
};

async function put(
  store: ArtifactStore,
  stepId: string,
  artifactId: string,
  body: string,
) {
  return store.put({
    scope: { projectId: 'project-1', runId: 'run-1', stepId },
    artifactId,
    version: 1,
    bytes: new TextEncoder().encode(body),
    mediaType: 'application/json',
  });
}

async function fixture(decision: 'approve' | 'reject' = 'approve') {
  const repository = new InMemoryDomainRepository();
  await repository.createProject({
    id: persistenceId('project', 'project-1'),
    name: 'Passerine',
    createdAt: now,
    updatedAt: now,
  });
  await repository.createRunIdempotently(
    {
      id: persistenceId('run', 'run-1'),
      projectId: persistenceId('project', 'project-1'),
      pipeline: 'feature',
      status: 'pending',
      input: { title: 'Add a status endpoint' },
      createdAt: now,
      updatedAt: now,
    },
    digest('run-input'),
  );
  const artifacts = createInMemoryArtifactStorage().store;
  const specification = JSON.stringify({
    version: 'feature-spec-v1',
    title: 'Status endpoint',
    requirements: ['GET /status returns a bounded response'],
  });
  const dod = JSON.stringify({
    version: 'definition-of-done-v1',
    criteria: [
      {
        id: 'status-test',
        description: 'Status route test passes',
        verifier: 'test-report',
      },
    ],
  });
  const plan = JSON.stringify({
    version: 'implementation-plan-v1',
    steps: ['Add route', 'Add test'],
  });
  const changes = JSON.stringify({
    version: 'change-set-v1',
    changes: [
      {
        operation: 'add',
        path: 'src/status.ts',
        mode: '100644',
        content: 'export const status = () => ({ ok: true });\n',
      },
    ],
  });
  const tests = JSON.stringify({
    version: 'test-evidence-v1',
    passed: true,
    command: 'pnpm test',
    exitCode: 0,
  });
  const review = JSON.stringify({
    version: 'review-result-v1',
    decision: 'approved',
    findings: [],
  });
  const specMeta = await put(
    artifacts,
    'specification',
    'specification',
    specification,
  );
  const dodMeta = await put(artifacts, 'specification', 'dod', dod);
  const planMeta = await put(artifacts, 'planning', 'plan', plan);
  const changeMeta = await put(artifacts, 'implementation', 'changes', changes);
  const testMeta = await put(artifacts, 'implementation', 'tests', tests);
  const reviewMeta = await put(artifacts, 'review', 'review', review);
  const verificationMeta = await put(
    artifacts,
    'verification',
    'trusted-test-report',
    JSON.stringify({ version: 'trusted-test-report-v1' }),
  );
  const runtime = new FakeRuntime([
    {
      artifacts: [],
      data: {
        version: 'specification-output-v1',
        specification: specMeta,
        definitionOfDone: dodMeta,
      },
    },
    { artifacts: [], data: { version: 'plan-output-v1', plan: planMeta } },
    {
      artifacts: [],
      data: {
        version: 'implementation-output-v1',
        changeSet: changeMeta,
        testEvidence: testMeta,
      },
    },
    {
      artifacts: [],
      data: {
        version: 'review-output-v1',
        review: reviewMeta,
        decision: 'approved',
      },
    },
    { artifacts: [], data: {} },
  ]);
  const waitpointCreates: unknown[] = [];
  const waiter: WorkflowApprovalWaiter = {
    async create(request) {
      waitpointCreates.push(request);
      return { id: 'waitpoint-safe-ref' };
    },
    async wait() {
      const approvals = await repository.listApprovals(
        persistenceId('run', 'run-1'),
      );
      const approval = approvals[0]!;
      await repository.consumeApprovalWithEvent(
        {
          approvalId: approval.id,
          runId: approval.runId,
          scope: approval.scope,
          fingerprint: approval.fingerprint,
          consumedAt: now,
        },
        {
          runId: approval.runId,
          eventId: persistenceId('event', `decision-${decision}`),
          fingerprint: digest(`decision-${decision}`),
          type:
            decision === 'approve' ? 'approval.approved' : 'approval.rejected',
          payload: { approvalId: approval.id, scopeHash: approval.fingerprint },
          occurredAt: now,
        },
      );
      return { status: 'completed' };
    },
  };
  return {
    repository,
    artifacts,
    runtime,
    waiter,
    waitpointCreates,
    verificationMeta,
  };
}

const input = {
  version: 'feature-workflow-input-v1' as const,
  runId: 'run-1',
  projectId: 'project-1',
  feature: { title: 'Add a status endpoint', description: 'Implement it.' },
  source: {
    repositorySha: 'a'.repeat(40),
    sourceSnapshotDigest: digest('source'),
  },
  digests: {
    config: digest('config'),
    model: digest('model'),
    prompt: digest('prompt'),
    environment: digest('environment'),
    policy: digest('policy'),
  },
};

describe('durable feature workflow', () => {
  it('surfaces a busy global session as a Trigger-retryable error without failing the run', async () => {
    const f = await fixture();
    const checkpoints = new InMemoryWorkflowCheckpointStore();
    await checkpoints.admitSession({
      reservationKey: 'reservation:other-run:implementation',
      projectId: 'project-1',
      runId: 'other-run',
      stepKey: 'implementation',
      estimatedMicrodollars: 100_000,
      workflowSpentMicrodollars: 0,
      dailySpentMicrodollars: 0,
      workflowLimitMicrodollars: 2_000_000,
      dailyLimitMicrodollars: 5_000_000,
      admissionNumerator: 80,
      admissionDenominator: 100,
      now,
      leaseExpiresAt: '2026-08-17T12:21:00.000Z',
    });
    const workflow = createDurableFeatureWorkflow({
      repository: f.repository,
      checkpoints,
      artifacts: f.artifacts,
      runtime: f.runtime,
      approval: f.waiter,
      roles,
      clock: () => now,
      priceUsage: () => 100,
      resolveTestCommand: () => 'pnpm test',
      verifier: {
        verify: async () => ({
          passed: true,
          evidenceDigest: f.verificationMeta.digest,
          evidenceArtifact: f.verificationMeta,
        }),
      },
      publicationAuthority: { authorize: async () => ({}) },
      publisher: {
        publish: async () => ({
          status: 'succeeded',
          draft: true,
          pullRequestUrl: 'https://github.test/pr/1',
        }),
      },
    });
    await expect(workflow.run(input)).rejects.toBeInstanceOf(
      FeatureWorkflowTaskTransientError,
    );
    await expect(
      f.repository.getRun(persistenceId('run', 'run-1')),
    ).resolves.toMatchObject({ status: 'running' });
    expect(f.runtime.starts).toHaveLength(0);
  });

  it('replays a terminal failed run without starting or publishing anything', async () => {
    const f = await fixture();
    await f.repository.transitionRun(
      persistenceId('run', 'run-1'),
      ['pending'],
      {
        status: 'failed',
        output: { status: 'failed', reason: 'prior_failure' },
        updatedAt: now,
        completedAt: now,
      },
    );
    const publish = vi.fn();
    const result = await createDurableFeatureWorkflow({
      repository: f.repository,
      checkpoints: new InMemoryWorkflowCheckpointStore(),
      artifacts: f.artifacts,
      runtime: f.runtime,
      approval: f.waiter,
      roles,
      clock: () => now,
      priceUsage: () => 100,
      resolveTestCommand: () => 'pnpm test',
      verifier: {
        verify: async () => ({
          passed: true,
          evidenceDigest: f.verificationMeta.digest,
          evidenceArtifact: f.verificationMeta,
        }),
      },
      publicationAuthority: { authorize: async () => ({}) },
      publisher: { publish },
    }).run(input);
    expect(result).toEqual({ status: 'failed', reason: 'prior_failure' });
    expect(f.runtime.starts).toHaveLength(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it('runs separate least-privilege role sessions through trusted draft publication', async () => {
    const f = await fixture();
    const published: unknown[] = [];
    const accessRequests: Array<{
      logicalStepId: string;
      stepId: string;
      stepInput: unknown;
    }> = [];
    const workflow = createDurableFeatureWorkflow({
      repository: f.repository,
      checkpoints: new InMemoryWorkflowCheckpointStore(),
      artifacts: f.artifacts,
      runtime: f.runtime,
      runtimeAccess: {
        prepare: async (request) => {
          accessRequests.push(request);
          return { resources: [], credentialRefs: [] };
        },
      },
      approval: f.waiter,
      roles,
      clock: () => now,
      priceUsage: () => 100,
      resolveTestCommand: () => 'pnpm test',
      verifier: {
        verify: async () => ({
          passed: true,
          evidenceDigest: f.verificationMeta.digest,
          evidenceArtifact: f.verificationMeta,
        }),
      },
      publicationAuthority: {
        authorize: async (request) => ({ authorized: request }),
      },
      publisher: {
        publish: async (request) => {
          published.push(request);
          return {
            status: 'succeeded',
            draft: true,
            pullRequestUrl: 'https://github.test/pr/1',
          };
        },
      },
    });

    await expect(workflow.run(input)).resolves.toMatchObject({
      status: 'succeeded',
      draftPullRequestUrl: 'https://github.test/pr/1',
    });
    expect(f.runtime.starts.map(({ request }) => request)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: 'spec-agent',
          environmentId: 'spec-env',
        }),
        expect.objectContaining({
          agentId: 'plan-agent',
          environmentId: 'plan-env',
        }),
        expect.objectContaining({
          agentId: 'implement-agent',
          environmentId: 'implement-env',
        }),
        expect.objectContaining({
          agentId: 'review-agent',
          environmentId: 'review-env',
        }),
        expect.objectContaining({
          agentId: 'verify-agent',
          environmentId: 'verify-env',
        }),
      ]),
    );
    expect(new Set(f.runtime.starts.map(({ handle }) => handle.id)).size).toBe(
      5,
    );
    expect(JSON.stringify(f.runtime.starts)).not.toMatch(
      /github|private.?key|installation.?token/i,
    );
    expect(published).toHaveLength(1);
    expect(f.waitpointCreates).toEqual([
      expect.objectContaining({ timeout: '3600s' }),
    ]);
    expect(f.runtime.cleaned).toHaveLength(5);
    expect(accessRequests.map((request) => request.logicalStepId)).toEqual([
      'specification',
      'planning',
      'implementation',
      'review',
      'verification',
    ]);
    expect(accessRequests[1]?.stepId).toMatch(/^run-1:planning:1$/);
    expect(accessRequests[1]?.stepInput).toMatchObject({
      specificationArtifact: { stepId: 'specification' },
      definitionOfDoneArtifact: { stepId: 'specification' },
    });
    expect(accessRequests[2]?.stepInput).toMatchObject({
      planArtifact: { stepId: 'planning' },
    });
    expect(accessRequests[3]?.stepInput).toMatchObject({
      changeSetArtifact: { stepId: 'implementation' },
      testEvidenceArtifact: { stepId: 'implementation' },
      definitionOfDoneArtifact: { stepId: 'specification' },
    });
  });

  it('stops after authoritative rejection even when the waitpoint wakes', async () => {
    const f = await fixture('reject');
    const workflow = createDurableFeatureWorkflow({
      repository: f.repository,
      checkpoints: new InMemoryWorkflowCheckpointStore(),
      artifacts: f.artifacts,
      runtime: f.runtime,
      approval: f.waiter,
      roles,
      clock: () => now,
      priceUsage: () => 100,
      resolveTestCommand: () => 'pnpm test',
      verifier: {
        verify: async () => ({
          passed: true,
          evidenceDigest: f.verificationMeta.digest,
          evidenceArtifact: f.verificationMeta,
        }),
      },
      publicationAuthority: { authorize: async () => ({}) },
      publisher: {
        publish: async () => {
          throw new Error('must not publish');
        },
      },
    });
    await expect(workflow.run(input)).resolves.toMatchObject({
      status: 'rejected',
    });
    expect(f.runtime.starts).toHaveLength(1);
  });

  it('terminates when the approval waitpoint expires', async () => {
    const f = await fixture();
    f.waiter.wait = async () => ({ status: 'timed_out' as const });
    const result = await createDurableFeatureWorkflow({
      repository: f.repository,
      checkpoints: new InMemoryWorkflowCheckpointStore(),
      artifacts: f.artifacts,
      runtime: f.runtime,
      approval: f.waiter,
      roles,
      clock: () => now,
      priceUsage: () => 100,
      resolveTestCommand: () => 'pnpm test',
      verifier: {
        verify: async () => ({
          passed: true,
          evidenceDigest: f.verificationMeta.digest,
          evidenceArtifact: f.verificationMeta,
        }),
      },
      publicationAuthority: { authorize: async () => ({}) },
      publisher: {
        publish: async () => ({
          status: 'succeeded',
          draft: true,
          pullRequestUrl: 'https://github.test/pr/ambiguous',
        }),
      },
    }).run(input);
    expect(result.status).toBe('expired');
    await expect(
      f.repository.listApprovals(persistenceId('run', 'run-1')),
    ).resolves.toEqual([expect.objectContaining({ status: 'expired' })]);
    expect(f.runtime.starts).toHaveLength(1);
  });

  it('replays completed steps and publication without duplicating external effects', async () => {
    const f = await fixture();
    const checkpoints = new InMemoryWorkflowCheckpointStore();
    let publishCalls = 0;
    const dependencies = {
      repository: f.repository,
      checkpoints,
      artifacts: f.artifacts,
      runtime: f.runtime,
      approval: f.waiter,
      roles,
      clock: () => now,
      priceUsage: () => 100,
      resolveTestCommand: () => 'pnpm test',
      verifier: {
        verify: async () => ({
          passed: true,
          evidenceDigest: f.verificationMeta.digest,
          evidenceArtifact: f.verificationMeta,
        }),
      },
      publicationAuthority: { authorize: async () => ({}) },
      publisher: {
        publish: async () => {
          publishCalls += 1;
          return {
            status: 'succeeded' as const,
            draft: true as const,
            pullRequestUrl: 'https://github.test/pr/1',
          };
        },
      },
    };
    const workflow = createDurableFeatureWorkflow(dependencies);
    const first = await workflow.run(input);
    const second = await createDurableFeatureWorkflow(dependencies).run(input);
    expect(second).toEqual(first);
    expect(f.runtime.starts).toHaveLength(5);
    expect(publishCalls).toBe(1);
  });

  it('classifies one transient runtime failure and retries it once', async () => {
    const f = await fixture();
    const originalStart = f.runtime.start.bind(f.runtime);
    let attempts = 0;
    f.runtime.start = async (request: unknown) => {
      attempts += 1;
      if (attempts === 1) throw new WorkflowTransientError('temporary');
      return originalStart(request);
    };
    const result = await createDurableFeatureWorkflow({
      repository: f.repository,
      checkpoints: new InMemoryWorkflowCheckpointStore(),
      artifacts: f.artifacts,
      runtime: f.runtime,
      approval: f.waiter,
      roles,
      clock: () => now,
      priceUsage: () => 100,
      resolveTestCommand: () => 'pnpm test',
      verifier: {
        verify: async () => ({
          passed: true,
          evidenceDigest: f.verificationMeta.digest,
          evidenceArtifact: f.verificationMeta,
        }),
      },
      publicationAuthority: { authorize: async () => ({}) },
      publisher: {
        publish: async () => ({
          status: 'succeeded',
          draft: true,
          pullRequestUrl: 'https://github.test/pr/1',
        }),
      },
    }).run(input);
    expect(result.status).toBe('succeeded');
    expect(attempts).toBe(6);
  });

  it('fails closed on malformed agent output and never reaches publication', async () => {
    const f = await fixture();
    f.runtime = new FakeRuntime([
      { artifacts: [], data: { version: 'unknown' } },
    ]);
    let published = false;
    const result = await createDurableFeatureWorkflow({
      repository: f.repository,
      checkpoints: new InMemoryWorkflowCheckpointStore(),
      artifacts: f.artifacts,
      runtime: f.runtime,
      approval: f.waiter,
      roles,
      clock: () => now,
      priceUsage: () => 100,
      resolveTestCommand: () => 'pnpm test',
      verifier: {
        verify: async () => ({
          passed: true,
          evidenceDigest: f.verificationMeta.digest,
          evidenceArtifact: f.verificationMeta,
        }),
      },
      publicationAuthority: { authorize: async () => ({}) },
      publisher: {
        publish: async () => {
          published = true;
          throw new Error('unexpected');
        },
      },
    }).run(input);
    expect(result.status).toBe('failed');
    expect(published).toBe(false);
    expect(f.runtime.cancelled).toHaveLength(1);
  });

  it('stops before a new session at the 80 percent workflow budget reserve', async () => {
    const f = await fixture();
    await f.repository.appendUsage({
      idempotencyId: persistenceId('usage', 'prior-usage'),
      runId: persistenceId('run', 'run-1'),
      model: 'sonnet',
      inputTokens: 1,
      outputTokens: 1,
      runtimeMs: 1,
      microdollars: 1_600_000,
      recordedAt: now,
    });
    const result = await createDurableFeatureWorkflow({
      repository: f.repository,
      checkpoints: new InMemoryWorkflowCheckpointStore(),
      artifacts: f.artifacts,
      runtime: f.runtime,
      approval: f.waiter,
      roles,
      clock: () => now,
      priceUsage: () => 100,
      resolveTestCommand: () => 'pnpm test',
      verifier: {
        verify: async () => ({
          passed: true,
          evidenceDigest: f.verificationMeta.digest,
          evidenceArtifact: f.verificationMeta,
        }),
      },
      publicationAuthority: { authorize: async () => ({}) },
      publisher: {
        publish: async () => {
          throw new Error('unexpected');
        },
      },
    }).run(input);
    expect(result).toEqual({
      status: 'budget_exhausted',
      reason: 'workflow_budget',
    });
    expect(f.runtime.starts).toHaveLength(0);
  });

  it('settles reported usage against the hard workflow cap before continuing', async () => {
    const f = await fixture();
    let published = false;
    const result = await createDurableFeatureWorkflow({
      repository: f.repository,
      checkpoints: new InMemoryWorkflowCheckpointStore(),
      artifacts: f.artifacts,
      runtime: f.runtime,
      approval: f.waiter,
      roles,
      clock: () => now,
      priceUsage: () => 2_000_001,
      resolveTestCommand: () => 'pnpm test',
      verifier: {
        verify: async () => ({
          passed: true,
          evidenceDigest: f.verificationMeta.digest,
          evidenceArtifact: f.verificationMeta,
        }),
      },
      publicationAuthority: { authorize: async () => ({}) },
      publisher: {
        publish: async () => {
          published = true;
          throw new Error('unexpected');
        },
      },
    }).run(input);
    expect(result).toEqual({
      status: 'budget_exhausted',
      reason: 'workflow_budget',
    });
    expect(f.runtime.starts).toHaveLength(1);
    expect(published).toBe(false);
    await expect(
      f.repository.listApprovals(persistenceId('run', 'run-1')),
    ).resolves.toHaveLength(0);
  });

  it('settles reported usage against the hard rolling daily cap', async () => {
    const f = await fixture();
    const result = await createDurableFeatureWorkflow({
      repository: f.repository,
      checkpoints: new InMemoryWorkflowCheckpointStore(),
      artifacts: f.artifacts,
      runtime: f.runtime,
      approval: f.waiter,
      roles: Object.fromEntries(
        Object.entries(roles).map(([key, value]) => [
          key,
          { ...value, maxReservationMicrodollars: 100_000 },
        ]),
      ) as FeatureWorkflowRoles,
      clock: () => now,
      priceUsage: () => 1_600_001,
      resolveTestCommand: () => 'pnpm test',
      dailyUsageMicrodollars: async () => 3_500_000,
      verifier: {
        verify: async () => ({
          passed: true,
          evidenceDigest: f.verificationMeta.digest,
          evidenceArtifact: f.verificationMeta,
        }),
      },
      publicationAuthority: { authorize: async () => ({}) },
      publisher: {
        publish: async () => ({
          status: 'succeeded',
          draft: true,
          pullRequestUrl: 'https://github.test/pr/ambiguous',
        }),
      },
    }).run(input);
    expect(result).toEqual({
      status: 'budget_exhausted',
      reason: 'daily_budget',
    });
    expect(f.runtime.starts).toHaveLength(1);
  });

  it('rechecks cancellation after verification and before publishing', async () => {
    const f = await fixture();
    let published = false;
    const result = await createDurableFeatureWorkflow({
      repository: f.repository,
      checkpoints: new InMemoryWorkflowCheckpointStore(),
      artifacts: f.artifacts,
      runtime: f.runtime,
      approval: f.waiter,
      roles,
      clock: () => now,
      priceUsage: () => 100,
      resolveTestCommand: () => 'pnpm test',
      verifier: {
        verify: async () => {
          await f.repository.updateRun(persistenceId('run', 'run-1'), {
            status: 'cancelled',
            updatedAt: now,
            completedAt: now,
          });
          return {
            passed: true,
            evidenceDigest: f.verificationMeta.digest,
            evidenceArtifact: f.verificationMeta,
          };
        },
      },
      publicationAuthority: { authorize: async () => ({}) },
      publisher: {
        publish: async () => {
          published = true;
          throw new Error('unexpected');
        },
      },
    }).run(input);
    expect(result.status).toBe('cancelled');
    expect(published).toBe(false);
  });

  it('does not authorize publication when trusted verification fails', async () => {
    const f = await fixture();
    let authorized = false;
    const result = await createDurableFeatureWorkflow({
      repository: f.repository,
      checkpoints: new InMemoryWorkflowCheckpointStore(),
      artifacts: f.artifacts,
      runtime: f.runtime,
      approval: f.waiter,
      roles,
      clock: () => now,
      priceUsage: () => 100,
      resolveTestCommand: () => 'pnpm test',
      verifier: {
        verify: async () => ({
          passed: false,
          evidenceDigest: digest('denied'),
          findings: ['protected path'],
        }),
      },
      publicationAuthority: {
        authorize: async () => {
          authorized = true;
          return {};
        },
      },
      publisher: {
        publish: async () => {
          throw new Error('unexpected');
        },
      },
    }).run(input);
    expect(result.status).toBe('failed');
    expect(authorized).toBe(false);
  });

  it('records a stale-base publisher refusal as terminal failure', async () => {
    const f = await fixture();
    const result = await createDurableFeatureWorkflow({
      repository: f.repository,
      checkpoints: new InMemoryWorkflowCheckpointStore(),
      artifacts: f.artifacts,
      runtime: f.runtime,
      approval: f.waiter,
      roles,
      clock: () => now,
      priceUsage: () => 100,
      resolveTestCommand: () => 'pnpm test',
      verifier: {
        verify: async () => ({
          passed: true,
          evidenceDigest: f.verificationMeta.digest,
          evidenceArtifact: f.verificationMeta,
        }),
      },
      publicationAuthority: { authorize: async () => ({ authorized: true }) },
      publisher: {
        publish: async () => {
          throw new Error('stale base SHA');
        },
      },
    }).run(input);
    expect(result).toMatchObject({
      status: 'failed',
      reason: 'stale base SHA',
    });
  });

  it('retries a classified transient publisher failure idempotently', async () => {
    const f = await fixture();
    const checkpoints = new InMemoryWorkflowCheckpointStore();
    let calls = 0;
    const workflow = createDurableFeatureWorkflow({
      repository: f.repository,
      checkpoints,
      artifacts: f.artifacts,
      runtime: f.runtime,
      approval: f.waiter,
      roles,
      clock: () => now,
      priceUsage: () => 100,
      resolveTestCommand: () => 'pnpm test',
      verifier: {
        verify: async () => ({
          passed: true,
          evidenceDigest: f.verificationMeta.digest,
          evidenceArtifact: f.verificationMeta,
        }),
      },
      publicationAuthority: { authorize: async () => ({ authorized: true }) },
      publisher: {
        publish: async () => {
          calls += 1;
          if (calls === 1) {
            throw Object.assign(new Error('temporary GitHub outage'), {
              code: 'github_unavailable',
            });
          }
          return {
            status: 'succeeded',
            draft: true,
            pullRequestUrl: 'https://github.test/pr/retried',
          } as const;
        },
      },
    });

    await expect(workflow.run(input)).rejects.toBeInstanceOf(
      FeatureWorkflowTaskTransientError,
    );
    await expect(workflow.run(input)).resolves.toEqual({
      status: 'succeeded',
      draftPullRequestUrl: 'https://github.test/pr/retried',
    });
    expect(calls).toBe(2);
  });

  it('reconciles an ambiguous publisher call through trusted idempotent publication', async () => {
    const f = await fixture();
    const checkpoints = new InMemoryWorkflowCheckpointStore();
    const effectKey = 'publisher:run-1';
    const seeded = await checkpoints.claimEffect(
      {
        key: effectKey,
        runId: 'run-1',
        kind: 'trusted-draft-publication',
        inputFingerprint: workflowHash({ authorized: true }),
        createdAt: now,
        updatedAt: now,
      },
      {
        ownerId: 'crashed-owner',
        now: '2026-08-17T11:00:00.000Z',
        leaseExpiresAt: '2026-08-17T11:01:00.000Z',
      },
    );
    await checkpoints.markEffectStarted(
      {
        key: effectKey,
        ownerId: 'crashed-owner',
        leaseVersion: seeded.leaseVersion,
      },
      '2026-08-17T11:00:00.000Z',
    );
    let published = false;
    const result = await createDurableFeatureWorkflow({
      repository: f.repository,
      checkpoints,
      artifacts: f.artifacts,
      runtime: f.runtime,
      approval: f.waiter,
      roles,
      clock: () => now,
      priceUsage: () => 100,
      resolveTestCommand: () => 'pnpm test',
      verifier: {
        verify: async () => ({
          passed: true,
          evidenceDigest: f.verificationMeta.digest,
          evidenceArtifact: f.verificationMeta,
        }),
      },
      publicationAuthority: { authorize: async () => ({ authorized: true }) },
      publisher: {
        publish: async () => {
          published = true;
          return {
            status: 'succeeded',
            draft: true,
            pullRequestUrl: 'https://github.test/pr/1',
          };
        },
      },
    }).run(input);
    expect(result).toMatchObject({ status: 'succeeded' });
    expect(published).toBe(true);
    await expect(checkpoints.getEffect(effectKey)).resolves.toMatchObject({
      status: 'succeeded',
    });
  });

  it('reconciles an ambiguous runtime start without duplicating the paid session', async () => {
    const f = await fixture();
    const checkpoints = new InMemoryWorkflowCheckpointStore();
    const request = {
      version: 'specification-request-v1',
      feature: input.feature,
      source: input.source,
      digests: input.digests,
      outputContract: 'specification-output-v1',
    };
    const effectKey = 'runtime:run-1:specification:1';
    const seeded = await checkpoints.claimEffect(
      {
        key: effectKey,
        runId: 'run-1',
        kind: 'runtime-session',
        inputFingerprint: workflowHash({
          stepKey: 'specification',
          attempt: 1,
          inputFingerprint: workflowHash(request),
          agentId: 'spec-agent',
          environmentId: 'spec-env',
          digests: input.digests,
          repositorySha: input.source.repositorySha,
          sourceSnapshotDigest: input.source.sourceSnapshotDigest,
          execution: {
            taskVersion: 'agentos-feature-workflow-v1',
            deploymentVersion: 'test-or-unknown',
          },
        }),
        createdAt: now,
        updatedAt: now,
      },
      {
        ownerId: 'crashed-owner',
        now: '2026-08-17T11:00:00.000Z',
        leaseExpiresAt: '2026-08-17T11:01:00.000Z',
      },
    );
    await checkpoints.markEffectStarted(
      {
        key: effectKey,
        ownerId: 'crashed-owner',
        leaseVersion: seeded.leaseVersion,
      },
      '2026-08-17T11:00:00.000Z',
    );
    f.runtime.reconciled = { id: 'session-reconciled' };
    const result = await createDurableFeatureWorkflow({
      repository: f.repository,
      checkpoints,
      artifacts: f.artifacts,
      runtime: f.runtime,
      approval: f.waiter,
      roles,
      clock: () => now,
      priceUsage: () => 100,
      resolveTestCommand: () => 'pnpm test',
      verifier: {
        verify: async () => ({
          passed: true,
          evidenceDigest: f.verificationMeta.digest,
          evidenceArtifact: f.verificationMeta,
        }),
      },
      publicationAuthority: { authorize: async () => ({}) },
      publisher: {
        publish: async () => ({
          status: 'succeeded',
          draft: true,
          pullRequestUrl: 'https://github.test/pr/ambiguous',
        }),
      },
    }).run(input);
    expect(result).toMatchObject({ status: 'succeeded' });
    expect(f.runtime.starts).toHaveLength(4);
    await expect(checkpoints.getEffect(effectKey)).resolves.toMatchObject({
      status: 'succeeded',
      externalRef: 'session-reconciled',
    });
  });

  it('reconciles a timed-out runtime create response before starting another session', async () => {
    const f = await fixture();
    const originalStart = f.runtime.start.bind(f.runtime);
    let first = true;
    f.runtime.start = async (request: unknown) => {
      const handle = await originalStart(request);
      if (first) {
        first = false;
        f.runtime.reconciled = handle;
        throw Object.assign(new Error('create response timed out'), {
          code: 'ETIMEDOUT',
        });
      }
      return handle;
    };

    const result = await createDurableFeatureWorkflow({
      repository: f.repository,
      checkpoints: new InMemoryWorkflowCheckpointStore(),
      artifacts: f.artifacts,
      runtime: f.runtime,
      approval: f.waiter,
      roles,
      clock: () => now,
      priceUsage: () => 100,
      resolveTestCommand: () => 'pnpm test',
      verifier: {
        verify: async () => ({
          passed: true,
          evidenceDigest: f.verificationMeta.digest,
          evidenceArtifact: f.verificationMeta,
        }),
      },
      publicationAuthority: { authorize: async () => ({}) },
      publisher: {
        publish: async () => ({
          status: 'succeeded',
          draft: true,
          pullRequestUrl: 'https://github.test/pr/reconciled-create',
        }),
      },
    }).run(input);

    expect(result.status).toBe('succeeded');
    expect(f.runtime.starts).toHaveLength(5);
  });
});
