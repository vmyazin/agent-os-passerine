import { randomUUID } from 'node:crypto';

import {
  createDomainArtifactManifestStore,
  createR2ArtifactAdminStore,
} from '@agentos/adapters';

import { repositoryFromEnv } from '../persistence/repository-factory';
import { runArtifactRetentionCleanup } from './artifact-cleanup';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for artifact cleanup`);
  return value;
}

export async function runConfiguredArtifactRetentionCleanup(): Promise<unknown> {
  const repository = repositoryFromEnv();
  const manifest = createDomainArtifactManifestStore(repository);
  const admin = createR2ArtifactAdminStore({
    accountId: required('CLOUDFLARE_R2_ACCOUNT_ID'),
    bucket: required('CLOUDFLARE_R2_ARTIFACT_BUCKET'),
    // These credentials are intentionally separate from the agent-facing
    // GetObject/PutObject-only credential.
    accessKeyId: required('CLOUDFLARE_R2_ADMIN_ACCESS_KEY_ID'),
    secretAccessKey: required('CLOUDFLARE_R2_ADMIN_SECRET_ACCESS_KEY'),
    manifest,
    ...(process.env.CLOUDFLARE_R2_JURISDICTION === undefined
      ? {}
      : {
          jurisdiction: process.env.CLOUDFLARE_R2_JURISDICTION as
            'default' | 'eu' | 'fedramp',
        }),
  });
  return runArtifactRetentionCleanup({
    repository,
    manifest,
    admin,
    owner: `vercel-cron-${randomUUID()}`,
    now: new Date(),
    limit: 100,
  });
}
