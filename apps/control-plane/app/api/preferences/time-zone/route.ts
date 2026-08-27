import { z } from 'zod';

import { controlPlaneService } from '../../../../src/application/runtime';
import { handleApi } from '../../../../src/http/api';
import { requireSessionAuthentication } from '../../../../src/http/authenticated';

const input = z.object({ timeZone: z.string().min(1).max(255) }).strict();
const output = z
  .object({
    timeZone: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export function PUT(request: Request): Promise<Response> {
  let login = '';
  return handleApi(
    request,
    {
      authorize: () => {
        login = requireSessionAuthentication(request).login;
      },
      body: input,
      output,
    },
    async ({ timeZone }) =>
      controlPlaneService().updateUserTimeZone(login, timeZone),
  );
}
