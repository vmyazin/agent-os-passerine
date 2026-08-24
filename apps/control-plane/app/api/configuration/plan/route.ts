// app/api/configuration/plan/route.ts
import { z } from 'zod';

import { MAX_AGENT_OS_CONFIG_SOURCE_BYTES } from '@agentos/core';

import { controlPlaneService } from '../../../../src/application/runtime';
import { handleApi } from '../../../../src/http/api';
import { requireApiAuthentication } from '../../../../src/http/authenticated';
import { configurationPlanSchema } from '../../../../src/http/contracts';

/**
 * What applying this YAML would change. Read-only: it writes nothing, spends
 * nothing, and never returns stored configuration values -- the diff's
 * `before` side is masked wherever a credential could live, the same rule the
 * configuration page renders by.
 */
export function POST(request: Request): Promise<Response> {
  return handleApi(
    request,
    {
      authorize: () => requireApiAuthentication(request),
      body: z
        .object({
          yaml: z
            .string()
            .min(1)
            .max(
              MAX_AGENT_OS_CONFIG_SOURCE_BYTES,
              'configuration source is too large',
            ),
        })
        .strict(),
      output: configurationPlanSchema,
    },
    async (body) => controlPlaneService().planConfigurationChange(body.yaml),
  );
}
