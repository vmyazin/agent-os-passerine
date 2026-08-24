import { createHash } from 'node:crypto';

import { InMemoryDomainRepository } from '@agentos/adapters';
import {
  isoTimestamp,
  persistenceId,
  type ProjectSourceImportInput,
} from '@agentos/core';
import { describe, expect, it, vi } from 'vitest';

import {
  ControlPlaneService,
  ServiceError,
  type IdGenerator,
  type ProjectSourceGateway,
} from './control-plane-service';

const at = isoTimestamp('2026-08-24T12:00:00.000Z');
const ids: IdGenerator = (kind, key) =>
  persistenceId(
    kind,
    `${kind}_${createHash('sha256').update(key).digest('hex').slice(0, 24)}`,
  );

function localGateway(
  inspect = vi.fn(async (input: ProjectSourceImportInput) => {
    if (input.kind !== 'local') throw new Error('expected local');
    return {
      inspection: {
        kind: 'local' as const,
        sourceKey: 'local:/work/passserine',
        canonicalLocation: '/work/passserine',
        suggestedName: 'passserine',
        defaultBranch: 'main',
        headSha: 'a'.repeat(40),
      },
      source: {
        kind: 'local' as const,
        sourceKey: 'local:/work/passserine',
        localPath: '/work/passserine',
        defaultBranch: 'main',
      },
    };
  }),
): ProjectSourceGateway {
  return {
    inspect,
    listCommits: vi.fn(async () => ({
      items: [
        {
          sha: 'a'.repeat(40),
          subject: 'Imported history',
          authorName: 'Ada',
          committedAt: at,
        },
      ],
    })),
  };
}

function service(
  repository: InMemoryDomainRepository,
  gateway: ProjectSourceGateway,
) {
  return new ControlPlaneService(
    repository,
    () => at,
    ids,
    undefined,
    undefined,
    undefined,
    [],
    undefined,
    gateway,
  );
}

describe('ControlPlaneService project sources', () => {
  it('inspects, atomically imports, repeats, and exposes safe source metadata', async () => {
    const repository = new InMemoryDomainRepository();
    const gateway = localGateway();
    const controlPlane = service(repository, gateway);

    await expect(
      controlPlane.inspectProjectSource({
        kind: 'local',
        localPath: '/work/passserine',
      }),
    ).resolves.toMatchObject({ canonicalLocation: '/work/passserine' });
    const first = await controlPlane.importProjectSource('import-1', {
      kind: 'local',
      localPath: '/work/passserine',
      defaultBranch: 'main',
    });
    expect(first.created).toBe(true);
    const replay = await controlPlane.importProjectSource('import-1', {
      kind: 'local',
      localPath: '/work/passserine',
      defaultBranch: 'main',
    });
    expect(replay).toEqual({ ...first, created: false });

    const detail = await controlPlane.getProjectDetail(first.project.id);
    expect(detail.source).toEqual({
      kind: 'local',
      location: '/work/passserine',
      defaultBranch: 'main',
    });
    expect(detail.latestRevision).toBeUndefined();
    await expect(
      controlPlane.listProjectCommits(first.project.id),
    ).resolves.toEqual({
      items: [
        {
          sha: 'a'.repeat(40),
          subject: 'Imported history',
          authorName: 'Ada',
          committedAt: at,
        },
      ],
    });
  });

  it('attaches to a matching configuration-created project', async () => {
    const repository = new InMemoryDomainRepository();
    const matchingId = ids('project', 'binding:localPath:/work/passserine');
    await repository.createProject({
      id: matchingId,
      name: 'Configured project',
      createdAt: at,
      updatedAt: at,
    });
    const imported = await service(
      repository,
      localGateway(),
    ).importProjectSource('attach-1', {
      kind: 'local',
      localPath: '/work/passserine',
    });
    expect(imported.project.id).toBe(matchingId);
    expect(imported.project.name).toBe('Configured project');
    expect(imported.created).toBe(false);
  });

  it('rejects reusing an import idempotency key with another source', async () => {
    const repository = new InMemoryDomainRepository();
    const gateway = localGateway(
      vi.fn(async (input: ProjectSourceImportInput) => {
        if (input.kind !== 'local') throw new Error('expected local');
        const name = input.localPath.split('/').at(-1)!;
        return {
          inspection: {
            kind: 'local' as const,
            sourceKey: `local:${input.localPath}`,
            canonicalLocation: input.localPath,
            suggestedName: name,
            defaultBranch: 'main',
            headSha: 'a'.repeat(40),
          },
          source: {
            kind: 'local' as const,
            sourceKey: `local:${input.localPath}`,
            localPath: input.localPath,
            defaultBranch: 'main',
          },
        };
      }),
    );
    const controlPlane = service(repository, gateway);
    await controlPlane.importProjectSource('reused-key', {
      kind: 'local',
      localPath: '/work/one',
    });

    await expect(
      controlPlane.importProjectSource('reused-key', {
        kind: 'local',
        localPath: '/work/two',
      }),
    ).rejects.toEqual(
      new ServiceError(
        'idempotency_conflict',
        'idempotency key was already used with another project source',
        409,
      ),
    );
  });

  it('sanitizes provider failures and keeps source-less projects available', async () => {
    const repository = new InMemoryDomainRepository();
    const sourceLessId = ids('project', 'source-less');
    await repository.createProject({
      id: sourceLessId,
      name: 'Legacy',
      createdAt: at,
      updatedAt: at,
    });
    const gateway = localGateway(
      vi.fn(async () => {
        throw Object.assign(new Error('The selected branch is unavailable'), {
          code: 'unavailable_branch',
        });
      }),
    );
    const controlPlane = service(repository, gateway);
    await expect(
      controlPlane.inspectProjectSource({
        kind: 'local',
        localPath: '/secret',
      }),
    ).rejects.toEqual(
      new ServiceError(
        'unavailable_branch',
        'The selected branch is unavailable',
        422,
      ),
    );
    const detail = await controlPlane.getProjectDetail(sourceLessId);
    expect(detail.id).toBe(sourceLessId);
    expect(detail.source).toBeUndefined();
    await expect(
      controlPlane.listProjectCommits(sourceLessId),
    ).rejects.toMatchObject({
      code: 'project_source_not_found',
      status: 404,
    });
  });
});
