import { describe, expect, it } from 'vitest';

import { createGoalRunSchema, allowedQuery } from './contracts';

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
