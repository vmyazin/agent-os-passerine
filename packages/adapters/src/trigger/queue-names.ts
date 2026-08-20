// packages/adapters/src/trigger/queue-names.ts

/** Per-project Trigger queue for feature workflows (concurrency 1 within project). */
export function featureWorkflowQueueName(projectId: string): string {
  return `agentos-feature-${projectId}`;
}

/** Per-project Trigger queue for goal workflows (concurrency 1 within project). */
export function goalWorkflowQueueName(projectId: string): string {
  return `agentos-goal-${projectId}`;
}
