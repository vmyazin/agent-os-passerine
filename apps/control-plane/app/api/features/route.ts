import { handleApi } from '../../../src/http/api';
import {
  createRunSchema,
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
      body: createRunSchema,
      output: runProjectionSchema,
      successStatus: 201,
    },
    async (body) => {
      return controlPlaneService().createFeatureRun(
        idempotencyKey(request),
        body,
      );
    },
  );
}
