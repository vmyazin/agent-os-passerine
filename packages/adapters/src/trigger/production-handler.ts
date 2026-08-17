import { createHash } from 'node:crypto';

import {
  canonicalPublicationManifestDigest,
  canonicalPublicationPolicyDigest,
  canonicalJsonValue,
  createArtifactCapabilityIssuer,
  createHmacAttestationIssuer,
  createHmacAttestationVerifier,
  normalizePublicationPolicySnapshot,
  parseAgentOsConfig,
  persistenceId,
  type AgentOsConfig,
  type ArtifactCapabilityKey,
  type ArtifactMetadata,
  type ConfigSnapshot,
  type PublicationAuthorizationClaims,
  type PublicationManifestBody,
} from '@agentos/core';
import { z } from 'zod';

import { createDomainArtifactManifestStore } from '../artifacts/manifest.js';
import { createR2ArtifactStore } from '../artifacts/r2.js';
import { createTrustedGitHubPublisherService } from '../github/service.js';
import { createManagedAgentsRuntimeProvider } from '../managed-agents/provider.js';
import { createNeonDomainRepositoryFromEnv } from '../persistence/neon-repository.js';
import { createAesWorkflowHandleSealer } from './handle-sealer.js';
import { createNeonWorkflowCheckpointStore } from './postgres-checkpoint-store.js';
import { resolveFeatureRolesFromSnapshot } from './production-composition.js';
import type { FeatureWorkflowTaskHandler } from './task.js';
import { createFeatureWorkflowTaskHandler } from './task-handler.js';
import { createTriggerApprovalWaiter } from './trigger-adapter.js';
import type { WorkflowPublicationAuthority } from './types.js';
import { createTrustedWorkflowVerifier } from './verifier.js';
import { createDurableFeatureWorkflow } from './workflow.js';

type Environment = Readonly<Record<string, string | undefined>>;

const sourceBundleSchema = z
  .object({
    version: z.literal('source-bundle-v1'),
    repository: z
      .object({
        owner: z.string().min(1).max(100),
        name: z.string().min(1).max(100),
        repositoryId: z.number().int().positive().safe(),
      })
      .strict(),
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

const MATERIALIZE_SCRIPT = `import { readFile, mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
const root = '/workspace/repo';
const safe = (p) => { if (typeof p !== 'string' || p.startsWith('/') || p.includes('\\\\') || p.includes('\\0')) throw new Error('unsafe path'); const t=resolve(root,p); if(t!==root&&!t.startsWith(root+sep)) throw new Error('escape'); return t; };
const source=JSON.parse(await readFile('/workspace/inputs/source-bundle.json','utf8'));
const changes=JSON.parse(await readFile('/workspace/inputs/changes.json','utf8'));
for (const f of source.files) { const t=safe(f.path); await mkdir(dirname(t),{recursive:true}); await writeFile(t,f.content,{mode:f.mode==='100755'?0o755:0o644}); }
for (const c of changes.changes) { const t=safe(c.path); if(c.operation==='delete') await rm(t,{force:true}); else { await mkdir(dirname(t),{recursive:true}); await writeFile(t,c.content,{mode:c.mode==='100755'?0o755:0o644}); await chmod(t,c.mode==='100755'?0o755:0o644); } }
`;

function shellQuote(value: string): string {
  if (value.includes('\0') || value.length > 2_000)
    throw new Error('trusted test command argument is invalid');
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function exactTrustedCommand(definition: {
  readonly executable: string;
  readonly arguments: readonly string[];
}): string {
  const invocation = [definition.executable, ...definition.arguments]
    .map(shellQuote)
    .join(' ');
  return `set +e; rm -rf /workspace/repo; mkdir -p /workspace/repo; node /workspace/inputs/materialize.mjs && cd /workspace/repo && ${invocation}; code=$?; printf '\\nAGENTOS_EXIT_CODE=%s\\n' "$code"; exit "$code"`;
}

function priceUsage(
  config: AgentOsConfig,
  usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly runtimeMs: number;
  },
  modelName: string,
): number {
  const model = Object.values(config.models).find(
    (candidate) => candidate.model === modelName,
  );
  if (model === undefined)
    throw new Error('runtime model is absent from the stored config');
  return Math.ceil(
    (usage.inputTokens * model.inputMicrodollarsPerMillionTokens +
      usage.outputTokens * model.outputMicrodollarsPerMillionTokens) /
      1_000_000 +
      (usage.runtimeMs * model.runtimeMicrodollarsPerMinute) / 60_000,
  );
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
  const runtime = await createManagedAgentsRuntimeProvider({
    apiKey: required(environment, 'ANTHROPIC_API_KEY'),
    ownershipSecret: required(environment, 'AGENTOS_RUNTIME_OWNERSHIP_SECRET'),
  });
  const artifactMcpUrl = new URL(
    required(environment, 'AGENTOS_ARTIFACT_MCP_URL'),
  ).toString();
  if (!artifactMcpUrl.startsWith('https://'))
    throw new Error('AGENTOS_ARTIFACT_MCP_URL must use HTTPS');
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
  const selectedRepositories = parsedJson<
    PublicationManifestBody['repository'][]
  >(environment, 'GITHUB_SELECTED_REPOSITORIES_JSON');
  if (selectedRepositories.length !== 1)
    throw new Error('the POC requires exactly one selected repository');
  const issuer = createHmacAttestationIssuer<PublicationAuthorizationClaims>({
    keyId: activeKey.keyId,
    secret: activeKey.secret,
    kind: 'github-publication',
  });
  const publisher = createTrustedGitHubPublisherService({
    githubApp: {
      appId: Number(required(environment, 'GITHUB_APP_ID')),
      privateKey: required(environment, 'GITHUB_APP_PRIVATE_KEY'),
    },
    databaseEnvironment: environment,
    authorizationVerifier:
      createHmacAttestationVerifier<PublicationAuthorizationClaims>({
        kind: 'github-publication',
        keys: publicationKeys,
      }),
    selectedRepositories,
    policyResolver: {
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
    },
    isCancelled: async (_projectId, runId) =>
      (await repository.getRun(persistenceId('run', runId)))?.status ===
      'cancelled',
  });
  const sourceBundles = new Map<
    string,
    {
      readonly metadata: ArtifactMetadata;
      readonly body: z.infer<typeof sourceBundleSchema>;
    }
  >();
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
    sourceBundles.set(runId, result);
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
      if (config.project.repository !== undefined) {
        const configuredRepository = new URL(config.project.repository);
        const configuredPath = configuredRepository.pathname
          .replace(/^\//, '')
          .replace(/\.git$/, '');
        const selectedRepository = selectedRepositories[0]!;
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
        policy: {
          protectedPaths: config.policies.protectedPaths,
          maxFiles: 100,
          maxFileBytes: config.policies.maxFileBytes,
          maxTotalBytes: 5_000_000,
        },
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
            repository: selectedRepositories[0]!,
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
          const issuedAt = new Date(snapshot.createdAt);
          return {
            manifest,
            authorization: issuer.issue({
              subject: `${workflow.projectId}:${workflow.runId}:${manifestDigest}`,
              issuedAt: issuedAt.toISOString(),
              claims: {
                purpose: 'publish-draft-pr',
                audience: 'github-publisher',
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
                  issuedAt.getTime() + 60 * 60_000,
                ).toISOString(),
              },
            }),
          };
        },
      };
      const roleDefinitions = resolveFeatureRolesFromSnapshot(snapshot, {
        artifactMcpUrl,
      });
      const runtimeAccess = {
        prepare: async (request: {
          workflow: {
            projectId: string;
            runId: string;
            source: { sourceSnapshotDigest: string };
          };
          stepId: string;
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
          if (request.role === 'verification') {
            files.push({
              filename: 'materialize.mjs',
              mediaType: 'text/javascript',
              bytes: new TextEncoder().encode(MATERIALIZE_SCRIPT),
              mountPath: '/workspace/inputs/materialize.mjs',
            });
            return runtime.provisionSessionAccess({
              idempotencyKey: request.idempotencyKey,
              files,
            });
          }
          const issuedAt = new Date();
          const bearerToken = artifactCapabilityIssuer.issue(
            {
              purpose: 'agent-artifact-access',
              audience: 'artifact-mcp',
              methods: ['artifact.get', 'artifact.put', 'artifact.list'],
              projectId: request.workflow.projectId,
              runId: request.workflow.runId,
              stepId: request.stepId,
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
          return runtime.provisionSessionAccess({
            idempotencyKey: request.idempotencyKey,
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
        runtime,
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
        publisher: { publish: async (input) => publisher.publish(input) },
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
