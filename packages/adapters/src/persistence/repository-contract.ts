import {
  isoTimestamp,
  persistenceId,
  type DomainRepository,
} from '@agentos/core';
import { describe, expect, it } from 'vitest';

export type RepositoryFactory = () =>
  DomainRepository | Promise<DomainRepository>;

export function domainRepositoryContract(
  implementation: string,
  createRepository: RepositoryFactory,
): void {
  describe(`${implementation} DomainRepository contract`, () => {
    it('keeps step identity and creation time immutable across idempotent upserts', async () => {
      const repository = await createRepository();
      const projectId = persistenceId('project', `${implementation}-project`);
      const runId = persistenceId('run', `${implementation}-run`);
      const stepId = persistenceId('stepRun', `${implementation}-step`);
      const createdAt = isoTimestamp('2026-08-17T07:00:00.000Z');

      await repository.createProject({
        id: projectId,
        name: implementation,
        createdAt,
        updatedAt: createdAt,
      });
      await repository.createRun({
        id: runId,
        projectId,
        pipeline: 'contract',
        status: 'pending',
        createdAt,
        updatedAt: createdAt,
      });
      await repository.upsertStepRun({
        id: stepId,
        runId,
        stepKey: 'implement',
        attempt: 1,
        status: 'running',
        createdAt,
        updatedAt: createdAt,
      });

      const updated = await repository.upsertStepRun({
        id: persistenceId('stepRun', `${implementation}-replacement-step`),
        runId,
        stepKey: 'implement',
        attempt: 1,
        status: 'succeeded',
        createdAt: isoTimestamp('2026-08-17T07:01:00.000Z'),
        updatedAt: isoTimestamp('2026-08-17T07:02:00.000Z'),
      });

      expect(updated.id).toBe(stepId);
      expect(updated.createdAt).toBe(createdAt);
      expect(updated.status).toBe('succeeded');
    });
  });
}
