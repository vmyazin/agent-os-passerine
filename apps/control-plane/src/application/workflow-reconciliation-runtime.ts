import { createNeonWorkflowReconciliationCursorStore } from '@agentos/adapters';
import { repositoryFromEnv } from '../persistence/repository-factory';
import { controlPlaneService, workflowDispatchFromEnv } from './runtime';
import { reconcileWorkflowOutbox } from './workflow-reconciliation';

export async function runConfiguredWorkflowReconciliation(): Promise<unknown> {
  const outbox = workflowDispatchFromEnv();
  if (outbox === undefined)
    throw new Error('Trigger workflow dispatch is not configured');
  const repository = repositoryFromEnv();
  const projects = await repository.listProjects({ limit: 1_000 });
  let scannedRuns = 0;
  let delivered = 0;
  let failed = 0;
  for (const project of projects) {
    const result = await reconcileWorkflowOutbox(
      repository,
      outbox,
      undefined,
      createNeonWorkflowReconciliationCursorStore(process.env, project.id),
      {
        projectId: project.id,
        advanceBacklogs: async (projectId) => {
          await controlPlaneService().advanceBacklogs(projectId);
        },
      },
    );
    scannedRuns += result.scannedRuns;
    delivered += result.delivered;
    failed += result.failed;
  }
  return { scannedRuns, delivered, failed };
}
