import { controlPlaneService } from '../../../../../src/application/runtime';
import { handleApi } from '../../../../../src/http/api';
import { requireApiAuthentication } from '../../../../../src/http/authenticated';
import {
  allowedQuery,
  boundedPathId,
  commitPageSchema,
} from '../../../../../src/http/contracts';

export function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleApi(
    request,
    {
      authorize: () => requireApiAuthentication(request),
      output: commitPageSchema,
    },
    async () => {
      const { id } = await context.params;
      const cursor = allowedQuery(request, ['cursor'])['cursor'];
      if (
        cursor !== undefined &&
        (cursor.length === 0 || cursor.length > 2_048)
      )
        throw Object.assign(new Error('commit cursor is invalid'), {
          code: 'validation_error',
          status: 422,
        });
      return controlPlaneService().listProjectCommits(
        boundedPathId(id),
        cursor,
      );
    },
  );
}
