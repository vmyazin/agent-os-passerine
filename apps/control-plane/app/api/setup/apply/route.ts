import { z } from 'zod';

import {
  canonicalConfigHash,
  canonicalConfigJson,
  loadAgentOsConfig,
  MAX_AGENT_OS_CONFIG_SOURCE_BYTES,
} from '@agentos/core';

import { controlPlaneService } from '../../../../src/application/runtime';
import { ServiceError } from '../../../../src/application/control-plane-service';
import { handleApi, MAX_CONFIG_APPLY_BODY_BYTES } from '../../../../src/http/api';
import { requireApiAuthentication } from '../../../../src/http/authenticated';
import {
  configurationProjectionSchema,
  idempotencyKey,
} from '../../../../src/http/contracts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const setupApplySchema = z
  .object({
    yaml: z
      .string()
      .min(2)
      .refine(
        (value) =>
          new TextEncoder().encode(value).byteLength <=
          MAX_AGENT_OS_CONFIG_SOURCE_BYTES,
        'configuration source is too large',
      ),
  })
  .strict();

/**
 * Session-authorized YAML apply for the setup wizard. The CLI apply endpoint
 * stays CLI-token-only; this route performs the same parse -> canonicalize ->
 * apply sequence server-side so the operator can paste YAML in the browser.
 * Concurrency expectations come from the currently active revision, so a
 * concurrent CLI apply is detected instead of silently overwritten.
 */
export function POST(request: Request): Promise<Response> {
  return handleApi(
    request,
    {
      authorize: () => requireApiAuthentication(request),
      body: setupApplySchema,
      output: configurationProjectionSchema,
      successStatus: 201,
      maxBodyBytes: MAX_CONFIG_APPLY_BODY_BYTES,
    },
    async (body) => {
      let canonicalConfig: string;
      let digest: string;
      try {
        const config = loadAgentOsConfig(body.yaml);
        canonicalConfig = canonicalConfigJson(config);
        digest = canonicalConfigHash(config);
      } catch (error) {
        throw new ServiceError(
          'invalid_configuration',
          error instanceof Error ? error.message.slice(0, 2_000) : 'invalid configuration',
          422,
        );
      }
      const service = controlPlaneService();
      const active = await service.getConfiguration(false);
      return service.applyConfiguration(idempotencyKey(request), {
        canonicalConfig,
        digest,
        expectedRevision: active.active?.revision ?? null,
        expectedDigest: active.active?.digest ?? null,
      });
    },
  );
}
