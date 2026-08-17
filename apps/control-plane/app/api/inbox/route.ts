import { controlPlaneService } from '../../../src/application/runtime';
import { handleApi } from '../../../src/http/api';
import { requireApiAuthentication } from '../../../src/http/authenticated';
import { assertNoQuery, inboxListingSchema } from '../../../src/http/contracts';

export function GET(request: Request): Promise<Response> {
  return handleApi(
    request,
    {
      authorize: () => requireApiAuthentication(request),
      output: inboxListingSchema,
    },
    async () => {
      assertNoQuery(request);
      const service = controlPlaneService();
      const [messages, approvals] = await Promise.all([
        service.listInbox(),
        service.listPendingApprovals(),
      ]);
      return { messages, approvals };
    },
  );
}
