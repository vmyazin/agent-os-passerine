import { NextResponse } from 'next/server';
import { isoTimestamp, persistenceId } from '@agentos/core';

import { repositoryFromEnv } from '../../../../src/persistence/repository-factory';
import { approvalArtifactStoreFromEnv } from '../../../../src/application/runtime';
import { requireApiAuthentication } from '../../../../src/http/authenticated';

export async function POST(request: Request): Promise<Response> {
  if (
    process.env.NODE_ENV === 'production' ||
    process.env.AGENTOS_E2E_SEED !== 'enabled'
  ) {
    return NextResponse.json(
      { error: { code: 'not_found', message: 'not found' } },
      { status: 404 },
    );
  }
  requireApiAuthentication(request);
  const repository = repositoryFromEnv();
  const at = isoTimestamp('2026-08-17T12:00:00.000Z');
  const projectId = persistenceId('project', 'e2e-project');
  const runId = persistenceId('run', 'e2e-run');
  if (!(await repository.getProject(projectId)))
    await repository.createProject({
      id: projectId,
      name: 'E2E Project',
      createdAt: at,
      updatedAt: at,
    });
  if (!(await repository.getRun(runId)))
    await repository.createRun({
      id: runId,
      projectId,
      pipeline: 'feature',
      status: 'waiting',
      input: {
        title: 'Approval inbox monitoring',
        provenance: {
          repositorySha: 'a'.repeat(40),
          configDigest: 'cfg',
          modelDigest: 'model',
          promptDigest: 'prompt',
          environmentDigest: 'env',
          policyDigest: 'policy',
        },
      },
      createdAt: at,
      updatedAt: at,
    });
  const approvalId = persistenceId('approval', 'e2e-approval');
  if (!(await repository.getApproval(approvalId)))
    await repository.createApproval({
      id: approvalId,
      runId,
      scope: 'Merge pull request #42',
      fingerprint: 'scope_hash_42',
      status: 'pending',
      createdAt: at,
      // The approval must be consumable against the server's real clock, so
      // its expiry is relative; a fixed future date is a calendar time bomb.
      expiresAt: isoTimestamp(
        new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      ),
    });
  // A spec/DoD approval with its artifacts, so the inbox demo shows the
  // decision the operator actually makes: the frozen acceptance tests that
  // will gate the run. Without the artifact bodies the summary degrades to a
  // bare approval and the acceptance block never renders.
  const specRunId = persistenceId('run', 'e2e-spec-run');
  const specApprovalId = persistenceId('approval', 'e2e-spec-approval');
  if (!(await repository.getRun(specRunId)))
    await repository.createRun({
      id: specRunId,
      projectId,
      pipeline: 'feature',
      status: 'waiting',
      input: {
        title: 'Deep-copy the todo store',
        provenance: {
          repositorySha: 'b'.repeat(40),
          configDigest: 'cfg',
          modelDigest: 'model',
          promptDigest: 'prompt',
          environmentDigest: 'env',
          policyDigest: 'policy',
        },
      },
      createdAt: at,
      updatedAt: at,
    });
  const artifacts = approvalArtifactStoreFromEnv();
  if (artifacts !== undefined) {
    const scope = {
      projectId,
      runId: specRunId,
      stepId: 'specification',
    } as const;
    const existing = await artifacts.list({ scope, limit: 10 });
    const put = async (artifactId: string, body: unknown) => {
      if (existing.items.some((item) => item.artifactId === artifactId)) return;
      await artifacts.put({
        scope,
        artifactId,
        version: 1,
        bytes: new TextEncoder().encode(JSON.stringify(body)),
        mediaType: 'application/json',
        retentionClass: 'working',
      });
    };
    await put('specification', {
      version: 'feature-spec-v1',
      title: 'Deep-copy the todo store',
      requirements: [
        'add(title) returns a todo the caller can mutate without changing the store',
        'list() returns copies, not the stored objects',
      ],
    });
    await put('dod', {
      version: 'definition-of-done-v2',
      criteria: [
        {
          id: 'list-deep-copy',
          description:
            'Mutating a todo returned by list() does not change the store',
          verifier: 'test-report',
        },
      ],
      acceptanceTests: [
        {
          path: 'test/acceptance/list-deep-copy.test.mjs',
          mode: '100644',
          content: [
            "import test from 'node:test';",
            "import assert from 'node:assert/strict';",
            "import { createTodoStore } from '../../src/todo-store.mjs';",
            '',
            "test('mutating a todo returned by list() does not change the store', () => {",
            '  const store = createTodoStore();',
            "  store.add('write the spec');",
            "  store.list()[0].title = 'mutated';",
            "  assert.equal(store.list()[0].title, 'write the spec');",
            '});',
            '',
          ].join('\n'),
        },
      ],
    });
  }
  if (!(await repository.getApproval(specApprovalId)))
    await repository.createApproval({
      id: specApprovalId,
      runId: specRunId,
      scope: 'feature-spec-and-dod',
      fingerprint: 'scope_hash_spec_dod',
      status: 'pending',
      createdAt: at,
      expiresAt: isoTimestamp(
        new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      ),
    });
  // A chained pair, so the run page's "Builds on" section has something to
  // show: a succeeded run that recorded where it published, and a run
  // started on top of it.
  const chainBaseId = persistenceId('run', 'e2e-chain-base');
  const chainedId = persistenceId('run', 'e2e-chain-next');
  const basePublication = {
    publishedBranch: 'agentos/run-e2e-chain-base-1f4a9c22',
    publishedCommitSha: 'd4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f607',
  };
  if (!(await repository.getRun(chainBaseId)))
    await repository.createRun({
      id: chainBaseId,
      projectId,
      pipeline: 'feature',
      status: 'succeeded',
      input: { title: 'Add the todo store', description: 'The first feature.' },
      output: {
        status: 'succeeded',
        localBranch: basePublication.publishedBranch,
        localRepositoryUrl: 'file:///workspaces/todo-app-02',
        ...basePublication,
      },
      createdAt: at,
      updatedAt: at,
      completedAt: at,
    });
  if (!(await repository.getRun(chainedId)))
    await repository.createRun({
      id: chainedId,
      projectId,
      pipeline: 'feature',
      status: 'running',
      input: {
        title: 'List todos by due date',
        description: 'Builds on the todo store.',
        chain: {
          baseRunId: 'e2e-chain-base',
          baseBranch: basePublication.publishedBranch,
          baseCommitSha: basePublication.publishedCommitSha,
        },
      },
      createdAt: at,
      updatedAt: at,
    });
  const messageId = persistenceId('inboxMessage', 'e2e-message');
  if (!(await repository.getInboxMessage(messageId)))
    await repository.createInboxMessage({
      id: messageId,
      runId,
      status: 'pending',
      body: { question: 'Which deployment window should we use?' },
      createdAt: at,
    });
  return NextResponse.json({ ok: true });
}
