import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  isoTimestamp,
  persistenceId,
  type ProjectId,
  type WorkflowRunId,
} from './persistence.js';

describe('persistence boundary values', () => {
  it('keeps identifier families opaque and distinct', () => {
    const projectId = persistenceId('project', 'project-1');
    const runId = persistenceId('run', 'run-1');

    expectTypeOf(projectId).toEqualTypeOf<ProjectId>();
    expectTypeOf(runId).toEqualTypeOf<WorkflowRunId>();
    // @ts-expect-error run identifiers cannot be used as project identifiers
    const invalidProjectId: ProjectId = runId;
    expect(invalidProjectId).toBe(runId);
  });

  it('rejects empty identifiers', () => {
    expect(() => persistenceId('project', '')).toThrow(
      'project identifier must not be empty',
    );
  });

  it('validates ISO timestamps before branding them', () => {
    expect(isoTimestamp('2026-08-16T12:00:00.000Z')).toBe(
      '2026-08-16T12:00:00.000Z',
    );
    expect(() => isoTimestamp('next Tuesday')).toThrow(
      'timestamp must be an ISO 8601 string',
    );
  });

  it.each([
    '2025-02-29T12:00:00Z',
    '2026-02-30T12:00:00Z',
    '2026-04-31T12:00:00Z',
  ])('rejects calendar-invalid timestamp %s', (value) => {
    expect(() => isoTimestamp(value)).toThrow(
      'timestamp must be an ISO 8601 string',
    );
  });
});
