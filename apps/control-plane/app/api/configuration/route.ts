// apps/control-plane/app/api/configuration/route.ts
import { controlPlaneService } from '../../../src/application/runtime';
import { handleApi } from '../../../src/http/api';
import { requireApiAuthentication } from '../../../src/http/authenticated';
import {
  activeConfigurationSchema,
  allowedQuery,
  configurationQuerySchema,
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
      const parsed = configurationQuerySchema.safeParse(
        allowedQuery(request, [
          'projectId',
          'repository',
          'localPath',
          'name',
        ]),
      );
      if (!parsed.success) {
        throw Object.assign(new Error('query parameters are invalid'), {
          code: 'validation_error',
          status: 422,
        });
      }
      const { projectId, repository, localPath, name } = parsed.data;
      const selector = {
        ...(projectId === undefined ? {} : { projectId }),
        ...(repository === undefined ? {} : { repository }),
        ...(localPath === undefined ? {} : { localPath }),
        ...(name === undefined ? {} : { name }),
      };
      return controlPlaneService().getConfiguration(
        includeCanonical,
        selector,
      );
    },
  );
}
