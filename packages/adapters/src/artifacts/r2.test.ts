import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { isoTimestamp, persistenceId } from '@agentos/core';

import { artifactStoreContract } from './artifact-store-contract.js';
import {
  createR2ArtifactStorageForTest,
  type R2Command,
  type R2SdkClient,
} from './test-support.js';
import { InMemoryDomainRepository } from '../persistence/in-memory.js';
import {
  createDomainArtifactManifestStore,
  createInMemoryArtifactManifestStore,
} from './manifest.js';

class FakeR2Client implements R2SdkClient {
  readonly objects = new Map<
    string,
    {
      bytes: Uint8Array;
      contentType: string;
      metadata: Record<string, string>;
      reportedSize?: number;
    }
  >();
  readonly commands: R2Command[] = [];
  failures = 0;
  raceOnPut = false;
  bodyFactory: (() => unknown) | undefined;
  beforePut: (() => Promise<void>) | undefined;
  beforeDelete: ((signal?: AbortSignal) => Promise<void>) | undefined;

  async send(
    command: R2Command,
    options?: { readonly abortSignal?: AbortSignal },
  ): Promise<Record<string, unknown>> {
    this.commands.push(command);
    if (this.failures > 0) {
      this.failures -= 1;
      throw Object.assign(new Error('sensitive upstream outage'), {
        name: 'TimeoutError',
      });
    }
    const input = command.input;
    const key = String(input.Key ?? '');
    switch (command.kind) {
      case 'PutObject': {
        await this.beforePut?.();
        const body = input.Body as Uint8Array;
        this.objects.set(key, {
          bytes: Uint8Array.from(body),
          contentType: String(input.ContentType),
          metadata: input.Metadata as Record<string, string>,
        });
        if (this.raceOnPut) {
          this.raceOnPut = false;
          throw Object.assign(new Error('conditional create lost race'), {
            name: 'PreconditionFailed',
            $metadata: { httpStatusCode: 412 },
          });
        }
        return { ETag: 'not-a-content-digest' };
      }
      case 'GetObject': {
        const value = this.objects.get(key);
        if (!value)
          throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
        return {
          Body: this.bodyFactory?.() ?? Readable.from([value.bytes]),
          ContentLength: value.reportedSize ?? value.bytes.byteLength,
          ContentType: value.contentType,
          Metadata: value.metadata,
          ETag: 'untrusted',
        };
      }
      case 'DeleteObject':
        await this.beforeDelete?.(options?.abortSignal);
        this.objects.delete(key);
        return {};
    }
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(client = new FakeR2Client()) {
  return {
    client,
    ...createR2ArtifactStorageForTest({
      client,
      bucket: 'agentos-artifacts',
      now: () => new Date('2026-08-17T00:00:00.000Z'),
      retry: { attempts: 2, baseDelayMs: 0 },
    }),
  };
}

artifactStoreContract('r2', () => fixture());

describe('R2 artifact storage', () => {
  it('retries an equivalent durable manifest after the clock advances', async () => {
    const client = new FakeR2Client();
    const repository = new InMemoryDomainRepository();
    await repository.createProject({
      id: persistenceId('project', 'p'),
      name: 'retry project',
      createdAt: isoTimestamp('2026-08-17T00:00:00.000Z'),
      updatedAt: isoTimestamp('2026-08-17T00:00:00.000Z'),
    });
    await repository.createRun({
      id: persistenceId('run', 'r'),
      projectId: persistenceId('project', 'p'),
      pipeline: 'artifact-retry',
      status: 'running',
      createdAt: isoTimestamp('2026-08-17T00:00:00.000Z'),
      updatedAt: isoTimestamp('2026-08-17T00:00:00.000Z'),
    });
    let clock = new Date('2026-08-17T00:00:00.000Z');
    const storage = createR2ArtifactStorageForTest({
      client,
      bucket: 'agentos-artifacts',
      manifest: createDomainArtifactManifestStore(repository),
      now: () => clock,
      retry: { attempts: 2, baseDelayMs: 0 },
    });
    const input = {
      scope: { projectId: 'p', runId: 'r', stepId: 's' },
      artifactId: 'retry',
      version: 1,
      bytes: new TextEncoder().encode('immutable'),
      mediaType: 'text/plain',
    } as const;
    client.failures = 2;
    await expect(storage.store.put(input)).rejects.toMatchObject({
      code: 'artifact_store_unavailable',
    });
    clock = new Date('2026-08-17T00:01:00.000Z');
    await expect(storage.store.put(input)).resolves.toMatchObject({
      createdAt: '2026-08-17T00:00:00.000Z',
      expiresAt: '2026-09-16T00:00:00.000Z',
    });
    await expect(
      storage.store.put({
        ...input,
        bytes: new TextEncoder().encode('different'),
      }),
    ).rejects.toMatchObject({ code: 'artifact_conflict' });
  });

  it('reserves deletion before touching R2 so a concurrent put is rejected', async () => {
    const result = fixture();
    const input = {
      scope: { projectId: 'p', runId: 'r', stepId: 's' },
      artifactId: 'reserved-delete',
      version: 1,
      bytes: new TextEncoder().encode('immutable'),
      mediaType: 'text/plain',
    } as const;
    const stored = await result.store.put(input);
    const started = deferred();
    const release = deferred();
    result.client.beforeDelete = async () => {
      result.client.beforeDelete = undefined;
      started.resolve();
      await release.promise;
    };
    const deleting = result.admin.delete(stored.key);
    await started.promise;
    await expect(result.store.put(input)).rejects.toMatchObject({
      code: 'artifact_deleted',
    });
    release.resolve();
    await expect(deleting).resolves.toBe(true);
  });

  it('does not reserve deletion while a put holds the logical write lease', async () => {
    const result = fixture();
    const input = {
      scope: { projectId: 'p', runId: 'r', stepId: 's' },
      artifactId: 'put-first',
      version: 1,
      bytes: new TextEncoder().encode('immutable'),
      mediaType: 'text/plain',
    } as const;
    const started = deferred();
    const release = deferred();
    result.client.beforePut = async () => {
      result.client.beforePut = undefined;
      started.resolve();
      await release.promise;
    };
    const putting = result.store.put(input);
    await started.promise;
    const key = `artifacts/v1/p/r/s/put-first/1/sha256/${createHash('sha256')
      .update(input.bytes)
      .digest('hex')}`;
    await expect(
      result.admin.delete(key, {
        deletedAt: '2099-01-01T00:00:00.000Z',
        reason: 'control_plane_delete',
      }),
    ).resolves.toBe(false);
    release.resolve();
    await expect(putting).resolves.toMatchObject({ key });
    await expect(result.admin.delete(key)).resolves.toBe(true);
    await expect(
      result.store.get({ scope: input.scope, key }),
    ).resolves.toBeUndefined();
  });

  it('keeps a failed blob deletion pending and converges on retry', async () => {
    const result = fixture();
    const input = {
      scope: { projectId: 'p', runId: 'r', stepId: 's' },
      artifactId: 'retry-delete',
      version: 1,
      bytes: new TextEncoder().encode('immutable'),
      mediaType: 'text/plain',
    } as const;
    const stored = await result.store.put(input);
    result.client.failures = 3;
    await expect(result.admin.delete(stored.key)).rejects.toMatchObject({
      code: 'artifact_store_unavailable',
    });
    await expect(result.store.put(input)).rejects.toMatchObject({
      code: 'artifact_deleted',
    });
    result.client.failures = 0;
    await expect(result.admin.delete(stored.key)).resolves.toBe(true);
    await expect(
      result.store.get({ scope: input.scope, key: stored.key }),
    ).resolves.toBeUndefined();
    expect((await result.store.list({ scope: input.scope })).items).toEqual([]);
  });

  it('propagates cleanup cancellation before deleting the R2 object', async () => {
    const result = fixture();
    const stored = await result.store.put({
      scope: { projectId: 'p', runId: 'r', stepId: 's' },
      artifactId: 'cancel-delete',
      version: 1,
      bytes: new TextEncoder().encode('immutable'),
      mediaType: 'text/plain',
    });
    const controller = new AbortController();
    const started = deferred();
    result.client.beforeDelete = async (signal) => {
      started.resolve();
      await new Promise<void>((_resolve, reject) =>
        signal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        }),
      );
    };
    const deleting = result.admin.delete(stored.key, undefined, {
      signal: controller.signal,
    });
    await started.promise;
    controller.abort();
    await expect(deleting).rejects.toMatchObject({
      code: 'artifact_store_unavailable',
    });
    expect(result.client.objects.has(stored.key)).toBe(true);
  });

  it('fails closed on invalid Cloudflare R2 configuration', async () => {
    const { createR2ArtifactStore } = await import('./r2.js');
    expect(() =>
      createR2ArtifactStore({
        accountId: '',
        bucket: 'bucket',
        accessKeyId: 'key',
        secretAccessKey: 'secret',
        manifest: createInMemoryArtifactManifestStore(),
      }),
    ).toThrow(/account/i);
    expect(() =>
      createR2ArtifactStore({
        accountId: 'a'.repeat(32),
        bucket: 'bucket',
        accessKeyId: 'key',
        secretAccessKey: 'secret',
        manifest: createInMemoryArtifactManifestStore(),
        endpoint: 'https://evil.example',
      } as never),
    ).toThrow(/endpoint overrides/i);
  });

  it('retries a bounded transient outage and sanitizes terminal errors', async () => {
    const result = fixture();
    result.client.failures = 1;
    const bytes = new TextEncoder().encode('retry');
    await result.store.put({
      scope: { projectId: 'p', runId: 'r', stepId: 's' },
      artifactId: 'log',
      version: 1,
      bytes,
      mediaType: 'text/plain',
    });
    expect(result.client.commands).toHaveLength(3);

    result.client.failures = 3;
    await expect(
      result.store.get({
        scope: { projectId: 'p', runId: 'r', stepId: 's' },
        key: (
          await result.store.list({
            scope: { projectId: 'p', runId: 'r', stepId: 's' },
          })
        ).items[0]!.key,
      }),
    ).rejects.toMatchObject({
      code: 'artifact_store_unavailable',
      message: 'artifact storage is unavailable',
    });
  });

  it('reconciles an authoritative manifest claim after a terminal R2 outage', async () => {
    const result = fixture();
    const request = {
      scope: { projectId: 'p', runId: 'r', stepId: 's' },
      artifactId: 'recovery',
      version: 1,
      bytes: new TextEncoder().encode('recover'),
      mediaType: 'text/plain',
    } as const;
    result.client.failures = 2;
    await expect(result.store.put(request)).rejects.toMatchObject({
      code: 'artifact_store_unavailable',
    });
    await expect(result.store.put(request)).resolves.toMatchObject({
      artifactId: 'recovery',
    });
    expect(
      (await result.store.list({ scope: request.scope })).items,
    ).toHaveLength(1);
  });

  it('re-reads and validates an object after a conditional-create race', async () => {
    const result = fixture();
    result.client.raceOnPut = true;
    const stored = await result.store.put({
      scope: { projectId: 'p', runId: 'r', stepId: 's' },
      artifactId: 'log',
      version: 1,
      bytes: new TextEncoder().encode('safe'),
      mediaType: 'text/plain',
    });
    expect(stored.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.client.commands.map((command) => command.kind)).toEqual([
      'GetObject',
      'PutObject',
      'GetObject',
    ]);
    expect(
      result.client.commands.find((command) => command.kind === 'PutObject')
        ?.input.IfNoneMatch,
    ).toBe('*');
  });

  it('rejects a body or metadata whose digest does not match the key', async () => {
    const result = fixture();
    const bytes = new TextEncoder().encode('safe');
    const metadata = await result.store.put({
      scope: { projectId: 'p', runId: 'r', stepId: 's' },
      artifactId: 'log',
      version: 1,
      bytes,
      mediaType: 'text/plain',
    });
    const object = result.client.objects.get(metadata.key)!;
    object.bytes = new TextEncoder().encode('tampered');
    await expect(
      result.store.get({
        scope: { projectId: 'p', runId: 'r', stepId: 's' },
        key: metadata.key,
      }),
    ).rejects.toMatchObject({ code: 'artifact_integrity_error' });
  });

  it('stops reading when a streaming body exceeds the caller limit', async () => {
    const result = fixture();
    const metadata = await result.store.put({
      scope: { projectId: 'p', runId: 'r', stepId: 's' },
      artifactId: 'log',
      version: 1,
      bytes: new TextEncoder().encode('safe'),
      mediaType: 'text/plain',
    });
    const object = result.client.objects.get(metadata.key)!;
    object.reportedSize = 4;
    object.bytes = new TextEncoder().encode('safe-but-too-long');
    await expect(
      result.store.get({
        scope: { projectId: 'p', runId: 'r', stepId: 's' },
        key: metadata.key,
        maxBytes: 4,
      }),
    ).rejects.toMatchObject({ code: 'artifact_too_large' });
  });

  it('uses application SHA-256 metadata without R2-incompatible full-object checksum headers', async () => {
    const result = fixture();
    await result.store.put({
      scope: { projectId: 'p', runId: 'r', stepId: 's' },
      artifactId: 'log',
      version: 1,
      bytes: new TextEncoder().encode('safe'),
      mediaType: 'text/plain',
    });
    const put = result.client.commands.find(
      (command) => command.kind === 'PutObject',
    );
    expect(put?.input.ChecksumSHA256).toBeUndefined();
    expect(put?.input.Metadata).toMatchObject({
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it('bounded-reads and verifies bytes when reconciling an existing object', async () => {
    const result = fixture();
    const request = {
      scope: { projectId: 'p', runId: 'r', stepId: 's' },
      artifactId: 'log',
      version: 1,
      bytes: new TextEncoder().encode('safe'),
      mediaType: 'text/plain',
    } as const;
    const metadata = await result.store.put(request);
    result.client.objects.get(metadata.key)!.bytes = new TextEncoder().encode(
      'evil',
    );
    await expect(result.store.put(request)).rejects.toMatchObject({
      code: 'artifact_integrity_error',
    });
    expect(result.client.commands.at(-1)?.kind).toBe('GetObject');
  });

  it('aborts a stalled GetObject stream when the body deadline expires', async () => {
    const client = new FakeR2Client();
    const result = {
      client,
      ...createR2ArtifactStorageForTest({
        client,
        bucket: 'agentos-artifacts',
        now: () => new Date('2026-08-17T00:00:00.000Z'),
        timeoutMs: 100,
        retry: { attempts: 1, baseDelayMs: 0 },
      }),
    };
    const metadata = await result.store.put({
      scope: { projectId: 'p', runId: 'r', stepId: 's' },
      artifactId: 'log',
      version: 1,
      bytes: new TextEncoder().encode('safe'),
      mediaType: 'text/plain',
    });
    let destroyed = false;
    const stalled = {
      [Symbol.asyncIterator]() {
        return stalled;
      },
      next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
      destroy() {
        destroyed = true;
      },
    };
    client.bodyFactory = () => stalled;
    await expect(
      result.store.get({
        scope: { projectId: 'p', runId: 'r', stepId: 's' },
        key: metadata.key,
      }),
    ).rejects.toMatchObject({ code: 'artifact_store_unavailable' });
    expect(destroyed).toBe(true);
  });

  it('preserves a scope-bound cursor for a filtered empty manifest page', async () => {
    const client = new FakeR2Client();
    const base = createInMemoryArtifactManifestStore();
    let scannedKey: string | undefined;
    const manifest: typeof base = {
      ...base,
      async beginWrite(metadata, lease) {
        scannedKey = metadata.key;
        return base.beginWrite(metadata, lease);
      },
      async list(request) {
        if (request.after === undefined && scannedKey !== undefined)
          return { items: [], nextAfter: scannedKey };
        return base.list(request);
      },
    };
    const storage = createR2ArtifactStorageForTest({
      client,
      manifest,
      bucket: 'agentos-artifacts',
      now: () => new Date('2026-08-17T00:00:00.000Z'),
    });
    await storage.store.put({
      scope: { projectId: 'p', runId: 'r', stepId: 's' },
      artifactId: 'log',
      version: 1,
      bytes: new TextEncoder().encode('safe'),
      mediaType: 'text/plain',
    });
    const page = await storage.store.list({
      scope: { projectId: 'p', runId: 'r', stepId: 's' },
      limit: 1,
    });
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeTypeOf('string');
    await expect(
      storage.store.list({
        scope: { projectId: 'p', runId: 'r', stepId: 's' },
        artifactPrefix: 'other',
        limit: 1,
        cursor: page.nextCursor!,
      }),
    ).rejects.toThrow(/cursor/i);
  });
});
