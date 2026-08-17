import { parseAgentOsConfig, type ConfigSnapshot } from '@agentos/core';

import type { FeatureWorkflowTaskHandler } from './task.js';
import type { FeatureRole, FeatureWorkflowRoles } from './types.js';

let initialized: Promise<FeatureWorkflowTaskHandler> | undefined;

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
            tools: [...agent.tools],
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
