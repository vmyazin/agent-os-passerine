import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { ArtifactAdminStore, ArtifactStore } from '@agentos/core';

export interface ArtifactStoreFixture {
  readonly store: ArtifactStore;
  readonly admin: ArtifactAdminStore;
}

export type ArtifactStoreFixtureFactory = () =>
  ArtifactStoreFixture | Promise<ArtifactStoreFixture>;

const scope = { projectId: 'project-1', runId: 'run-1', stepId: 'step-1' };

function request(artifactId: string, content = artifactId) {
  const bytes = new TextEncoder().encode(content);
  return {
    scope,
    artifactId,
    version: 1,
    digest: createHash('sha256').update(bytes).digest('hex'),
    bytes,
    mediaType: 'text/plain; charset=utf-8',
    retentionClass: 'working' as const,
  };
}

export function artifactStoreContract(
  name: string,
  factory: ArtifactStoreFixtureFactory,
): void {
  describe(`${name} artifact store contract`, () => {
    it('round-trips immutable bytes and accepts an identical replay', async () => {
      const { store } = await factory();
      const input = request('spec', 'hello');
      const first = await store.put(input);
      input.bytes[0] = 0x78;
      const replay = await store.put(request('spec', 'hello'));
      const value = await store.get({ scope, key: first.key });

      expect(replay).toEqual(first);
      expect(new TextDecoder().decode(value?.bytes)).toBe('hello');
      if (value) value.bytes[0] = 0x79;
      expect(
        new TextDecoder().decode(
          (await store.get({ scope, key: first.key }))?.bytes,
        ),
      ).toBe('hello');
    });

    it('rejects conflicting metadata at an existing digest key', async () => {
      const { store } = await factory();
      await store.put(request('spec', 'hello'));
      await expect(
        store.put({
          ...request('spec', 'hello'),
          mediaType: 'application/octet-stream',
        }),
      ).rejects.toMatchObject({ code: 'artifact_conflict' });
    });

    it('atomically rejects different bytes for one logical artifact version', async () => {
      const { store } = await factory();
      await store.put(request('spec', 'first'));
      await expect(store.put(request('spec', 'second'))).rejects.toMatchObject({
        code: 'artifact_conflict',
      });
    });

    it('permits only one digest when conflicting logical puts race', async () => {
      const { store } = await factory();
      const results = await Promise.allSettled([
        store.put(request('spec', 'first')),
        store.put(request('spec', 'second')),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === 'rejected'),
      ).toHaveLength(1);
      const listed = await store.list({ scope });
      expect(listed.items).toHaveLength(1);
    });

    it('does not read or enumerate across project, run, or step boundaries', async () => {
      const { store } = await factory();
      const stored = await store.put(request('spec'));
      for (const otherScope of [
        { ...scope, projectId: 'project-2' },
        { ...scope, runId: 'run-2' },
        { ...scope, stepId: 'step-2' },
      ]) {
        await expect(
          store.get({ scope: otherScope, key: stored.key }),
        ).rejects.toMatchObject({ code: 'artifact_scope_denied' });
        expect((await store.list({ scope: otherScope })).items).toEqual([]);
      }
    });

    it('paginates deterministically within an artifact prefix', async () => {
      const { store } = await factory();
      for (const artifactId of ['log-a', 'log-b', 'other'])
        await store.put(request(artifactId));

      const first = await store.list({
        scope,
        artifactPrefix: 'log',
        limit: 1,
      });
      expect(first.items).toHaveLength(1);
      expect(first.nextCursor).toMatch(/^[A-Za-z0-9_.-]+$/);
      expect(first.nextCursor).not.toContain(first.items[0]?.key ?? '');
      const second = await store.list({
        scope,
        artifactPrefix: 'log',
        cursor: first.nextCursor!,
        limit: 1,
      });
      expect(second.items).toHaveLength(1);
      expect(second.items[0]?.key).not.toBe(first.items[0]?.key);
      expect(second.nextCursor).toBeUndefined();
    });

    it('binds opaque cursors to the requested scope', async () => {
      const { store } = await factory();
      await store.put(request('log-a'));
      await store.put(request('log-b'));
      const first = await store.list({ scope, limit: 1 });
      await expect(
        store.list({
          scope: { ...scope, runId: 'run-2' },
          cursor: first.nextCursor!,
          limit: 1,
        }),
      ).rejects.toMatchObject({ code: 'invalid_artifact' });
    });

    it('rejects forged cursors and prefix swaps', async () => {
      const { store } = await factory();
      await store.put(request('log-a'));
      await store.put(request('log-b'));
      const first = await store.list({
        scope,
        artifactPrefix: 'log',
        limit: 1,
      });
      const cursor = first.nextCursor!;
      const replacement = cursor.endsWith('a') ? 'b' : 'a';
      await expect(
        store.list({
          scope,
          artifactPrefix: 'log',
          cursor: `${cursor.slice(0, -1)}${replacement}`,
          limit: 1,
        }),
      ).rejects.toMatchObject({ code: 'invalid_artifact' });
      await expect(
        store.list({
          scope,
          artifactPrefix: 'other',
          cursor,
          limit: 1,
        }),
      ).rejects.toMatchObject({ code: 'invalid_artifact' });
    });

    it('keeps deletion on the administrator boundary', async () => {
      const { store, admin } = await factory();
      const artifact = await store.put(request('spec'));
      expect('delete' in store).toBe(false);
      await expect(admin.delete('../unsafe')).rejects.toMatchObject({
        code: 'invalid_artifact',
      });
      expect(await admin.delete(artifact.key)).toBe(true);
      expect(await store.get({ scope, key: artifact.key })).toBeUndefined();
    });

    it('keeps a deleted logical version tombstoned forever', async () => {
      const { store, admin } = await factory();
      const input = request('tombstone', 'immutable');
      const artifact = await store.put(input);
      await admin.delete(artifact.key);

      await expect(store.put(input)).rejects.toMatchObject({
        code: 'artifact_deleted',
      });
      await expect(
        store.get({ scope, key: artifact.key }),
      ).resolves.toBeUndefined();
      expect((await store.list({ scope })).items).toEqual([]);
    });

    it('does not delete a real artifact through a forged same-tuple key', async () => {
      const { store, admin } = await factory();
      const artifact = await store.put(request('protected', 'real'));
      const forged = artifact.key.replace(artifact.digest, 'f'.repeat(64));

      await expect(admin.delete(forged)).resolves.toBe(false);
      await expect(
        store.get({ scope, key: artifact.key }),
      ).resolves.toMatchObject({
        digest: artifact.digest,
      });
      expect((await store.list({ scope })).items).toHaveLength(1);
    });
  });
}
