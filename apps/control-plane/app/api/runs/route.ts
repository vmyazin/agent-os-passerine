import { z } from 'zod';

import { controlPlaneService } from '../../../src/application/runtime';
import { handleApi } from '../../../src/http/api';
import { requireApiAuthentication } from '../../../src/http/authenticated';
import {
  assertNoQuery,
  runProjectionSchema,
} from '../../../src/http/contracts';

export function GET(request: Request): Promise<Response> {
  return handleApi(
    request,
    {
      authorize: () => requireApiAuthentication(request),
      output: z.array(runProjectionSchema),
    },
    async () => {
      assertNoQuery(request);
      return controlPlaneService().listRuns();
    },
  );
}
