import { handleApi } from '../../../src/http/api';
import {
  createGoalRunSchema,
  idempotencyKey,
  runProjectionSchema,
} from '../../../src/http/contracts';
import { requireApiAuthentication } from '../../../src/http/authenticated';
import { controlPlaneService } from '../../../src/application/runtime';

export function POST(request: Request): Promise<Response> {
  return handleApi(
    request,
    {
      authorize: () => requireApiAuthentication(request),
      body: createGoalRunSchema,
      output: runProjectionSchema,
      successStatus: 201,
    },
    async (body) => {
      return controlPlaneService().createGoalRun(idempotencyKey(request), {
        ...body,
        criteria: body.criteria.map((criterion) => ({
          id: criterion.id,
          type: criterion.type,
          description: criterion.description,
          command: criterion.command,
          ...(criterion.required === undefined
            ? {}
            : { required: criterion.required }),
        })),
      });
    },
  );
}
