// app/api/runs/[id]/restart/route.ts
import { controlPlaneService } from '../../../../../src/application/runtime';
import { handleApi } from '../../../../../src/http/api';
import { requireApiAuthentication } from '../../../../../src/http/authenticated';
import {
  boundedPathId,
  idempotencyKey,
  runProjectionSchema,
} from '../../../../../src/http/contracts';

/**
 * Starts a finished run's request again, as a new run. The original stays as
 * the record of what happened; provenance is resolved again from the applied
 * configuration, because something was usually changed to make it work.
 */
export function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleApi(
    request,
    {
      authorize: () => requireApiAuthentication(request),
      output: runProjectionSchema,
      successStatus: 201,
    },
    async () => {
      const { id } = await context.params;
      return controlPlaneService().restartRun(
        idempotencyKey(request),
        boundedPathId(id),
      );
    },
  );
}
