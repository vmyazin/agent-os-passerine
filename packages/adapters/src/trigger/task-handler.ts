import { createHash } from 'node:crypto';

import type { ConfigSnapshot, DomainRepository } from '@agentos/core';
import {
  canonicalConfigHash,
  canonicalJsonValue,
  canonicalPublicationPolicyDigest,
  normalizePublicationPolicySnapshot,
  parseAgentOsConfig,
  persistenceId,
} from '@agentos/core';
import { z } from 'zod';

import { featureWorkflowInputSchema, runChainSchema } from './schemas.js';
import type { FeatureWorkflowResult } from './types.js';

const runInputSchema = z
  .object({
    idempotencyKey: z.string().min(1).max(256),
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(20_000),
    // A chained run's source is its base run's published commit; the
    // control plane resolved it from that run's own publication record, so
    // dispatch reads it rather than re-deriving anything.
    chain: runChainSchema.optional(),
    provenance: z
      .object({
        repositorySha: z.string().regex(/^[0-9a-f]{40}$/),
        configDigest: z.string().regex(/^[0-9a-f]{64}$/),
        modelDigest: z.string().regex(/^[0-9a-f]{64}$/),
        promptDigest: z.string().regex(/^[0-9a-f]{64}$/),
        environmentDigest: z.string().regex(/^[0-9a-f]{64}$/),
        policyDigest: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
  })
  .strict();

export interface SourceSnapshotResolver {
  resolve(input: {
    readonly projectId: string;
    readonly runId: string;
    readonly repositorySha: string;
  }): Promise<
    string | { readonly digest: string; readonly artifactKey: string }
  >;
}

export interface DurableFeatureWorkflowRunner {
  run(input: unknown): Promise<FeatureWorkflowResult>;
}

export interface FeatureWorkflowTaskHandlerOptions {
  readonly repository: DomainRepository;
  readonly workflow?: DurableFeatureWorkflowRunner;
  readonly workflowForSnapshot?: (
    snapshot: ConfigSnapshot,
    execution?: {
      readonly taskVersion: string;
      readonly deploymentVersion: string;
      readonly triggerRunId?: string;
    },
  ) => Promise<DurableFeatureWorkflowRunner> | DurableFeatureWorkflowRunner;
  readonly sourceSnapshot: SourceSnapshotResolver;
}

export function createFeatureWorkflowTaskHandler(
  options: FeatureWorkflowTaskHandlerOptions,
): {
  run(
    payload: {
      readonly version: 'feature-task-payload-v1';
      readonly runId: string;
    },
    execution?: {
      readonly taskVersion: string;
      readonly deploymentVersion: string;
      readonly triggerRunId?: string;
    },
  ): Promise<FeatureWorkflowResult>;
} {
  return Object.freeze({
    async run(payload, execution) {
      const run = await options.repository.getRun(
        persistenceId('run', payload.runId),
      );
      if (run === undefined || run.pipeline !== 'feature')
        throw new Error('authoritative feature run does not exist');
      const stored = runInputSchema.safeParse(run.input);
      if (!stored.success)
        throw new Error('authoritative feature run input is invalid');
      const snapshots = await options.repository.listConfigSnapshots(run.id, {
        limit: 2,
      });
      if (snapshots.length !== 1)
        throw new Error('feature run must have exactly one config snapshot');
      const snapshot = snapshots[0]!;
      const config = parseAgentOsConfig(snapshot.config);
      const componentHash = (value: unknown) =>
        createHash('sha256').update(canonicalJsonValue(value)).digest('hex');
      const expectedPolicyDigest = canonicalPublicationPolicyDigest(
        normalizePublicationPolicySnapshot({
          version: 'publication-policy-v1',
          protectedPaths: config.policies.protectedPaths,
          maxFiles: 100,
          maxFileBytes: config.policies.maxFileBytes,
          maxTotalBytes: 5_000_000,
          allowBinary: config.policies.allowBinary,
          allowSymlinks: config.policies.allowSymlinks,
          allowDeletes: true,
          allowedModes: ['100644', '100755'],
        }),
      );
      if (
        canonicalConfigHash(config) !== snapshot.configDigest ||
        componentHash(config.models) !== snapshot.modelDigest ||
        componentHash(
          Object.fromEntries(
            Object.entries(config.agents).map(([name, agent]) => [
              name,
              agent.prompt ?? '',
            ]),
          ),
        ) !== snapshot.promptDigest ||
        componentHash(config.environments) !== snapshot.environmentDigest ||
        expectedPolicyDigest !== snapshot.policyDigest ||
        snapshot.repositorySha !== stored.data.provenance.repositorySha ||
        snapshot.configDigest !== stored.data.provenance.configDigest ||
        snapshot.modelDigest !== stored.data.provenance.modelDigest ||
        snapshot.promptDigest !== stored.data.provenance.promptDigest ||
        snapshot.environmentDigest !==
          stored.data.provenance.environmentDigest ||
        snapshot.policyDigest !== stored.data.provenance.policyDigest
      )
        throw new Error('feature run config snapshot provenance mismatch');
      // Provenance still pins the applied configuration revision and its
      // SHA -- every assertion above ran against it. What changes for a
      // chained run is only where the source is read from.
      const sourceSha =
        stored.data.chain?.baseCommitSha ??
        stored.data.provenance.repositorySha;
      const sourceSnapshot = await options.sourceSnapshot.resolve({
        projectId: run.projectId,
        runId: run.id,
        repositorySha: sourceSha,
      });
      const workflowInput = featureWorkflowInputSchema.parse({
        version: 'feature-workflow-input-v1',
        runId: run.id,
        projectId: run.projectId,
        feature: {
          title: stored.data.title,
          description: stored.data.description,
        },
        ...(stored.data.chain === undefined
          ? {}
          : { chain: stored.data.chain }),
        source: {
          repositorySha: sourceSha,
          sourceSnapshotDigest:
            typeof sourceSnapshot === 'string'
              ? sourceSnapshot
              : sourceSnapshot.digest,
          ...(typeof sourceSnapshot === 'string'
            ? {}
            : { sourceArtifactKey: sourceSnapshot.artifactKey }),
        },
        digests: {
          config: stored.data.provenance.configDigest,
          model: stored.data.provenance.modelDigest,
          prompt: stored.data.provenance.promptDigest,
          environment: stored.data.provenance.environmentDigest,
          policy: stored.data.provenance.policyDigest,
        },
      });
      const runner = options.workflowForSnapshot
        ? await options.workflowForSnapshot(snapshot, execution)
        : options.workflow;
      if (runner === undefined)
        throw new Error('feature workflow runner is not configured');
      return runner.run(workflowInput);
    },
  });
}
