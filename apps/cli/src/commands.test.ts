import { describe, expect, it, vi } from 'vitest';

import type { ApiRequest } from './types.js';
import { executeRemoteCommand, type RemoteCommand } from './commands.js';

const baseRun = {
  projectId: 'project_1',
  title: 'Ship CLI',
  description: 'Build the command surface',
  repositorySha: 'a'.repeat(40),
  configDigest: 'config',
  modelDigest: 'model',
  promptDigest: 'prompt',
  environmentDigest: 'environment',
  policyDigest: 'policy',
  idempotencyKey: 'mutation-key',
  json: false,
} as const;

describe('remote command route mapping', () => {
  it.each<[RemoteCommand, ApiRequest]>([
    [
      { kind: 'feature.start', ...baseRun },
      {
        method: 'POST',
        path: '/api/features',
        body: expect.any(Object),
        idempotencyKey: 'mutation-key',
      },
    ],
    [
      { kind: 'goal.start', ...baseRun },
      {
        method: 'POST',
        path: '/api/goals',
        body: expect.any(Object),
        idempotencyKey: 'mutation-key',
      },
    ],
    [
      { kind: 'runs.list', json: false },
      { method: 'GET', path: '/api/runs' },
    ],
    [
      { kind: 'runs.show', id: 'run_1', json: false },
      { method: 'GET', path: '/api/runs/run_1' },
    ],
    [
      {
        kind: 'runs.cancel',
        id: 'run_1',
        idempotencyKey: 'cancel-1',
        json: false,
      },
      {
        method: 'POST',
        path: '/api/runs/run_1/cancel',
        body: {},
        idempotencyKey: 'cancel-1',
      },
    ],
    [
      { kind: 'inbox.list', json: false },
      { method: 'GET', path: '/api/inbox' },
    ],
    [
      {
        kind: 'inbox.reply',
        id: 'message_1',
        reply: 'yes',
        idempotencyKey: 'reply-1',
        json: false,
      },
      {
        method: 'POST',
        path: '/api/inbox/message_1/reply',
        body: { reply: 'yes' },
        idempotencyKey: 'reply-1',
      },
    ],
    [
      {
        kind: 'inbox.approve',
        id: 'approval_1',
        scopeHash: 'scope-hash',
        idempotencyKey: 'approve-1',
        json: false,
      },
      {
        method: 'POST',
        path: '/api/approvals/approval_1/approve',
        body: { scopeHash: 'scope-hash' },
        idempotencyKey: 'approve-1',
      },
    ],
    [
      {
        kind: 'inbox.reject',
        id: 'approval_1',
        scopeHash: 'scope-hash',
        idempotencyKey: 'reject-1',
        json: false,
      },
      {
        method: 'POST',
        path: '/api/approvals/approval_1/reject',
        body: { scopeHash: 'scope-hash' },
        idempotencyKey: 'reject-1',
      },
    ],
  ])('maps $kind to the exact server contract', async (command, expected) => {
    const request = vi.fn(async () => ({ ok: true }));
    await executeRemoteCommand(command, { request });
    expect(request).toHaveBeenCalledWith(expected);
  });
});
