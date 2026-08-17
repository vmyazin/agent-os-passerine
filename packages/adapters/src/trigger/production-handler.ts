import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

import {
  canonicalPublicationManifestDigest,
  canonicalPublicationPolicyDigest,
  createHmacAttestationIssuer,
  createHmacAttestationVerifier,
  normalizePublicationPolicySnapshot,
  parseAgentOsConfig,
  persistenceId,
  type AgentOsConfig,
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
import { createNodeTrustedCommandExecutor } from './trusted-command-executor.js';
import type { WorkflowPublicationAuthority } from './types.js';
import { createTrustedWorkflowVerifier } from './verifier.js';
import { createDurableFeatureWorkflow } from './workflow.js';

type Environment = Readonly<Record<string, string | undefined>>;

const sourceBundleSchema = z
  .object({
    version: z.literal('source-bundle-v1'),
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

function workspacePath(root: string, candidate: string): string {
  if (
    candidate.startsWith('/') ||
    candidate.includes('\\') ||
    candidate.includes('\0')
  )
    throw new Error('source/change path is unsafe');
  const target = resolve(root, candidate);
  if (target !== root && !target.startsWith(`${root}${sep}`))
    throw new Error('source/change path escapes workspace');
  return target;
}

export function createSourceBundleMaterializer(sourceBundle: unknown) {
  const source = sourceBundleSchema.parse(sourceBundle);
  return Object.freeze({
    async prepare(input: { readonly changeSet: unknown }) {
      const root = await mkdtemp(join(tmpdir(), 'agentos-verify-'));
      try {
        for (const file of source.files) {
          const target = workspacePath(root, file.path);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, file.content, {
            mode: file.mode === '100755' ? 0o755 : 0o644,
          });
        }
        for (const change of changeSetSchema.parse(input.changeSet).changes) {
          const target = workspacePath(root, change.path);
          if (change.operation === 'delete') await rm(target, { force: true });
          else {
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, change.content, {
              mode: change.mode === '100755' ? 0o755 : 0o644,
            });
          }
        }
        return {
          cwd: root,
          cleanup: () => rm(root, { recursive: true, force: true }),
        };
      } catch (error) {
        await rm(root, { recursive: true, force: true });
        throw error;
      }
    },
  });
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
  const loadSource = async (projectId: string, runId: string) => {
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
    const result = { metadata, body };
    sourceBundles.set(runId, result);
    return result;
  };
  return createFeatureWorkflowTaskHandler({
    repository,
    sourceSnapshot: {
      resolve: async ({ projectId, runId }) =>
        ((loaded) => ({
          digest: loaded.metadata.digest,
          artifactKey: loaded.metadata.key,
        }))(await loadSource(projectId, runId)),
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
        executor: createNodeTrustedCommandExecutor({
          allowedCommands: commands,
          clock: () => new Date().toISOString(),
          materializer: createSourceBundleMaterializer(source.body),
        }),
        policy: {
          protectedPaths: config.policies.protectedPaths,
          maxFiles: 100,
          maxFileBytes: config.policies.maxFileBytes,
          maxTotalBytes: 5_000_000,
        },
      });
      const publicationAuthority: WorkflowPublicationAuthority = {
        authorize: async ({ workflow, changeSet, artifacts: evidence }) => {
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
            testEvidence: evidence
              .filter((item) => item.artifactId === 'tests')
              .map((item) => ({
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
      return createDurableFeatureWorkflow({
        repository,
        checkpoints,
        artifacts,
        runtime,
        approval: createTriggerApprovalWaiter(),
        roles: resolveFeatureRolesFromSnapshot(snapshot),
        clock: () => new Date().toISOString(),
        priceUsage: (usage, model) => priceUsage(config, usage, model),
        verifier,
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
