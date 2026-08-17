import { createHash } from 'node:crypto';

import {
  isoTimestamp,
  type ArtifactCapabilityClaims,
  type DomainRepository,
} from '@agentos/core';

import { ArtifactStoreAdapterError } from './errors.js';

export interface ArtifactCapabilityQuotaConsumption {
  readonly operationId: string;
  readonly bytes: number;
  readonly now: Date;
}

export interface ArtifactCapabilityQuotaStore {
  consume(
    claims: ArtifactCapabilityClaims,
    consumption: ArtifactCapabilityQuotaConsumption,
  ): Promise<void>;
}

function claimsFingerprint(claims: ArtifactCapabilityClaims): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        claims.purpose,
        claims.audience,
        [...claims.methods],
        claims.projectId,
        claims.runId,
        claims.stepId,
        claims.prefix ?? null,
        claims.maxBytes,
        claims.maxCalls,
        claims.maxCumulativeBytes,
        claims.notBefore,
        claims.expiresAt,
        claims.nonce,
      ]),
      'utf8',
    )
    .digest('hex');
}

export function createDomainArtifactCapabilityQuotaStore(
  repository: DomainRepository,
): ArtifactCapabilityQuotaStore {
  return Object.freeze({
    async consume(
      claims: ArtifactCapabilityClaims,
      consumption: ArtifactCapabilityQuotaConsumption,
    ): Promise<void> {
      const result = await repository.consumeArtifactCapabilityQuota({
        purpose: claims.purpose,
        audience: claims.audience,
        nonce: claims.nonce,
        fingerprint: claimsFingerprint(claims),
        operationId: consumption.operationId,
        bytes: consumption.bytes,
        maxCalls: claims.maxCalls,
        maxCumulativeBytes: claims.maxCumulativeBytes,
        notBefore: isoTimestamp(claims.notBefore),
        expiresAt: isoTimestamp(claims.expiresAt),
        now: isoTimestamp(consumption.now.toISOString()),
      });
      if (!result.allowed)
        throw new ArtifactStoreAdapterError(
          'artifact_quota_exhausted',
          'artifact capability quota exhausted',
          429,
        );
    },
  });
}
