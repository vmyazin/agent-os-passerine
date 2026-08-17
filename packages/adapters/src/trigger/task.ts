import { AbortTaskRunError, task } from '@trigger.dev/sdk';
import { z } from 'zod';

import { FeatureWorkflowTaskTransientError } from './types.js';

export const featureTaskPayloadSchema = z
  .object({
    version: z.literal('feature-task-payload-v1'),
    runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  })
  .strict();

export type FeatureTaskPayload = z.infer<typeof featureTaskPayloadSchema>;

export interface FeatureWorkflowTaskHandler {
  run(payload: FeatureTaskPayload): Promise<unknown>;
}

let handler: FeatureWorkflowTaskHandler | undefined;

/** Called by the deployment bootstrap after constructing trusted adapters. */
export function registerFeatureWorkflowTaskHandler(
  value: FeatureWorkflowTaskHandler,
): void {
  if (handler !== undefined)
    throw new Error('feature workflow task handler is already registered');
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
  run: async (rawPayload: unknown) => {
    const parsed = featureTaskPayloadSchema.safeParse(rawPayload);
    if (!parsed.success)
      throw new AbortTaskRunError('invalid feature workflow task payload');
    if (handler === undefined)
      throw new AbortTaskRunError(
        'feature workflow task handler was not registered',
      );
    try {
      return await handler.run(parsed.data);
    } catch (error) {
      if (error instanceof FeatureWorkflowTaskTransientError) throw error;
      throw new AbortTaskRunError('permanent feature workflow task failure');
    }
  },
});
