import { repositoryFromEnv } from '../persistence/repository-factory';
import { workflowDispatchFromEnv } from './runtime';
import { reconcileWorkflowOutbox } from './workflow-reconciliation';

export async function runConfiguredWorkflowReconciliation(): Promise<unknown> {
  const outbox = workflowDispatchFromEnv();
  if (outbox === undefined)
    throw new Error('Trigger workflow dispatch is not configured');
  return reconcileWorkflowOutbox(repositoryFromEnv(), outbox);
}
