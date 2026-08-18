import * as os from 'node:os';
import * as path from 'node:path';

import type { RuntimeProvider } from '@agentos/core';

import type { KimiLocalAccessStore } from './access.js';
import { createKimiRuntimeProvider } from './provider.js';

type Environment = Readonly<Record<string, string | undefined>>;

/** Blank/absent `KIMI_API_KEY` is treated as "kimi is not configured". */
export function kimiFromEnv(
  environment: Environment,
): { apiKey: string; baseUrl?: string } | undefined {
  const apiKey = environment.KIMI_API_KEY?.trim();
  if (!apiKey) return undefined;
  const baseUrl = environment.KIMI_BASE_URL?.trim();
  return { apiKey, ...(baseUrl ? { baseUrl } : {}) };
}

/**
 * Shared kimi runtime provider construction, used by both the production
 * feature-workflow composition and the control plane's cancellation
 * runtime so the two call sites can't drift. Returns `undefined` exactly
 * when `kimiFromEnv(environment)` does (blank/absent `KIMI_API_KEY`).
 *
 * `wireAccessCleanup` defaults to `true`, forwarding `cleanupAccess()`
 * calls into `store.discard(...)` so staged local files/credentials are
 * released once a session's access is no longer needed. The control
 * plane's cancellation runtime passes `false`: its `KimiLocalAccessStore`
 * is a fresh, separate in-process instance from whichever Trigger worker
 * process actually staged a given resource, so nothing it could stage
 * itself ever appears there to discard -- real discard only ever happens
 * worker-side, where the resource was staged.
 */
export function createKimiRuntimeProviderFromEnv(
  environment: Environment,
  options: {
    readonly ownershipSecret: string;
    readonly artifactMcpUrl: string;
    readonly store: KimiLocalAccessStore;
    readonly wireAccessCleanup?: boolean;
  },
): RuntimeProvider | undefined {
  const kimi = kimiFromEnv(environment);
  if (kimi === undefined) return undefined;
  return createKimiRuntimeProvider({
    apiKey: kimi.apiKey,
    ...(kimi.baseUrl === undefined ? {} : { baseUrl: kimi.baseUrl }),
    ownershipSecret: options.ownershipSecret,
    sandboxRoot:
      environment.AGENTOS_KIMI_SANDBOX_ROOT?.trim() ||
      path.join(os.tmpdir(), 'agentos-kimi'),
    resolveFile: options.store.resolveFile,
    artifactMcp: {
      url: options.artifactMcpUrl,
      resolveCredential: options.store.resolveCredential,
    },
    ...(options.wireAccessCleanup === false
      ? {}
      : {
          accessCleanup: (input) =>
            options.store.discard({
              fileIds: input.resources.map((resource) => resource.fileId),
              credentialRefs: input.credentialRefs,
            }),
        }),
  });
}
