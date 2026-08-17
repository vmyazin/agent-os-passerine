import { AbortTaskRunError, task } from '@trigger.dev/sdk';
import { z } from 'zod';

import { FeatureWorkflowTaskTransientError } from './types.js';
import { createLazyProductionFeatureWorkflowTaskHandler } from './production-composition.js';

export const featureTaskPayloadSchema = z
  .object({
    version: z.literal('feature-task-payload-v1'),
    runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  })
  .strict();

export type FeatureTaskPayload = z.infer<typeof featureTaskPayloadSchema>;

export interface FeatureWorkflowTaskHandler {
  run(
    payload: FeatureTaskPayload,
    execution?: {
      readonly taskVersion: string;
      readonly deploymentVersion: string;
      readonly triggerRunId?: string;
    },
  ): Promise<unknown>;
}

let handler: FeatureWorkflowTaskHandler =
  createLazyProductionFeatureWorkflowTaskHandler();

/** Test/development override; production defaults to the repo-owned composition. */
export function registerFeatureWorkflowTaskHandler(
  value: FeatureWorkflowTaskHandler,
): void {
  handler = value;
}

export const featureWorkflowTask = task({
  id: 'agentos-feature-workflow-v1',
  queue: { name: 'agentos-feature-workflow', concurrencyLimit: 1 },
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 1_000,
    maxTimeoutInMs: 10_000,
    factor: 2,
    randomize: true,
  },
  maxDuration: 3_600,
  run: async (rawPayload: unknown, context) => {
    const parsed = featureTaskPayloadSchema.safeParse(rawPayload);
    if (!parsed.success)
      throw new AbortTaskRunError('invalid feature workflow task payload');
    try {
      return await handler.run(parsed.data, {
        taskVersion: 'agentos-feature-workflow-v1',
        deploymentVersion:
          context.ctx.deployment?.version ??
          process.env.TRIGGER_VERSION ??
          'development-unversioned',
        ...(context?.ctx?.run?.id === undefined
          ? {}
          : { triggerRunId: context.ctx.run.id }),
      });
    } catch (error) {
      if (error instanceof FeatureWorkflowTaskTransientError) throw error;
      throw new AbortTaskRunError('permanent feature workflow task failure');
    }
  },
});
