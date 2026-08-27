import { handleApi } from '../../../../src/http/api';
import { requireApiAuthentication } from '../../../../src/http/authenticated';
import { activeRunCountSchema } from '../../../../src/http/contracts';
import { fetchActiveRunCount } from '../../../../src/ui/rail-counts';

export async function GET(request: Request): Promise<Response> {
  const response = await handleApi(
    request,
    {
      authorize: () => requireApiAuthentication(request),
      output: activeRunCountSchema,
    },
    async () => ({ count: await fetchActiveRunCount() }),
  );
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}
