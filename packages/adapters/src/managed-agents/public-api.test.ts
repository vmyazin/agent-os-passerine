import { describe, expect, expectTypeOf, it } from 'vitest';

import type { RuntimeProvider } from '@agentos/core';

import * as publicApi from './index.js';
import type { ManagedAgentsRuntimeProviderOptions } from './index.js';

// @ts-expect-error Beta-shaped client contracts are package-internal.
import type { ManagedAgentsClient } from './index.js';
// @ts-expect-error Beta-shaped provider agent resources are package-internal.
import type { ManagedAgentsRemoteAgent } from './index.js';
// @ts-expect-error Beta-shaped provider environment resources are package-internal.
import type { ManagedAgentsRemoteEnvironment } from './index.js';
// @ts-expect-error Beta-shaped provider session resources are package-internal.
import type { ManagedAgentsRemoteSession } from './index.js';
// @ts-expect-error Beta-shaped provider events are package-internal.
import type { ManagedAgentsEvent } from './index.js';
// @ts-expect-error The concrete provider class is not publicly constructible.
import type { ManagedAgentsRuntimeProvider } from './index.js';

type ForbiddenOptionKeys = Extract<
  keyof ManagedAgentsRuntimeProviderOptions,
  'client' | 'clientFactory' | 'clock'
>;

describe('managed agents public API', () => {
  it('exports the validated factory but not the concrete provider constructor', () => {
    expect(publicApi).toHaveProperty('createManagedAgentsRuntimeProvider');
    expect(publicApi).not.toHaveProperty('ManagedAgentsRuntimeProvider');
  });

  it('keeps SDK injection and beta response shapes out of public types', () => {
    expectTypeOf<ForbiddenOptionKeys>().toEqualTypeOf<never>();
    expectTypeOf<
      Awaited<ReturnType<typeof publicApi.createManagedAgentsRuntimeProvider>>
    >().toMatchTypeOf<RuntimeProvider>();
  });
});

void (0 as unknown as ManagedAgentsClient);
void (0 as unknown as ManagedAgentsRemoteAgent);
void (0 as unknown as ManagedAgentsRemoteEnvironment);
void (0 as unknown as ManagedAgentsRemoteSession);
void (0 as unknown as ManagedAgentsEvent);
void (0 as unknown as ManagedAgentsRuntimeProvider);
