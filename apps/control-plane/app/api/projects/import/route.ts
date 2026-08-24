import { controlPlaneService } from '../../../../src/application/runtime';
import { handleApi } from '../../../../src/http/api';
import { requireApiAuthentication } from '../../../../src/http/authenticated';
import {
  idempotencyKey,
  projectSourceImportInputSchema,
  projectSourceImportResultSchema,
} from '../../../../src/http/contracts';

export function POST(request: Request): Promise<Response> {
  return handleApi(
    request,
    {
      authorize: () => requireApiAuthentication(request),
      body: projectSourceImportInputSchema,
      output: projectSourceImportResultSchema,
      successStatus: 201,
    },
    async (body) => {
      if (body.kind === 'github')
        return controlPlaneService().importProjectSource(
          idempotencyKey(request),
          body,
        );
      return controlPlaneService().importProjectSource(
        idempotencyKey(request),
        body.defaultBranch === undefined
          ? { kind: 'local', localPath: body.localPath }
          : {
              kind: 'local',
              localPath: body.localPath,
              defaultBranch: body.defaultBranch,
            },
      );
    },
  );
}
