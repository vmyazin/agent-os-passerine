import { createHash } from 'node:crypto';

import {
  createDurableTriggerOutbox,
  createNeonWorkflowCheckpointStore,
  createTriggerApprovalWaiter,
  createTriggerWorkflowDispatcher,
} from '@agentos/adapters';
import { isoTimestamp, persistenceId } from '@agentos/core';

import { ControlPlaneService, type IdGenerator } from './control-plane-service';
import { repositoryFromEnv } from '../persistence/repository-factory';

const deterministicId: IdGenerator = (kind, idempotencyKey) =>
  persistenceId(
    kind,
    `${kind}_${createHash('sha256').update(`${kind}:${idempotencyKey}`).digest('hex').slice(0, 32)}`,
  );

let service: ControlPlaneService | undefined;

export function workflowDispatchFromEnv() {
  const triggerSecret = process.env.TRIGGER_SECRET_KEY;
  const databaseUrl = process.env.DATABASE_URL;
  if (triggerSecret === undefined) return undefined;
  if (databaseUrl === undefined) {
    throw new Error(
      'DATABASE_URL is required when TRIGGER_SECRET_KEY enables workflow dispatch',
    );
  }
  return createDurableTriggerOutbox({
    checkpoints: createNeonWorkflowCheckpointStore(process.env),
    trigger: createTriggerWorkflowDispatcher(),
    approval: createTriggerApprovalWaiter(),
    clock: () => new Date().toISOString(),
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
