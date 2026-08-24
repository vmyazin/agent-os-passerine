import { describe, expect, it } from 'vitest';

import {
  createGoalRunSchema,
  createRunSchema,
  allowedQuery,
  runProjectionSchema,
} from './contracts';

const request = {
  projectId: 'project-1',
  title: 'Bounded goal',
  description: 'Finish with trusted checks.',
  repositorySha: 'a'.repeat(40),
  configDigest: 'config',
  modelDigest: 'model',
  promptDigest: 'prompt',
  environmentDigest: 'environment',
  policyDigest: 'policy',
};
const criterion = {
  id: 'tests',
  type: 'command' as const,
  description: 'Tests pass',
  command: 'pnpm test',
};

describe('control-plane HTTP contracts', () => {
  it('accepts only a bounded unique set of strict command goal criteria', () => {
    expect(
      createGoalRunSchema.safeParse({ ...request, criteria: [criterion] })
        .success,
    ).toBe(true);
    expect(
      createGoalRunSchema.safeParse({
        ...request,
        criteria: [{ ...criterion, unexpected: true }],
      }).success,
    ).toBe(false);
    expect(
      createGoalRunSchema.safeParse({
        ...request,
        criteria: [criterion, criterion],
      }).success,
    ).toBe(false);
    expect(
      createGoalRunSchema.safeParse({
        ...request,
        criteria: Array.from({ length: 21 }, (_, index) => ({
          ...criterion,
          id: `criterion-${String(index)}`,
        })),
      }).success,
    ).toBe(false);
  });

  it('carries a chain edge in and back out again', () => {
    expect(
      createRunSchema.safeParse({ ...request, baseRunId: 'run_1' }).success,
    ).toBe(true);

    // The route validates its own response, so a projection field missing
    // from this schema is a 500 that no service-level test can see.
    const projection = {
      id: 'run_2',
      outcome: {
        localBranch: 'agentos/run-1-abcdef01',
        localRepositoryUrl: 'file:///workspaces/exp',
        // The follow-up action reads these two off the projection, so they
        // have to survive the response schema.
        publishedBranch: 'agentos/run-1-abcdef01',
        publishedCommitSha: 'd'.repeat(40),
      },
      projectId: 'project-1',
      pipeline: 'feature',
      status: 'running' as const,
      chain: {
        baseRunId: 'run_1',
        baseBranch: 'agentos/run-1-abcdef01',
        baseCommitSha: 'd'.repeat(40),
      },
      createdAt: '2026-08-17T12:00:00.000Z',
      updatedAt: '2026-08-17T12:00:00.000Z',
      repositorySha: 'a'.repeat(40),
      configDigest: 'config',
      modelDigest: 'model',
      promptDigest: 'prompt',
      environmentDigest: 'environment',
      policyDigest: 'policy',
      steps: [],
      timeline: [],
    };
    expect(runProjectionSchema.safeParse(projection).success).toBe(true);
  });

  describe('allowedQuery', () => {
    const request = (query: string) =>
      new Request(`https://control.example/api/x${query}`);

    it('returns allowlisted parameters and rejects everything else', () => {
      expect(allowedQuery(request(''), ['projectId'])).toEqual({});
      expect(allowedQuery(request('?projectId=p1'), ['projectId'])).toEqual({
        projectId: 'p1',
      });
      expect(() => allowedQuery(request('?other=1'), ['projectId'])).toThrow(
        'query parameters are not supported',
      );
      expect(() =>
        allowedQuery(request('?projectId=a&projectId=b'), ['projectId']),
      ).toThrow('query parameters are not supported');
    });
  });
});
