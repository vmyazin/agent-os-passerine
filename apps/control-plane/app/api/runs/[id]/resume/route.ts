// app/api/runs/[id]/resume/route.ts
import { controlPlaneService } from '../../../../../src/application/runtime';
import { handleApi } from '../../../../../src/http/api';
import { requireApiAuthentication } from '../../../../../src/http/authenticated';
import {
  boundedPathId,
  runProjectionSchema,
} from '../../../../../src/http/contracts';

/**
 * Continues a finished run where it stopped, reusing the steps it already
 * validated instead of paying a model to produce them again.
 *
 * The counterpart to restart, not a replacement: a resume re-enters the same
 * run, so it keeps that run's pinned configuration and repository snapshot.
 * When something was changed to make the work succeed, restart is the action
 * that picks the change up.
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
    },
    async () => {
      const { id } = await context.params;
      return controlPlaneService().resumeRun(boundedPathId(id));
    },
  );
}
