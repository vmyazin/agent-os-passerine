import { randomUUID } from 'node:crypto';

import {
  createDomainArtifactManifestStore,
  createR2ArtifactAdminStore,
  type R2ArtifactStorageOptions,
} from '@agentos/adapters';
import type { ArtifactManifestStore } from '@agentos/core';

import { repositoryFromEnv } from '../persistence/repository-factory';
import {
  ARTIFACT_RETENTION_CLEANUP_POLICY,
  runArtifactRetentionCleanup,
} from './artifact-cleanup';

export const ARTIFACT_RETENTION_CLEANUP_PAGE_LIMIT =
  ARTIFACT_RETENTION_CLEANUP_POLICY.pageLimit;

function required(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required for artifact cleanup`);
  return value;
}

export function artifactCleanupR2Options(
  environment: Readonly<Record<string, string | undefined>>,
  manifest: ArtifactManifestStore,
): R2ArtifactStorageOptions {
  const agentAccessKeyId = required(
    environment,
    'CLOUDFLARE_R2_ARTIFACT_ACCESS_KEY_ID',
  );
  const adminAccessKeyId = required(
    environment,
    'CLOUDFLARE_R2_ADMIN_ACCESS_KEY_ID',
  );
  if (agentAccessKeyId === adminAccessKeyId)
    throw new Error(
      'R2 admin credentials must be separate from agent credentials',
    );
  return {
    accountId: required(environment, 'CLOUDFLARE_R2_ACCOUNT_ID'),
    bucket: required(environment, 'CLOUDFLARE_R2_ARTIFACT_BUCKET'),
    accessKeyId: adminAccessKeyId,
    secretAccessKey: required(
      environment,
      'CLOUDFLARE_R2_ADMIN_SECRET_ACCESS_KEY',
    ),
    manifest,
    ...(environment.CLOUDFLARE_R2_JURISDICTION === undefined
      ? {}
      : {
          jurisdiction: environment.CLOUDFLARE_R2_JURISDICTION as
            'default' | 'eu' | 'fedramp',
        }),
  };
}

export async function runConfiguredArtifactRetentionCleanup(): Promise<unknown> {
  const repository = repositoryFromEnv();
  const manifest = createDomainArtifactManifestStore(repository);
  const admin = createR2ArtifactAdminStore(
    artifactCleanupR2Options(process.env, manifest),
  );
  return runArtifactRetentionCleanup({
    repository,
    manifest,
    admin,
    owner: `vercel-cron-${randomUUID()}`,
    now: new Date(),
    limit: ARTIFACT_RETENTION_CLEANUP_PAGE_LIMIT,
  });
}
