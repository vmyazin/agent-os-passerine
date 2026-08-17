import { createHash } from 'node:crypto';

import { isoTimestamp, persistenceId } from '@agentos/core';

import { ControlPlaneService, type IdGenerator } from './control-plane-service';
import { repositoryFromEnv } from '../persistence/repository-factory';

const deterministicId: IdGenerator = (kind, idempotencyKey) =>
  persistenceId(
    kind,
    `${kind}_${createHash('sha256').update(`${kind}:${idempotencyKey}`).digest('hex').slice(0, 32)}`,
  );

let service: ControlPlaneService | undefined;

export function controlPlaneService(): ControlPlaneService {
  service ??= new ControlPlaneService(
    repositoryFromEnv(),
    () => isoTimestamp(new Date().toISOString()),
    deterministicId,
  );
  return service;
}
