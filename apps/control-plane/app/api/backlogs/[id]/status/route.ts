// app/api/backlogs/[id]/status/route.ts
import { z } from 'zod';

import { controlPlaneService } from '../../../../../src/application/runtime';
import { handleApi } from '../../../../../src/http/api';
import { requireApiAuthentication } from '../../../../../src/http/authenticated';
import {
  backlogProjectionSchema,
  boundedPathId,
} from '../../../../../src/http/contracts';

export function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleApi(
    request,
    {
      authorize: () => requireApiAuthentication(request),
      // Completed is not a state an operator may assert: it is what the
      // scheduler concludes when every item has succeeded.
      body: z.object({ status: z.enum(['active', 'paused']) }).strict(),
      output: backlogProjectionSchema,
    },
    async (body) => {
      const { id } = await context.params;
      return controlPlaneService().setBacklogStatus(
        boundedPathId(id),
        body.status,
      );
    },
  );
}
