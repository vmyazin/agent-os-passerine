import { createHash } from 'node:crypto';

import {
  createDurableTriggerOutbox,
  createAesWorkflowHandleSealer,
  createManagedAgentsRuntimeProvider,
  createNeonWorkflowCheckpointStore,
  createRepositoryRuntimeHandleVault,
  createTriggerApprovalWaiter,
  createTriggerWorkflowDispatcher,
} from '@agentos/adapters';
import {
  isoTimestamp,
  persistenceId,
  type RuntimeHandle,
  type RuntimeProvider,
} from '@agentos/core';

import { ControlPlaneService, type IdGenerator } from './control-plane-service';
import { repositoryFromEnv } from '../persistence/repository-factory';

const deterministicId: IdGenerator = (kind, idempotencyKey) =>
  persistenceId(
    kind,
    `${kind}_${createHash('sha256').update(`${kind}:${idempotencyKey}`).digest('hex').slice(0, 32)}`,
  );

let service: ControlPlaneService | undefined;

function requiredRuntime(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '')
    throw new Error(`${name} is required to control an active runtime session`);
  return value;
}

function cancellationRuntime(): RuntimeProvider {
  let provider: Promise<RuntimeProvider> | undefined;
  const get = () =>
    (provider ??= createManagedAgentsRuntimeProvider({
      apiKey: requiredRuntime('ANTHROPIC_API_KEY'),
      ownershipSecret: requiredRuntime('AGENTOS_RUNTIME_OWNERSHIP_SECRET'),
    }));
  return {
    syncAgent: async (value) => (await get()).syncAgent(value),
    syncEnvironment: async (value) => (await get()).syncEnvironment(value),
    start: async (value) => (await get()).start(value),
    reconcileStart: async (value) => (await get()).reconcileStart?.(value),
    async *events(handle) {
      yield* (await get()).events(handle);
    },
    send: async (handle, value) => (await get()).send(handle, value),
    resume: async (handle, value) => (await get()).resume(handle, value),
    cancel: async (handle, reason) => (await get()).cancel(handle, reason),
    collectOutput: async (handle) => (await get()).collectOutput(handle),
    usage: async (handle) => (await get()).usage(handle),
    cleanup: async (handle) => (await get()).cleanup(handle),
  };
}

export function workflowDispatchFromEnv() {
  const triggerSecret = process.env.TRIGGER_SECRET_KEY;
  const databaseUrl = process.env.DATABASE_URL;
  if (triggerSecret === undefined) return undefined;
  if (databaseUrl === undefined) {
    throw new Error(
      'DATABASE_URL is required when TRIGGER_SECRET_KEY enables workflow dispatch',
    );
  }
  const repository = repositoryFromEnv();
  let vault: ReturnType<typeof createRepositoryRuntimeHandleVault> | undefined;
  const runtimeHandles = () =>
    (vault ??= createRepositoryRuntimeHandleVault({
      repository,
      sealer: createAesWorkflowHandleSealer(
        Buffer.from(requiredRuntime('AGENTOS_RUNTIME_HANDLE_KEY'), 'base64url'),
      ),
    }));
  return createDurableTriggerOutbox({
    checkpoints: createNeonWorkflowCheckpointStore(process.env),
    trigger: createTriggerWorkflowDispatcher(),
    approval: createTriggerApprovalWaiter(),
    clock: () => new Date().toISOString(),
    runtime: cancellationRuntime(),
    repository,
    runtimeHandles: {
      load: (externalId, runId): Promise<RuntimeHandle> =>
        runtimeHandles().load(externalId, runId),
      markCancelled: (externalId, at) =>
        runtimeHandles().markCancelled(externalId, at),
      markCleaned: (externalId, at) =>
        runtimeHandles().markCleaned(externalId, at),
    },
  });
}

export function controlPlaneService(): ControlPlaneService {
  service ??= new ControlPlaneService(
    repositoryFromEnv(),
    () => isoTimestamp(new Date().toISOString()),
    deterministicId,
    workflowDispatchFromEnv(),
  );
  return service;
}

export function resetControlPlaneServiceForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('control-plane service reset is test-only');
  }
  service = undefined;
}
