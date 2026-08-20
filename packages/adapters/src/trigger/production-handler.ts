import { createHash } from 'node:crypto';

import {
  calculateUsageCost,
  canonicalPublicationManifestDigest,
  canonicalPublicationPolicyDigest,
  canonicalJsonValue,
  createArtifactCapabilityIssuer,
  createHmacAttestationIssuer,
  createHmacAttestationVerifier,
  createVerifierRegistry,
  isoTimestamp,
  normalizePublicationPolicySnapshot,
  parseAgentOsConfig,
  persistenceId,
  registerVerifier,
  type AgentOsConfig,
  type ArtifactCapabilityKey,
  type ArtifactMetadata,
  type ConfigSnapshot,
  type PublicationAuthorizationClaims,
  type PublicationManifestBody,
  type RuntimeAgent,
  type RuntimeProvider,
} from '@agentos/core';
import { z } from 'zod';

import { createDomainArtifactManifestStore } from '../artifacts/manifest.js';
import { createR2ArtifactStore } from '../artifacts/r2.js';
import type { TrustedPublicationPolicyResolver } from '../github/service.js';
import { createKimiLocalAccessStore } from '../kimi/access.js';
import {
  createKimiRuntimeProviderFromEnv,
  kimiFromEnv,
} from '../kimi/from-env.js';
import { createManagedAgentsRuntimeProvider } from '../managed-agents/provider.js';
import { createNeonDomainRepositoryFromEnv } from '../persistence/neon-repository.js';
import { createRoutingRuntimeProvider } from '../runtime/routing.js';
import { createAesWorkflowHandleSealer } from './handle-sealer.js';
import { createFeatureGoalStepRunner } from './goal-feature-runner.js';
import { createGoalWorkflowTaskHandler } from './goal-task-handler.js';
import { createTrustedGoalCommandVerifier } from './goal-verifier.js';
import { createDurableGoalWorkflow } from './goal-workflow.js';
import { createNeonWorkflowCheckpointStore } from './postgres-checkpoint-store.js';
import {
  composePublicationTarget,
  resolveFeatureRolesFromSnapshot,
} from './production-composition.js';
import type { FeatureWorkflowTaskHandler } from './task.js';
import { createFeatureWorkflowTaskHandler } from './task-handler.js';
import { createTriggerApprovalWaiter } from './trigger-adapter.js';
import type {
  FeatureWorkflowRoles,
  WorkflowPublicationAuthority,
} from './types.js';
import { createTrustedWorkflowVerifier } from './verifier.js';
import { createDurableFeatureWorkflow } from './workflow.js';

type Environment = Readonly<Record<string, string | undefined>>;

const sourceBundleSchema = z
  .object({
    version: z.literal('source-bundle-v1'),
    repository: z.union([
      z
        .object({
          owner: z.string().min(1).max(100),
          name: z.string().min(1).max(100),
          repositoryId: z.number().int().positive().safe(),
        })
        .strict(),
      z
        .object({
          kind: z.literal('local'),
          owner: z.literal('local'),
          name: z
            .string()
            .regex(/^(?!\.)(?!.*\.git$)[A-Za-z0-9._-]{1,100}$/i),
        })
        .strict(),
    ]),
    baseBranch: z.string().min(1).max(255),
    repositorySha: z.string().regex(/^[0-9a-f]{40}$/),
    treeSha: z.string().regex(/^[0-9a-f]{40}$/),
    files: z
      .array(
        z
          .object({
            path: z.string().min(1).max(1024),
            mode: z.enum(['100644', '100755']),
            content: z.string().max(1_000_000),
          })
          .strict(),
      )
      .max(5_000),
  })
  .strict();

const changeSetSchema = z
  .object({
    version: z.literal('change-set-v1'),
    changes: z
      .array(
        z.discriminatedUnion('operation', [
          z
            .object({
              operation: z.enum(['add', 'modify']),
              path: z.string().min(1).max(1024),
              mode: z.enum(['100644', '100755']),
              content: z.string().max(1_000_000),
            })
            .strict(),
          z
            .object({
              operation: z.literal('delete'),
              path: z.string().min(1).max(1024),
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(100),
  })
  .strict();

const featureWorkflowResultSchema = z
  .object({
    status: z.enum([
      'succeeded',
      'rejected',
      'expired',
      'cancelled',
      'budget_exhausted',
      'failed',
    ]),
    draftPullRequestUrl: z.url().max(2_048).optional(),
    localBranch: z.string().max(512).optional(),
    localRepositoryUrl: z.url().max(2_048).optional(),
    reason: z.string().max(1_000).optional(),
  })
  .strict();

function required(environment: Environment, name: string): string {
  const value = environment[name];
  if (value === undefined || value.trim() === '')
    throw new Error(`${name} is required for the production feature workflow`);
  return value;
}

function parsedJson<T>(environment: Environment, name: string): T {
  try {
    return JSON.parse(required(environment, name)) as T;
  } catch {
    throw new Error(`${name} must contain valid JSON`);
  }
}

function collectArtifactMetadata(value: unknown): ArtifactMetadata[] {
  const result = new Map<string, ArtifactMetadata>();
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > 8 || result.size > 24)
      throw new Error('runtime input artifact manifest is too complex');
    if (Array.isArray(candidate)) {
      for (const entry of candidate) visit(entry, depth + 1);
      return;
    }
    if (typeof candidate !== 'object' || candidate === null) return;
    const record = candidate as Record<string, unknown>;
    if (
      typeof record.key === 'string' &&
      typeof record.projectId === 'string' &&
      typeof record.runId === 'string' &&
      typeof record.stepId === 'string' &&
      typeof record.artifactId === 'string' &&
      typeof record.digest === 'string' &&
      typeof record.sizeBytes === 'number'
    ) {
      result.set(record.key, candidate as ArtifactMetadata);
      return;
    }
    for (const entry of Object.values(record)) visit(entry, depth + 1);
  };
  visit(value, 0);
  return [...result.values()].sort((left, right) =>
    left.key.localeCompare(right.key),
  );
}

function policy(config: AgentOsConfig) {
  return normalizePublicationPolicySnapshot({
    version: 'publication-policy-v1',
    protectedPaths: config.policies.protectedPaths,
    maxFiles: 100,
    maxFileBytes: config.policies.maxFileBytes,
    maxTotalBytes: 5_000_000,
    allowBinary: config.policies.allowBinary,
    allowSymlinks: config.policies.allowSymlinks,
    allowDeletes: true,
    allowedModes: ['100644', '100755'],
  });
}

// The inputs directory is passed as argv[2]: Managed Agents currently mounts
// file resources under /mnt/session/uploads/<mount_path> rather than at the
// absolute mount path itself, so the trusted command resolves the real
// location at run time and hands it to this script.
const MATERIALIZE_SCRIPT = `import { readFile, mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
const inputs = process.argv[2];
if (typeof inputs !== 'string' || inputs.length === 0) throw new Error('inputs directory argument is required');
const root = '/workspace/repo';
const safe = (p) => { if (typeof p !== 'string' || p.startsWith('/') || p.includes('\\\\') || p.includes('\\0')) throw new Error('unsafe path'); const t=resolve(root,p); if(t!==root&&!t.startsWith(root+sep)) throw new Error('escape'); return t; };
const source=JSON.parse(await readFile(inputs+'/source-bundle.json','utf8'));
const changes=JSON.parse(await readFile(inputs+'/changes.json','utf8'));
for (const f of source.files) { const t=safe(f.path); await mkdir(dirname(t),{recursive:true}); await writeFile(t,f.content,{mode:f.mode==='100755'?0o755:0o644}); }
for (const c of changes.changes) { const t=safe(c.path); if(c.operation==='delete') await rm(t,{force:true}); else { await mkdir(dirname(t),{recursive:true}); await writeFile(t,c.content,{mode:c.mode==='100755'?0o755:0o644}); await chmod(t,c.mode==='100755'?0o755:0o644); } }
`;

function shellQuote(value: string): string {
  if (value.includes('\0') || value.length > 2_000)
    throw new Error('trusted test command argument is invalid');
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function exactTrustedCommand(definition: {
  readonly executable: string;
  readonly arguments: readonly string[];
}): string {
  const invocation = [definition.executable, ...definition.arguments]
    .map(shellQuote)
    .join(' ');
  return `set +e; IN=/workspace/inputs; [ -f "$IN/source-bundle.json" ] || IN=/mnt/session/uploads/workspace/inputs; rm -rf /workspace/repo; mkdir -p /workspace/repo; node "$IN/materialize.mjs" "$IN" && cd /workspace/repo && pnpm install --frozen-lockfile --ignore-scripts && ${invocation}; code=$?; printf '\\nAGENTOS_EXIT_CODE=%s\\n' "$code"; exit "$code"`;
}

function priceUsage(
  config: AgentOsConfig,
  usage: import('@agentos/core').RuntimeUsage,
  modelName: string,
): number {
  const model = Object.values(config.models).find(
    (candidate) => candidate.model === modelName,
  );
  if (model === undefined)
    throw new Error('runtime model is absent from the stored config');
  return calculateUsageCost(usage, model);
}

// Re-exported so existing importers of `kimiFromEnv` from this module keep
// working; the implementation lives in ../kimi/from-env.js, shared with the
// control plane's cancellation runtime (see createKimiRuntimeProviderFromEnv
// below).
export { kimiFromEnv };

/**
 * Pure routing lookup: which runtime key (a key into the composed provider
 * registry, e.g. `'managed'` or `'kimi'`) a given agent should run on,
 * according to the model provider its config-defined agent definition
 * points at and the run's config-declared routing table.
 */
export function resolveRuntimeKey(
  config: AgentOsConfig,
  agent: Pick<RuntimeAgent, 'id'>,
): string {
  const definition = config.agents[agent.id];
  if (definition === undefined)
    throw new Error(`config has no agent definition for '${agent.id}'`);
  const model = config.models[definition.model];
  if (model === undefined)
    throw new Error(`config has no model profile for '${definition.model}'`);
  return config.runtime.routing[model.provider] ?? config.runtime.provider;
}

/**
 * Fail-closed routing resolution for one run's feature roles, evaluated at
 * composition time before any session work starts. Returns the runtime key
 * each role's agent resolved to, plus whether the run needs the kimi
 * provider at all (only then is the routing facade introduced).
 *
 * Rejects, with a named error:
 *
 * - a role routed to `kimi` while no kimi provider was built
 *   (`KIMI_API_KEY` absent) -- never a silent fallback to managed;
 * - a role routed to any runtime key outside the built provider set (a typo,
 *   or the legacy `provider: local`);
 * - the `verification` role routed to `kimi` at all. Its trusted command
 *   bakes container-absolute paths (`rm -rf /workspace/repo`, `node
 *   /workspace/inputs/materialize.mjs`; see `exactTrustedCommand`), which on
 *   the containerless kimi sandbox would run against the worker host's real
 *   filesystem.
 */
export function resolveRoleRuntimeKeys(
  config: AgentOsConfig,
  roles: FeatureWorkflowRoles,
  options: {
    readonly builtRuntimeKeys: ReadonlySet<string>;
    readonly kimiConfigured: boolean;
  },
): {
  readonly runtimeKeys: ReadonlyMap<string, string>;
  readonly requiresKimi: boolean;
} {
  const runtimeKeys = new Map<string, string>();
  let requiresKimi = false;
  for (const [roleName, role] of Object.entries(roles)) {
    const runtimeKey = resolveRuntimeKey(config, role.agent);
    runtimeKeys.set(role.agent.id, runtimeKey);
    if (runtimeKey === 'kimi' && !options.kimiConfigured) {
      throw new Error(
        `KIMI_API_KEY is required: config routes '${role.agent.id}' to the kimi runtime`,
      );
    }
    if (!options.builtRuntimeKeys.has(runtimeKey)) {
      throw new Error(
        `unknown runtime '${runtimeKey}' routed for agent '${role.agent.id}'`,
      );
    }
    if (roleName === 'verification' && runtimeKey === 'kimi') {
      throw new Error(
        'the verification role cannot route to the kimi runtime; route it to managed',
      );
    }
    if (runtimeKey === 'kimi') requiresKimi = true;
  }
  return { runtimeKeys, requiresKimi };
}

export async function createProductionFeatureWorkflowFromEnv(
  environment: Environment,
): Promise<FeatureWorkflowTaskHandler> {
  const repository = createNeonDomainRepositoryFromEnv(environment);
  const checkpoints = createNeonWorkflowCheckpointStore(environment);
  const artifacts = createR2ArtifactStore({
    accountId: required(environment, 'CLOUDFLARE_R2_ACCOUNT_ID'),
    bucket: required(environment, 'CLOUDFLARE_R2_ARTIFACT_BUCKET'),
    accessKeyId: required(environment, 'CLOUDFLARE_R2_ARTIFACT_ACCESS_KEY_ID'),
    secretAccessKey: required(
      environment,
      'CLOUDFLARE_R2_ARTIFACT_SECRET_ACCESS_KEY',
    ),
    manifest: createDomainArtifactManifestStore(repository),
  });
  const ownershipSecret = required(
    environment,
    'AGENTOS_RUNTIME_OWNERSHIP_SECRET',
  );
  const managedProvider = await createManagedAgentsRuntimeProvider({
    apiKey: required(environment, 'ANTHROPIC_API_KEY'),
    ownershipSecret,
  });
  const artifactMcpUrl = new URL(
    required(environment, 'AGENTOS_ARTIFACT_MCP_URL'),
  ).toString();
  if (!artifactMcpUrl.startsWith('https://'))
    throw new Error('AGENTOS_ARTIFACT_MCP_URL must use HTTPS');
  // Kimi sessions are local, so a blank/absent KIMI_API_KEY simply means the
  // kimi runtime is never built -- config that routes to it then fails
  // closed (below) instead of silently falling back to the managed runtime.
  // This process (a Trigger worker) is where staged local access actually
  // gets discarded, so accessCleanup stays wired to the store (the default).
  const kimiAccessStore = createKimiLocalAccessStore();
  const kimiProvider = createKimiRuntimeProviderFromEnv(environment, {
    ownershipSecret,
    artifactMcpUrl,
    store: kimiAccessStore,
  });
  const verificationRegistryHosts = z
    .array(
      z
        .string()
        .min(1)
        .max(253)
        .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i),
    )
    .min(1)
    .max(4)
    .parse(
      parsedJson<unknown>(
        environment,
        'AGENTOS_VERIFICATION_REGISTRY_HOSTS_JSON',
      ),
    );
  const artifactCapabilityKeys = parsedJson<ArtifactCapabilityKey[]>(
    environment,
    'ARTIFACT_CAPABILITY_KEYS_JSON',
  );
  const artifactCapabilityKey = artifactCapabilityKeys[0];
  if (artifactCapabilityKey === undefined)
    throw new Error('at least one Artifact MCP capability key is required');
  const artifactCapabilityIssuer = createArtifactCapabilityIssuer(
    artifactCapabilityKey,
  );
  const handleSealer = createAesWorkflowHandleSealer(
    Buffer.from(
      required(environment, 'AGENTOS_RUNTIME_HANDLE_KEY'),
      'base64url',
    ),
  );
  const publicationKeys = parsedJson<
    Array<{ readonly keyId: string; readonly secret: string }>
  >(environment, 'GITHUB_PUBLICATION_KEYS_JSON');
  const activeKey = publicationKeys[0];
  if (activeKey === undefined)
    throw new Error('at least one GitHub publication key is required');
  const testReportKeys = parsedJson<
    Array<{ readonly keyId: string; readonly secret: string }>
  >(environment, 'AGENTOS_TEST_REPORT_KEYS_JSON');
  const testReportKey = testReportKeys[0];
  if (testReportKey === undefined)
    throw new Error('at least one trusted test report key is required');
  const testReportIssuer = createHmacAttestationIssuer({
    keyId: testReportKey.keyId,
    secret: testReportKey.secret,
    kind: 'trusted-test-report',
  });
  const issuer = createHmacAttestationIssuer<PublicationAuthorizationClaims>({
    keyId: activeKey.keyId,
    secret: activeKey.secret,
    kind: 'github-publication',
  });
  // Shared between the GitHub and local-git publication paths: both verify
  // authorization claims signed by the same key material, distinguished at
  // verification time by the claims' `audience` field (not by which keys
  // signed them). Only the GitHub branch additionally requires GITHUB_APP_ID
  // / GITHUB_APP_PRIVATE_KEY / GITHUB_SELECTED_REPOSITORIES_JSON, and those
  // are read lazily per-snapshot in workflowForSnapshot (via
  // composePublicationTarget) so a local-only deployment never needs them.
  const authorizationVerifier =
    createHmacAttestationVerifier<PublicationAuthorizationClaims>({
      kind: 'github-publication',
      keys: publicationKeys,
    });
  const publicationPolicyResolver: TrustedPublicationPolicyResolver = {
    resolve: async ({ runId, policyDigest }) => {
      const snapshots = await repository.listConfigSnapshots(
        persistenceId('run', runId),
        { limit: 2 },
      );
      if (snapshots.length !== 1)
        throw new Error('publication config snapshot is unavailable');
      const result = policy(parseAgentOsConfig(snapshots[0]!.config));
      if (canonicalPublicationPolicyDigest(result) !== policyDigest)
        throw new Error('publication policy digest mismatch');
      return result;
    },
  };
  const publicationIsCancelled = async (_projectId: string, runId: string) =>
    (await repository.getRun(persistenceId('run', runId)))?.status ===
    'cancelled';
  const sourceBundles = new Map<
    string,
    {
      readonly metadata: ArtifactMetadata;
      readonly body: z.infer<typeof sourceBundleSchema>;
    }
  >();
  const SOURCE_BUNDLE_CACHE_MAX = 32;
  const rememberSourceBundle = (
    runId: string,
    result: {
      readonly metadata: ArtifactMetadata;
      readonly body: z.infer<typeof sourceBundleSchema>;
    },
  ) => {
    sourceBundles.delete(runId);
    sourceBundles.set(runId, result);
    while (sourceBundles.size > SOURCE_BUNDLE_CACHE_MAX) {
      const oldest = sourceBundles.keys().next().value;
      if (oldest === undefined) break;
      sourceBundles.delete(oldest);
    }
  };
  const loadSource = async (
    projectId: string,
    runId: string,
    repositorySha: string,
  ) => {
    const page = await artifacts.list({
      scope: { projectId, runId, stepId: 'source' },
      artifactPrefix: 'bundle',
      limit: 2,
    });
    if (page.items.length !== 1)
      throw new Error('run must have exactly one source bundle');
    const metadata = page.items[0]!;
    const value = await artifacts.get({
      scope: { projectId, runId, stepId: 'source' },
      key: metadata.key,
      maxBytes: 16 * 1024 * 1024,
    });
    if (value === undefined) throw new Error('source bundle object is missing');
    const body = sourceBundleSchema.parse(
      JSON.parse(new TextDecoder().decode(value.bytes)),
    );
    if (body.repositorySha !== repositorySha) {
      throw new Error('source bundle repository binding mismatch');
    }
    const result = { metadata, body };
    rememberSourceBundle(runId, result);
    return result;
  };
  return createFeatureWorkflowTaskHandler({
    repository,
    sourceSnapshot: {
      resolve: async ({ projectId, runId, repositorySha }) =>
        ((loaded) => ({
          digest: loaded.metadata.digest,
          artifactKey: loaded.metadata.key,
        }))(await loadSource(projectId, runId, repositorySha)),
    },
    workflowForSnapshot: async (snapshot: ConfigSnapshot, execution) => {
      const config = parseAgentOsConfig(snapshot.config);
      // Per-snapshot selection between the GitHub-backed and local-git
      // publication paths (see composePublicationTarget). Neither branch
      // performs a live network call at construction time.
      const target = composePublicationTarget(config, {
        environment,
        authorizationVerifier,
        policy: policy(config),
        policyResolver: publicationPolicyResolver,
        isCancelled: publicationIsCancelled,
      });
      if (config.project.repository !== undefined) {
        const configuredRepository = new URL(config.project.repository);
        const configuredPath = configuredRepository.pathname
          .replace(/^\//, '')
          .replace(/\.git$/, '');
        // `target.repository` is the GitHub shape whenever
        // config.project.repository is set -- composePublicationTarget's
        // GitHub branch is exactly the branch taken here.
        const selectedRepository = target.repository as {
          readonly owner: string;
          readonly name: string;
        };
        if (
          configuredRepository.hostname !== 'github.com' ||
          configuredPath !==
            `${selectedRepository.owner}/${selectedRepository.name}`
        ) {
          throw new Error(
            'stored config repository is outside the selected GitHub repository',
          );
        }
      }
      const source = sourceBundles.get(snapshot.runId);
      if (source === undefined) throw new Error('source bundle is unavailable');
      const commands = parsedJson<
        Record<string, { executable: string; arguments: string[] }>
      >(environment, 'AGENTOS_TRUSTED_TEST_COMMANDS_JSON');
      const verifier = createTrustedWorkflowVerifier({
        policy: policy(config),
        artifacts,
        attest: (evidence) => {
          const evidenceDigest = createHash('sha256')
            .update(canonicalJsonValue(evidence))
            .digest('hex');
          return testReportIssuer.issue({
            subject: `${snapshot.runId}:verification:${evidenceDigest}`,
            issuedAt: snapshot.createdAt,
            claims: {
              source: 'managed-agent-command-observer',
              runId: snapshot.runId,
              evidenceDigest,
            },
          }) as unknown as import('@agentos/core').JsonValue;
        },
      });
      const publicationAuthority: WorkflowPublicationAuthority = {
        authorize: async ({
          workflow,
          changeSet,
          verification,
          artifacts: evidence,
        }) => {
          const trustedReports = evidence.filter(
            (item) =>
              item.stepId === 'verification' &&
              item.artifactId === 'trusted-test-report',
          );
          if (
            trustedReports.length !== 1 ||
            trustedReports[0]!.digest !== verification.evidenceDigest
          )
            throw new Error('trusted publication evidence is unavailable');
          const manifest: PublicationManifestBody = {
            version: 'publication-manifest-v1',
            projectId: workflow.projectId,
            runId: workflow.runId,
            stepId: 'publication',
            repository: target.repository,
            expectedBase: {
              branch: config.project.defaultBranch,
              sha: workflow.source.repositorySha,
            },
            configDigest: workflow.digests.config,
            policyDigest: workflow.digests.policy,
            sourceSnapshotDigest: workflow.source.sourceSnapshotDigest,
            testEvidence: trustedReports.map((item) => ({
              kind: 'test-report' as const,
              artifactDigest: item.digest,
            })),
            changes: changeSetSchema.parse(changeSet).changes,
          };
          const manifestDigest = canonicalPublicationManifestDigest(manifest);
          // Issue at authorization time: the publisher enforces a validity
          // window of at most PUBLICATION_AUTHORIZATION_MAX_TTL_MS, and a
          // window anchored to run creation would already be spent by the
          // time a real pipeline reaches publication.
          const issuedAt = new Date();
          return {
            manifest,
            authorization: issuer.issue({
              subject: `${workflow.projectId}:${workflow.runId}:${manifestDigest}`,
              issuedAt: issuedAt.toISOString(),
              claims: {
                purpose: 'publish-draft-pr',
                audience: target.audience,
                projectId: workflow.projectId,
                runId: workflow.runId,
                stepId: manifest.stepId,
                repository: manifest.repository,
                expectedBase: manifest.expectedBase,
                configDigest: manifest.configDigest,
                policyDigest: manifest.policyDigest,
                sourceSnapshotDigest: manifest.sourceSnapshotDigest,
                testEvidenceDigest: canonicalPublicationManifestDigest(
                  manifest.testEvidence,
                ),
                manifestDigest,
                nonce: `publish-${workflow.runId}`,
                expiresAt: new Date(
                  issuedAt.getTime() + 10 * 60_000,
                ).toISOString(),
              },
            }),
          };
        },
      };
      const roleDefinitions = resolveFeatureRolesFromSnapshot(snapshot, {
        artifactMcpUrl,
        verificationRegistryHosts,
      });
      // Fail-closed routing check, before any session work (see
      // resolveRoleRuntimeKeys for the three rules it enforces).
      const builtRuntimeKeys = new Set<string>(['managed']);
      if (kimiProvider !== undefined) builtRuntimeKeys.add('kimi');
      const { requiresKimi } = resolveRoleRuntimeKeys(config, roleDefinitions, {
        builtRuntimeKeys,
        kimiConfigured: kimiProvider !== undefined,
      });
      const run = await repository.getRun(snapshot.runId);
      if (run === undefined) throw new Error('workflow run is unavailable');
      const projectManagedProvider = managedProvider.forProject(run.projectId);
      // Only wrap the managed provider in the routing facade when this run's
      // config actually routes at least one role to kimi -- the facade
      // prefixes every handle id (`managed <id>` / `kimi <id>`), and that
      // change is only safe to take for runs that need it. A managed-only
      // run (the common case, and every run before kimi routing existed)
      // keeps producing the exact same bare managed handle ids it always
      // has, so existing persisted/sealed handles and their shape stay
      // byte-identical.
      const workflowRuntime: RuntimeProvider = requiresKimi
        ? createRoutingRuntimeProvider({
            providers: {
              managed: projectManagedProvider,
              kimi: kimiProvider!,
            },
            defaultProvider: config.runtime.provider,
            route: (agent: RuntimeAgent) => resolveRuntimeKey(config, agent),
          })
        : projectManagedProvider;
      const runtimeAccess = {
        prepare: async (request: {
          workflow: {
            projectId: string;
            runId: string;
            source: { sourceSnapshotDigest: string };
          };
          stepId: string;
          logicalStepId: string;
          role:
            | 'specification'
            | 'planning'
            | 'implementation'
            | 'review'
            | 'verification';
          stepInput: unknown;
          idempotencyKey: string;
        }) => {
          const loadedSource = sourceBundles.get(request.workflow.runId);
          if (
            loadedSource === undefined ||
            loadedSource.metadata.digest !==
              request.workflow.source.sourceSnapshotDigest
          )
            throw new Error('runtime source bundle binding mismatch');
          const inputs = collectArtifactMetadata(request.stepInput);
          const files = [
            {
              filename: 'source-bundle.json',
              mediaType: 'application/json',
              bytes: new TextEncoder().encode(
                JSON.stringify(loadedSource.body),
              ),
              mountPath: '/workspace/inputs/source-bundle.json',
            },
          ];
          for (const metadata of inputs) {
            if (
              metadata.projectId !== request.workflow.projectId ||
              metadata.runId !== request.workflow.runId
            )
              throw new Error('runtime input artifact binding mismatch');
            const value = await artifacts.get({
              scope: {
                projectId: metadata.projectId,
                runId: metadata.runId,
                stepId: metadata.stepId,
              },
              key: metadata.key,
              maxBytes: metadata.sizeBytes,
            });
            if (
              value === undefined ||
              value.digest !== metadata.digest ||
              value.sizeBytes !== metadata.sizeBytes
            )
              throw new Error('runtime input artifact is unavailable');
            files.push({
              filename: `${metadata.stepId}-${metadata.artifactId}.json`,
              mediaType: value.mediaType,
              bytes: Uint8Array.from(value.bytes),
              mountPath:
                request.role === 'verification' &&
                metadata.artifactId === 'changes'
                  ? '/workspace/inputs/changes.json'
                  : `/workspace/inputs/${metadata.stepId}-${metadata.artifactId}.json`,
            });
          }
          // Kimi-routed roles never leave the process: stage the same
          // bytes/token the managed preparer would upload into the local
          // access store instead, so the kimi provider's resolveFile /
          // artifactMcp.resolveCredential hooks can materialize them.
          // Managed-routed roles keep calling the managed preparer exactly
          // as before -- byte-identical.
          const runtimeKey = resolveRuntimeKey(
            config,
            roleDefinitions[request.role].agent,
          );
          const stageOrUpload = (input: {
            readonly mcpUrl?: string;
            readonly bearerToken?: string;
            readonly files: typeof files;
          }) =>
            runtimeKey === 'kimi'
              ? kimiAccessStore.stage({
                  files: input.files.map((file) => ({
                    bytes: file.bytes,
                    mountPath: file.mountPath,
                  })),
                  credentials:
                    input.bearerToken === undefined
                      ? []
                      : [{ token: input.bearerToken }],
                })
              : projectManagedProvider.provisionSessionAccess({
                  idempotencyKey: request.idempotencyKey,
                  ...input,
                });
          if (request.role === 'verification') {
            files.push({
              filename: 'materialize.mjs',
              mediaType: 'text/javascript',
              bytes: new TextEncoder().encode(MATERIALIZE_SCRIPT),
              mountPath: '/workspace/inputs/materialize.mjs',
            });
            return stageOrUpload({ files });
          }
          const issuedAt = new Date();
          const bearerToken = artifactCapabilityIssuer.issue(
            {
              purpose: 'agent-artifact-access',
              audience: 'artifact-mcp',
              methods: ['artifact.get', 'artifact.put', 'artifact.list'],
              projectId: request.workflow.projectId,
              runId: request.workflow.runId,
              stepId: request.logicalStepId,
              maxBytes: 1_000_000,
              maxCalls: 1_000,
              maxCumulativeBytes: 16 * 1024 * 1024,
              notBefore: issuedAt.toISOString(),
              expiresAt: new Date(
                issuedAt.getTime() + 59 * 60_000,
              ).toISOString(),
              nonce: createHash('sha256')
                .update(request.idempotencyKey)
                .digest('base64url'),
            },
            issuedAt,
          );
          return stageOrUpload({
            mcpUrl: artifactMcpUrl,
            bearerToken,
            files,
          });
        },
      };
      return createDurableFeatureWorkflow({
        repository,
        checkpoints,
        artifacts,
        runtime: workflowRuntime,
        approval: createTriggerApprovalWaiter(),
        roles: roleDefinitions,
        runtimeAccess,
        clock: () => new Date().toISOString(),
        priceUsage: (usage, model) => priceUsage(config, usage, model),
        verifier,
        resolveTestCommand: (commandKey) => {
          const definition = commands[commandKey];
          if (definition === undefined)
            throw new Error('test command is not in the trusted allowlist');
          return exactTrustedCommand(definition);
        },
        publicationAuthority,
        publisher: target.publisher,
        execution:
          execution ??
          ({
            taskVersion: 'agentos-feature-workflow-v1',
            deploymentVersion: 'development-unversioned',
          } as const),
        handleSealer,
      });
    },
  });
}

export async function createProductionGoalWorkflowFromEnv(
  environment: Environment,
): Promise<import('./goal-task.js').GoalWorkflowTaskHandler> {
  const repository = createNeonDomainRepositoryFromEnv(environment);
  const artifacts = createR2ArtifactStore({
    accountId: required(environment, 'CLOUDFLARE_R2_ACCOUNT_ID'),
    bucket: required(environment, 'CLOUDFLARE_R2_ARTIFACT_BUCKET'),
    accessKeyId: required(environment, 'CLOUDFLARE_R2_ARTIFACT_ACCESS_KEY_ID'),
    secretAccessKey: required(
      environment,
      'CLOUDFLARE_R2_ARTIFACT_SECRET_ACCESS_KEY',
    ),
    manifest: createDomainArtifactManifestStore(repository),
  });
  const featureTask = await createProductionFeatureWorkflowFromEnv(environment);
  const keys = parsedJson<
    Array<{ readonly keyId: string; readonly secret: string }>
  >(environment, 'AGENTOS_TEST_REPORT_KEYS_JSON');
  const verifierRegistry = registerVerifier(
    createVerifierRegistry(),
    'command',
    createTrustedGoalCommandVerifier({
      artifacts,
      keys,
      clock: () => new Date().toISOString(),
    }),
  );
  return createGoalWorkflowTaskHandler({
    repository,
    workflowForExecution: (execution) =>
      createDurableGoalWorkflow({
        repository,
        stepRunner: createFeatureGoalStepRunner({
          repository,
          artifacts,
          featureTask: {
            run: async (payload, childExecution) => {
              const result = featureWorkflowResultSchema.parse(
                await featureTask.run(payload, childExecution),
              );
              return {
                status: result.status,
                ...(result.draftPullRequestUrl === undefined
                  ? {}
                  : { draftPullRequestUrl: result.draftPullRequestUrl }),
                ...(result.localBranch === undefined
                  ? {}
                  : { localBranch: result.localBranch }),
                ...(result.localRepositoryUrl === undefined
                  ? {}
                  : { localRepositoryUrl: result.localRepositoryUrl }),
                ...(result.reason === undefined
                  ? {}
                  : { reason: result.reason }),
              };
            },
          },
          clock: () => isoTimestamp(new Date().toISOString()),
          ...(execution === undefined ? {} : { execution }),
        }),
        verifierRegistry,
        clock: () => isoTimestamp(new Date().toISOString()),
      }),
  });
}
