// apps/control-plane/app/api/inbox/route.ts
import { controlPlaneService } from '../../../src/application/runtime';
import { handleApi } from '../../../src/http/api';
import { requireApiAuthentication } from '../../../src/http/authenticated';
import {
  allowedQuery,
  boundedPathId,
  inboxListingSchema,
} from '../../../src/http/contracts';

export function GET(request: Request): Promise<Response> {
  return handleApi(
    request,
    {
      authorize: () => requireApiAuthentication(request),
      output: inboxListingSchema,
    },
    async () => {
      const query = allowedQuery(request, ['projectId']);
      const projectId =
        query.projectId === undefined
          ? undefined
          : boundedPathId(query.projectId);
      const service = controlPlaneService();
      const [messages, approvals] = await Promise.all([
        service.listInbox(50, projectId),
        service.listPendingApprovals(50, true, projectId),
      ]);
      return { messages, approvals };
    },
  );
}
