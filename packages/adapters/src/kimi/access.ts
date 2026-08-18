import { randomBytes } from 'node:crypto';

import type { RuntimeFileResource } from '@agentos/core';

/**
 * Local (in-process) equivalent of the managed provider's session-access
 * upload: kimi sessions run on a local sandbox, so mounted files and
 * capability credentials never leave the process -- they're just held here
 * behind opaque ids and handed to the kimi runtime provider's
 * `resolveFile`/`artifactMcp.resolveCredential` hooks.
 */
export interface KimiLocalAccessStore {
  readonly resolveFile: (fileId: string) => Promise<Uint8Array>;
  readonly resolveCredential: (ref: string) => Promise<string>;
  stage(input: {
    readonly files: readonly {
      readonly bytes: Uint8Array;
      readonly mountPath: string;
    }[];
    readonly credentials: readonly { readonly token: string }[];
  }): {
    readonly resources: RuntimeFileResource[];
    readonly credentialRefs: string[];
  };
  discard(refs: {
    readonly fileIds: readonly string[];
    readonly credentialRefs: readonly string[];
  }): void;
}

function opaqueId(prefix: 'kimi-file' | 'kimi-cred'): string {
  return `${prefix}-${randomBytes(16).toString('hex')}`;
}

export function createKimiLocalAccessStore(): KimiLocalAccessStore {
  const files = new Map<string, Uint8Array>();
  const credentials = new Map<string, string>();

  return {
    async resolveFile(fileId: string): Promise<Uint8Array> {
      const bytes = files.get(fileId);
      if (bytes === undefined) {
        // Generic on purpose: this is the one path a resolver error could
        // otherwise echo a secret-bearing id back toward the model.
        throw new Error('unknown kimi local file reference');
      }
      return bytes;
    },
    async resolveCredential(ref: string): Promise<string> {
      const token = credentials.get(ref);
      if (token === undefined) {
        throw new Error('unknown kimi local credential reference');
      }
      return token;
    },
    stage(input) {
      const resources: RuntimeFileResource[] = input.files.map((file) => {
        const fileId = opaqueId('kimi-file');
        files.set(fileId, file.bytes);
        return { type: 'file' as const, fileId, mountPath: file.mountPath };
      });
      const credentialRefs = input.credentials.map((credential) => {
        const ref = opaqueId('kimi-cred');
        credentials.set(ref, credential.token);
        return ref;
      });
      return { resources, credentialRefs };
    },
    discard(refs) {
      for (const fileId of refs.fileIds) files.delete(fileId);
      for (const ref of refs.credentialRefs) credentials.delete(ref);
    },
  };
}
