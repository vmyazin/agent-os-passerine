// app/api/projects/[id]/runs/route.ts
import { controlPlaneService } from '../../../../../src/application/runtime';
import { handleApi } from '../../../../../src/http/api';
import { requireApiAuthentication } from '../../../../../src/http/authenticated';
import {
  boundedPathId,
  idempotencyKey,
  runProjectionSchema,
  startProjectRunSchema,
} from '../../../../../src/http/contracts';

/**
 * Starts a run for a project from the browser. Provenance comes from the
 * project's applied revision, so the form never asks an operator to paste
 * digests; `POST /api/features` and `POST /api/goals` keep their explicit
 * provenance for callers that have it.
 */
export function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleApi(
    request,
    {
      authorize: () => requireApiAuthentication(request),
      body: startProjectRunSchema,
      output: runProjectionSchema,
      successStatus: 201,
    },
    async (body) => {
      const { id } = await context.params;
      return controlPlaneService().startRunForProject(idempotencyKey(request), {
        projectId: boundedPathId(id),
        title: body.title,
        description: body.description,
        pipeline: body.pipeline,
        ...(body.baseRunId === undefined ? {} : { baseRunId: body.baseRunId }),
        // `required` is optional on the domain criterion, so an explicit
        // undefined is not the same as absent under exactOptionalPropertyTypes.
        ...(body.criteria === undefined
          ? {}
          : {
              criteria: body.criteria.map((criterion) => ({
                id: criterion.id,
                type: criterion.type,
                description: criterion.description,
                command: criterion.command,
                ...(criterion.required === undefined
                  ? {}
                  : { required: criterion.required }),
              })),
            }),
      });
    },
  );
}
