import type { JsonValue } from '@agentos/core';

import { controlPlaneService } from '../../../../../src/application/runtime';
import { handleApi } from '../../../../../src/http/api';
import { requireApiAuthentication } from '../../../../../src/http/authenticated';
import {
  idempotencyKey,
  boundedPathId,
  inboxMessageSchema,
  inboxReplySchema,
} from '../../../../../src/http/contracts';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return handleApi(
    request,
    {
      authorize: () => requireApiAuthentication(request),
      body: inboxReplySchema,
      output: inboxMessageSchema,
    },
    async (body) => {
      return controlPlaneService().replyInbox(
        boundedPathId(id),
        body.reply as JsonValue,
        idempotencyKey(request),
      );
    },
  );
}
