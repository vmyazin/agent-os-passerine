import type { Clock } from '@agentos/core';

import {
  createManagedAgentsRuntimeProviderWithDependencies,
  type ManagedAgentsClientOptions,
} from './provider.js';
import type { ManagedAgentsClient } from './sdk-contract.js';
import type {
  ManagedAgentsProvider,
  ManagedAgentsRuntimeProviderOptions,
} from './types.js';

export type {
  ManagedAgentsClient,
  ManagedAgentsEvent,
  ManagedAgentsRemoteFile,
  ManagedAgentsRemoteAgent,
  ManagedAgentsRemoteEnvironment,
  ManagedAgentsRemoteSession,
} from './sdk-contract.js';

export interface ManagedAgentsTestProviderOptions extends ManagedAgentsRuntimeProviderOptions {
  readonly client?: ManagedAgentsClient;
  readonly clientFactory?: (
    options: ManagedAgentsClientOptions,
  ) => ManagedAgentsClient | Promise<ManagedAgentsClient>;
  readonly clock?: Clock;
}

/** Internal test seam; not exported by the package entry point. */
export async function createManagedAgentsRuntimeProviderForTest(
  options: ManagedAgentsTestProviderOptions,
): Promise<ManagedAgentsProvider> {
  const { client, clientFactory, clock, ...validatedOptions } = options;
  return createManagedAgentsRuntimeProviderWithDependencies(validatedOptions, {
    ...(client === undefined ? {} : { client }),
    ...(clientFactory === undefined ? {} : { clientFactory }),
    ...(clock === undefined ? {} : { clock }),
  });
}
