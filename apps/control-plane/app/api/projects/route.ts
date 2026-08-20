// app/api/projects/route.ts
import { z } from 'zod';

import { controlPlaneService } from '../../../src/application/runtime';
import { handleApi } from '../../../src/http/api';
import { requireApiAuthentication } from '../../../src/http/authenticated';
import { projectListProjectionSchema } from '../../../src/http/contracts';

export function GET(request: Request): Promise<Response> {
  return handleApi(
    request,
    {
      authorize: () => requireApiAuthentication(request),
      output: z.array(projectListProjectionSchema),
    },
    async () => controlPlaneService().listProjects(),
  );
}
