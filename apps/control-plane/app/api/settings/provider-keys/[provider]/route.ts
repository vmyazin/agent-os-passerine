import { z } from 'zod';

import { controlPlaneService } from '../../../../../src/application/runtime';
import { handleApi } from '../../../../../src/http/api';
import { requireSessionAuthentication } from '../../../../../src/http/authenticated';

const input = z.object({ apiKey: z.string().min(1).max(4096) }).strict();
// Deliberately without the key: no response this route can produce contains a
// credential, so a proxy log or a browser cache cannot leak one back out.
const output = z
  .object({
    credentials: z.array(
      z.object({
        provider: z.string(),
        providerLabel: z.string(),
        apiKeyVariable: z.string(),
        source: z.enum(['database', 'environment', 'none']),
        hint: z.string().optional(),
        updatedAt: z.string().optional(),
      }),
    ),
  })
  .strict();

export function PUT(
  request: Request,
  context: { params: Promise<{ provider: string }> },
): Promise<Response> {
  return handleApi(
    request,
    {
      authorize: () => {
        requireSessionAuthentication(request);
      },
      body: input,
      output,
    },
    async ({ apiKey }) => ({
      credentials: await controlPlaneService().setProviderApiKey(
        (await context.params).provider,
        apiKey,
      ),
    }),
  );
}

export function DELETE(
  request: Request,
  context: { params: Promise<{ provider: string }> },
): Promise<Response> {
  return handleApi(
    request,
    {
      authorize: () => {
        requireSessionAuthentication(request);
      },
      output,
    },
    async () => ({
      credentials: await controlPlaneService().clearProviderApiKey(
        (await context.params).provider,
      ),
    }),
  );
}
