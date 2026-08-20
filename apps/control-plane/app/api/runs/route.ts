// apps/control-plane/app/api/runs/route.ts
import { z } from 'zod';

import { controlPlaneService } from '../../../src/application/runtime';
import { handleApi } from '../../../src/http/api';
import { requireApiAuthentication } from '../../../src/http/authenticated';
import {
  allowedQuery,
  boundedPathId,
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
      const query = allowedQuery(request, ['projectId']);
      const projectId =
        query.projectId === undefined
          ? undefined
          : boundedPathId(query.projectId);
      return controlPlaneService().listRuns(50, projectId);
    },
  );
}
