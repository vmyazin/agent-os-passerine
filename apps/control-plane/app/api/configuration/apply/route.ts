import { controlPlaneService } from '../../../../src/application/runtime';
import { handleApi } from '../../../../src/http/api';
import { MAX_CONFIG_APPLY_BODY_BYTES } from '../../../../src/http/api';
import { requireCliAuthentication } from '../../../../src/http/authenticated';
import {
  configurationApplySchema,
  configurationProjectionSchema,
  idempotencyKey,
} from '../../../../src/http/contracts';

export function POST(request: Request): Promise<Response> {
  return handleApi(
    request,
    {
      authorize: () => requireCliAuthentication(request),
      body: configurationApplySchema,
      output: configurationProjectionSchema,
      successStatus: 201,
      maxBodyBytes: MAX_CONFIG_APPLY_BODY_BYTES,
    },
    async (body) => {
      const { projectId, ...input } = body;
      return controlPlaneService().applyConfiguration(idempotencyKey(request), {
        ...input,
        ...(projectId === undefined ? {} : { projectId }),
      });
    },
  );
}
