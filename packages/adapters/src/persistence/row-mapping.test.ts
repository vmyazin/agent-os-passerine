import { describe, expect, it } from 'vitest';

import {
  mapConfigRevisionRow,
  mapInboxMessageRow,
  mapWorkflowRunRow,
} from './row-mapping.js';

describe('persistence SQL row mapping', () => {
  it('preserves JSON null in required JSONB fields', () => {
    expect(
      mapConfigRevisionRow({
        id: 'config-1',
        projectId: 'project-1',
        revision: 1,
        config: null,
        configDigest: 'config',
        modelDigest: 'model',
        promptDigest: 'prompt',
        environmentDigest: 'environment',
        policyDigest: 'policy',
        repositorySha: 'sha',
        createdAt: '2026-08-16T12:00:00.000Z',
      }).config,
    ).toBeNull();

    expect(
      mapInboxMessageRow({
        id: 'message-1',
        runId: 'run-1',
        stepRunId: null,
        status: 'pending',
        body: null,
        reply: null,
        replyPresent: false,
        createdAt: '2026-08-16T12:00:00.000Z',
        repliedAt: null,
      }).body,
    ).toBeNull();
  });

  it('keeps JSON null when an optional JSONB column is present', () => {
    const run = mapWorkflowRunRow({
      id: 'run-1',
      projectId: 'project-1',
      configRevisionId: null,
      pipeline: 'feature',
      status: 'pending',
      input: null,
      inputPresent: true,
      output: null,
      outputPresent: false,
      error: null,
      errorPresent: false,
      createdAt: '2026-08-16T12:00:00.000Z',
      updatedAt: '2026-08-16T12:00:00.000Z',
      startedAt: null,
      completedAt: null,
      cleanupAt: null,
    });

    expect(run).toHaveProperty('input', null);
    expect(run).not.toHaveProperty('output');
    expect(run).not.toHaveProperty('configRevisionId');
  });
});
