import { controlPlaneService } from '../../../../../src/application/runtime';
import { handleApi } from '../../../../../src/http/api';
import { requireApiAuthentication } from '../../../../../src/http/authenticated';
import {
  projectSourceImportInputSchema,
  projectSourceInspectionSchema,
} from '../../../../../src/http/contracts';

export function POST(request: Request): Promise<Response> {
  return handleApi(
    request,
    {
      authorize: () => requireApiAuthentication(request),
      body: projectSourceImportInputSchema,
      output: projectSourceInspectionSchema,
    },
    async (body) => {
      if (body.kind === 'github')
        return controlPlaneService().inspectProjectSource(body);
      return controlPlaneService().inspectProjectSource(
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
