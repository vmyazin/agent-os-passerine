import { describe, expect, it } from 'vitest';

import { createAesWorkflowHandleSealer } from './handle-sealer.js';

describe('runtime handle sealing', () => {
  it('round-trips the full ownership handle only with matching AAD', async () => {
    const sealer = createAesWorkflowHandleSealer(new Uint8Array(32).fill(7));
    const handle = {
      id: 'session-1',
      runId: 'run-1',
      stepId: 'step-1',
      agentId: 'agent-1',
      agentVersion: 3,
      environmentId: 'env-1',
      ownershipCapability: 'secret-capability',
    };
    const sealed = await sealer.seal(handle, { runId: 'run-1' });

    expect(sealed).not.toContain('secret-capability');
    await expect(sealer.open(sealed, { runId: 'run-1' })).resolves.toEqual(
      handle,
    );
    await expect(sealer.open(sealed, { runId: 'run-2' })).rejects.toThrow(
      /authentication/i,
    );
  });
});
