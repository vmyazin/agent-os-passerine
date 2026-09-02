import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';

import {
  assertContainedRepository,
  assertReaderPublisherRepositoryPairing,
  createDurableTriggerOutbox,
  createDomainArtifactManifestStore,
  createAesWorkflowHandleSealer,
  createKimiLocalAccessStore,
  createKimiRuntimeProviderFromEnv,
  createFilesystemArtifactStorage,
  createGitHubProjectSourceReader,
  createLocalApprovalWaiter,
  createLocalDirectDispatcher,
  createLocalDirectFeatureWorkflowFromEnv,
  createLocalSourceSnapshotIngestor,
  inspectLocalProjectSource,
  listLocalProjectCommits,
  createManagedAgentsRuntimeProvider,
  createNeonWorkflowCheckpointStore,
  createTriggerSdkBoundary,
  createRepositoryRuntimeHandleVault,
  createRoutingRuntimeProvider,
  createRuntimeStartRecoveryResolver,
  createR2ArtifactStore,
  createTrustedSourceSnapshotIngestor,
  createTrustedRepositoryHeadResolver,
  createTriggerApprovalWaiter,
  createTriggerWorkflowDispatcher,
  githubOwnerNameFromUrl,
  githubRepositoryBindingKey,
  parseGitHubRepositoryAllowlist,
  recoverLocalDirectRuns,
  runGit,
  selectGitHubRepositoryFromUrl,
  kimiFromEnv,
  type TrustedSourceSnapshotIngestor,
  type GitHubProjectSourceReader,
} from '@agentos/adapters';
import {
  isoTimestamp,
  parseAgentOsConfig,
  persistenceId,
  type GitHubPublicationRepository,
  type ProjectSource,
  type ProjectSourceImportInput,
  type RuntimeHandle,
  type RuntimeProvider,
} from '@agentos/core';

import {
  ControlPlaneService,
  type IdGenerator,
  type ProjectSourceGateway,
} from './control-plane-service';
import { repositoryFromEnv } from '../persistence/repository-factory';

const deterministicId: IdGenerator = (kind, idempotencyKey) =>
  persistenceId(
    kind,
    `${kind}_${createHash('sha256').update(`${kind}:${idempotencyKey}`).digest('hex').slice(0, 32)}`,
  );

let service: ControlPlaneService | undefined;
let githubProjectSources: GitHubProjectSourceReader | undefined;

function githubProjectSourceReaderFromEnv(): GitHubProjectSourceReader {
  if (githubProjectSources !== undefined) return githubProjectSources;
  const readerAppId = Number(requiredRuntime('GITHUB_READER_APP_ID'));
  const publisherAppId = Number(process.env.GITHUB_APP_ID);
  const publisherPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY?.trim();
  githubProjectSources = createGitHubProjectSourceReader({
    readerApp: {
      appId: readerAppId,
      privateKey: requiredRuntime('GITHUB_READER_APP_PRIVATE_KEY'),
    },
    ...(Number.isSafeInteger(publisherAppId) &&
    publisherAppId > 0 &&
    publisherPrivateKey !== undefined &&
    publisherPrivateKey !== ''
      ? {
          publisherApp: {
            appId: publisherAppId,
            privateKey: publisherPrivateKey,
          },
        }
      : {}),
  });
  return githubProjectSources;
}

export function projectSourceGatewayFromEnv(): ProjectSourceGateway {
  return {
    async inspect(input: ProjectSourceImportInput) {
      if (input.kind === 'local') {
        const inspection = await inspectLocalProjectSource(input);
        return {
          inspection,
          source: {
            kind: 'local',
            sourceKey: inspection.sourceKey,
            localPath: inspection.canonicalLocation,
            defaultBranch: inspection.defaultBranch,
          },
        };
      }
      const result = await githubProjectSourceReaderFromEnv().inspect(
        input.repositoryUrl,
      );
      const { owner, name } = githubOwnerNameFromUrl(
        result.inspection.canonicalLocation,
      );
      return {
        inspection: result.inspection,
        source: {
          kind: 'github',
          sourceKey: result.inspection.sourceKey,
          repositoryUrl: result.inspection.canonicalLocation,
          owner,
          name,
          repositoryId: result.repositoryId,
          readerInstallationId: result.readerInstallationId,
          ...(result.publisherInstallationId === undefined
            ? {}
            : { publisherInstallationId: result.publisherInstallationId }),
          defaultBranch: result.inspection.defaultBranch,
        },
      };
    },
    async listCommits(source: ProjectSource, cursor?: string) {
      return source.kind === 'local'
        ? listLocalProjectCommits(source, cursor)
        : githubProjectSourceReaderFromEnv().listCommits(source, cursor);
    },
  };
}

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

function deploymentRegistryHostsFromEnv(): readonly string[] {
  const raw = process.env.AGENTOS_VERIFICATION_REGISTRY_HOSTS_JSON;
  if (raw === undefined || raw.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (host): host is string =>
      typeof host === 'string' && host.trim().length > 0,
  );
}

/**
 * The absolute directory that holds local experiment repositories, or
 * `undefined` when local experiments are not configured for this
 * deployment. Blank/whitespace-only values are treated as absent, matching
 * every other optional environment reader in this module.
 */
export function localWorkspacesRootFromEnv(): string | undefined {
  const trimmed = process.env.AGENTOS_LOCAL_WORKSPACES_ROOT?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
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

/**
 * Distinguishes "the trusted GitHub reader is misconfigured or unset" from
 * every other failure mode a repository-head resolution can hit, so the
 * `GET /api/setup/repository-head` route can map it to a 503
 * (`reader_unavailable`) instead of the generic 502
 * (`repository_head_unavailable`) it uses for resolution failures.
 */
export class ReaderConfigurationError extends Error {
  override readonly name = 'ReaderConfigurationError';
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
  const readerRepositories = parseGitHubRepositoryAllowlist(
    requiredRuntime('GITHUB_READER_SELECTED_REPOSITORIES_JSON'),
    'GITHUB_READER_SELECTED_REPOSITORIES_JSON',
  );
  const publisherRepositories = parseGitHubRepositoryAllowlist(
    requiredRuntime('GITHUB_SELECTED_REPOSITORIES_JSON'),
    'GITHUB_SELECTED_REPOSITORIES_JSON',
  );
  assertReaderPublisherRepositoryPairing(
    readerRepositories,
    publisherRepositories,
  );
  return {
    githubApp: {
      appId: readerAppId,
      privateKey: requiredRuntime('GITHUB_READER_APP_PRIVATE_KEY'),
    },
    readerRepositories,
    publisherRepositories,
  };
}

/**
 * Head resolution for the setup wizard: the same trusted-reader wiring the
 * workflow dispatch path uses, exposed so the wizard can refresh the bound
 * repository's default-branch SHA before starting a run. Also resolves
 * local experiment repositories (`config.project.localPath`) by running
 * `git rev-parse` directly against the containment-checked working tree --
 * no GitHub reader involved on that path, and the GitHub reader is built
 * lazily (and only once) so a local-only deployment never needs its env.
 */
export function repositoryHeadResolverFromEnv(): {
  resolve(config: ReturnType<typeof parseAgentOsConfig>): Promise<{
    readonly repository: string;
    readonly branch: string;
    readonly repositorySha: string;
  }>;
} {
  let github:
    | {
        readonly resolver: ReturnType<
          typeof createTrustedRepositoryHeadResolver
        >;
        readonly readerRepositories: readonly GitHubPublicationRepository[];
      }
    | undefined;
  const getGithub = () => {
    if (github === undefined) {
      let reader: ReturnType<typeof trustedReaderConfiguration>;
      try {
        reader = trustedReaderConfiguration();
      } catch (error) {
        throw new ReaderConfigurationError(
          error instanceof Error
            ? error.message
            : 'trusted reader is not configured',
        );
      }
      github = {
        resolver: createTrustedRepositoryHeadResolver({
          githubApp: reader.githubApp,
        }),
        readerRepositories: reader.readerRepositories,
      };
    }
    return github;
  };
  return {
    async resolve(config) {
      if (config.project.localPath !== undefined) {
        const workspacesRoot = localWorkspacesRootFromEnv();
        if (workspacesRoot === undefined)
          throw new Error(
            'AGENTOS_LOCAL_WORKSPACES_ROOT is required to resolve a local repository head',
          );
        const repo = await assertContainedRepository(
          config.project.localPath,
          workspacesRoot,
        );
        const repositorySha = await runGit(repo, [
          'rev-parse',
          config.project.defaultBranch,
        ]);
        return {
          repository: `local/${basename(config.project.localPath)}`,
          branch: config.project.defaultBranch,
          repositorySha,
        };
      }
      if (config.project.repository === undefined)
        throw new Error('GitHub repository URL is required');
      const { resolver, readerRepositories } = getGithub();
      const selected = selectGitHubRepositoryFromUrl(
        config.project.repository,
        readerRepositories,
      );
      const repositorySha = await resolver.resolve({
        repository: selected,
        repositoryUrl: config.project.repository,
        defaultBranch: config.project.defaultBranch,
      });
      return {
        repository: githubRepositoryBindingKey(selected),
        branch: config.project.defaultBranch,
        repositorySha,
      };
    },
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

/**
 * Which executor claims this deployment's runs.
 *
 * Exactly one executor may be active, because both claim a run by writing the
 * same outbox effects: two of them would race for the same start and the same
 * runtime session. `AGENTOS_EXECUTOR` states the choice; when it is unset the
 * answer is the historical one -- Trigger if a secret key is present, no
 * dispatcher at all otherwise.
 */
export function executorFromEnv(): 'trigger' | 'local-direct' | undefined {
  const selected = process.env.AGENTOS_EXECUTOR?.trim() ?? '';
  const triggerConfigured =
    (process.env.TRIGGER_SECRET_KEY?.trim() ?? '') !== '';
  if (selected === '') return triggerConfigured ? 'trigger' : undefined;
  if (selected === 'trigger') return 'trigger';
  if (selected === 'local-direct') {
    if (triggerConfigured)
      throw new Error(
        'AGENTOS_EXECUTOR=local-direct cannot be combined with TRIGGER_SECRET_KEY: only one executor may be active, otherwise both would claim the same run',
      );
    return 'local-direct';
  }
  throw new Error(
    `AGENTOS_EXECUTOR must be "trigger" or "local-direct" (received "${selected}")`,
  );
}

/**
 * The composed local feature workflow. Named from the factory rather than
 * imported: the task module that declares the interface also registers the
 * Trigger task, and this process must not load it.
 */
type LocalDirectFeatureWorkflow = Awaited<
  ReturnType<typeof createLocalDirectFeatureWorkflowFromEnv>
>;

/**
 * The same durable outbox the Trigger branch builds, wired to pieces that all
 * live in this process: a filesystem artifact store, the local source
 * ingestor, the database-polling approval waiter, and a dispatcher that calls
 * the feature workflow directly. Postgres stays authoritative; only the
 * coordination and execution edges move.
 */
/**
 * The cancellation runtime for the local executor.
 *
 * The cloud one (`cancellationRuntime`) exists because a Managed Agents
 * session outlives the worker that started it: a different process has to be
 * able to reach in and stop it, which is why it needs credentials and an
 * artifact MCP URL. Neither statement is true here. A local session is an
 * object in this process, owned by the composition's own provider, and the
 * dispatcher's abort -- delivered through `trigger.cancel(externalRunRef)` in
 * the same cancellation flow -- is what actually stops it.
 *
 * So these are deliberate no-ops rather than an oversight, and they are not a
 * silent success: a session this process cannot see is a session that is
 * already gone, because it could only ever have lived here. Every method the
 * cancellation path does not use throws instead of pretending, so a future
 * caller finds out rather than getting a plausible answer.
 */
export function localCancellationRuntime(): RuntimeProvider {
  const unsupported = (method: string) => (): never => {
    throw new Error(
      `the local-direct executor's cancellation runtime does not implement ${method}: local sessions are owned by the process that started them`,
    );
  };
  return {
    syncAgent: async () => undefined,
    syncEnvironment: async () => undefined,
    start: unsupported('start'),
    events: unsupported('events'),
    send: unsupported('send'),
    resume: unsupported('resume'),
    collectOutput: unsupported('collectOutput'),
    usage: unsupported('usage'),
    // Nothing remote holds this session, and nothing outlives the process.
    cancel: async () => undefined,
    cleanup: async () => undefined,
    cleanupAccess: async () => undefined,
  } as unknown as RuntimeProvider;
}

/**
 * Restart recovery is a once-per-process sweep, not a per-dispatch one. The
 * flag lives at module scope because `localDirectDispatchFromEnv` may be
 * called more than once in a process (tests, a re-read of the environment),
 * and a second sweep would race the first for the same runs.
 */
let localDirectRecoveryStarted = false;

function localDirectDispatchFromEnv() {
  const repository = repositoryFromEnv();
  const checkpoints = createNeonWorkflowCheckpointStore(process.env);
  const stateDirectory = requiredRuntime('AGENTOS_LOCAL_STATE_DIR');
  // The very same root the local composition uses, so the ingestor writing a
  // source snapshot here and the workflow reading it there are one store.
  const artifacts = createFilesystemArtifactStorage({
    root: join(stateDirectory, 'artifacts'),
    manifest: createDomainArtifactManifestStore(repository),
  }).store;

  const resolveSourceSnapshotRun = async (runId: string) => {
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
    return { run, config, repositorySha };
  };

  let localIngestor: TrustedSourceSnapshotIngestor | undefined;
  const getLocalIngestor = (): TrustedSourceSnapshotIngestor =>
    (localIngestor ??= createLocalSourceSnapshotIngestor({
      artifacts,
      workspacesRoot:
        localWorkspacesRootFromEnv() ??
        (() => {
          throw new Error(
            'AGENTOS_LOCAL_WORKSPACES_ROOT is required to ingest local experiment source snapshots',
          );
        })(),
      resolveBinding: async (runId) => {
        const resolved = await resolveSourceSnapshotRun(runId);
        const localPath = resolved.config.project.localPath;
        if (localPath === undefined)
          throw new Error(
            'source snapshot binding is not a local experiment run',
          );
        return {
          projectId: resolved.run.projectId,
          runId: resolved.run.id,
          localPath,
          baseBranch: resolved.config.project.defaultBranch,
          repositorySha: resolved.repositorySha,
        };
      },
    }));

  const sourceSnapshot: TrustedSourceSnapshotIngestor = {
    async ensure(runId) {
      const resolved = await resolveSourceSnapshotRun(runId);
      if (resolved.config.project.localPath === undefined)
        throw new Error(
          'the local-direct executor runs local projects only; this run has no project.localPath in its config, so use the Trigger executor for it',
        );
      return getLocalIngestor().ensure(runId);
    },
  };

  let vault: ReturnType<typeof createRepositoryRuntimeHandleVault> | undefined;
  const runtimeHandles = () =>
    (vault ??= createRepositoryRuntimeHandleVault({
      repository,
      sealer: createAesWorkflowHandleSealer(
        Buffer.from(requiredRuntime('AGENTOS_RUNTIME_HANDLE_KEY'), 'base64url'),
      ),
    }));

  // Composed on first dispatch, not here: an unconfigured environment should
  // report the local executor's missing variables by name from the
  // composition, rather than failing the whole control plane at import time.
  let composed: Promise<LocalDirectFeatureWorkflow> | undefined;
  const handlerOnce = () =>
    (composed ??= createLocalDirectFeatureWorkflowFromEnv(process.env));

  const outbox = createDurableTriggerOutbox({
    checkpoints,
    trigger: createLocalDirectDispatcher({
      handler: {
        // The dispatcher builds the very payload and execution context the
        // Trigger task builds (`feature-task-payload-v1`); the structural
        // `unknown` on its side only keeps the Trigger types out of a process
        // that has left Trigger behind.
        run: async (payload, execution) =>
          (await handlerOnce()).run(
            payload as Parameters<LocalDirectFeatureWorkflow['run']>[0],
            execution as Parameters<LocalDirectFeatureWorkflow['run']>[1],
          ),
      },
    }),
    approval: createLocalApprovalWaiter({ repository }),
    clock: () => new Date().toISOString(),
    runtime: localCancellationRuntime(),
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
    // Deliberately absent. Start recovery exists to reconcile a cloud session
    // whose start may or may not have landed while the process was away; a
    // local session lives in this process and is recovered by resume instead.
    sourceSnapshot,
  });

  // Fire-and-forget, and once per process. This sweep reopens the runs the
  // *previous* process died holding -- nothing in this process is waiting on
  // its answer, and the control plane must come up whether or not it works.
  // Awaiting it would put a database round-trip per stranded run in front of
  // boot; letting it throw would take the app down over runs that are already
  // stuck. A sweep that fails leaves those runs exactly as it found them, and
  // the next restart tries again.
  if (!localDirectRecoveryStarted) {
    localDirectRecoveryStarted = true;
    void recoverLocalDirectRuns({
      repository,
      checkpoints,
      dispatch: async ({ runId, pipeline, resumeGeneration }) => {
        if (pipeline !== 'feature' && pipeline !== 'goal')
          throw new Error(`run ${runId} has no dispatchable pipeline`);
        await outbox.requestStart({
          // The same key the operator-driven resume mints, so a resume and a
          // recovery of one run at one generation are one dispatch.
          idempotencyKey: `workflow-start:${runId}:resume:${String(resumeGeneration)}`,
          runId,
          pipeline,
          resumeGeneration,
        });
      },
    }).catch((error: unknown) => {
      console.error('local-direct restart recovery failed', error);
    });
  }

  return outbox;
}

export function workflowDispatchFromEnv() {
  const executor = executorFromEnv();
  if (executor === undefined) return undefined;
  if (executor === 'local-direct') return localDirectDispatchFromEnv();
  const triggerSecret = process.env.TRIGGER_SECRET_KEY?.trim() || undefined;
  const databaseUrl = process.env.DATABASE_URL?.trim() || undefined;
  if (triggerSecret === undefined) return undefined;
  if (databaseUrl === undefined) {
    throw new Error(
      'DATABASE_URL is required when TRIGGER_SECRET_KEY enables workflow dispatch',
    );
  }
  const repository = repositoryFromEnv();
  // A deployment validates its trusted reader configuration eagerly, at
  // this exact point, whenever there is any indication it might actually
  // need a GitHub reader: either it has not opted into local experiments at
  // all (no AGENTOS_LOCAL_WORKSPACES_ROOT -- the classic, pre-local-
  // experiments deployment shape), or it HAS opted in but has also started
  // configuring a reader App (GITHUB_READER_APP_ID set) -- a
  // GitHub-and-local deployment should discover a broken reader (e.g.
  // reusing the publisher App identity) at construction time, not mid-
  // dispatch the first time a GitHub-bound run needs it. Only a genuinely
  // local-only deployment -- local workspaces configured AND no reader App
  // id set at all -- defers reader construction into the GitHub ingestor's
  // lazy branch further down, since that deployment may never need a
  // GitHub reader and must not be required to configure one.
  const eagerReader =
    localWorkspacesRootFromEnv() === undefined ||
    (process.env.GITHUB_READER_APP_ID?.trim() ?? '') !== ''
      ? trustedReaderConfiguration()
      : undefined;
  const artifacts = createR2ArtifactStore({
    accountId: requiredRuntime('CLOUDFLARE_R2_ACCOUNT_ID'),
    bucket: requiredRuntime('CLOUDFLARE_R2_ARTIFACT_BUCKET'),
    accessKeyId: requiredRuntime('CLOUDFLARE_R2_ARTIFACT_ACCESS_KEY_ID'),
    secretAccessKey: requiredRuntime(
      'CLOUDFLARE_R2_ARTIFACT_SECRET_ACCESS_KEY',
    ),
    manifest: createDomainArtifactManifestStore(repository),
  });

  /**
   * Loads the run + its (unique) config snapshot and validates the
   * SHA-binding invariant every source-ingestion path depends on. Shared by
   * both the GitHub and local resolveBinding closures below so the
   * binding-integrity checks (SHA regex, snapshot repositorySha equality)
   * live in exactly one place.
   */
  const resolveSourceSnapshotRun = async (runId: string) => {
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
    return { run, config, repositorySha };
  };

  // Built lazily, one ingestor per allowlisted repository: the GitHub
  // ingestor needs the trusted reader env (GITHUB_READER_*), which a
  // local-only deployment must not be required to set.
  const githubIngestors = new Map<string, TrustedSourceSnapshotIngestor>();
  const getGithubIngestor = (
    repository: GitHubPublicationRepository,
  ): TrustedSourceSnapshotIngestor => {
    const cacheKey = githubRepositoryBindingKey(repository);
    const cached = githubIngestors.get(cacheKey);
    if (cached !== undefined) return cached;
    const reader = eagerReader ?? trustedReaderConfiguration();
    const ingestor = createTrustedSourceSnapshotIngestor({
      githubApp: { ...reader.githubApp },
      artifacts,
      resolveBinding: async (runId) => {
        const resolved = await resolveSourceSnapshotRun(runId);
        if (resolved.config.project.repository === undefined)
          throw new Error('source snapshot binding is not a GitHub run');
        const selected = selectGitHubRepositoryFromUrl(
          resolved.config.project.repository,
          reader.readerRepositories,
        );
        if (githubRepositoryBindingKey(selected) !== cacheKey)
          throw new Error('source snapshot repository binding mismatch');
        return {
          projectId: resolved.run.projectId,
          runId: resolved.run.id,
          repositorySha: resolved.repositorySha,
          baseBranch: resolved.config.project.defaultBranch,
          repository: selected,
        };
      },
    });
    githubIngestors.set(cacheKey, ingestor);
    return ingestor;
  };

  let localIngestor: TrustedSourceSnapshotIngestor | undefined;
  const getLocalIngestor = (): TrustedSourceSnapshotIngestor =>
    (localIngestor ??= createLocalSourceSnapshotIngestor({
      artifacts,
      workspacesRoot:
        localWorkspacesRootFromEnv() ??
        (() => {
          throw new Error(
            'AGENTOS_LOCAL_WORKSPACES_ROOT is required to ingest local experiment source snapshots',
          );
        })(),
      resolveBinding: async (runId) => {
        const resolved = await resolveSourceSnapshotRun(runId);
        const localPath = resolved.config.project.localPath;
        if (localPath === undefined)
          throw new Error(
            'source snapshot binding is not a local experiment run',
          );
        return {
          projectId: resolved.run.projectId,
          runId: resolved.run.id,
          localPath,
          baseBranch: resolved.config.project.defaultBranch,
          repositorySha: resolved.repositorySha,
        };
      },
    }));

  const sourceSnapshot: TrustedSourceSnapshotIngestor = {
    async ensure(runId) {
      const resolved = await resolveSourceSnapshotRun(runId);
      if (resolved.config.project.localPath !== undefined)
        return getLocalIngestor().ensure(runId);
      if (resolved.config.project.repository === undefined)
        throw new Error('source snapshot binding requires a repository URL');
      const reader = eagerReader ?? trustedReaderConfiguration();
      const selected = selectGitHubRepositoryFromUrl(
        resolved.config.project.repository,
        reader.readerRepositories,
      );
      return getGithubIngestor(selected).ensure(runId);
    },
  };
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

/**
 * Approval summaries read spec/DoD artifact bodies; without R2 env the inbox
 * degrades to bare approvals instead of failing. The seed route writes
 * through this same store so a seeded approval renders the way a real one
 * does.
 */
export function approvalArtifactStoreFromEnv() {
  // Follow the executor. The local one keeps artifact bodies on disk, and
  // without this the inbox degrades to bare approvals -- which means the
  // operator approves a Definition of Done without seeing the acceptance
  // tests it froze, defeating the point of that gate.
  if (executorFromEnv() === 'local-direct') {
    const stateDirectory = process.env.AGENTOS_LOCAL_STATE_DIR?.trim();
    if (!stateDirectory) return undefined;
    return createFilesystemArtifactStorage({
      root: join(stateDirectory, 'artifacts'),
      manifest: createDomainArtifactManifestStore(repositoryFromEnv()),
    }).store;
  }
  const configured =
    (process.env.CLOUDFLARE_R2_ACCOUNT_ID?.trim() ?? '') !== '' &&
    (process.env.CLOUDFLARE_R2_ARTIFACT_BUCKET?.trim() ?? '') !== '' &&
    (process.env.CLOUDFLARE_R2_ARTIFACT_ACCESS_KEY_ID?.trim() ?? '') !== '' &&
    (process.env.CLOUDFLARE_R2_ARTIFACT_SECRET_ACCESS_KEY?.trim() ?? '') !== '';
  if (!configured) return undefined;
  return createR2ArtifactStore({
    accountId: requiredRuntime('CLOUDFLARE_R2_ACCOUNT_ID'),
    bucket: requiredRuntime('CLOUDFLARE_R2_ARTIFACT_BUCKET'),
    accessKeyId: requiredRuntime('CLOUDFLARE_R2_ARTIFACT_ACCESS_KEY_ID'),
    secretAccessKey: requiredRuntime(
      'CLOUDFLARE_R2_ARTIFACT_SECRET_ACCESS_KEY',
    ),
    manifest: createDomainArtifactManifestStore(repositoryFromEnv()),
  });
}

/**
 * The workflow checkpoint store, when this deployment has one. Reading the
 * dispatch record needs it; a deployment without a database simply has no
 * record to show.
 */
export function workflowCheckpointsFromEnv() {
  if ((process.env.DATABASE_URL?.trim() ?? '') === '') return undefined;
  try {
    return createNeonWorkflowCheckpointStore(process.env);
  } catch {
    return undefined;
  }
}

/**
 * What Trigger says about a run this control plane handed off.
 *
 * Enqueueing succeeds whether or not a worker exists, so this is the only
 * source that can distinguish "queued behind other work" from "waiting for a
 * worker that will never arrive". Gated on the same key that enables
 * dispatch, and silent when it cannot answer.
 */
export async function externalRunStateFromEnv(
  externalRef: string,
): Promise<{ readonly status: string; readonly error?: string } | undefined> {
  if ((process.env.TRIGGER_SECRET_KEY?.trim() ?? '') === '') return undefined;
  try {
    return await createTriggerSdkBoundary().retrieveRun(externalRef);
  } catch {
    return undefined;
  }
}

export function controlPlaneService(): ControlPlaneService {
  if (service === undefined) {
    const dispatch = workflowDispatchFromEnv();
    // Provenance head resolution during configuration apply goes through the
    // same mode-aware resolver the setup wizard uses, so local experiment
    // configs resolve against their local repository instead of requiring a
    // GitHub reader.
    const repositoryHead =
      dispatch === undefined
        ? undefined
        : (() => {
            const resolver = repositoryHeadResolverFromEnv();
            return {
              resolve: async (config: ReturnType<typeof parseAgentOsConfig>) =>
                (await resolver.resolve(config)).repositorySha,
            };
          })();
    const approvalArtifacts = approvalArtifactStoreFromEnv();
    service = new ControlPlaneService(
      repositoryFromEnv(),
      () => isoTimestamp(new Date().toISOString()),
      deterministicId,
      dispatch,
      repositoryHead,
      trustedGoalCommandsFromEnv(),
      deploymentRegistryHostsFromEnv(),
      approvalArtifacts,
      projectSourceGatewayFromEnv(),
      // Resuming needs to clear the checkpoints that refuse a replay, so a
      // deployment without a database simply cannot offer it.
      workflowCheckpointsFromEnv(),
    );
  }
  return service;
}

export function resetControlPlaneServiceForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('control-plane service reset is test-only');
  }
  service = undefined;
  githubProjectSources = undefined;
}
