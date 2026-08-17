import { describe, expect, it } from 'vitest';

import type { ArtifactManifestStore } from '@agentos/core';

import {
  ARTIFACT_RETENTION_CLEANUP_PAGE_LIMIT,
  artifactCleanupR2Options,
} from './artifact-cleanup-runtime';
import { ARTIFACT_RETENTION_CLEANUP_POLICY } from './artifact-cleanup';

const manifest = {} as ArtifactManifestStore;

describe('configured artifact cleanup runtime', () => {
  it('pins the production cleanup page at the safe maximum', () => {
    expect(ARTIFACT_RETENTION_CLEANUP_PAGE_LIMIT).toBe(25);
    expect(
      ARTIFACT_RETENTION_CLEANUP_POLICY.timeBudgetMs +
        ARTIFACT_RETENTION_CLEANUP_POLICY.safetyMarginMs,
    ).toBeLessThan(ARTIFACT_RETENTION_CLEANUP_POLICY.leaseDurationMs);
  });

  it('fails closed when agent and admin R2 access-key IDs are identical', () => {
    expect(() =>
      artifactCleanupR2Options(
        {
          CLOUDFLARE_R2_ACCOUNT_ID: 'a'.repeat(32),
          CLOUDFLARE_R2_ARTIFACT_BUCKET: 'agentos-artifacts',
          CLOUDFLARE_R2_ARTIFACT_ACCESS_KEY_ID: 'shared-key',
          CLOUDFLARE_R2_ADMIN_ACCESS_KEY_ID: 'shared-key',
          CLOUDFLARE_R2_ADMIN_SECRET_ACCESS_KEY: 'admin-secret',
        },
        manifest,
      ),
    ).toThrow(/separate/i);
  });
});
