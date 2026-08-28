// app/api/runs/[id]/budget-override/route.ts
import { controlPlaneService } from '../../../../../src/application/runtime';
import { handleApi } from '../../../../../src/http/api';
import { requireApiAuthentication } from '../../../../../src/http/authenticated';
import {
  boundedPathId,
  budgetOverrideSchema,
  runProjectionSchema,
} from '../../../../../src/http/contracts';

/**
 * Grants a run a one-time allowance past the budget that stopped it.
 *
 * Granting does not start anything: it raises this run's caps by the granted
 * amount and leaves the run where it is, so the operator resumes it as a
 * separate, deliberate act.
 */
export function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleApi(
    request,
    {
      authorize: () => requireApiAuthentication(request),
      body: budgetOverrideSchema,
      output: runProjectionSchema,
    },
    async (body) => {
      const { id } = await context.params;
      return controlPlaneService().overrideRunBudget(
        boundedPathId(id),
        body.microdollars,
      );
    },
  );
}
