import { handleApi } from '../../../../src/http/api';
import { requireApiAuthentication } from '../../../../src/http/authenticated';
import { inboxCountSchema } from '../../../../src/http/contracts';
import { fetchInboxAttentionCount } from '../../../../src/ui/rail-counts';

export async function GET(request: Request): Promise<Response> {
  const response = await handleApi(
    request,
    {
      authorize: () => requireApiAuthentication(request),
      output: inboxCountSchema,
    },
    async () => ({ count: await fetchInboxAttentionCount() }),
  );
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}
