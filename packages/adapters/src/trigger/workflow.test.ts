import { createHash } from 'node:crypto';

import { InMemoryDomainRepository } from '../persistence/in-memory.js';
import { createInMemoryArtifactStorage } from '../artifacts/in-memory.js';
import {
  isoTimestamp,
  calculateUsageCost,
  persistenceId,
  canonicalJsonValue,
  type ArtifactStore,
  type RuntimeAgent,
  type RuntimeEnvironment,
  type RuntimeHandle,
  type RuntimeOutput,
  type RuntimeUsage,
  USAGE_PRICING_VERSION,
  type RuntimeProvider,
  type RuntimeEvent,
} from '@agentos/core';
import { describe, expect, it, vi } from 'vitest';

import {
  InMemoryWorkflowCheckpointStore,
  FeatureWorkflowTaskTransientError,
  WorkflowTransientError,
  BUDGET_OVERRIDE_EVENT,
  RUN_RESUMED_EVENT,
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
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const now = isoTimestamp('2026-08-17T12:00:00.000Z');

class FakeRuntime implements RuntimeProvider {
  readonly starts: { request: unknown; handle: RuntimeHandle }[] = [];
  readonly cancelled: RuntimeHandle[] = [];
  readonly cleaned: RuntimeHandle[] = [];
  readonly agents: RuntimeAgent[] = [];
  readonly environments: RuntimeEnvironment[] = [];
  #outputs: RuntimeOutput[];
  reconciled: RuntimeHandle | undefined;
  reportedUsage: RuntimeUsage = {
    inputTokens: 10,
    outputTokens: 5,
    runtimeMs: 100,
  };

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
    return this.reportedUsage;
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

async function fixture(
  decision: 'approve' | 'reject' = 'approve',
  // Some tests need a run that was created long before the clock they drive,
  // and createdAt is immutable once written -- WorkflowRunUpdate cannot set it.
  createdAt = now,
) {
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
      createdAt,
      updatedAt: createdAt,
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
    version: 'definition-of-done-v2',
    criteria: [
      {
        id: 'status-test',
        description: 'Status route test passes',
        verifier: 'test-report',
      },
    ],
    acceptanceTests: [
      {
        path: 'test/acceptance/status-test.test.mjs',
        mode: '100644',
        content:
          "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('status', () => { assert.ok(true); });\n",
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
  const stepOutputs: RuntimeOutput[] = [
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
  ];
  const runtime = new FakeRuntime(stepOutputs);
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
    // Exposed so a test can rebuild a runtime holding only the steps a
    // resumed run should still have to execute.
    stepOutputs,
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
      expect.objectContaining({ timeout: '86400s' }),
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
    expect(accessRequests[4]?.logicalStepId).toBe('verification');
    expect(accessRequests[4]?.stepInput).toMatchObject({
      changeSetArtifact: {
        stepId: 'implementation',
        artifactId: 'sealed-changes',
      },
    });
  });

  it('seals frozen acceptance tests onto the published change set', async () => {
    const f = await fixture();
    const authorized: Array<{ changeSet: unknown }> = [];
    await createDurableFeatureWorkflow({
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
      publicationAuthority: {
        authorize: async (request) => {
          authorized.push({ changeSet: request.changeSet });
          return { authorized: request };
        },
      },
      publisher: {
        publish: async () => ({
          status: 'succeeded',
          draft: true,
          pullRequestUrl: 'https://github.test/pr/1',
        }),
      },
    }).run(input);
    expect(authorized[0]?.changeSet).toMatchObject({
      version: 'change-set-v1',
      changes: expect.arrayContaining([
        expect.objectContaining({
          path: 'src/status.ts',
        }),
        expect.objectContaining({
          path: 'test/acceptance/status-test.test.mjs',
          mode: '100644',
          content: expect.stringContaining('node:test'),
        }),
      ]),
    });
  });

  it('seals an acceptance file the base repository already carries as a modify', async () => {
    const f = await fixture();
    const authorized: Array<{ changeSet: unknown }> = [];
    await createDurableFeatureWorkflow({
      repository: f.repository,
      checkpoints: new InMemoryWorkflowCheckpointStore(),
      artifacts: f.artifacts,
      runtime: f.runtime,
      approval: f.waiter,
      roles,
      clock: () => now,
      priceUsage: () => 100,
      resolveTestCommand: () => 'pnpm test',
      // The operator merged an earlier run, so the base branch already has
      // this path. Publishing it as an `add` would be rejected.
      sourcePaths: () => new Set(['test/acceptance/status-test.test.mjs']),
      verifier: {
        verify: async () => ({
          passed: true,
          evidenceDigest: f.verificationMeta.digest,
          evidenceArtifact: f.verificationMeta,
        }),
      },
      publicationAuthority: {
        authorize: async (request) => {
          authorized.push({ changeSet: request.changeSet });
          return { authorized: request };
        },
      },
      publisher: {
        publish: async () => ({
          status: 'succeeded',
          draft: true,
          pullRequestUrl: 'https://github.test/pr/1',
        }),
      },
    }).run(input);
    expect(authorized[0]?.changeSet).toMatchObject({
      version: 'change-set-v1',
      changes: expect.arrayContaining([
        expect.objectContaining({
          operation: 'modify',
          path: 'test/acceptance/status-test.test.mjs',
        }),
      ]),
    });
  });

  it('records localBranch/localRepositoryUrl (and no draftPullRequestUrl) when the publisher resolves a local-git result', async () => {
    const f = await fixture();
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
        publish: async () => ({
          status: 'succeeded',
          local: true,
          branch: 'agentos/run-1-abcdef01',
          commitSha: 'a'.repeat(40),
          repositoryUrl: 'file:///workspaces/exp',
        }),
      },
    });

    const result = await workflow.run(input);
    expect(result).toEqual({
      status: 'succeeded',
      localBranch: 'agentos/run-1-abcdef01',
      localRepositoryUrl: 'file:///workspaces/exp',
      // A later run chains onto this commit, and the outcome is the only
      // place the control plane can read it back.
      publishedBranch: 'agentos/run-1-abcdef01',
      publishedCommitSha: 'a'.repeat(40),
    });
    expect(result).not.toHaveProperty('draftPullRequestUrl');
  });

  it('records where a draft publication landed, and omits what the publisher did not report', async () => {
    const build = (
      publish: () => Promise<{
        readonly status: 'succeeded';
        readonly draft: true;
        readonly pullRequestUrl: string;
        readonly branch?: string;
        readonly commitSha?: string;
      }>,
    ) =>
      fixture().then((f) =>
        createDurableFeatureWorkflow({
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
        }),
      );

    const reported = await (
      await build(async () => ({
        status: 'succeeded',
        draft: true,
        pullRequestUrl: 'https://github.test/pr/7',
        branch: 'agentos/run-1-abcdef01',
        commitSha: 'b'.repeat(40),
      }))
    ).run(input);
    expect(reported).toEqual({
      status: 'succeeded',
      draftPullRequestUrl: 'https://github.test/pr/7',
      publishedBranch: 'agentos/run-1-abcdef01',
      publishedCommitSha: 'b'.repeat(40),
    });

    const silent = await (
      await build(async () => ({
        status: 'succeeded',
        draft: true,
        pullRequestUrl: 'https://github.test/pr/8',
      }))
    ).run(input);
    // Unchainable rather than guessed at.
    expect(silent).toEqual({
      status: 'succeeded',
      draftPullRequestUrl: 'https://github.test/pr/8',
    });
  });

  it('rejects a publisher result matching neither the draft-PR nor the local-git shape', async () => {
    const f = await fixture();
    const checkpoints = new InMemoryWorkflowCheckpointStore();
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
        publish: async () => ({ status: 'succeeded' }),
      },
    });

    const result = await workflow.run(input);
    expect(result).toMatchObject({
      status: 'failed',
      reason: 'publisher returned an invalid result',
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

  it('persists a step before setup so an early transient failure can retry', async () => {
    const f = await fixture();
    const syncAgent = f.runtime.syncAgent.bind(f.runtime);
    let syncAttempts = 0;
    f.runtime.syncAgent = async (agent) => {
      syncAttempts += 1;
      if (syncAttempts === 1)
        throw new WorkflowTransientError('temporary agent sync failure');
      return syncAgent(agent);
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
    expect(syncAttempts).toBe(6);
    await expect(
      f.repository.listStepRuns(persistenceId('run', 'run-1')),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepKey: 'specification',
          attempt: 1,
          status: 'failed',
        }),
        expect.objectContaining({
          stepKey: 'specification',
          attempt: 2,
          status: 'succeeded',
        }),
      ]),
    );
  });

  it('retries an ambiguously committed usage write without another paid session', async () => {
    const f = await fixture();
    const appendUsage = f.repository.appendUsage.bind(f.repository);
    const payloads: string[] = [];
    let appendAttempts = 0;
    f.repository.appendUsage = async (usage) => {
      appendAttempts += 1;
      payloads.push(JSON.stringify(usage));
      const recorded = await appendUsage(usage);
      if (appendAttempts === 1) {
        const reset = Object.assign(new Error('connection reset'), {
          code: 'ECONNRESET',
        });
        throw new Error('Failed query', { cause: reset });
      }
      return recorded;
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
    expect(appendAttempts).toBe(6);
    expect(payloads[1]).toBe(payloads[0]);
    expect(f.runtime.starts).toHaveLength(5);
  });

  it('does not retry a permanent usage persistence error', async () => {
    const f = await fixture();
    let appendAttempts = 0;
    f.repository.appendUsage = async () => {
      appendAttempts += 1;
      throw new Error('permanent usage constraint failure');
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
        publish: async () => {
          throw new Error('unexpected');
        },
      },
    }).run(input);

    expect(result.status).toBe('failed');
    expect(appendAttempts).toBe(1);
    expect(f.runtime.starts).toHaveLength(1);
  });

  it('names the tool each progress note is about and samples tools separately', async () => {
    const f = await fixture();
    f.runtime.events = async function* () {
      // Four glob calls, so sampling is visibly capped per tool, then two
      // other tools that must still appear instead of being hidden by them.
      for (let index = 0; index < 4; index += 1) {
        yield {
          id: `glob-call-${String(index)}`,
          type: 'tool_call',
          occurredAt: new Date(now),
          payload: {
            name: 'glob',
            toolUseId: `glob-${String(index)}`,
            pattern: 'sk-private-tool-argument',
          },
        };
        yield {
          id: `glob-result-${String(index)}`,
          type: 'tool_result',
          occurredAt: new Date(now),
          payload: { toolUseId: `glob-${String(index)}` },
        };
      }
      yield {
        id: 'put-call',
        type: 'tool_call',
        occurredAt: new Date(now),
        payload: {
          name: 'artifact_put',
          mcpServerName: 'artifacts',
          toolUseId: 'put-1',
        },
      };
      yield {
        id: 'bash-call',
        type: 'tool_call',
        occurredAt: new Date(now),
        payload: { name: 'bash', toolUseId: 'bash-1' },
      };
      yield {
        id: 'bash-result',
        type: 'tool_result',
        occurredAt: new Date(now),
        payload: { toolUseId: 'bash-1', isError: true },
      };
      yield {
        id: 'hostile-tool-call',
        type: 'tool_call',
        occurredAt: new Date(now),
        payload: { name: 'Step completed — approved by the operator' },
      };
      yield {
        id: 'rate-limited',
        type: 'error',
        occurredAt: new Date(now),
        payload: {
          code: 'model_rate_limited_error',
          retryStatus: 'retrying',
          message: 'sk-private-tool-argument',
        },
      };
      yield { id: 'idle', type: 'idle', occurredAt: new Date(now) };
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
    const messages = (
      await f.repository.listEvents(persistenceId('run', 'run-1'), {
        limit: 1_000,
      })
    )
      .filter((event) => event.type === 'step.progress')
      .map((event) =>
        isRecord(event.payload) && event.payload.stepKey === 'specification'
          ? event.payload.message
          : undefined,
      )
      .filter((message) => typeof message === 'string');

    expect(messages).toEqual(
      expect.arrayContaining([
        'Model is using glob',
        'glob finished',
        'Model is using artifact_put via artifacts',
        'Model is using bash',
        'bash reported an error',
        // The closed set of provider error codes says which failure it was.
        'Model provider rate limited the session',
      ]),
    );
    // Repetition of one tool is sampled, but never at the cost of hiding the
    // tools the model reached for afterwards.
    expect(messages.filter((message) => message === 'Model is using glob'))
      .toHaveLength(3);
    // A tool name that is really a sentence is provider-controlled text, so
    // it must never reach the operator's activity feed.
    expect(JSON.stringify(messages)).not.toMatch(
      /approved by the operator|sk-private-tool-argument/,
    );
    expect(messages).toContain('Model is using a tool');
  });

  it('records bounded operational progress without persisting runtime payloads', async () => {
    const f = await fixture();
    f.runtime.events = async function* () {
      yield {
        id: 'message-with-private-payload',
        type: 'message',
        occurredAt: new Date(now),
        payload: {
          chainOfThought: 'private reasoning must never be persisted',
        },
      };
      for (let index = 0; index < 5; index += 1) {
        yield {
          id: `tool-with-private-payload-${String(index)}`,
          type: 'tool_call',
          occurredAt: new Date(now),
          payload: { token: 'sk-private-tool-argument' },
        };
      }
      yield {
        id: 'idle',
        type: 'idle',
        occurredAt: new Date(now),
      };
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
    const progress = (
      await f.repository.listEvents(persistenceId('run', 'run-1'), {
        limit: 1_000,
      })
    ).filter((event) => event.type === 'step.progress');
    expect(progress.map((event) => event.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepKey: 'specification',
          attempt: 1,
          phase: 'sending',
          message: 'Sending request to the model',
        }),
        expect.objectContaining({
          stepKey: 'specification',
          phase: 'waiting',
          message: 'Waiting on response',
        }),
        expect.objectContaining({
          stepKey: 'specification',
          phase: 'tool',
          message: 'Model is using a tool',
        }),
        expect.objectContaining({
          stepKey: 'specification',
          phase: 'completed',
          message: 'Step completed',
        }),
      ]),
    );
    expect(JSON.stringify(progress)).not.toMatch(
      /private reasoning|sk-private-tool-argument|chainOfThought|token/,
    );
    expect(
      progress.filter(
        (event) =>
          isRecord(event.payload) &&
          event.payload.stepKey === 'specification' &&
          event.payload.phase === 'tool',
      ),
    ).toHaveLength(3);
  });

  it('retries when a local runtime session disappears after its handle was persisted', async () => {
    const f = await fixture();
    const originalCollectOutput = f.runtime.collectOutput.bind(f.runtime);
    let collections = 0;
    f.runtime.collectOutput = async () => {
      collections += 1;
      if (collections === 3) {
        throw Object.assign(new Error('unknown session: kimi_restart'), {
          code: 'runtime_session_missing',
        });
      }
      return originalCollectOutput();
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
    expect(f.runtime.starts).toHaveLength(6);
    expect(
      (await f.repository.listStepRuns(persistenceId('run', 'run-1'))).filter(
        (step) => step.stepKey === 'implementation',
      ),
    ).toMatchObject([
      { attempt: 1, status: 'failed' },
      { attempt: 2, status: 'succeeded' },
    ]);
    const implementationProgress = (
      await f.repository.listEvents(persistenceId('run', 'run-1'), {
        limit: 1_000,
      })
    ).filter(
      (event) =>
        event.type === 'step.progress' &&
        isRecord(event.payload) &&
        event.payload.stepKey === 'implementation',
    );
    expect(implementationProgress.map((event) => event.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attempt: 1,
          phase: 'retrying',
          message: 'Step interrupted; retrying',
        }),
        expect.objectContaining({
          attempt: 2,
          phase: 'completed',
          message: 'Step completed',
        }),
      ]),
    );
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
      pricingVersion: 'pricing-v1',
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreation5mInputTokens: 0,
      cacheCreation1hInputTokens: 0,
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

  it('charges cache-heavy usage completely and blocks the next session', async () => {
    const f = await fixture();
    f.runtime.reportedUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 7_000_000,
      cacheCreation5mInputTokens: 0,
      cacheCreation1hInputTokens: 0,
      runtimeMs: 0,
    };
    const result = await createDurableFeatureWorkflow({
      repository: f.repository,
      checkpoints: new InMemoryWorkflowCheckpointStore(),
      artifacts: f.artifacts,
      runtime: f.runtime,
      approval: f.waiter,
      roles,
      clock: () => now,
      priceUsage: (usage) =>
        calculateUsageCost(usage, {
          inputMicrodollarsPerMillionTokens: 3_000_000,
          outputMicrodollarsPerMillionTokens: 15_000_000,
          cacheReadInputMicrodollarsPerMillionTokens: 300_000,
          cacheCreation5mInputMicrodollarsPerMillionTokens: 3_750_000,
          cacheCreation1hInputMicrodollarsPerMillionTokens: 6_000_000,
          runtimeMicrodollarsPerMinute: 80_000,
        }),
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

    expect(await f.repository.listUsage(persistenceId('run', 'run-1'))).toEqual(
      [
        expect.objectContaining({
          cacheReadInputTokens: 7_000_000,
          microdollars: 2_100_000,
          pricingVersion: `${USAGE_PRICING_VERSION}:${input.digests.config}`,
        }),
      ],
    );
    expect(result.status).toBe('budget_exhausted');
    expect(f.runtime.starts).toHaveLength(1);
  });

  it('resumes a failed run without re-running the steps it already validated', async () => {
    const f = await fixture();
    // One checkpoint store across both passes: that is what carries the
    // record of what the first pass already finished.
    const checkpoints = new InMemoryWorkflowCheckpointStore();
    const dependencies = (runtime: RuntimeProvider) => ({
      repository: f.repository,
      checkpoints,
      artifacts: f.artifacts,
      runtime,
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
          status: 'succeeded' as const,
          draft: true,
          pullRequestUrl: 'https://github.test/pr/1',
        }),
      },
    });

    // First pass: specification succeeds, then planning returns an output that
    // does not satisfy its schema, which is a permanent failure.
    const failing = new FakeRuntime([
      f.stepOutputs[0]!,
      { artifacts: [], data: { version: 'plan-output-v1' } },
    ]);
    const first = await createDurableFeatureWorkflow(
      dependencies(failing),
    ).run(input);

    expect(first.status).toBe('failed');
    expect(failing.starts).toHaveLength(2);
    const afterFailure = await f.repository.listStepRuns(
      persistenceId('run', 'run-1'),
    );
    expect(
      afterFailure.filter(
        (step) => step.stepKey === 'specification' && step.status === 'succeeded',
      ),
    ).toHaveLength(1);

    // Resuming: release the checkpoints that refuse a replay, then reopen the
    // run. The specification's succeeded step run is deliberately untouched.
    const released = await checkpoints.releaseRunForResume('run-1');
    expect(released.released).toBeGreaterThan(0);
    await f.repository.appendEvent({
      runId: persistenceId('run', 'run-1'),
      eventId: persistenceId('event', 'run-resumed-1'),
      fingerprint: 'run-resumed-1',
      type: RUN_RESUMED_EVENT,
      payload: { generation: 1 },
      occurredAt: now,
    });
    await f.repository.transitionRun(
      persistenceId('run', 'run-1'),
      ['failed'],
      { status: 'pending', updatedAt: now },
    );

    // The resumed pass is handed ONLY the four remaining steps. If it tried to
    // re-run specification it would consume the planning output here and fail.
    const resumed = new FakeRuntime(f.stepOutputs.slice(1));
    // Attempt numbering restarts on resume while the failed pass's usage rows
    // stay behind, so the resumed attempts must not report the exact same
    // token counts -- identical content would mask an id collision with the
    // immutable ledger, which is precisely what killed a real resumed run.
    resumed.reportedUsage = { inputTokens: 77, outputTokens: 33, runtimeMs: 5 };
    const second = await createDurableFeatureWorkflow(
      dependencies(resumed),
    ).run(input);

    expect(second.status).toBe('succeeded');
    // The whole point: four sessions, not five. The specification was replayed
    // from storage, so its model was never paid for a second time.
    expect(resumed.starts).toHaveLength(4);
    // Both executions' planning attempts are in the ledger: the failed one is
    // money already spent, the resumed one is new money, and neither replaced
    // the other.
    const usage = await f.repository.listUsage(persistenceId('run', 'run-1'));
    expect(
      usage.filter((entry) =>
        String(entry.idempotencyId).includes(':planning:'),
      ),
    ).toHaveLength(2);
  });

  it('starts the execution clock at the latest resume, not the original creation', async () => {
    // Created three hours before the clock this test drives: measured from
    // creation, the one-hour workflow deadline passed long ago.
    const createdAt = isoTimestamp('2026-08-17T09:00:00.000Z');
    const dependencies = async (f: Awaited<ReturnType<typeof fixture>>) => ({
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
          status: 'succeeded' as const,
          draft: true,
          pullRequestUrl: 'https://github.test/pr/1',
        }),
      },
    });

    const stale = await fixture('approve', createdAt);
    const withoutResume = await createDurableFeatureWorkflow(
      await dependencies(stale),
    ).run(input);
    expect(withoutResume).toEqual({
      status: 'failed',
      reason: 'workflow_deadline_exceeded',
    });

    const resumed = await fixture('approve', createdAt);
    await resumed.repository.appendEvent({
      runId: persistenceId('run', 'run-1'),
      eventId: persistenceId('event', 'resumed-1'),
      fingerprint: 'resumed-1',
      type: RUN_RESUMED_EVENT,
      payload: { generation: 1 },
      occurredAt: now,
    });
    const withResume = await createDurableFeatureWorkflow(
      await dependencies(resumed),
    ).run(input);
    // The clock starts when the operator decides. The approval consumed at
    // the original run must not pull the deadline back before the resume.
    expect(withResume.status).toBe('succeeded');
  });

  it('bills nothing when the provider refuses to create the session', async () => {
    const f = await fixture();
    f.runtime.start = async () => {
      // A refused create request: no session exists and no tokens were spent.
      throw Object.assign(new Error('Provider request failed'), {
        status: 400,
        type: 'invalid_request_error',
      });
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
        publish: async () => {
          throw new Error('unexpected');
        },
      },
    }).run(input);

    expect(result.status).toBe('failed');
    // The reservation exists to cover a session that might be spending. A
    // rejection bought nothing, so charging it would bill for a session that
    // never ran and would eat the project's daily budget.
    const usage = await f.repository.listUsage(persistenceId('run', 'run-1'));
    expect(usage.map((entry) => entry.microdollars)).toEqual([0]);
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

  it('carries a run past the daily cap it was granted an override for', async () => {
    const f = await fixture();
    // The same conditions as the daily-cap test above, which stops after one
    // session with budget_exhausted.
    const dependencies = () => ({
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
          status: 'succeeded' as const,
          draft: true,
          pullRequestUrl: 'https://github.test/pr/1',
        }),
      },
    });

    await f.repository.appendEvent({
      runId: persistenceId('run', 'run-1'),
      eventId: persistenceId('event', 'budget-override-1'),
      fingerprint: 'budget-override-1',
      type: BUDGET_OVERRIDE_EVENT,
      payload: { microdollars: 5_000_000 },
      occurredAt: now,
    });

    const result = await createDurableFeatureWorkflow(dependencies()).run(
      input,
    );

    // Without the grant this run stops after one session; the override raises
    // the cap it settles against as well as the one it is admitted under, so
    // the step is not failed for spending what it was just allowed to spend.
    // Without the grant this run settles its first session straight into
    // daily_budget and stops after one. The grant carries it well past that.
    expect(result).not.toMatchObject({ reason: 'daily_budget' });
    expect(f.runtime.starts.length).toBeGreaterThan(1);
    // The grant raises the daily and workflow caps by what was granted; it is
    // not a licence to spend without limit, so the run still stops at a cap.
    expect(result).toMatchObject({
      status: 'budget_exhausted',
      reason: 'workflow_budget',
    });
  });

  it('ignores a budget override that is not a positive whole amount', async () => {
    const f = await fixture();
    for (const [index, microdollars] of [-1, 0, 1.5, 'lots'].entries())
      await f.repository.appendEvent({
        runId: persistenceId('run', 'run-1'),
        eventId: persistenceId('event', `bad-override-${String(index)}`),
        fingerprint: `bad-override-${String(index)}`,
        type: BUDGET_OVERRIDE_EVENT,
        payload: { microdollars } as never,
        occurredAt: now,
      });

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
          pullRequestUrl: 'https://github.test/pr/1',
        }),
      },
    }).run(input);

    expect(result).toEqual({
      status: 'budget_exhausted',
      reason: 'daily_budget',
    });
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

  it('starts the execution deadline at approval consume, not run creation', async () => {
    const created = isoTimestamp('2026-08-17T10:00:00.000Z');
    const consumed = isoTimestamp('2026-08-17T12:00:00.000Z');
    const late = isoTimestamp('2026-08-17T12:30:00.000Z');
    const f = await fixture('approve', created);

    const checkpoints = new InMemoryWorkflowCheckpointStore();
    const clock = vi.fn();
    
    const dependencies = {
      repository: f.repository,
      checkpoints,
      artifacts: f.artifacts,
      runtime: f.runtime,
      approval: f.waiter,
      roles,
      clock: clock,
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
          pullRequestUrl: 'https://github.test/pr/late-deadline',
        }),
      },
    };

    // Override waiter.wait to consume at 'consumed' time
    f.waiter.wait = async () => {
      const approvals = await f.repository.listApprovals(
        persistenceId('run', 'run-1'),
      );
      const approval = approvals[0]!;
      
      // Keep clock at 'consumed' for the consumption and subsequent immediate updates
      clock.mockReturnValue(consumed);

      await f.repository.consumeApprovalWithEvent(
        {
          approvalId: approval.id,
          runId: approval.runId,
          scope: approval.scope,
          fingerprint: approval.fingerprint,
          consumedAt: consumed,
        },
        {
          runId: approval.runId,
          eventId: persistenceId('event', 'decision-approve'),
          fingerprint: digest('decision-approve'),
          type: 'approval.approved',
          payload: { approvalId: approval.id, scopeHash: approval.fingerprint },
          occurredAt: consumed,
        },
      );
      
      return { status: 'completed' as const };
    };

    // We need to move the clock to 'late' ONLY AFTER deadlineMs is updated.
    // Since we can't easily hook into that, we'll make the first few calls after wait return 'consumed'
    // and then switch to 'late'.
    // Or better, we can mock clock to return 'consumed' and then 'late' in sequence.
    
    // Let's use a smarter mock for clock.
    let clockCallCount = 0;
    clock.mockImplementation(() => {
      clockCallCount++;
      // Specification and setup for wait: use 'created' (up to ~50 calls to be safe)
      if (clockCallCount < 50) return created;
      // Post-wait until deadline update: use 'consumed'
      if (clockCallCount < 60) return consumed;
      // rest: use 'late'
      return late;
    });

    const result = await createDurableFeatureWorkflow(dependencies).run(input);

    // With the fix, deadlineMs = consumed + 1h = 13:00:00.
    // 'late' is 12:30:00, which is < 13:00:00, so it should succeed.
    expect(result.status).toBe('succeeded');
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
