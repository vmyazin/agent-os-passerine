import { describe, expectTypeOf, it } from 'vitest';

import type {
  ArtifactAdminStore,
  ArtifactStore,
  Clock,
  RepositoryPublisher,
  RuntimeProvider,
  UsageMeter,
} from './ports.js';

describe('core ports', () => {
  it('keeps runtime orchestration provider-neutral', () => {
    expectTypeOf<RuntimeProvider>().toHaveProperty('syncAgent');
    expectTypeOf<RuntimeProvider>().toHaveProperty('syncEnvironment');
    expectTypeOf<RuntimeProvider>().toHaveProperty('start');
    expectTypeOf<RuntimeProvider>().toHaveProperty('events');
    expectTypeOf<RuntimeProvider>().toHaveProperty('send');
    expectTypeOf<RuntimeProvider>().toHaveProperty('resume');
    expectTypeOf<RuntimeProvider>().toHaveProperty('cancel');
    expectTypeOf<RuntimeProvider>().toHaveProperty('collectOutput');
    expectTypeOf<RuntimeProvider>().toHaveProperty('usage');
    expectTypeOf<RuntimeProvider>().toHaveProperty('cleanup');
  });

  it('separates artifact administration from agent access', () => {
    expectTypeOf<ArtifactStore>().toHaveProperty('get');
    expectTypeOf<ArtifactStore>().toHaveProperty('put');
    expectTypeOf<ArtifactStore>().toHaveProperty('list');
    expectTypeOf<ArtifactStore>().not.toMatchTypeOf<{
      delete(key: string): Promise<boolean>;
    }>();
    expectTypeOf<ArtifactAdminStore>().toHaveProperty('delete');
  });

  it('only permits repository validation and draft publication', () => {
    expectTypeOf<RepositoryPublisher>().toHaveProperty('validate');
    expectTypeOf<RepositoryPublisher>().toHaveProperty('publishDraft');
    expectTypeOf<RepositoryPublisher>().not.toMatchTypeOf<{
      merge(id: string): Promise<void>;
    }>();
  });

  it('defines usage and deterministic clock boundaries', () => {
    expectTypeOf<UsageMeter>().toHaveProperty('record');
    expectTypeOf<Clock>().toHaveProperty('now');
    expectTypeOf<Clock>().toHaveProperty('sleep');
  });
});
