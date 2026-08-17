import type { GoalWorkflowTaskHandler } from './goal-task.js';

let initialized: Promise<GoalWorkflowTaskHandler> | undefined;

/** Keeps Trigger task discovery free of secret-bearing adapter construction. */
export function createLazyProductionGoalWorkflowTaskHandler(): GoalWorkflowTaskHandler {
  return Object.freeze({
    async run(
      payload: Parameters<GoalWorkflowTaskHandler['run']>[0],
      execution?: Parameters<GoalWorkflowTaskHandler['run']>[1],
    ) {
      initialized ??= initializeProductionHandler();
      return (await initialized).run(payload, execution);
    },
  });
}

async function initializeProductionHandler(): Promise<GoalWorkflowTaskHandler> {
  const { createProductionGoalWorkflowFromEnv } =
    await import('./production-handler.js');
  return createProductionGoalWorkflowFromEnv(process.env);
}
