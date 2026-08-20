// packages/adapters/src/trigger/workflow-budget.ts
import {
  isoTimestamp,
  parseAgentOsConfig,
  persistenceId,
  type AgentOsConfig,
  type ConfigSnapshot,
  type DomainRepository,
  type IsoTimestamp,
  type ProjectId,
} from '@agentos/core';

import { FEATURE_WORKFLOW_DEFAULTS } from './types.js';

export interface WorkflowBudgetLimits {
  readonly workflowLimitMicrodollars: number;
  readonly dailyLimitMicrodollars: number;
  readonly admissionNumerator: number;
  readonly admissionDenominator: number;
}

export function budgetLimitsFromConfig(
  config: AgentOsConfig,
): WorkflowBudgetLimits {
  return {
    workflowLimitMicrodollars: config.budgets.workflowMicrodollars,
    dailyLimitMicrodollars: config.budgets.dailyMicrodollars,
    admissionNumerator: config.budgets.admissionReservePercent,
    admissionDenominator: 100,
  };
}

export function budgetLimitsFromSnapshot(
  snapshot: ConfigSnapshot,
): WorkflowBudgetLimits {
  return budgetLimitsFromConfig(parseAgentOsConfig(snapshot.config));
}

export const DEFAULT_WORKFLOW_BUDGET_LIMITS: WorkflowBudgetLimits = {
  workflowLimitMicrodollars: FEATURE_WORKFLOW_DEFAULTS.workflowMicrodollars,
  dailyLimitMicrodollars: FEATURE_WORKFLOW_DEFAULTS.dailyMicrodollars,
  admissionNumerator: FEATURE_WORKFLOW_DEFAULTS.admissionNumerator,
  admissionDenominator: FEATURE_WORKFLOW_DEFAULTS.admissionDenominator,
};

async function sumUsageInWindow(
  repository: DomainRepository,
  projectId: ProjectId | undefined,
  since: IsoTimestamp,
  until: IsoTimestamp,
): Promise<number> {
  const runs = await repository.listRuns({
    limit: 1_000,
    ...(projectId === undefined ? {} : { projectId }),
  });
  let total = 0;
  for (const run of runs) {
    const usage = await repository.listUsage(run.id, { limit: 1_000 });
    total += usage
      .filter(
        (record) => record.recordedAt >= since && record.recordedAt <= until,
      )
      .reduce((sum, record) => sum + record.microdollars, 0);
  }
  return total;
}

export function createProjectDailyUsageMicrodollars(
  repository: DomainRepository,
): (at: string, projectId: string) => Promise<number> {
  return async (at, projectId) => {
    const until = isoTimestamp(at);
    const since = isoTimestamp(
      new Date(Date.parse(at) - 24 * 60 * 60 * 1_000).toISOString(),
    );
    return sumUsageInWindow(
      repository,
      persistenceId('project', projectId),
      since,
      until,
    );
  };
}

export function createDeploymentDailyUsageMicrodollars(
  repository: DomainRepository,
): (at: string) => Promise<number> {
  return async (at) => {
    const until = isoTimestamp(at);
    const since = isoTimestamp(
      new Date(Date.parse(at) - 24 * 60 * 60 * 1_000).toISOString(),
    );
    return sumUsageInWindow(repository, undefined, since, until);
  };
}

export function deploymentDailyLimitFromEnv(
  environment: Readonly<Record<string, string | undefined>>,
): number | undefined {
  const raw = environment.AGENTOS_DEPLOYMENT_DAILY_MICRODOLLARS?.trim();
  if (raw === undefined || raw === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(
      'AGENTOS_DEPLOYMENT_DAILY_MICRODOLLARS must be a positive integer',
    );
  return parsed;
}

export async function budgetLimitsForRun(
  repository: DomainRepository,
  runId: string,
): Promise<WorkflowBudgetLimits> {
  const snapshots = await repository.listConfigSnapshots(
    persistenceId('run', runId),
    { limit: 2 },
  );
  // Settlement and orphan cleanup call this, and they must never be blocked by
  // a run whose snapshot is missing or unreadable: a reservation that cannot be
  // settled keeps its paid session lease, and under the per-project fence only
  // reconciliation can release it, so the whole project would wedge. Charging
  // an orphan against the conservative deployment defaults is the safe
  // outcome; admission always passes snapshot-derived limits explicitly.
  if (snapshots.length !== 1) return DEFAULT_WORKFLOW_BUDGET_LIMITS;
  try {
    return budgetLimitsFromSnapshot(snapshots[0]!);
  } catch {
    return DEFAULT_WORKFLOW_BUDGET_LIMITS;
  }
}

export function resolveWorkflowBudgetLimits(
  dependencies: {
    readonly budgetLimits?: WorkflowBudgetLimits;
  },
): WorkflowBudgetLimits {
  return dependencies.budgetLimits ?? DEFAULT_WORKFLOW_BUDGET_LIMITS;
}

export function resolveProjectDailyUsageMicrodollars(dependencies: {
  readonly projectDailyUsageMicrodollars?: (
    at: string,
    projectId: string,
  ) => Promise<number>;
  readonly dailyUsageMicrodollars?: (
    at: string,
    projectId: string,
  ) => Promise<number>;
}): (at: string, projectId: string) => Promise<number> {
  return (
    dependencies.projectDailyUsageMicrodollars ??
    dependencies.dailyUsageMicrodollars ??
    (async () => 0)
  );
}
