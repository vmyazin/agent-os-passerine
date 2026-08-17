import { persistenceId, type DomainRepository } from '@agentos/core';

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
      if (snapshots.length !== 1)
        throw new Error('goal run must have exactly one config snapshot');
      const criteria = await options.repository.listGoalCriteria(run.id, {
        limit: 21,
      });
      if (criteria.length < 1 || criteria.length > 20)
        throw new Error('goal run must have a bounded criterion set');
      const workflow = options.workflowForExecution
        ? await options.workflowForExecution(execution)
        : options.workflow;
      if (workflow === undefined)
        throw new Error('goal workflow runner is not configured');
      return workflow.run({ runId: run.id });
    },
  });
}
