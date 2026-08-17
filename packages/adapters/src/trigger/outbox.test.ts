import type { RuntimeProvider } from '@agentos/core';
import { describe, expect, it, vi } from 'vitest';

import { InMemoryWorkflowCheckpointStore } from './checkpoint-store.js';
import { createDurableTriggerOutbox } from './outbox.js';

const now = '2026-08-17T12:00:00.000Z';

async function startedEffect(
  store: InMemoryWorkflowCheckpointStore,
  input: { key: string; kind: string; externalRef: string },
) {
  await store.claimEffect({
    key: input.key,
    runId: 'run-1',
    kind: input.kind,
    inputFingerprint: 'a'.repeat(64),
    createdAt: now,
    updatedAt: now,
  });
  await store.markEffectStarted(input.key, now);
  await store.attachExternalRef(input.key, input.externalRef, now);
}

function collaborators(runtime?: RuntimeProvider) {
  const checkpoints = new InMemoryWorkflowCheckpointStore();
  const cancelTrigger = vi.fn(async () => undefined);
  return {
    checkpoints,
    cancelTrigger,
    outbox: createDurableTriggerOutbox({
      checkpoints,
      trigger: {
        startFeature: vi.fn(),
        cancel: cancelTrigger,
      },
      approval: {
        create: vi.fn(),
        wait: vi.fn(),
        wake: vi.fn(),
      },
      clock: () => now,
      ...(runtime === undefined ? {} : { runtime }),
    }),
  };
}

describe('durable Trigger outbox cancellation', () => {
  it('does not stop Trigger when an active runtime cannot be cancelled safely', async () => {
    const { checkpoints, cancelTrigger, outbox } = collaborators();
    await startedEffect(checkpoints, {
      key: 'trigger:run-1',
      kind: 'trigger-workflow-start',
      externalRef: 'trigger-run-1',
    });
    await startedEffect(checkpoints, {
      key: 'runtime:run-1:implementation:1',
      kind: 'runtime-session',
      externalRef: 'runtime-session-1',
    });

    await expect(
      outbox.requestCancel({ idempotencyKey: 'cancel:run-1', runId: 'run-1' }),
    ).rejects.toThrow('trusted runtime provider');

    expect(cancelTrigger).not.toHaveBeenCalled();
    await expect(checkpoints.getEffect('cancel:run-1')).resolves.toMatchObject({
      status: 'started',
    });
  });

  it('cancels the active runtime before Trigger and replays without duplicates', async () => {
    const calls: string[] = [];
    const runtime = {
      cancel: vi.fn(async () => {
        calls.push('runtime');
      }),
    } as unknown as RuntimeProvider;
    const { checkpoints, cancelTrigger, outbox } = collaborators(runtime);
    cancelTrigger.mockImplementation(async () => {
      calls.push('trigger');
    });
    await startedEffect(checkpoints, {
      key: 'trigger:run-1',
      kind: 'trigger-workflow-start',
      externalRef: 'trigger-run-1',
    });
    await startedEffect(checkpoints, {
      key: 'runtime:run-1:implementation:1',
      kind: 'runtime-session',
      externalRef: 'runtime-session-1',
    });
    const request = { idempotencyKey: 'cancel:run-1', runId: 'run-1' };

    await outbox.requestCancel(request);
    await outbox.requestCancel(request);

    expect(calls).toEqual(['runtime', 'trigger']);
    expect(runtime.cancel).toHaveBeenCalledWith(
      { id: 'runtime-session-1' },
      'authoritative run cancellation',
    );
  });
});
