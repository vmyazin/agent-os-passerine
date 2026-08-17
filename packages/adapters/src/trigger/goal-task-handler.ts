import { persistenceId, type DomainRepository } from '@agentos/core';

import { validateDurableGoalInputs } from './goal-workflow.js';

export interface GoalWorkflowTaskExecution {
  readonly taskVersion: string;
  readonly deploymentVersion: string;
  readonly triggerRunId?: string;
}

export interface GoalWorkflowRunner {
  run(input: { readonly runId: string }): Promise<unknown>;
}

export interface GoalWorkflowTaskHandlerOptions {
  readonly repository: DomainRepository;
  readonly workflow?: GoalWorkflowRunner;
  readonly workflowForExecution?: (
    execution?: GoalWorkflowTaskExecution,
  ) => Promise<GoalWorkflowRunner> | GoalWorkflowRunner;
}

export function createGoalWorkflowTaskHandler(
  options: GoalWorkflowTaskHandlerOptions,
): {
  run(
    payload: {
      readonly version: 'goal-task-payload-v1';
      readonly runId: string;
    },
    execution?: GoalWorkflowTaskExecution,
  ): Promise<unknown>;
} {
  return Object.freeze({
    async run(payload, execution) {
      const run = await options.repository.getRun(
        persistenceId('run', payload.runId),
      );
      if (run === undefined || run.pipeline !== 'goal')
        throw new Error('authoritative goal run does not exist');
      const snapshots = await options.repository.listConfigSnapshots(run.id, {
        limit: 2,
      });
      const criteria = await options.repository.listGoalCriteria(run.id, {
        limit: 21,
      });
      validateDurableGoalInputs(run, snapshots, criteria);
      const workflow = options.workflowForExecution
        ? await options.workflowForExecution(execution)
        : options.workflow;
      if (workflow === undefined)
        throw new Error('goal workflow runner is not configured');
      return workflow.run({ runId: run.id });
    },
  });
}
