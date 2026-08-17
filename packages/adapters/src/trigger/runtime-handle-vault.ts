import {
  isoTimestamp,
  persistenceId,
  type DomainRepository,
  type JsonValue,
  type RuntimeHandle,
} from '@agentos/core';

import type { RuntimeHandleVault, WorkflowHandleSealer } from './types.js';

function isRecord(
  value: JsonValue | undefined,
): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createRepositoryRuntimeHandleVault(options: {
  readonly repository: DomainRepository;
  readonly sealer: WorkflowHandleSealer;
}): RuntimeHandleVault {
  const find = async (externalId: string, runId: string) => {
    const session = await options.repository.getExternalSession(
      persistenceId('externalSession', `runtime:${externalId}`),
    );
    if (
      session === undefined ||
      session.runId !== runId ||
      session.externalId !== externalId ||
      !isRecord(session.state) ||
      session.state.version !== 'sealed-runtime-handle-state-v1' ||
      typeof session.state.sealedHandle !== 'string' ||
      !isRecord(session.state.aad)
    )
      throw new Error('sealed runtime handle is unavailable or misbound');
    return session;
  };
  return Object.freeze({
    async store(
      input: Parameters<RuntimeHandleVault['store']>[0],
    ): Promise<void> {
      const id = persistenceId('externalSession', `runtime:${input.handle.id}`);
      const existing = await options.repository.getExternalSession(id);
      if (existing !== undefined) {
        if (
          existing.runId !== input.runId ||
          existing.stepRunId !== input.stepRunId ||
          existing.externalId !== input.handle.id
        )
          throw new Error(
            'sealed runtime handle conflicts with recovery state',
          );
        return;
      }
      const sealedHandle = await options.sealer.seal(input.handle, input.aad);
      await options.repository.createExternalSession({
        id,
        runId: persistenceId('run', input.runId),
        stepRunId: persistenceId('stepRun', input.stepRunId),
        provider: 'runtime',
        externalId: input.handle.id,
        status: 'active',
        state: {
          version: 'sealed-runtime-handle-state-v1',
          sealedHandle,
          aad: input.aad,
          role: input.role,
        },
        createdAt: isoTimestamp(input.at),
      });
    },
    async load(externalId: string, runId: string): Promise<RuntimeHandle> {
      const session = await find(externalId, runId);
      const state = session.state as Record<string, JsonValue>;
      const handle = await options.sealer.open(
        String(state.sealedHandle),
        state.aad!,
      );
      if (handle.id !== externalId)
        throw new Error('sealed runtime handle external ID mismatch');
      return handle;
    },
    async markCancelled(externalId: string, at: string): Promise<void> {
      const session = await find(
        externalId,
        await findRunId(options.repository, externalId),
      );
      await options.repository.updateExternalSession(session.id, {
        status: 'cancelled',
        updatedAt: isoTimestamp(at),
      });
    },
    async markCleaned(externalId: string, at: string): Promise<void> {
      const session = await options.repository.getExternalSession(
        persistenceId('externalSession', `runtime:${externalId}`),
      );
      if (session === undefined)
        throw new Error('runtime session is unavailable');
      await options.repository.updateExternalSession(session.id, {
        cleanupAt: isoTimestamp(at),
        updatedAt: isoTimestamp(at),
      });
    },
  });
}

async function findRunId(
  repository: DomainRepository,
  externalId: string,
): Promise<string> {
  const session = await repository.getExternalSession(
    persistenceId('externalSession', `runtime:${externalId}`),
  );
  if (session === undefined) throw new Error('runtime session is unavailable');
  return session.runId;
}
