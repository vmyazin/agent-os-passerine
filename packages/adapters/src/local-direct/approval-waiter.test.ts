import { isoTimestamp, persistenceId } from '@agentos/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InMemoryDomainRepository } from '../persistence/in-memory.js';
import { createLocalApprovalWaiter } from './approval-waiter.js';

const runId = persistenceId('run', 'run-1');
const projectId = persistenceId('project', 'project-1');
const approvalId = 'approval_0123456789abcdef0123456789abcdef';
const scope = 'feature-spec-and-dod';
const fingerprint = 'f'.repeat(64);
const waitEffectKey = `waitpoint:run-1:${approvalId}`;
const waiterId = `local-approval:${approvalId}`;

const createdAt = '2026-09-02T12:00:00.000Z';
const expiresAt = '2026-09-02T13:00:00.000Z';

async function repositoryWithPendingApproval() {
  const repository = new InMemoryDomainRepository();
  await repository.createProject({
    id: projectId,
    name: 'Local direct',
    createdAt: isoTimestamp(createdAt),
    updatedAt: isoTimestamp(createdAt),
  });
  await repository.createRun({
    id: runId,
    projectId,
    pipeline: 'feature',
    status: 'waiting',
    createdAt: isoTimestamp(createdAt),
    updatedAt: isoTimestamp(createdAt),
  });
  await repository.createApproval({
    id: persistenceId('approval', approvalId),
    runId,
    scope,
    fingerprint,
    status: 'pending',
    createdAt: isoTimestamp(createdAt),
    expiresAt: isoTimestamp(expiresAt),
  });
  return repository;
}

async function consume(
  repository: InMemoryDomainRepository,
  consumedAt = '2026-09-02T12:10:00.000Z',
) {
  const consumed = await repository.consumeApproval({
    approvalId: persistenceId('approval', approvalId),
    runId,
    scope,
    fingerprint,
    consumedAt: isoTimestamp(consumedAt),
  });
  expect(consumed?.status).toBe('consumed');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('local approval waiter', () => {
  it('derives one stable waitpoint id from the workflow effect key', async () => {
    const repository = await repositoryWithPendingApproval();
    const waiter = createLocalApprovalWaiter({ repository });
    const first = await waiter.create({
      idempotencyKey: waitEffectKey,
      timeout: '3600s',
      tags: [`run:run-1`, `approval:${approvalId}`],
    });
    const second = await waiter.create({
      idempotencyKey: waitEffectKey,
      timeout: '120s',
      tags: [],
    });
    expect(first).toEqual({ id: waiterId });
    // The id carries no state, so a re-created waitpoint is the same waitpoint.
    expect(second).toEqual(first);
  });

  it('refuses an idempotency key that is not a workflow waitpoint key', async () => {
    const repository = await repositoryWithPendingApproval();
    const waiter = createLocalApprovalWaiter({ repository });
    await expect(
      waiter.create({
        idempotencyKey: 'not-a-waitpoint',
        timeout: '1s',
        tags: [],
      }),
    ).rejects.toThrow(/waitpoint:<runId>:<approvalId>/);
  });

  it('completes when a wake finds the approval row consumed', async () => {
    vi.useFakeTimers();
    const repository = await repositoryWithPendingApproval();
    const waiter = createLocalApprovalWaiter({
      repository,
      clock: () => createdAt,
      // Long enough that only the wake can resolve this wait.
      pollIntervalMs: 600_000,
    });
    const pending = waiter.wait(waiterId);
    await vi.advanceTimersByTimeAsync(0);
    await consume(repository);
    await waiter.wake(waiterId);
    await expect(pending).resolves.toEqual({ status: 'completed' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('completes by polling alone when no wake ever arrives', async () => {
    vi.useFakeTimers();
    const repository = await repositoryWithPendingApproval();
    const waiter = createLocalApprovalWaiter({
      repository,
      clock: () => createdAt,
      pollIntervalMs: 5_000,
    });
    const pending = waiter.wait(waiterId);
    await vi.advanceTimersByTimeAsync(4_999);
    await consume(repository);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toEqual({ status: 'completed' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('completes immediately when the row was already consumed', async () => {
    vi.useFakeTimers();
    const repository = await repositoryWithPendingApproval();
    await consume(repository);
    const waiter = createLocalApprovalWaiter({
      repository,
      clock: () => createdAt,
      pollIntervalMs: 5_000,
    });
    await expect(waiter.wait(waiterId)).resolves.toEqual({
      status: 'completed',
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out once the deadline passes with the row still pending', async () => {
    vi.useFakeTimers();
    const repository = await repositoryWithPendingApproval();
    let now = createdAt;
    const waiter = createLocalApprovalWaiter({
      repository,
      clock: () => now,
      pollIntervalMs: 5_000,
    });
    const pending = waiter.wait(waiterId);
    await vi.advanceTimersByTimeAsync(5_000);
    now = '2026-09-02T13:00:00.001Z';
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toEqual({ status: 'timed_out' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out when the row was expired by someone else', async () => {
    const repository = await repositoryWithPendingApproval();
    await repository.expireApproval(persistenceId('approval', approvalId), {
      runId,
      scope,
      fingerprint,
      at: isoTimestamp(expiresAt),
    });
    const waiter = createLocalApprovalWaiter({
      repository,
      clock: () => createdAt,
    });
    await expect(waiter.wait(waiterId)).resolves.toEqual({
      status: 'timed_out',
    });
  });

  it('keeps waiting on a wake that is not a decision', async () => {
    vi.useFakeTimers();
    const repository = await repositoryWithPendingApproval();
    const waiter = createLocalApprovalWaiter({
      repository,
      clock: () => createdAt,
      pollIntervalMs: 600_000,
    });
    const settled = vi.fn();
    const pending = waiter.wait(waiterId).then(settled);
    await vi.advanceTimersByTimeAsync(0);
    // A wake never carries the decision, so a premature one resolves nothing.
    await waiter.wake(waiterId);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).not.toHaveBeenCalled();
    await consume(repository);
    await waiter.wake(waiterId);
    await pending;
    expect(settled).toHaveBeenCalledWith({ status: 'completed' });
  });

  it('ignores a wake for an id nobody is waiting on', async () => {
    const repository = await repositoryWithPendingApproval();
    const waiter = createLocalApprovalWaiter({ repository });
    await expect(
      waiter.wake('local-approval:approval_absent'),
    ).resolves.toBeUndefined();
    await expect(
      waiter.wake('waitpoint-from-another-executor'),
    ).resolves.toBeUndefined();
  });

  it('abandons the wait, and its timer, when the process is shutting down', async () => {
    vi.useFakeTimers();
    const repository = await repositoryWithPendingApproval();
    const shutdown = new AbortController();
    const waiter = createLocalApprovalWaiter({
      repository,
      clock: () => createdAt,
      pollIntervalMs: 600_000,
      signal: shutdown.signal,
    });
    const pending = waiter.wait(waiterId);
    await vi.advanceTimersByTimeAsync(0);
    shutdown.abort();
    await expect(pending).rejects.toThrow(/shutdown/);
    expect(vi.getTimerCount()).toBe(0);
    // A wait started after shutdown never registers a timer at all.
    await expect(waiter.wait(waiterId)).rejects.toThrow(/shutdown/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a waitpoint id it did not issue', async () => {
    const repository = await repositoryWithPendingApproval();
    const waiter = createLocalApprovalWaiter({ repository });
    await expect(waiter.wait('trigger-waitpoint-ref')).rejects.toThrow(
      /unknown waitpoint id/,
    );
  });
});
