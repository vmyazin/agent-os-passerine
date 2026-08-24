// app/api/backlogs/route.ts
import { z } from 'zod';

import { controlPlaneService } from '../../../src/application/runtime';
import { handleApi } from '../../../src/http/api';
import { requireApiAuthentication } from '../../../src/http/authenticated';
import {
  allowedQuery,
  backlogProjectionSchema,
  createBacklogSchema,
  idempotencyKey,
} from '../../../src/http/contracts';

export function GET(request: Request): Promise<Response> {
  return handleApi(
    request,
    {
      authorize: () => requireApiAuthentication(request),
      output: z.array(backlogProjectionSchema),
    },
    async () => {
      const query = allowedQuery(request, ['projectId']);
      const projectId = query['projectId'];
      if (projectId === undefined)
        throw Object.assign(new Error('projectId is required'), {
          code: 'validation_error',
          status: 422,
        });
      return controlPlaneService().listBacklogs(projectId);
    },
  );
}

export function POST(request: Request): Promise<Response> {
  return handleApi(
    request,
    {
      authorize: () => requireApiAuthentication(request),
      body: createBacklogSchema,
      output: backlogProjectionSchema,
      successStatus: 201,
    },
    async (body) =>
      controlPlaneService().createBacklog(idempotencyKey(request), body),
  );
}
