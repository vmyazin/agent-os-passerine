import { basename } from 'node:path';

import {
  parseAgentOsConfig,
  type AgentOsConfig,
  type AttestationVerifier,
  type ConfigSnapshot,
  type PublicationAuthorizationClaims,
  type PublicationManifestBody,
} from '@agentos/core';

import { createNeonPublicationStore } from '../github/postgres-store.js';
import {
  githubRepositoryBindingKey,
  parseGitHubRepositoryAllowlist,
  selectGitHubRepositoryFromUrl,
} from '../github/repository-allowlist.js';
import {
  createTrustedGitHubPublisherService,
  type TrustedPublicationPolicyResolver,
} from '../github/service.js';
import { createLocalGitPublisher } from '../local-git/index.js';
import type { FeatureWorkflowTaskHandler } from './task.js';
import type { FeatureRole, FeatureWorkflowRoles } from './types.js';

type Environment = Readonly<Record<string, string | undefined>>;

let initialized: Promise<FeatureWorkflowTaskHandler> | undefined;

const githubPublicationTargets = new Map<string, PublicationTarget>();

const FEATURE_ROLES: readonly FeatureRole[] = [
  'specification',
  'planning',
  'implementation',
  'review',
  'verification',
];

export function resolveFeatureRolesFromSnapshot(
  snapshot: ConfigSnapshot,
  options?: {
    readonly artifactMcpUrl: string;
    readonly verificationRegistryHosts?: readonly string[];
  },
): FeatureWorkflowRoles {
  const config = parseAgentOsConfig(snapshot.config);
  const pipeline = config.pipelines.feature;
  if (pipeline === undefined)
    throw new Error('stored config has no feature pipeline');
  const resolved = Object.fromEntries(
    FEATURE_ROLES.map((role) => {
      const step = pipeline.steps.find((candidate) => candidate.id === role);
      if (step === undefined)
        throw new Error(`feature pipeline has no ${role} step`);
      const agent = config.agents[step.agent]!;
      const environmentId = step.environment ?? agent.environment;
      if (environmentId === undefined)
        throw new Error(`${role} has no explicit environment`);
      const environment = config.environments[environmentId]!;
      const model = config.models[agent.model]!;
      const configuredMcps = [...new Set([...agent.mcps, ...environment.mcps])];
      if (
        options !== undefined &&
        role !== 'verification' &&
        (configuredMcps.length !== 1 || configuredMcps[0] !== 'artifacts')
      )
        throw new Error(`${role} must allow only the artifacts MCP`);
      if (
        role === 'verification' &&
        (configuredMcps.length !== 0 ||
          agent.tools.length !== 1 ||
          agent.tools[0] !== 'bash')
      )
        throw new Error('verification must be Bash-only with no MCP access');
      if (
        role === 'verification' &&
        (Object.keys(environment.variables).length !== 0 ||
          environment.packages !== undefined ||
          (environment.networking?.type === 'limited' &&
            (environment.networking.allowedHosts.length !== 0 ||
              environment.networking.allowMcpServers ||
              environment.networking.allowPackageManagers)))
      )
        throw new Error(
          'verification must use a secretless isolated environment with no network or package setup',
        );
      if (environment.networking?.type === 'unrestricted')
        throw new Error(`${role} cannot use unrestricted networking`);
      const artifactHost =
        options === undefined
          ? undefined
          : new URL(options.artifactMcpUrl).hostname;
      const verificationRegistryHosts = [
        ...new Set(options?.verificationRegistryHosts ?? []),
      ];
      if (
        role === 'verification' &&
        verificationRegistryHosts.some(
          (host) =>
            host.length > 253 ||
            !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host),
        )
      )
        throw new Error('verification registry host allowlist is invalid');
      return [
        role,
        {
          agent: {
            id: step.agent,
            model: model.model,
            instructions: agent.prompt,
            // Managed Agents rejects sessions whose file resources cannot be
            // read, and every workflow session mounts the source bundle. The
            // config invariant stays Bash-only for verification; the resolved
            // runtime toolset additionally enables the read tool.
            tools:
              role === 'verification'
                ? [...new Set([...agent.tools, 'read'])]
                : [...agent.tools],
            mcps:
              role === 'verification'
                ? []
                : options === undefined
                  ? [...agent.mcps]
                  : [options.artifactMcpUrl],
          },
          environment: {
            id: environmentId,
            runtime: environment.runtime,
            image: environment.image,
            variables:
              role === 'verification' ? {} : { ...environment.variables },
            networking: {
              type: 'limited' as const,
              allowedHosts: [
                ...new Set([
                  ...(environment.networking?.type === 'limited'
                    ? environment.networking.allowedHosts
                    : []),
                  ...(artifactHost === undefined || role === 'verification'
                    ? []
                    : [artifactHost]),
                  ...(role === 'verification' ? verificationRegistryHosts : []),
                ]),
              ],
              allowMcpServers: options !== undefined && role !== 'verification',
              allowPackageManagers:
                role === 'verification'
                  ? false
                  : environment.networking?.type === 'limited'
                    ? environment.networking.allowPackageManagers
                    : false,
            },
            ...(environment.packages === undefined || role === 'verification'
              ? {}
              : { packages: environment.packages }),
          },
          maxReservationMicrodollars: 700_000,
        },
      ];
    }),
  ) as unknown as FeatureWorkflowRoles;
  if (
    new Set(FEATURE_ROLES.map((role) => resolved[role].environment.id)).size !==
    FEATURE_ROLES.length
  )
    throw new Error(
      'feature roles must use separate least-privilege environments',
    );
  return resolved;
}

function required(environment: Environment, name: string): string {
  const value = environment[name];
  if (value === undefined || value.trim() === '')
    throw new Error(`${name} is required for the production feature workflow`);
  return value;
}

export interface PublicationTarget {
  readonly publisher: { publish(input: unknown): Promise<unknown> };
  readonly repository: PublicationManifestBody['repository'];
  readonly audience: 'github-publisher' | 'local-git-publisher';
}

/**
 * Per-snapshot selection between the two publication paths a project's
 * stored config can declare: a GitHub `repository` URL, or a local-
 * experiment `localPath`. `AgentOsConfigSchema` already enforces these are
 * mutually exclusive at parse time (packages/core/src/config.ts); the check
 * here is defense-in-depth against that invariant ever regressing.
 *
 * GitHub-only environment requirements (`GITHUB_SELECTED_REPOSITORIES_JSON`,
 * `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`) are read lazily inside the
 * GitHub branch so a local-only deployment never needs to set them. Neither
 * branch performs a live network call at construction time: the GitHub
 * publisher service and the local-git publisher's Postgres-backed store both
 * defer to the underlying serverless Neon driver, which connects lazily on
 * first query.
 */
export function composePublicationTarget(
  config: AgentOsConfig,
  options: {
    readonly environment: Environment;
    readonly authorizationVerifier: AttestationVerifier<PublicationAuthorizationClaims>;
    readonly policy: unknown;
    readonly policyResolver: TrustedPublicationPolicyResolver;
    readonly isCancelled?: (
      projectId: string,
      runId: string,
    ) => Promise<boolean>;
  },
): PublicationTarget {
  const { repository: repositoryUrl, localPath } = config.project;
  if ((repositoryUrl === undefined) === (localPath === undefined))
    throw new Error(
      'project must configure exactly one of repository or localPath',
    );

  if (repositoryUrl !== undefined) {
    const selectedRepositories = parseGitHubRepositoryAllowlist(
      required(options.environment, 'GITHUB_SELECTED_REPOSITORIES_JSON'),
      'GITHUB_SELECTED_REPOSITORIES_JSON',
    );
    const selected = selectGitHubRepositoryFromUrl(
      repositoryUrl,
      selectedRepositories,
    );
    const cacheKey = githubRepositoryBindingKey(selected);
    const cached = githubPublicationTargets.get(cacheKey);
    if (cached !== undefined) return cached;
    const publisher = createTrustedGitHubPublisherService({
      githubApp: {
        appId: Number(required(options.environment, 'GITHUB_APP_ID')),
        privateKey: required(options.environment, 'GITHUB_APP_PRIVATE_KEY'),
      },
      databaseEnvironment: options.environment,
      authorizationVerifier: options.authorizationVerifier,
      selectedRepositories,
      policyResolver: options.policyResolver,
      ...(options.isCancelled === undefined
        ? {}
        : { isCancelled: options.isCancelled }),
    });
    const target = {
      publisher: { publish: async (input: unknown) => publisher.publish(input) },
      repository: selected,
      audience: 'github-publisher' as const,
    };
    githubPublicationTargets.set(cacheKey, target);
    return target;
  }

  const workspacesRoot = required(
    options.environment,
    'AGENTOS_LOCAL_WORKSPACES_ROOT',
  );
  const publisher = createLocalGitPublisher({
    workspacesRoot,
    localPath: localPath!,
    verifier: options.authorizationVerifier,
    policy: options.policy,
    store: createNeonPublicationStore(options.environment),
  });
  return {
    publisher: { publish: async (input) => publisher.publish(input) },
    repository: {
      kind: 'local',
      owner: 'local',
      name: basename(localPath!),
    },
    audience: 'local-git-publisher',
  };
}

/**
 * Module-load-safe production entrypoint. Secret-bearing adapters are created
 * only on first execution so Trigger's task discovery/build phase stays pure.
 */
export function createLazyProductionFeatureWorkflowTaskHandler(): FeatureWorkflowTaskHandler {
  return Object.freeze({
    async run(
      payload: Parameters<FeatureWorkflowTaskHandler['run']>[0],
      execution?: Parameters<FeatureWorkflowTaskHandler['run']>[1],
    ) {
      initialized ??= initializeProductionHandler();
      return (await initialized).run(payload, execution);
    },
  });
}

async function initializeProductionHandler(): Promise<FeatureWorkflowTaskHandler> {
  const { createProductionFeatureWorkflowFromEnv } =
    await import('./production-handler.js');
  return createProductionFeatureWorkflowFromEnv(process.env);
}
