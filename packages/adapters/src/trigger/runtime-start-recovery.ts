import {
  calculateUsageCost,
  USAGE_PRICING_VERSION,
  parseAgentOsConfig,
  persistenceId,
  type DomainRepository,
  type JsonValue,
  type RuntimeFileResource,
  type RuntimeUsage,
} from '@agentos/core';

import { resolveFeatureRolesFromSnapshot } from './production-composition.js';
import type { FeatureRole, WorkflowCheckpointStore } from './types.js';

function record(
  value: JsonValue | undefined,
): Record<string, JsonValue> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : undefined;
}

function roleForStep(stepKey: string): FeatureRole {
  if (stepKey === 'fix') return 'implementation';
  if (stepKey === 'review-after-fix') return 'review';
  if (
    stepKey === 'specification' ||
    stepKey === 'planning' ||
    stepKey === 'implementation' ||
    stepKey === 'review' ||
    stepKey === 'verification'
  )
    return stepKey;
  throw new Error('runtime recovery step role is invalid');
}

function accessOutput(value: JsonValue | undefined): {
  resources: RuntimeFileResource[];
  credentialRefs: string[];
} {
  const source = record(value);
  if (
    !source ||
    !Array.isArray(source.resources) ||
    !Array.isArray(source.credentialRefs)
  )
    throw new Error('runtime recovery access checkpoint is invalid');
  const resources = source.resources.map((candidate) => {
    const item = record(candidate);
    if (!item || item.type !== 'file' || typeof item.fileId !== 'string')
      throw new Error('runtime recovery file resource is invalid');
    return {
      type: 'file' as const,
      fileId: item.fileId,
      ...(typeof item.mountPath === 'string'
        ? { mountPath: item.mountPath }
        : {}),
    };
  });
  const credentialRefs = source.credentialRefs.map((value) => {
    if (typeof value !== 'string')
      throw new Error('runtime recovery credential reference is invalid');
    return value;
  });
  return { resources, credentialRefs };
}

export function createRuntimeStartRecoveryResolver(options: {
  readonly repository: DomainRepository;
  readonly checkpoints: WorkflowCheckpointStore;
  readonly artifactMcpUrl: string;
}) {
  return Object.freeze({
    async resolve(input: {
      readonly runId: string;
      readonly effectKey: string;
    }) {
      const run = await options.repository.getRun(
        persistenceId('run', input.runId),
      );
      if (run === undefined)
        throw new Error('runtime recovery run is unavailable');
      const steps = await options.repository.listStepRuns(run.id, {
        limit: 100,
      });
      const step = steps.find(
        (candidate) =>
          `runtime:${input.runId}:${candidate.stepKey}:${String(candidate.attempt)}` ===
          input.effectKey,
      );
      if (step === undefined)
        throw new Error('runtime recovery step intent is unavailable');
      const snapshots = await options.repository.listConfigSnapshots(run.id, {
        limit: 2,
      });
      if (snapshots.length !== 1)
        throw new Error('runtime recovery config snapshot is unavailable');
      const snapshot = snapshots[0]!;
      const roles = resolveFeatureRolesFromSnapshot(snapshot, {
        artifactMcpUrl: options.artifactMcpUrl,
      });
      const role = roleForStep(step.stepKey);
      const definition = roles[role];
      const stepInput = record(step.input);
      const payload = stepInput?.payload;
      const provenance = record(stepInput?.provenance);
      if (payload === undefined || provenance === undefined)
        throw new Error('runtime recovery step payload is unavailable');
      const sourceEffects = await options.checkpoints.listEffects(input.runId);
      const access = sourceEffects.find(
        (effect) =>
          effect.key ===
            `runtime-access:${input.runId}:${step.stepKey}:${String(step.attempt)}` &&
          effect.status === 'succeeded',
      );
      const sessionAccess = accessOutput(access?.output);
      const repositorySha = provenance.repositorySha;
      const sourceSnapshotDigest = provenance.sourceSnapshotDigest;
      const configDigest = record(provenance.digests)?.config;
      if (
        typeof repositorySha !== 'string' ||
        typeof sourceSnapshotDigest !== 'string' ||
        typeof configDigest !== 'string'
      )
        throw new Error('runtime recovery provenance is invalid');
      const config = parseAgentOsConfig(snapshot.config);
      const modelConfig = Object.values(config.models).find(
        (candidate) => candidate.model === definition.agent.model,
      );
      if (modelConfig === undefined)
        throw new Error('runtime recovery model pricing is unavailable');
      const priceUsage = (usage: RuntimeUsage) =>
        calculateUsageCost(usage, modelConfig);
      return {
        request: {
          runId: input.runId,
          stepId: step.id,
          agentId: definition.agent.id,
          environmentId: definition.environment.id,
          input: payload,
          timeoutMs: 20 * 60_000,
          idempotencyKey: input.effectKey,
          maxCostMicrodollars: definition.maxReservationMicrodollars ?? 700_000,
          resources: sessionAccess.resources,
          credentialRefs: sessionAccess.credentialRefs,
        },
        aadForExternalId: (externalId: string) =>
          ({
            version: 'runtime-handle-aad-v1',
            runId: input.runId,
            stepId: step.id,
            role,
            externalId,
            repositorySha,
            sourceSnapshotDigest,
            configDigest,
          }) as JsonValue,
        role,
        stepRunId: step.id,
        stepKey: step.stepKey,
        resources: sessionAccess.resources,
        credentialRefs: sessionAccess.credentialRefs,
        model: definition.agent.model,
        pricingVersion: `${USAGE_PRICING_VERSION}:${snapshot.configDigest}`,
        priceUsage,
      };
    },
  });
}
