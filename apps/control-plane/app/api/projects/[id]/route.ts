// app/api/projects/[id]/route.ts
import { controlPlaneService } from '../../../../src/application/runtime';
import { handleApi } from '../../../../src/http/api';
import { requireApiAuthentication } from '../../../../src/http/authenticated';
import {
  boundedPathId,
  projectDetailProjectionSchema,
} from '../../../../src/http/contracts';

export function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleApi(
    request,
    {
      authorize: () => requireApiAuthentication(request),
      output: projectDetailProjectionSchema,
    },
    async () => {
      const { id } = await context.params;
      return controlPlaneService().getProjectDetail(boundedPathId(id));
    },
  );
}
