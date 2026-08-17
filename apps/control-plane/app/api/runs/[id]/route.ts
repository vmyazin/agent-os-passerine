import { controlPlaneService } from '../../../../src/application/runtime';
import { handleApi } from '../../../../src/http/api';
import { requireApiAuthentication } from '../../../../src/http/authenticated';
import {
  boundedPathId,
  runProjectionSchema,
} from '../../../../src/http/contracts';

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return handleApi(
    request,
    {
      authorize: () => requireApiAuthentication(request),
      output: runProjectionSchema,
    },
    async () => {
      return controlPlaneService().getRun(boundedPathId(id));
    },
  );
}
