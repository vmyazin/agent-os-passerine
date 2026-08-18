import { describe, expect, it } from 'vitest';

import { createKimiLocalAccessStore } from './access.js';

describe('createKimiLocalAccessStore', () => {
  it('round-trips staged files through resolveFile', async () => {
    const store = createKimiLocalAccessStore();
    const bytes = new TextEncoder().encode('hello world');
    const { resources } = store.stage({
      files: [{ bytes, mountPath: '/workspace/inputs/hello.txt' }],
      credentials: [],
    });
    expect(resources).toHaveLength(1);
    const resource = resources[0]!;
    expect(resource.type).toBe('file');
    expect(resource.mountPath).toBe('/workspace/inputs/hello.txt');
    expect(resource.fileId).toMatch(/^kimi-file-[0-9a-f]{32}$/);
    await expect(store.resolveFile(resource.fileId)).resolves.toEqual(bytes);
  });

  it('round-trips staged credentials through resolveCredential', async () => {
    const store = createKimiLocalAccessStore();
    const { credentialRefs } = store.stage({
      files: [],
      credentials: [{ token: 'super-secret-token' }],
    });
    expect(credentialRefs).toHaveLength(1);
    const ref = credentialRefs[0]!;
    expect(ref).toMatch(/^kimi-cred-[0-9a-f]{32}$/);
    await expect(store.resolveCredential(ref)).resolves.toBe(
      'super-secret-token',
    );
  });

  it('stages multiple files and credentials independently in one call', async () => {
    const store = createKimiLocalAccessStore();
    const { resources, credentialRefs } = store.stage({
      files: [
        { bytes: new Uint8Array([1]), mountPath: '/a' },
        { bytes: new Uint8Array([2]), mountPath: '/b' },
      ],
      credentials: [{ token: 'tok-1' }, { token: 'tok-2' }],
    });
    expect(resources).toHaveLength(2);
    expect(credentialRefs).toHaveLength(2);
    expect(new Set(resources.map((r) => r.fileId)).size).toBe(2);
    expect(new Set(credentialRefs).size).toBe(2);
    await expect(store.resolveFile(resources[0]!.fileId)).resolves.toEqual(
      new Uint8Array([1]),
    );
    await expect(store.resolveFile(resources[1]!.fileId)).resolves.toEqual(
      new Uint8Array([2]),
    );
    await expect(store.resolveCredential(credentialRefs[0]!)).resolves.toBe(
      'tok-1',
    );
    await expect(store.resolveCredential(credentialRefs[1]!)).resolves.toBe(
      'tok-2',
    );
  });

  it('rejects an unknown file id with a generic message', async () => {
    const store = createKimiLocalAccessStore();
    await expect(store.resolveFile('kimi-file-doesnotexist')).rejects.toThrow(
      /unknown kimi local file reference/,
    );
  });

  it('rejects an unknown credential ref with a generic message that never embeds the token', async () => {
    const store = createKimiLocalAccessStore();
    const { credentialRefs } = store.stage({
      files: [],
      credentials: [{ token: 'top-secret-do-not-leak' }],
    });
    const knownRef = credentialRefs[0]!;
    store.discard({ fileIds: [], credentialRefs: [knownRef] });
    const error = await store
      .resolveCredential(knownRef)
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/unknown kimi local credential reference/);
    expect(String(error)).not.toMatch(/top-secret-do-not-leak/);
  });

  it('discard removes staged files so resolveFile subsequently rejects', async () => {
    const store = createKimiLocalAccessStore();
    const { resources } = store.stage({
      files: [{ bytes: new Uint8Array([9]), mountPath: '/x' }],
      credentials: [],
    });
    const fileId = resources[0]!.fileId;
    await expect(store.resolveFile(fileId)).resolves.toEqual(
      new Uint8Array([9]),
    );
    store.discard({ fileIds: [fileId], credentialRefs: [] });
    await expect(store.resolveFile(fileId)).rejects.toThrow(
      /unknown kimi local file reference/,
    );
  });

  it('discard removes staged credentials so resolveCredential subsequently rejects', async () => {
    const store = createKimiLocalAccessStore();
    const { credentialRefs } = store.stage({
      files: [],
      credentials: [{ token: 'discard-me' }],
    });
    const ref = credentialRefs[0]!;
    await expect(store.resolveCredential(ref)).resolves.toBe('discard-me');
    store.discard({ fileIds: [], credentialRefs: [ref] });
    await expect(store.resolveCredential(ref)).rejects.toThrow(
      /unknown kimi local credential reference/,
    );
  });
});
