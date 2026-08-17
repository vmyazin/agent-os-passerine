import { AbortTaskRunError, task } from '@trigger.dev/sdk';
import { z } from 'zod';

import { createLazyProductionGoalWorkflowTaskHandler } from './goal-production-composition.js';
import {
  GOAL_WORKFLOW_TASK_ID,
  GoalWorkflowTaskTransientError,
} from './types.js';

export const goalTaskPayloadSchema = z
  .object({
    version: z.literal('goal-task-payload-v1'),
    runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  })
  .strict();

export type GoalTaskPayload = z.infer<typeof goalTaskPayloadSchema>;

export interface GoalWorkflowTaskHandler {
  run(
    payload: GoalTaskPayload,
    execution?: {
      readonly taskVersion: string;
      readonly deploymentVersion: string;
      readonly triggerRunId?: string;
    },
  ): Promise<unknown>;
}

let handler: GoalWorkflowTaskHandler =
  createLazyProductionGoalWorkflowTaskHandler();

/** Test/development override; production defaults to the repo-owned composition. */
export function registerGoalWorkflowTaskHandler(
  value: GoalWorkflowTaskHandler,
): void {
  handler = value;
}

export const goalWorkflowTask = task({
  id: 'agentos-goal-workflow-v1',
  queue: { name: 'agentos-goal-workflow', concurrencyLimit: 1 },
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 1_000,
    maxTimeoutInMs: 10_000,
    factor: 2,
    randomize: true,
  },
  maxDuration: 3_600,
  run: async (rawPayload: unknown, context) => {
    const parsed = goalTaskPayloadSchema.safeParse(rawPayload);
    if (!parsed.success)
      throw new AbortTaskRunError('invalid goal workflow task payload');
    try {
      return await handler.run(parsed.data, {
        taskVersion: GOAL_WORKFLOW_TASK_ID,
        deploymentVersion:
          context.ctx.deployment?.version ??
          process.env.TRIGGER_VERSION ??
          'development-unversioned',
        ...(context?.ctx?.run?.id === undefined
          ? {}
          : { triggerRunId: context.ctx.run.id }),
      });
    } catch (error) {
      if (error instanceof GoalWorkflowTaskTransientError) throw error;
      const detail =
        error instanceof Error ? `: ${error.message.slice(0, 200)}` : '';
      throw new AbortTaskRunError(
        `permanent goal workflow task failure${detail}`,
      );
    }
  },
});
