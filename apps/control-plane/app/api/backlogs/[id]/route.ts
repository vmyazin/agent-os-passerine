// app/api/backlogs/[id]/route.ts
import { z } from 'zod';

import { controlPlaneService } from '../../../../src/application/runtime';
import { handleApi } from '../../../../src/http/api';
import { requireApiAuthentication } from '../../../../src/http/authenticated';
import { boundedPathId } from '../../../../src/http/contracts';

/**
 * Removing a backlog that was created by mistake. The service refuses once
 * any item has produced a run, so this can never erase the record of work
 * that actually happened.
 */
export function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleApi(
    request,
    {
      authorize: () => requireApiAuthentication(request),
      output: z.object({ deleted: z.literal(true) }).strict(),
    },
    async () => {
      const { id } = await context.params;
      await controlPlaneService().deleteBacklog(boundedPathId(id));
      return { deleted: true as const };
    },
  );
}
