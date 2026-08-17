import type { DomainRepository } from '@agentos/core';
import { persistenceId } from '@agentos/core';
import { z } from 'zod';

import { featureWorkflowInputSchema } from './schemas.js';
import type { FeatureWorkflowResult } from './types.js';

const runInputSchema = z
  .object({
    idempotencyKey: z.string().min(1).max(256),
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(20_000),
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
  }): Promise<string>;
}

export interface DurableFeatureWorkflowRunner {
  run(input: unknown): Promise<FeatureWorkflowResult>;
}

export interface FeatureWorkflowTaskHandlerOptions {
  readonly repository: DomainRepository;
  readonly workflow: DurableFeatureWorkflowRunner;
  readonly sourceSnapshot: SourceSnapshotResolver;
}

export function createFeatureWorkflowTaskHandler(
  options: FeatureWorkflowTaskHandlerOptions,
): {
  run(payload: {
    readonly version: 'feature-task-payload-v1';
    readonly runId: string;
  }): Promise<FeatureWorkflowResult>;
} {
  return Object.freeze({
    async run(payload) {
      const run = await options.repository.getRun(
        persistenceId('run', payload.runId),
      );
      if (run === undefined || run.pipeline !== 'feature')
        throw new Error('authoritative feature run does not exist');
      const stored = runInputSchema.safeParse(run.input);
      if (!stored.success)
        throw new Error('authoritative feature run input is invalid');
      const sourceSnapshotDigest = await options.sourceSnapshot.resolve({
        projectId: run.projectId,
        runId: run.id,
        repositorySha: stored.data.provenance.repositorySha,
      });
      const workflowInput = featureWorkflowInputSchema.parse({
        version: 'feature-workflow-input-v1',
        runId: run.id,
        projectId: run.projectId,
        feature: {
          title: stored.data.title,
          description: stored.data.description,
        },
        source: {
          repositorySha: stored.data.provenance.repositorySha,
          sourceSnapshotDigest,
        },
        digests: {
          config: stored.data.provenance.configDigest,
          model: stored.data.provenance.modelDigest,
          prompt: stored.data.provenance.promptDigest,
          environment: stored.data.provenance.environmentDigest,
          policy: stored.data.provenance.policyDigest,
        },
      });
      return options.workflow.run(workflowInput);
    },
  });
}
