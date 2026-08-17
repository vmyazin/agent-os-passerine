import { controlPlaneService } from '../../../src/application/runtime';
import { handleApi } from '../../../src/http/api';
import { requireApiAuthentication } from '../../../src/http/authenticated';
import {
  activeConfigurationSchema,
  assertNoQuery,
} from '../../../src/http/contracts';

export function GET(request: Request): Promise<Response> {
  let includeCanonical = false;
  return handleApi(
    request,
    {
      authorize: () => {
        includeCanonical = requireApiAuthentication(request).kind === 'cli';
      },
      output: activeConfigurationSchema,
    },
    async () => {
      assertNoQuery(request);
      return controlPlaneService().getConfiguration(includeCanonical);
    },
  );
}
