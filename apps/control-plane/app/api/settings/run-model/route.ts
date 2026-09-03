import { z } from 'zod';

import { controlPlaneService } from '../../../../src/application/runtime';
import { handleApi } from '../../../../src/http/api';
import { requireSessionAuthentication } from '../../../../src/http/authenticated';

/** An empty selection clears the setting: each project decides again. */
const input = z
  .object({ modelId: z.string().min(1).max(255).nullable() })
  .strict();
const output = z
  .object({
    selectedId: z.string().optional(),
    options: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        provider: z.string(),
        providerLabel: z.string(),
        model: z.string(),
        available: z.boolean(),
      }),
    ),
    updatedAt: z.string().optional(),
  })
  .strict();

export function PUT(request: Request): Promise<Response> {
  return handleApi(
    request,
    {
      authorize: () => {
        requireSessionAuthentication(request);
      },
      body: input,
      output,
    },
    async ({ modelId }) =>
      controlPlaneService().updateRunModel(modelId ?? undefined),
  );
}
