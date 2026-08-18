import { createHash } from 'node:crypto';

import {
  createDurableTriggerOutbox,
  createDomainArtifactManifestStore,
  createAesWorkflowHandleSealer,
  createKimiLocalAccessStore,
  createKimiRuntimeProviderFromEnv,
  createManagedAgentsRuntimeProvider,
  createNeonWorkflowCheckpointStore,
  createRepositoryRuntimeHandleVault,
  createRoutingRuntimeProvider,
  createRuntimeStartRecoveryResolver,
  createR2ArtifactStore,
  createTrustedSourceSnapshotIngestor,
  createTrustedRepositoryHeadResolver,
  createTriggerApprovalWaiter,
  createTriggerWorkflowDispatcher,
  kimiFromEnv,
} from '@agentos/adapters';
import {
  isoTimestamp,
  parseAgentOsConfig,
  persistenceId,
  type PublicationManifestBody,
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

/** Goal creation stays fail-closed when the trusted allowlist is absent. */
function trustedGoalCommandsFromEnv(): ReadonlySet<string> | undefined {
  const raw = process.env.AGENTOS_TRUSTED_TEST_COMMANDS_JSON;
  if (raw === undefined || raw.trim() === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    return undefined;
  const keys = Object.keys(parsed).filter((key) => key.trim().length > 0);
  return keys.length > 0 ? new Set(keys) : undefined;
}

function requiredRuntime(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '')
    throw new Error(`${name} is required to control an active runtime session`);
  return value;
}

function parsedRuntimeJson<T>(name: string): T {
  try {
    return JSON.parse(requiredRuntime(name)) as T;
  } catch {
    throw new Error(`${name} must contain valid JSON`);
  }
}

function trustedReaderConfiguration() {
  const readerAppId = Number(requiredRuntime('GITHUB_READER_APP_ID'));
  const publisherAppId = Number(requiredRuntime('GITHUB_APP_ID'));
  if (
    !Number.isSafeInteger(readerAppId) ||
    readerAppId <= 0 ||
    readerAppId === publisherAppId
  )
    throw new Error(
      'GITHUB_READER_APP_ID must identify a separate read-only GitHub App',
    );
  const selectedRepositories = parsedRuntimeJson<
    PublicationManifestBody['repository'][]
  >('GITHUB_READER_SELECTED_REPOSITORIES_JSON');
  if (selectedRepositories.length !== 1)
    throw new Error('the POC requires exactly one selected reader repository');
  const publisherRepositories = parsedRuntimeJson<
    PublicationManifestBody['repository'][]
  >('GITHUB_SELECTED_REPOSITORIES_JSON');
  const readerRepository = selectedRepositories[0]!;
  const publisherRepository = publisherRepositories[0];
  if (
    publisherRepositories.length !== 1 ||
    publisherRepository === undefined ||
    publisherRepository.owner !== readerRepository.owner ||
    publisherRepository.name !== readerRepository.name ||
    publisherRepository.repositoryId !== readerRepository.repositoryId
  )
    throw new Error(
      'reader and publisher GitHub Apps must bind the same selected repository',
    );
  return {
    githubApp: {
      appId: readerAppId,
      privateKey: requiredRuntime('GITHUB_READER_APP_PRIVATE_KEY'),
    },
    selectedRepositories,
  };
}

function verificationRegistryHosts(): readonly string[] {
  const hosts = parsedRuntimeJson<unknown>(
    'AGENTOS_VERIFICATION_REGISTRY_HOSTS_JSON',
  );
  if (
    !Array.isArray(hosts) ||
    hosts.length < 1 ||
    hosts.length > 4 ||
    hosts.some(
      (host) =>
        typeof host !== 'string' ||
        host.length > 253 ||
        !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host),
    )
  )
    throw new Error(
      'AGENTOS_VERIFICATION_REGISTRY_HOSTS_JSON must contain 1-4 exact registry hosts',
    );
  return hosts;
}

// The routing facade's handle-id prefix for kimi-owned handles
// (createRoutingRuntimeProvider's HANDLE_DELIMITER is a single space).
const KIMI_HANDLE_PREFIX = 'kimi ';

/**
 * Guards every handle-consuming method against a stored `kimi <id>` handle
 * arriving while kimi is *not* currently built (e.g. KIMI_API_KEY was
 * removed from the environment after the handle was persisted). Without
 * this, the bare (unwrapped) managed provider would receive the raw
 * prefixed string as if it were one of its own session ids and forward it
 * straight to the Anthropic SDK. Never wrap bare managed handles in the
 * routing facade to "fix" this instead -- unprefixed managed handle ids
 * must keep working exactly as they always have.
 */
export function assertKimiHandleSupported(
  handle: RuntimeHandle,
  kimiConfigured: boolean,
): void {
  if (!kimiConfigured && handle.id.startsWith(KIMI_HANDLE_PREFIX)) {
    throw new Error(
      `kimi runtime is not configured; cannot operate on handle '${handle.id}'`,
    );
  }
}

/**
 * Composes the control plane's recovery/cancellation runtime from an
 * already-built managed provider and (when configured) the kimi provider.
 *
 * Dispatch is entirely handle-id driven: a `kimi <id>` handle reaches the
 * kimi provider, and a bare (unprefixed) handle -- what every managed-only
 * run's Trigger worker persists, since that composition never builds a
 * routing facade at all -- passes through to the managed provider byte for
 * byte.
 *
 * `start`/`reconcileStart` deliberately bypass the facade and bind straight
 * to the managed provider. This recovery path never calls `syncAgent`, so
 * the facade could only ever route them to the default provider anyway --
 * but it would also *prefix* the handle it returned (`managed <id>`),
 * persisting an id shape the Trigger worker never produces for the same
 * session. Binding directly keeps both processes agreeing byte for byte on
 * what a managed handle id looks like.
 */
export function composeCancellationRuntime(input: {
  readonly managed: RuntimeProvider;
  readonly kimi: RuntimeProvider | undefined;
}): RuntimeProvider {
  const { managed, kimi } = input;
  if (kimi === undefined) return managed;
  const routed = createRoutingRuntimeProvider({
    providers: { managed, kimi },
    defaultProvider: 'managed',
    route: () => undefined,
  });
  return {
    ...routed,
    start: (request) => managed.start(request),
    reconcileStart: async (request) => managed.reconcileStart?.(request),
  };
}

async function buildCancellationRuntime(): Promise<RuntimeProvider> {
  const ownershipSecret = requiredRuntime('AGENTOS_RUNTIME_OWNERSHIP_SECRET');
  const managed = await createManagedAgentsRuntimeProvider({
    apiKey: requiredRuntime('ANTHROPIC_API_KEY'),
    ownershipSecret,
  });
  // The control plane's KimiLocalAccessStore is a fresh, separate
  // in-process instance from whichever Trigger worker actually staged a
  // given resource, so wireAccessCleanup: false keeps this side's
  // cleanupAccess a no-op -- real discard only ever happens worker-side,
  // where the resource was staged (see createKimiRuntimeProviderFromEnv).
  const kimiProvider = createKimiRuntimeProviderFromEnv(process.env, {
    ownershipSecret,
    artifactMcpUrl: requiredRuntime('AGENTOS_ARTIFACT_MCP_URL'),
    store: createKimiLocalAccessStore(),
    wireAccessCleanup: false,
  });
  return composeCancellationRuntime({ managed, kimi: kimiProvider });
}

function cancellationRuntime(): RuntimeProvider {
  let provider: Promise<RuntimeProvider> | undefined;
  const get = () => (provider ??= buildCancellationRuntime());
  // Re-checked per call (cheap, pure) rather than cached at construction
  // time, so this always reflects the environment as it is right now.
  const kimiConfigured = () => kimiFromEnv(process.env) !== undefined;
  return {
    syncAgent: async (value) => (await get()).syncAgent(value),
    syncEnvironment: async (value) => (await get()).syncEnvironment(value),
    start: async (value) => (await get()).start(value),
    reconcileStart: async (value) => (await get()).reconcileStart?.(value),
    async *events(handle) {
      assertKimiHandleSupported(handle, kimiConfigured());
      yield* (await get()).events(handle);
    },
    send: async (handle, value) => {
      assertKimiHandleSupported(handle, kimiConfigured());
      await (await get()).send(handle, value);
    },
    resume: async (handle, value) => {
      assertKimiHandleSupported(handle, kimiConfigured());
      await (await get()).resume(handle, value);
    },
    cancel: async (handle, reason) => {
      assertKimiHandleSupported(handle, kimiConfigured());
      await (await get()).cancel(handle, reason);
    },
    collectOutput: async (handle) => {
      assertKimiHandleSupported(handle, kimiConfigured());
      return (await get()).collectOutput(handle);
    },
    usage: async (handle) => {
      assertKimiHandleSupported(handle, kimiConfigured());
      return (await get()).usage(handle);
    },
    cleanup: async (handle) => {
      assertKimiHandleSupported(handle, kimiConfigured());
      await (await get()).cleanup(handle);
    },
    cleanupAccess: async (input) => {
      const runtime = await get();
      if (runtime.cleanupAccess === undefined)
        throw new Error('runtime access cleanup is unavailable');
      await runtime.cleanupAccess(input);
    },
  };
}

export function workflowDispatchFromEnv() {
  const triggerSecret = process.env.TRIGGER_SECRET_KEY?.trim() || undefined;
  const databaseUrl = process.env.DATABASE_URL?.trim() || undefined;
  if (triggerSecret === undefined) return undefined;
  if (databaseUrl === undefined) {
    throw new Error(
      'DATABASE_URL is required when TRIGGER_SECRET_KEY enables workflow dispatch',
    );
  }
  const repository = repositoryFromEnv();
  const reader = trustedReaderConfiguration();
  const artifacts = createR2ArtifactStore({
    accountId: requiredRuntime('CLOUDFLARE_R2_ACCOUNT_ID'),
    bucket: requiredRuntime('CLOUDFLARE_R2_ARTIFACT_BUCKET'),
    accessKeyId: requiredRuntime('CLOUDFLARE_R2_ARTIFACT_ACCESS_KEY_ID'),
    secretAccessKey: requiredRuntime(
      'CLOUDFLARE_R2_ARTIFACT_SECRET_ACCESS_KEY',
    ),
    manifest: createDomainArtifactManifestStore(repository),
  });
  const sourceSnapshot = createTrustedSourceSnapshotIngestor({
    githubApp: {
      ...reader.githubApp,
    },
    artifacts,
    resolveBinding: async (runId) => {
      const run = await repository.getRun(persistenceId('run', runId));
      if (
        run === undefined ||
        (run.pipeline !== 'feature' && run.pipeline !== 'goal')
      )
        throw new Error('source snapshot workflow run does not exist');
      const snapshots = await repository.listConfigSnapshots(run.id, {
        limit: 2,
      });
      if (snapshots.length !== 1)
        throw new Error('source snapshot config binding is unavailable');
      const config = parseAgentOsConfig(snapshots[0]!.config);
      const provenance = run.input as {
        provenance?: { repositorySha?: unknown };
      };
      const repositorySha = provenance.provenance?.repositorySha;
      if (
        typeof repositorySha !== 'string' ||
        !/^[0-9a-f]{40}$/.test(repositorySha) ||
        repositorySha !== snapshots[0]!.repositorySha
      )
        throw new Error('source snapshot repository SHA binding is invalid');
      return {
        projectId: run.projectId,
        runId: run.id,
        repositorySha,
        baseBranch: config.project.defaultBranch,
        repository: reader.selectedRepositories[0]!,
      };
    },
  });
  let vault: ReturnType<typeof createRepositoryRuntimeHandleVault> | undefined;
  const runtimeHandles = () =>
    (vault ??= createRepositoryRuntimeHandleVault({
      repository,
      sealer: createAesWorkflowHandleSealer(
        Buffer.from(requiredRuntime('AGENTOS_RUNTIME_HANDLE_KEY'), 'base64url'),
      ),
    }));
  const checkpoints = createNeonWorkflowCheckpointStore(process.env);
  return createDurableTriggerOutbox({
    checkpoints,
    trigger: createTriggerWorkflowDispatcher(),
    approval: createTriggerApprovalWaiter(),
    clock: () => new Date().toISOString(),
    runtime: cancellationRuntime(),
    repository,
    runtimeHandles: {
      store: (input) => runtimeHandles().store(input),
      load: (externalId, runId): Promise<RuntimeHandle> =>
        runtimeHandles().load(externalId, runId),
      markCancelled: (externalId, at) =>
        runtimeHandles().markCancelled(externalId, at),
      markCleaned: (externalId, at) =>
        runtimeHandles().markCleaned(externalId, at),
    },
    runtimeStartRecovery: createRuntimeStartRecoveryResolver({
      repository,
      checkpoints,
      artifactMcpUrl: requiredRuntime('AGENTOS_ARTIFACT_MCP_URL'),
      verificationRegistryHosts: verificationRegistryHosts(),
    }),
    sourceSnapshot,
  });
}

export function controlPlaneService(): ControlPlaneService {
  if (service === undefined) {
    const dispatch = workflowDispatchFromEnv();
    const repositoryHead =
      dispatch === undefined
        ? undefined
        : (() => {
            const reader = trustedReaderConfiguration();
            const resolver = createTrustedRepositoryHeadResolver({
              githubApp: reader.githubApp,
            });
            return {
              resolve: (config: ReturnType<typeof parseAgentOsConfig>) => {
                if (config.project.repository === undefined)
                  throw new Error('GitHub repository URL is required');
                return resolver.resolve({
                  repository: reader.selectedRepositories[0]!,
                  repositoryUrl: config.project.repository,
                  defaultBranch: config.project.defaultBranch,
                });
              },
            };
          })();
    service = new ControlPlaneService(
      repositoryFromEnv(),
      () => isoTimestamp(new Date().toISOString()),
      deterministicId,
      dispatch,
      repositoryHead,
      trustedGoalCommandsFromEnv(),
    );
  }
  return service;
}

export function resetControlPlaneServiceForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('control-plane service reset is test-only');
  }
  service = undefined;
}
