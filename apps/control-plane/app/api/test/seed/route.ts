import { NextResponse } from 'next/server';
import { isoTimestamp, persistenceId } from '@agentos/core';

import { repositoryFromEnv } from '../../../../src/persistence/repository-factory';
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
