import { createHash } from 'node:crypto';

import {
  createDurableTriggerOutbox,
  createDomainArtifactManifestStore,
  createAesWorkflowHandleSealer,
  createManagedAgentsRuntimeProvider,
  createNeonWorkflowCheckpointStore,
  createRepositoryRuntimeHandleVault,
  createRuntimeStartRecoveryResolver,
  createR2ArtifactStore,
  createTrustedSourceSnapshotIngestor,
  createTrustedRepositoryHeadResolver,
  createTriggerApprovalWaiter,
  createTriggerWorkflowDispatcher,
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
    cleanupAccess: async (input) => {
      const runtime = await get();
      if (runtime.cleanupAccess === undefined)
        throw new Error('runtime access cleanup is unavailable');
      await runtime.cleanupAccess(input);
    },
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
      if (run === undefined || run.pipeline !== 'feature')
        throw new Error('source snapshot feature run does not exist');
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
