// app/api/goals/commands/route.ts
import { z } from 'zod';

import { controlPlaneService } from '../../../../src/application/runtime';
import { handleApi } from '../../../../src/http/api';
import { requireApiAuthentication } from '../../../../src/http/authenticated';
import { allowedQuery, boundedPathId } from '../../../../src/http/contracts';

const trustedGoalCommandsSchema = z
  .object({ commands: z.array(z.string()) })
  .strict();

/**
 * The command allowlist a goal's criteria must draw from, for this project:
 * the deployment allowlist narrowed by the project's verification policy.
 *
 * Read-only. It exists so a criterion can be *chosen* rather than typed --
 * createGoalRun rejects an unlisted command with a 422, and discovering the
 * list by submitting a form is a poor way to learn it.
 */
export function GET(request: Request): Promise<Response> {
  return handleApi(
    request,
    {
      authorize: () => requireApiAuthentication(request),
      output: trustedGoalCommandsSchema,
    },
    async () => {
      const query = allowedQuery(request, ['projectId']);
      const projectId =
        query.projectId === undefined
          ? undefined
          : boundedPathId(query.projectId);
      return {
        commands: [
          ...(await controlPlaneService().listTrustedGoalCommands(projectId)),
        ],
      };
    },
  );
}
