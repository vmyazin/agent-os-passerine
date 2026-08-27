import type {
  Approval,
  ArtifactRecord,
  Backlog,
  BacklogItem,
  ConfigRevision,
  ConfigSnapshot,
  DomainEvent,
  ExternalSession,
  GoalCriterion,
  GoalProgress,
  InboxMessage,
  Project,
  ProjectSource,
  StepRun,
  UsageRecordEntry,
  UserPreferences,
  WebhookReceipt,
  WorkflowRun,
} from '@agentos/core';
import { sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { getTableColumns } from 'drizzle-orm/utils';

import {
  approvals,
  artifacts,
  configRevisions,
  configSnapshots,
  domainEvents,
  externalSessions,
  goalCriteria,
  goalProgress,
  inboxMessages,
  projects,
  projectSources,
  stepRuns,
  usageRecords,
  webhookReceipts,
  workflowRuns,
  userPreferences,
  backlogs,
  backlogItems,
} from './schema.js';

type SqlRow = Readonly<Record<string, unknown>>;

interface RowMapping {
  readonly requiredJson?: readonly string[];
  readonly optionalJson?: Readonly<Record<string, string>>;
}

function mapRow<T>(row: SqlRow, mapping: RowMapping = {}): T {
  const requiredJson = new Set(mapping.requiredJson);
  const optionalJson = mapping.optionalJson ?? {};
  const presenceKeys = new Set(Object.values(optionalJson));
  const mapped: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(row)) {
    if (presenceKeys.has(key)) continue;
    if (value !== null) {
      mapped[key] = value;
      continue;
    }
    if (requiredJson.has(key)) {
      mapped[key] = null;
      continue;
    }
    const presenceKey = optionalJson[key];
    if (presenceKey !== undefined && row[presenceKey] === true) {
      mapped[key] = null;
    }
  }

  return mapped as T;
}

function present(column: PgColumn, alias: string) {
  return sql<boolean>`${column} is not null`.as(alias);
}

export const projectSelection = getTableColumns(projects);
export const userPreferencesSelection = getTableColumns(userPreferences);
export const projectSourceSelection = getTableColumns(projectSources);
export const configRevisionSelection = getTableColumns(configRevisions);
export const configSnapshotSelection = getTableColumns(configSnapshots);
export const workflowRunSelection = {
  ...getTableColumns(workflowRuns),
  inputPresent: present(workflowRuns.input, 'input_present'),
  outputPresent: present(workflowRuns.output, 'output_present'),
  errorPresent: present(workflowRuns.error, 'error_present'),
};
export const stepRunSelection = {
  ...getTableColumns(stepRuns),
  inputPresent: present(stepRuns.input, 'input_present'),
  outputPresent: present(stepRuns.output, 'output_present'),
  errorPresent: present(stepRuns.error, 'error_present'),
};
export const externalSessionSelection = {
  ...getTableColumns(externalSessions),
  statePresent: present(externalSessions.state, 'state_present'),
};
export const approvalSelection = getTableColumns(approvals);
export const inboxMessageSelection = {
  ...getTableColumns(inboxMessages),
  replyPresent: present(inboxMessages.reply, 'reply_present'),
};
export const domainEventSelection = {
  ...getTableColumns(domainEvents),
  payloadPresent: present(domainEvents.payload, 'payload_present'),
};
export const artifactSelection = getTableColumns(artifacts);
export const usageRecordSelection = getTableColumns(usageRecords);
export const webhookReceiptSelection = getTableColumns(webhookReceipts);
export const goalCriterionSelection = getTableColumns(goalCriteria);
export const backlogSelection = getTableColumns(backlogs);
export const backlogItemSelection = getTableColumns(backlogItems);
export const goalProgressSelection = {
  ...getTableColumns(goalProgress),
  payloadPresent: present(goalProgress.payload, 'payload_present'),
};

export const mapBacklogRow = (row: SqlRow): Backlog => mapRow(row);
export const mapBacklogItemRow = (row: SqlRow): BacklogItem => mapRow(row);
export const mapProjectRow = (row: SqlRow): Project => mapRow(row);
export const mapUserPreferencesRow = (row: SqlRow): UserPreferences =>
  mapRow(row);
export const mapProjectSourceRow = (row: SqlRow): ProjectSource => {
  const common = {
    projectId: row.projectId as ProjectSource['projectId'],
    sourceKey: row.sourceKey as string,
    defaultBranch: row.defaultBranch as string,
    createdAt: row.createdAt as ProjectSource['createdAt'],
    updatedAt: row.updatedAt as ProjectSource['updatedAt'],
  };
  if (row.kind === 'github') {
    return {
      ...common,
      kind: 'github',
      repositoryUrl: row.repositoryUrl as string,
      owner: row.githubOwner as string,
      name: row.githubName as string,
      repositoryId: row.repositoryId as number,
      readerInstallationId: row.readerInstallationId as number,
      ...(row.publisherInstallationId === null
        ? {}
        : { publisherInstallationId: row.publisherInstallationId as number }),
    };
  }
  return {
    ...common,
    kind: 'local',
    localPath: row.localPath as string,
  };
};
export const mapConfigRevisionRow = (row: SqlRow): ConfigRevision =>
  mapRow(row, { requiredJson: ['config'] });
export const mapConfigSnapshotRow = (row: SqlRow): ConfigSnapshot =>
  mapRow(row, { requiredJson: ['config'] });
export const mapWorkflowRunRow = (row: SqlRow): WorkflowRun => {
  const mapped = mapRow<WorkflowRun & { idempotencyFingerprint?: string }>(
    row,
    {
      optionalJson: {
        input: 'inputPresent',
        output: 'outputPresent',
        error: 'errorPresent',
      },
    },
  );
  delete mapped.idempotencyFingerprint;
  return mapped;
};
export const mapStepRunRow = (row: SqlRow): StepRun =>
  mapRow(row, {
    optionalJson: {
      input: 'inputPresent',
      output: 'outputPresent',
      error: 'errorPresent',
    },
  });
export const mapExternalSessionRow = (row: SqlRow): ExternalSession =>
  mapRow(row, { optionalJson: { state: 'statePresent' } });
export const mapApprovalRow = (row: SqlRow): Approval => mapRow(row);
export const mapInboxMessageRow = (row: SqlRow): InboxMessage =>
  mapRow(row, {
    requiredJson: ['body'],
    optionalJson: { reply: 'replyPresent' },
  });
export const mapDomainEventRow = (row: SqlRow): DomainEvent =>
  mapRow(row, { optionalJson: { payload: 'payloadPresent' } });
export const mapArtifactRow = (row: SqlRow): ArtifactRecord => mapRow(row);
export const mapUsageRecordRow = (row: SqlRow): UsageRecordEntry => mapRow(row);
export const mapWebhookReceiptRow = (row: SqlRow): WebhookReceipt =>
  mapRow(row);
export const mapGoalCriterionRow = (row: SqlRow): GoalCriterion =>
  mapRow(row, { requiredJson: ['definition'] });
export const mapGoalProgressRow = (row: SqlRow): GoalProgress =>
  mapRow(row, { optionalJson: { payload: 'payloadPresent' } });
