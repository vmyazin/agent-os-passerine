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
            pricingVersion: 'pricing-v1',
            inputTokens: 0,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreation5mInputTokens: 0,
            cacheCreation1hInputTokens: 0,
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
            definition: {
              id: 'fk',
              type: 'command',
              description: 'fk',
              command: 'true',
            },
            status: 'pending' as const,
            createdAt: at,
          }),
        () =>
          repository.appendGoalProgress({
            id: persistenceId('goalProgress', 'fk-progress-run'),
            runId: missingRun,
            step: 1,
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
          pricingVersion: 'pricing-v1',
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreation5mInputTokens: 0,
          cacheCreation1hInputTokens: 0,
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
          step: 1,
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
        definition: {
          id: 'one',
          type: 'command',
          description: 'one',
          command: 'true',
        },
        status: 'pending',
        createdAt: at,
      });
      const duplicateCriterion = {
        id: persistenceId('goalCriterion', 'criterion-two'),
        runId: ids.runId,
        ordinal: 0,
        description: 'two',
        definition: {
          id: 'two',
          type: 'command',
          description: 'two',
          command: 'true',
        },
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

    it('persists canonical goal definitions and idempotent bounded progress', async () => {
      const repository = await createRepository();
      const { runId } = await seed(
        repository,
        `${implementation}-durable-goal`,
      );
      type DurableCriterion = Parameters<
        DomainRepository['createGoalCriterion']
      >[0] & {
        readonly definition: {
          readonly id: string;
          readonly type: 'command';
          readonly description: string;
          readonly command: string;
        };
      };
      type DurableProgress = Parameters<
        DomainRepository['appendGoalProgress']
      >[0] & { readonly step: number };
      const durable = repository as DomainRepository & {
        createGoalCriterionIdempotently(
          criterion: DurableCriterion,
        ): Promise<DurableCriterion>;
        appendGoalProgressIdempotently(
          progress: DurableProgress,
        ): Promise<DurableProgress>;
      };
      const criterion: DurableCriterion = {
        id: persistenceId('goalCriterion', `${implementation}-criterion`),
        runId,
        ordinal: 0,
        description: 'Tests pass',
        definition: {
          id: 'tests',
          type: 'command',
          description: 'Tests pass',
          command: 'pnpm test',
        },
        status: 'pending',
        createdAt: at,
      };

      const createdCriterion =
        await durable.createGoalCriterionIdempotently(criterion);
      await expect(
        durable.createGoalCriterionIdempotently({
          ...criterion,
          definition: {
            command: 'pnpm test',
            description: 'Tests pass',
            type: 'command',
            id: 'tests',
          },
        }),
      ).resolves.toEqual(createdCriterion);
      await expect(
        durable.createGoalCriterionIdempotently({
          ...criterion,
          definition: {
            id: 'tests',
            type: 'command',
            description: 'Tests pass',
            command: 'pnpm test:changed',
          },
        }),
      ).rejects.toThrow(/conflict|different/i);

      const progress: DurableProgress = {
        id: persistenceId('goalProgress', `${implementation}-progress`),
        runId,
        criterionId: criterion.id,
        step: 1,
        status: 'failed',
        detail: 'Tests failed',
        payload: { code: 'test_failure', attempt: 1 },
        recordedAt: at,
      };
      const createdProgress =
        await durable.appendGoalProgressIdempotently(progress);
      await expect(
        durable.appendGoalProgressIdempotently({
          ...progress,
          payload: { attempt: 1, code: 'test_failure' },
        }),
      ).resolves.toEqual(createdProgress);
      await expect(
        durable.appendGoalProgressIdempotently({
          ...progress,
          detail: 'Different result',
        }),
      ).rejects.toThrow(/conflict|different/i);

      for (const step of [0, 4]) {
        await expect(
          durable.appendGoalProgressIdempotently({
            ...progress,
            id: persistenceId(
              'goalProgress',
              `${implementation}-invalid-step-${String(step)}`,
            ),
            step,
          }),
        ).rejects.toThrow(/step/i);
      }
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

    it('atomically claims one artifact manifest row and audits retention deletion', async () => {
      const repository = await createRepository();
      const { runId } = await seed(
        repository,
        `${implementation}-artifact-claim`,
      );
      const base = {
        runId,
        key: 'artifact-manifest/v1/step/spec/1',
        mediaType: 'text/plain',
        sizeBytes: 4,
        uri: `artifacts/v1/project/run/step/spec/1/sha256/${'a'.repeat(64)}`,
        retentionClass: 'working' as const,
        manifestVersion: 'artifact-manifest-v1' as const,
        deletionState: 'active' as const,
        createdAt: at,
        cleanupAt: isoTimestamp('2026-08-18T08:00:00.000000Z'),
      };
      const claimed = await Promise.all([
        repository.claimArtifact({
          ...base,
          id: persistenceId('artifact', `${implementation}-claim-left`),
          digest: 'a'.repeat(64),
        }),
        repository.claimArtifact({
          ...base,
          id: persistenceId('artifact', `${implementation}-claim-right`),
          digest: 'b'.repeat(64),
        }),
      ]);
      expect(new Set(claimed.map((artifact) => artifact.id))).toHaveLength(1);
      expect(new Set(claimed.map((artifact) => artifact.digest))).toHaveLength(
        1,
      );
      expect(
        await repository.getArtifactByRunKey(runId, base.key),
      ).toMatchObject({ key: base.key });
      expect(
        await repository.listArtifactsByRunKey(
          runId,
          'artifact-manifest/v1/step/',
          undefined,
          10,
        ),
      ).toHaveLength(1);
      const due = await repository.listArtifactsDueForCleanup(
        isoTimestamp('2026-08-18T08:00:00.000001Z'),
        10,
      );
      expect(due).toHaveLength(1);
      const deletionAt = isoTimestamp('2026-08-18T08:00:00.000001Z');
      const reserved = await repository.reserveArtifactDeletion({
        id: due[0]!.id,
        runId,
        logicalKey: due[0]!.key,
        uri: due[0]!.uri!,
        digest: due[0]!.digest,
        now: deletionAt,
        requestedAt: deletionAt,
        reason: 'retention_expired',
      });
      expect(reserved?.deletionState).toBe('pending');
      await repository.finalizeArtifactDeletion({
        id: due[0]!.id,
        runId,
        logicalKey: due[0]!.key,
        uri: due[0]!.uri!,
        digest: due[0]!.digest,
        deletedAt: deletionAt,
        reason: 'retention_expired',
      });
      expect(
        await repository.listArtifactsByRunKey(
          runId,
          'artifact-manifest/v1/step/',
          undefined,
          10,
        ),
      ).toEqual([]);
    });

    it('charges every quota invocation and rejects first-call byte overflow', async () => {
      const repository = await createRepository();
      const quota = repository as DomainRepository & {
        consumeArtifactCapabilityQuota(request: {
          purpose: string;
          audience: string;
          nonce: string;
          fingerprint: string;
          operationId: string;
          bytes: number;
          maxCalls: number;
          maxCumulativeBytes: number;
          notBefore: ReturnType<typeof isoTimestamp>;
          expiresAt: ReturnType<typeof isoTimestamp>;
          now: ReturnType<typeof isoTimestamp>;
        }): Promise<{
          allowed: boolean;
          replayed: boolean;
          calls: number;
          cumulativeBytes: number;
        }>;
      };
      const base = {
        purpose: 'agent-artifact-access',
        audience: 'artifact-mcp',
        nonce: `${implementation}-quota-nonce`,
        fingerprint: 'quota-fingerprint',
        bytes: 6,
        maxCalls: 1,
        maxCumulativeBytes: 10,
        notBefore: isoTimestamp('2026-08-17T08:00:00.000000Z'),
        expiresAt: isoTimestamp('2026-08-17T08:10:00.000000Z'),
        now: isoTimestamp('2026-08-17T08:01:00.000000Z'),
      };
      const raced = await Promise.all([
        quota.consumeArtifactCapabilityQuota({ ...base, operationId: 'one' }),
        quota.consumeArtifactCapabilityQuota({ ...base, operationId: 'two' }),
      ]);
      expect(raced.filter((result) => result.allowed)).toHaveLength(1);
      const winner = raced[0]!.allowed ? 'one' : 'two';
      await expect(
        quota.consumeArtifactCapabilityQuota({
          ...base,
          operationId: winner,
        }),
      ).resolves.toMatchObject({
        allowed: false,
        replayed: false,
        calls: 1,
        cumulativeBytes: 6,
      });

      await expect(
        quota.consumeArtifactCapabilityQuota({
          ...base,
          nonce: `${implementation}-quota-first-overflow`,
          operationId: 'first-too-large',
          bytes: 11,
          maxCalls: 2,
        }),
      ).resolves.toEqual({
        allowed: false,
        replayed: false,
        calls: 0,
        cumulativeBytes: 0,
      });

      const byteBase = {
        ...base,
        nonce: `${implementation}-quota-bytes`,
        maxCalls: 2,
      };
      const byteRace = await Promise.all([
        quota.consumeArtifactCapabilityQuota({
          ...byteBase,
          operationId: 'byte-one',
        }),
        quota.consumeArtifactCapabilityQuota({
          ...byteBase,
          operationId: 'byte-two',
        }),
      ]);
      expect(byteRace.filter((result) => result.allowed)).toHaveLength(1);
    });

    it('grants only one durable artifact cleanup lease at a time', async () => {
      const repository = await createRepository();
      const leased = repository as DomainRepository & {
        claimArtifactCleanupLease(request: {
          owner: string;
          now: ReturnType<typeof isoTimestamp>;
          expiresAt: ReturnType<typeof isoTimestamp>;
        }): Promise<boolean>;
      };
      const raced = await Promise.all([
        leased.claimArtifactCleanupLease({
          owner: `${implementation}-worker-one`,
          now: isoTimestamp('2026-08-17T08:00:00.000000Z'),
          expiresAt: isoTimestamp('2026-08-17T08:05:00.000000Z'),
        }),
        leased.claimArtifactCleanupLease({
          owner: `${implementation}-worker-two`,
          now: isoTimestamp('2026-08-17T08:00:00.000000Z'),
          expiresAt: isoTimestamp('2026-08-17T08:05:00.000000Z'),
        }),
      ]);
      expect(raced.filter(Boolean)).toHaveLength(1);
      const winningOwner = raced[0]
        ? `${implementation}-worker-one`
        : `${implementation}-worker-two`;
      const losingOwner = raced[0]
        ? `${implementation}-worker-two`
        : `${implementation}-worker-one`;
      await expect(
        leased.renewArtifactCleanupLease({
          owner: losingOwner,
          now: isoTimestamp('2026-08-17T08:01:00.000000Z'),
          expiresAt: isoTimestamp('2026-08-17T08:06:00.000000Z'),
        }),
      ).resolves.toBe(false);
      await expect(
        leased.renewArtifactCleanupLease({
          owner: winningOwner,
          now: isoTimestamp('2026-08-17T08:01:00.000000Z'),
          expiresAt: isoTimestamp('2026-08-17T08:06:00.000000Z'),
        }),
      ).resolves.toBe(true);
      await expect(
        leased.claimArtifactCleanupLease({
          owner: `${implementation}-worker-three`,
          now: isoTimestamp('2026-08-17T08:06:00.000001Z'),
          expiresAt: isoTimestamp('2026-08-17T08:10:00.000000Z'),
        }),
      ).resolves.toBe(true);
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
          definition: {
            id: 'large',
            type: 'command',
            description: 'large',
            command: 'true',
          },
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

    it('counts runs exactly beyond the list page cap', async () => {
      const repository = await createRepository();
      const { projectId, revisionId } = await seed(
        repository,
        `${implementation}-count`,
      );
      // MAX_LIST_LIMIT is 100, so a count derived from listRuns would
      // saturate here and report a total that never grows again.
      const total = 105;
      for (let index = 1; index < total; index += 1) {
        await repository.createRun({
          id: persistenceId('run', `${implementation}-count-run-${String(index)}`),
          projectId,
          configRevisionId: revisionId,
          pipeline: 'parity',
          status: 'pending',
          createdAt: at,
          updatedAt: at,
        });
      }
      expect(await repository.countRuns({ projectId })).toBe(total);
      expect((await repository.listRuns({ projectId, limit: 1_000 })).length).toBe(100);
      expect(
        await repository.countRuns({
          projectId: persistenceId('project', `${implementation}-count-absent`),
        }),
      ).toBe(0);
    });

    it('isolates configuration preconditions per project', async () => {
      const repository = await createRepository();
      const project = (key: 'cas-a' | 'cas-b') => ({
        id: persistenceId('project', `${implementation}-${key}`),
        name: key,
        createdAt: at,
        updatedAt: at,
      });
      const draft = (
        suffix: string,
        projectId: Parameters<DomainRepository['createProject']>[0]['id'],
      ) => ({
        id: persistenceId('configRevision', `${implementation}-cas-${suffix}`),
        projectId,
        config: null,
        configDigest: `digest-${suffix}`,
        modelDigest: 'model',
        promptDigest: 'prompt',
        environmentDigest: 'environment',
        policyDigest: 'policy',
        repositorySha: 'sha',
        createdAt: at,
      });
      const a = project('cas-a');
      const b = project('cas-b');

      const a1 = await repository.applyConfigRevision(a, draft('a1', a.id), {
        revision: null,
        digest: null,
      });
      expect(a1.revision).toBe(1);

      const b1 = await repository.applyConfigRevision(b, draft('b1', b.id), {
        revision: null,
        digest: null,
      });
      expect(b1.revision).toBe(1);

      const a2 = await repository.applyConfigRevision(a, draft('a2', a.id), {
        revision: 1,
        digest: 'digest-a1',
      });
      expect(a2.revision).toBe(2);

      await expect(
        repository.applyConfigRevision(a, draft('a3', a.id), {
          revision: 1,
          digest: 'digest-a1',
        }),
      ).rejects.toMatchObject({ name: 'StaleConfigurationError' });
    });

    it('scopes the latest configuration revision per project', async () => {
      const repository = await createRepository();
      const a = {
        id: persistenceId('project', `${implementation}-latest-a`),
        name: 'latest-a',
        createdAt: at,
        updatedAt: at,
      };
      const b = {
        id: persistenceId('project', `${implementation}-latest-b`),
        name: 'latest-b',
        createdAt: at,
        updatedAt: at,
      };
      const draft = (suffix: string, projectId: typeof a.id) => ({
        id: persistenceId('configRevision', `${implementation}-latest-${suffix}`),
        projectId,
        config: null,
        configDigest: `digest-${suffix}`,
        modelDigest: 'model',
        promptDigest: 'prompt',
        environmentDigest: 'environment',
        policyDigest: 'policy',
        repositorySha: 'sha',
        createdAt: at,
      });
      await repository.applyConfigRevision(a, draft('a1', a.id), {
        revision: null,
        digest: null,
      });
      await repository.applyConfigRevision(b, draft('b1', b.id), {
        revision: null,
        digest: null,
      });
      const latestA = await repository.getLatestConfigRevision(a.id);
      expect(latestA?.configDigest).toBe('digest-a1');
      const missing = await repository.getLatestConfigRevision(
        persistenceId('project', `${implementation}-latest-none`),
      );
      expect(missing).toBeUndefined();
    });
  });
}
