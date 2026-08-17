import { controlPlaneService } from '../../../../../src/application/runtime';
import { handleApi } from '../../../../../src/http/api';
import { requireApiAuthentication } from '../../../../../src/http/authenticated';
import {
  approvalDecisionSchema,
  approvalSchema,
  boundedPathId,
  idempotencyKey,
} from '../../../../../src/http/contracts';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return handleApi(
    request,
    {
      authorize: () => requireApiAuthentication(request),
      body: approvalDecisionSchema,
      output: approvalSchema,
    },
    async () => {
      return controlPlaneService().consumeApproval(
        boundedPathId(id),
        'approve',
        idempotencyKey(request),
      );
    },
  );
}
