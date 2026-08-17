import {
  isoTimestamp,
  persistenceId,
  type DomainRepository,
} from '@agentos/core';
import { describe, expect, it } from 'vitest';

import type { RepositoryFactory } from './repository-contract.js';

const at = isoTimestamp('2026-08-17T08:00:00.000000Z');

async function seed(repository: DomainRepository, suffix: string) {
  const projectId = persistenceId('project', `${suffix}-project`);
  const revisionId = persistenceId('configRevision', `${suffix}-revision`);
  const runId = persistenceId('run', `${suffix}-run`);
  const stepId = persistenceId('stepRun', `${suffix}-step`);

  await repository.createProject({
    id: projectId,
    name: suffix,
    createdAt: at,
    updatedAt: at,
  });
  await repository.createConfigRevision({
    id: revisionId,
    projectId,
    revision: 1,
    config: null,
    configDigest: 'config',
    modelDigest: 'model',
    promptDigest: 'prompt',
    environmentDigest: 'environment',
    policyDigest: 'policy',
    repositorySha: 'sha',
    createdAt: at,
  });
  await repository.createRun({
    id: runId,
    projectId,
    configRevisionId: revisionId,
    pipeline: 'parity',
    status: 'pending',
    createdAt: at,
    updatedAt: at,
  });
  await repository.upsertStepRun({
    id: stepId,
    runId,
    stepKey: 'step',
    attempt: 1,
    status: 'pending',
    createdAt: at,
    updatedAt: at,
  });
  return { projectId, revisionId, runId, stepId };
}

export function repositoryParityContract(
  implementation: string,
  createRepository: RepositoryFactory,
): void {
  describe(`${implementation} PostgreSQL parity contract`, () => {
    it('rejects every missing parent foreign key', async () => {
      const repository = await createRepository();
      const ids = await seed(repository, `${implementation}-fk`);
      const missingProject = persistenceId('project', 'missing-project');
      const missingRevision = persistenceId(
        'configRevision',
        'missing-revision',
      );
      const missingRun = persistenceId('run', 'missing-run');
      const missingStep = persistenceId('stepRun', 'missing-step');
      const missingSession = persistenceId(
        'externalSession',
        'missing-session',
      );
      const missingCriterion = persistenceId(
        'goalCriterion',
        'missing-criterion',
      );

      await expect(
        repository.createConfigRevision({
          id: persistenceId('configRevision', 'fk-revision'),
          projectId: missingProject,
          revision: 2,
          config: null,
          configDigest: 'config',
          modelDigest: 'model',
          promptDigest: 'prompt',
          environmentDigest: 'environment',
          policyDigest: 'policy',
          repositorySha: 'sha',
          createdAt: at,
        }),
      ).rejects.toThrow();
      await expect(
        repository.createRun({
          id: persistenceId('run', 'fk-run-project'),
          projectId: missingProject,
          pipeline: 'fk',
          status: 'pending',
          createdAt: at,
          updatedAt: at,
        }),
      ).rejects.toThrow();
      await expect(
        repository.createRun({
          id: persistenceId('run', 'fk-run-revision'),
          projectId: ids.projectId,
          configRevisionId: missingRevision,
          pipeline: 'fk',
          status: 'pending',
          createdAt: at,
          updatedAt: at,
        }),
      ).rejects.toThrow();
      await expect(
        repository.createConfigSnapshot({
          id: persistenceId('configSnapshot', 'fk-snapshot-run'),
          runId: missingRun,
          configRevisionId: ids.revisionId,
          config: null,
          configDigest: 'config',
          modelDigest: 'model',
          promptDigest: 'prompt',
          environmentDigest: 'environment',
          policyDigest: 'policy',
          repositorySha: 'sha',
          createdAt: at,
        }),
      ).rejects.toThrow();
      await expect(
        repository.createConfigSnapshot({
          id: persistenceId('configSnapshot', 'fk-snapshot-revision'),
          runId: ids.runId,
          configRevisionId: missingRevision,
          config: null,
          configDigest: 'config',
          modelDigest: 'model',
          promptDigest: 'prompt',
          environmentDigest: 'environment',
          policyDigest: 'policy',
          repositorySha: 'sha',
          createdAt: at,
        }),
      ).rejects.toThrow();
      await expect(
        repository.upsertStepRun({
          id: persistenceId('stepRun', 'fk-step-run'),
          runId: missingRun,
          stepKey: 'fk',
          attempt: 1,
          status: 'pending',
          createdAt: at,
          updatedAt: at,
        }),
      ).rejects.toThrow();
      await expect(
        repository.upsertStepRun({
          id: persistenceId('stepRun', 'fk-step-session'),
          runId: ids.runId,
          stepKey: 'fk-session',
          attempt: 1,
          status: 'pending',
          externalSessionId: missingSession,
          createdAt: at,
          updatedAt: at,
        }),
      ).rejects.toThrow();
      await expect(
        repository.createExternalSession({
          id: persistenceId('externalSession', 'fk-session-run'),
          runId: missingRun,
          provider: 'test',
          externalId: 'run',
          status: 'active',
          createdAt: at,
        }),
      ).rejects.toThrow();
      await expect(
        repository.createExternalSession({
          id: persistenceId('externalSession', 'fk-session-step'),
          runId: ids.runId,
          stepRunId: missingStep,
          provider: 'test',
          externalId: 'step',
          status: 'active',
          createdAt: at,
        }),
      ).rejects.toThrow();

      const runChildren = [
        () =>
          repository.createApproval({
            id: persistenceId('approval', 'fk-approval'),
            runId: missingRun,
            scope: 'fk',
            fingerprint: 'fk',
            status: 'pending' as const,
            createdAt: at,
            expiresAt: at,
          }),
        () =>
          repository.createInboxMessage({
            id: persistenceId('inboxMessage', 'fk-inbox-run'),
            runId: missingRun,
            status: 'pending' as const,
            body: null,
            createdAt: at,
          }),
        () =>
          repository.appendEvent({
            runId: missingRun,
            eventId: persistenceId('event', 'fk-event'),
            fingerprint: 'fk',
            type: 'fk',
            occurredAt: at,
          }),
        () =>
          repository.createArtifact({
            id: persistenceId('artifact', 'fk-artifact-run'),
            runId: missingRun,
            key: 'fk',
            digest: 'fk',
            createdAt: at,
          }),
        () =>
          repository.appendUsage({
            idempotencyId: persistenceId('usage', 'fk-usage-run'),
            runId: missingRun,
            model: 'test',
            inputTokens: 0,
            outputTokens: 0,
            runtimeMs: 0,
            microdollars: 0,
            recordedAt: at,
          }),
        () =>
          repository.createGoalCriterion({
            id: persistenceId('goalCriterion', 'fk-criterion'),
            runId: missingRun,
            ordinal: 0,
            description: 'fk',
            status: 'pending' as const,
            createdAt: at,
          }),
        () =>
          repository.appendGoalProgress({
            id: persistenceId('goalProgress', 'fk-progress-run'),
            runId: missingRun,
            status: 'pending' as const,
            recordedAt: at,
          }),
      ];
      for (const operation of runChildren)
        await expect(operation()).rejects.toThrow();

      await expect(
        repository.createInboxMessage({
          id: persistenceId('inboxMessage', 'fk-inbox-step'),
          runId: ids.runId,
          stepRunId: missingStep,
          status: 'pending',
          body: null,
          createdAt: at,
        }),
      ).rejects.toThrow();
      await expect(
        repository.createArtifact({
          id: persistenceId('artifact', 'fk-artifact-step'),
          runId: ids.runId,
          stepRunId: missingStep,
          key: 'fk-step',
          digest: 'fk',
          createdAt: at,
        }),
      ).rejects.toThrow();
      await expect(
        repository.appendUsage({
          idempotencyId: persistenceId('usage', 'fk-usage-step'),
          runId: ids.runId,
          stepRunId: missingStep,
          model: 'test',
          inputTokens: 0,
          outputTokens: 0,
          runtimeMs: 0,
          microdollars: 0,
          recordedAt: at,
        }),
      ).rejects.toThrow();
      await expect(
        repository.appendGoalProgress({
          id: persistenceId('goalProgress', 'fk-progress-criterion'),
          runId: ids.runId,
          criterionId: missingCriterion,
          status: 'pending',
          recordedAt: at,
        }),
      ).rejects.toThrow();
    });

    it('enforces secondary uniqueness without poisoning indexes', async () => {
      const repository = await createRepository();
      const ids = await seed(repository, `${implementation}-unique`);

      const duplicateRevision = {
        id: persistenceId('configRevision', 'duplicate-revision'),
        projectId: ids.projectId,
        revision: 1,
        config: null,
        configDigest: 'config',
        modelDigest: 'model',
        promptDigest: 'prompt',
        environmentDigest: 'environment',
        policyDigest: 'policy',
        repositorySha: 'sha',
        createdAt: at,
      } as const;
      await expect(
        repository.createConfigRevision(duplicateRevision),
      ).rejects.toThrow();
      await expect(
        repository.createConfigRevision({ ...duplicateRevision, revision: 2 }),
      ).resolves.toMatchObject({ revision: 2 });

      await repository.createExternalSession({
        id: persistenceId('externalSession', 'session-one'),
        runId: ids.runId,
        provider: 'provider',
        externalId: 'external',
        status: 'active',
        createdAt: at,
      });
      const duplicateSession = {
        id: persistenceId('externalSession', 'session-two'),
        runId: ids.runId,
        provider: 'provider',
        externalId: 'external',
        status: 'active' as const,
        createdAt: at,
      };
      await expect(
        repository.createExternalSession(duplicateSession),
      ).rejects.toThrow();
      await expect(
        repository.createExternalSession({
          ...duplicateSession,
          externalId: 'external-two',
        }),
      ).resolves.toMatchObject({ externalId: 'external-two' });

      await repository.createArtifact({
        id: persistenceId('artifact', 'artifact-one'),
        runId: ids.runId,
        key: 'artifact-key',
        digest: 'digest',
        createdAt: at,
      });
      const duplicateArtifact = {
        id: persistenceId('artifact', 'artifact-two'),
        runId: ids.runId,
        key: 'artifact-key',
        digest: 'digest',
        createdAt: at,
      };
      await expect(
        repository.createArtifact(duplicateArtifact),
      ).rejects.toThrow();
      await expect(
        repository.createArtifact({
          ...duplicateArtifact,
          key: 'artifact-two',
        }),
      ).resolves.toMatchObject({ key: 'artifact-two' });

      await repository.createGoalCriterion({
        id: persistenceId('goalCriterion', 'criterion-one'),
        runId: ids.runId,
        ordinal: 0,
        description: 'one',
        status: 'pending',
        createdAt: at,
      });
      const duplicateCriterion = {
        id: persistenceId('goalCriterion', 'criterion-two'),
        runId: ids.runId,
        ordinal: 0,
        description: 'two',
        status: 'pending' as const,
        createdAt: at,
      };
      await expect(
        repository.createGoalCriterion(duplicateCriterion),
      ).rejects.toThrow();
      await expect(
        repository.createGoalCriterion({
          ...duplicateCriterion,
          ordinal: 1,
        }),
      ).resolves.toMatchObject({ ordinal: 1 });
    });

    it('allocates monotonically increasing event sequences in the repository', async () => {
      const repository = await createRepository();
      const { runId } = await seed(
        repository,
        `${implementation}-event-sequence`,
      );
      const first = await repository.appendEvent({
        runId,
        eventId: persistenceId('event', 'allocated-first'),
        fingerprint: 'allocated-first',
        type: 'allocated',
        occurredAt: at,
      });
      const second = await repository.appendEvent({
        runId,
        eventId: persistenceId('event', 'allocated-second'),
        fingerprint: 'allocated-second',
        type: 'allocated',
        occurredAt: at,
      });
      expect([first.sequence, second.sequence]).toEqual([1, 2]);
      await expect(repository.getEvent(runId, second.eventId)).resolves.toEqual(
        second,
      );
    });

    it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
      'rejects invalid artifact size %s',
      async (sizeBytes) => {
        const repository = await createRepository();
        const { runId } = await seed(
          repository,
          `${implementation}-artifact-${String(sizeBytes)}`,
        );
        await expect(
          repository.createArtifact({
            id: persistenceId('artifact', `invalid-${String(sizeBytes)}`),
            runId,
            key: 'invalid',
            sizeBytes,
            digest: 'invalid',
            createdAt: at,
          }),
        ).rejects.toThrow('sizeBytes must be a non-negative safe integer');
      },
    );

    it('rejects integer values PostgreSQL cannot store', async () => {
      const repository = await createRepository();
      const ids = await seed(repository, `${implementation}-integer-range`);
      const outsideInteger = 2_147_483_648;

      await expect(
        repository.createConfigRevision({
          id: persistenceId('configRevision', 'large-revision'),
          projectId: ids.projectId,
          revision: outsideInteger,
          config: null,
          configDigest: 'config',
          modelDigest: 'model',
          promptDigest: 'prompt',
          environmentDigest: 'environment',
          policyDigest: 'policy',
          repositorySha: 'sha',
          createdAt: at,
        }),
      ).rejects.toThrow('revision must be a positive PostgreSQL integer');
      await expect(
        repository.upsertStepRun({
          id: persistenceId('stepRun', 'large-attempt'),
          runId: ids.runId,
          stepKey: 'large',
          attempt: outsideInteger,
          status: 'pending',
          createdAt: at,
          updatedAt: at,
        }),
      ).rejects.toThrow('attempt must be a positive PostgreSQL integer');
      await expect(
        repository.createGoalCriterion({
          id: persistenceId('goalCriterion', 'large-ordinal'),
          runId: ids.runId,
          ordinal: outsideInteger,
          description: 'large',
          status: 'pending',
          createdAt: at,
        }),
      ).rejects.toThrow('ordinal must be a non-negative PostgreSQL integer');
    });

    it('bounds list results and resumes after a stable timestamp cursor', async () => {
      const repository = await createRepository();
      const ids = ['one', 'two', 'three'] as const;
      for (const [index, id] of ids.entries()) {
        await repository.createProject({
          id: persistenceId('project', `${implementation}-page-${id}`),
          name: id,
          createdAt: isoTimestamp(`2026-08-17T10:00:0${String(index)}.000000Z`),
          updatedAt: at,
        });
      }

      const first = await repository.listProjects({
        limit: 2,
        after: {
          at: isoTimestamp('2026-08-17T09:59:59.000000Z'),
          id: persistenceId('project', 'cursor'),
        },
      });
      expect(first.map((project) => project.name)).toEqual(['one', 'two']);
      const last = first.at(-1);
      if (last === undefined) throw new Error('expected first page');
      const second = await repository.listProjects({
        limit: 2,
        after: { at: last.createdAt, id: last.id },
      });
      expect(second.map((project) => project.name)).toEqual(['three']);
    });

    it('uses bytewise opaque-ID ordering for tied timestamp cursors', async () => {
      const repository = await createRepository();
      const names = ['Z', 'a', 'é', '😀'] as const;
      const tiedAt = isoTimestamp('2026-08-17T10:10:00.000000Z');
      for (const name of names) {
        await repository.createProject({
          id: persistenceId('project', `${implementation}-collation-${name}`),
          name,
          createdAt: tiedAt,
          updatedAt: at,
        });
      }

      const first = await repository.listProjects({
        limit: 2,
        after: {
          at: isoTimestamp('2026-08-17T10:09:59.000000Z'),
          id: persistenceId('project', 'cursor'),
        },
      });
      expect(first.map((project) => project.name)).toEqual(['Z', 'a']);
      const last = first.at(-1);
      if (last === undefined) throw new Error('expected first collation page');
      const second = await repository.listProjects({
        limit: 2,
        after: { at: last.createdAt, id: last.id },
      });
      expect(second.map((project) => project.name)).toEqual(['é', '😀']);
    });

    it('uses bytewise step-key ordering across pages', async () => {
      const repository = await createRepository();
      const { runId } = await seed(repository, `${implementation}-step-order`);
      const stepKeys = ['Z', 'a', 'é', '😀'] as const;
      for (const stepKey of stepKeys) {
        await repository.upsertStepRun({
          id: persistenceId('stepRun', `${implementation}-${stepKey}`),
          runId,
          stepKey,
          attempt: 1,
          status: 'pending',
          createdAt: at,
          updatedAt: at,
        });
      }

      const first = await repository.listStepRuns(runId, { limit: 2 });
      expect(first.map((step) => step.stepKey)).toEqual(['Z', 'a']);
      const last = first.at(-1);
      if (last === undefined) throw new Error('expected first step page');
      const second = await repository.listStepRuns(runId, {
        limit: 2,
        after: { stepKey: last.stepKey, attempt: last.attempt },
      });
      expect(second.map((step) => step.stepKey)).toEqual(['step', 'é']);
      const secondLast = second.at(-1);
      if (secondLast === undefined)
        throw new Error('expected second step page');
      const third = await repository.listStepRuns(runId, {
        limit: 2,
        after: {
          stepKey: secondLast.stepKey,
          attempt: secondLast.attempt,
        },
      });
      expect(third.map((step) => step.stepKey)).toEqual(['😀']);
    });
  });
}
