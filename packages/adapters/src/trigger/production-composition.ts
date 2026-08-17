import { parseAgentOsConfig, type ConfigSnapshot } from '@agentos/core';

import type { FeatureWorkflowTaskHandler } from './task.js';
import type { FeatureRole, FeatureWorkflowRoles } from './types.js';

let initialized: Promise<FeatureWorkflowTaskHandler> | undefined;

const FEATURE_ROLES: readonly FeatureRole[] = [
  'specification',
  'planning',
  'implementation',
  'review',
];

export function resolveFeatureRolesFromSnapshot(
  snapshot: ConfigSnapshot,
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
      return [
        role,
        {
          agent: {
            id: step.agent,
            model: model.model,
            instructions: agent.prompt,
            tools: [...agent.tools],
            mcps: [...agent.mcps],
          },
          environment: {
            id: environmentId,
            runtime: environment.runtime,
            image: environment.image,
            variables: { ...environment.variables },
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
