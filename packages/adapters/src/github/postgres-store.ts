import { neon } from '@neondatabase/serverless';

import { GitHubPublisherError } from './errors.js';
import type {
  PublicationEvent,
  PublicationPhase,
  PublicationRecord,
  PublicationStore,
} from './types.js';
import { databaseUrlFromEnv } from '../persistence/database-config.js';

export interface PublicationSqlExecutor {
  execute(
    query: string,
    parameters: readonly unknown[],
  ): Promise<readonly unknown[]>;
}

const phases = new Set<PublicationPhase>([
  'claimed',
  'blobs_created',
  'tree_created',
  'commit_created',
  'ref_created',
  'pr_created',
  'succeeded',
  'cancelled',
  'failed',
]);

function row(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requiredString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined
    ? undefined
    : requiredString(value);
}

function safeInteger(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  if (!/^[1-9]\d*$/.test(String(value))) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function malformed(): never {
  throw new GitHubPublisherError(
    'publication_store_conflict',
    'Durable publication record is malformed',
  );
}

function mapRecord(value: unknown): PublicationRecord {
  const input = row(value);
  const phase = requiredString(input?.phase) as PublicationPhase | undefined;
  const repositoryId = safeInteger(input?.repositoryId);
  const revision = safeInteger(input?.revision);
  const pullRequestNumber =
    input?.pullRequestNumber === null || input?.pullRequestNumber === undefined
      ? undefined
      : safeInteger(input.pullRequestNumber);
  const blobShasValue = input?.blobShas;
  const blobShas =
    blobShasValue === null || blobShasValue === undefined
      ? undefined
      : row(blobShasValue);
  if (
    input === undefined ||
    phase === undefined ||
    !phases.has(phase) ||
    repositoryId === undefined ||
    revision === undefined ||
    (input.pullRequestNumber !== null &&
      input.pullRequestNumber !== undefined &&
      pullRequestNumber === undefined) ||
    (blobShas !== undefined &&
      Object.values(blobShas).some((entry) => typeof entry !== 'string'))
  ) {
    malformed();
  }
  const required = {
    key: requiredString(input.key),
    bindingKey: requiredString(input.bindingKey),
    projectId: requiredString(input.projectId),
    runId: requiredString(input.runId),
    manifestDigest: requiredString(input.manifestDigest),
    policyDigest: requiredString(input.policyDigest),
    baseSha: requiredString(input.baseSha),
    branch: requiredString(input.branch),
    createdAt: requiredString(input.createdAt),
    updatedAt: requiredString(input.updatedAt),
  };
  if (Object.values(required).some((entry) => entry === undefined)) malformed();
  if (input.draft !== null && input.draft !== undefined && input.draft !== true)
    malformed();
  return {
    key: required.key!,
    bindingKey: required.bindingKey!,
    projectId: required.projectId!,
    runId: required.runId!,
    repositoryId,
    manifestDigest: required.manifestDigest!,
    policyDigest: required.policyDigest!,
    baseSha: required.baseSha!,
    branch: required.branch!,
    phase,
    ...(blobShas === undefined
      ? {}
      : { blobShas: blobShas as Record<string, string> }),
    ...(optionalString(input.treeSha) === undefined
      ? {}
      : { treeSha: optionalString(input.treeSha)! }),
    ...(optionalString(input.commitSha) === undefined
      ? {}
      : { commitSha: optionalString(input.commitSha)! }),
    ...(pullRequestNumber === undefined ? {} : { pullRequestNumber }),
    ...(optionalString(input.pullRequestUrl) === undefined
      ? {}
      : { pullRequestUrl: optionalString(input.pullRequestUrl)! }),
    ...(input.draft === true ? { draft: true as const } : {}),
    ...(optionalString(input.errorCode) === undefined
      ? {}
      : { errorCode: optionalString(input.errorCode)! }),
    revision,
    createdAt: required.createdAt!,
    updatedAt: required.updatedAt!,
  };
}

function mapEvent(value: unknown): PublicationEvent {
  const input = row(value);
  const publicationKey = requiredString(input?.publicationKey);
  const phase = requiredString(input?.phase) as PublicationPhase | undefined;
  const at = requiredString(input?.at);
  const details = row(input?.details);
  if (
    publicationKey === undefined ||
    phase === undefined ||
    !phases.has(phase) ||
    at === undefined ||
    details === undefined ||
    Object.values(details).some(
      (entry) =>
        typeof entry !== 'string' &&
        typeof entry !== 'number' &&
        typeof entry !== 'boolean',
    )
  ) {
    malformed();
  }
  return {
    publicationKey,
    phase,
    at,
    details: details as Record<string, string | number | boolean>,
  };
}

function isPublicationConflict(error: unknown): boolean {
  const input = row(error);
  return (
    input?.code === 'P0001' &&
    typeof input.message === 'string' &&
    input.message.includes('agentos_publication_conflict')
  );
}

const selection = `
  "publication_key" as "key", "binding_key" as "bindingKey",
  "project_id" as "projectId", "run_id" as "runId",
  "repository_id"::text as "repositoryId", "manifest_digest" as "manifestDigest",
  "policy_digest" as "policyDigest", "base_sha" as "baseSha", "branch",
  "phase", "blob_shas" as "blobShas", "tree_sha" as "treeSha",
  "commit_sha" as "commitSha", "pull_request_number"::text as "pullRequestNumber",
  "pull_request_url" as "pullRequestUrl", "draft", "error_code" as "errorCode",
  "revision"::text as "revision",
  to_char("created_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt",
  to_char("updated_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "updatedAt"
`;

class PostgresPublicationStore implements PublicationStore {
  constructor(private readonly sql: PublicationSqlExecutor) {}

  async claim(
    input: Parameters<PublicationStore['claim']>[0],
  ): Promise<PublicationRecord> {
    try {
      const rows = await this.sql.execute(
        `select ${selection} from "agentos_claim_publication"($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          input.key,
          input.bindingKey,
          input.projectId,
          input.runId,
          input.repositoryId,
          input.manifestDigest,
          input.policyDigest,
          input.baseSha,
          input.branch,
          input.now,
        ],
      );
      if (rows.length !== 1) malformed();
      return mapRecord(rows[0]);
    } catch (error) {
      if (isPublicationConflict(error)) {
        throw new GitHubPublisherError(
          'publication_collision',
          'Publication binding conflicts with durable state',
        );
      }
      throw error;
    }
  }

  async save(
    key: string,
    expectedRevision: number,
    patch: Parameters<PublicationStore['save']>[2],
    publicationEvent: PublicationEvent,
  ): Promise<PublicationRecord> {
    const { phase, updatedAt, ...storedPatch } = patch;
    if (
      publicationEvent.publicationKey !== key ||
      publicationEvent.phase !== phase ||
      publicationEvent.at !== updatedAt ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision <= 0
    ) {
      throw new GitHubPublisherError(
        'publication_store_conflict',
        'Publication event does not match its checkpoint',
      );
    }
    try {
      const rows = await this.sql.execute(
        `select ${selection} from "agentos_save_publication"($1,$2,$3,$4::jsonb,$5,$6::jsonb)`,
        [
          key,
          expectedRevision,
          phase,
          JSON.stringify(storedPatch),
          updatedAt,
          JSON.stringify(publicationEvent.details),
        ],
      );
      if (rows.length !== 1) malformed();
      return mapRecord(rows[0]);
    } catch (error) {
      if (isPublicationConflict(error)) {
        throw new GitHubPublisherError(
          'publication_store_conflict',
          'Publication checkpoint changed concurrently',
        );
      }
      throw error;
    }
  }

  async get(key: string): Promise<PublicationRecord | undefined> {
    const rows = await this.sql.execute(
      `select ${selection} from "publication_records" where "publication_key" = $1 limit 1`,
      [key],
    );
    return rows[0] === undefined ? undefined : mapRecord(rows[0]);
  }

  async listEvents(): Promise<readonly PublicationEvent[]> {
    const rows = await this.sql.execute(
      `select "publication_key" as "publicationKey", "phase",
        to_char("at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "at",
        "details" from "publication_events" order by "sequence"`,
      [],
    );
    return rows.map(mapEvent);
  }
}

export function createPostgresPublicationStoreForTest(
  executor: PublicationSqlExecutor,
): PublicationStore {
  return new PostgresPublicationStore(executor);
}

export function createNeonPublicationStore(
  environment: Readonly<Record<string, string | undefined>>,
): PublicationStore {
  const sql = neon(databaseUrlFromEnv(environment), {
    arrayMode: false,
    fullResults: false,
  });
  return new PostgresPublicationStore({
    execute: async (query, parameters) =>
      (await sql.query(query, [...parameters])) as readonly unknown[],
  });
}
