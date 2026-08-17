import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { artifactStoreContract } from './artifact-store-contract.js';
import {
  createR2ArtifactStorageForTest,
  type R2Command,
  type R2SdkClient,
} from './test-support.js';

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

  async send(command: R2Command): Promise<Record<string, unknown>> {
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
      case 'HeadObject': {
        const value = this.objects.get(key);
        if (!value)
          throw Object.assign(new Error('missing'), { name: 'NotFound' });
        return {
          ContentLength: value.reportedSize ?? value.bytes.byteLength,
          ContentType: value.contentType,
          Metadata: value.metadata,
        };
      }
      case 'PutObject': {
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
          Body: Readable.from([value.bytes]),
          ContentLength: value.reportedSize ?? value.bytes.byteLength,
          ContentType: value.contentType,
          Metadata: value.metadata,
          ETag: 'untrusted',
        };
      }
      case 'ListObjectsV2': {
        const prefix = String(input.Prefix ?? '');
        const after = String(input.StartAfter ?? '');
        const max = Number(input.MaxKeys ?? 100);
        const keys = [...this.objects.keys()]
          .filter(
            (candidate) => candidate.startsWith(prefix) && candidate > after,
          )
          .sort();
        const page = keys.slice(0, max);
        return {
          Contents: page.map((Key) => ({ Key })),
          IsTruncated: keys.length > page.length,
          NextContinuationToken:
            keys.length > page.length
              ? Buffer.from(page.at(-1) ?? '').toString('base64url')
              : undefined,
        };
      }
      case 'DeleteObject':
        this.objects.delete(key);
        return {};
    }
  }
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
  it('fails closed on invalid Cloudflare R2 configuration', async () => {
    const { createR2ArtifactStore } = await import('./r2.js');
    expect(() =>
      createR2ArtifactStore({
        accountId: '',
        bucket: 'bucket',
        accessKeyId: 'key',
        secretAccessKey: 'secret',
      }),
    ).toThrow(/account/i);
    expect(() =>
      createR2ArtifactStore({
        accountId: 'account',
        bucket: 'bucket',
        accessKeyId: 'key',
        secretAccessKey: 'secret',
        endpoint: 'http://example.com',
      }),
    ).toThrow(/HTTPS/i);
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
      result.store.list({ scope: { projectId: 'p', runId: 'r', stepId: 's' } }),
    ).rejects.toMatchObject({
      code: 'artifact_store_unavailable',
      message: 'artifact storage is unavailable',
    });
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
      'HeadObject',
      'PutObject',
      'HeadObject',
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

  it('uses SHA-256 checksums and never treats an ETag as the digest', async () => {
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
    expect(put?.input.ChecksumSHA256).toBeTypeOf('string');
    expect(put?.input.Metadata).toMatchObject({
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });
});
