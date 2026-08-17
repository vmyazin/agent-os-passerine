import {
  createArtifactMcpHandler,
  createDomainArtifactCapabilityQuotaStore,
  createDomainArtifactManifestStore,
  createR2ArtifactStore,
  type ArtifactMcpHandler,
  type R2ArtifactStorageOptions,
} from '@agentos/adapters';
import {
  createArtifactCapabilityVerifier,
  type DomainRepository,
  type ArtifactCapabilityKey,
} from '@agentos/core';
import { repositoryFromEnv } from '../persistence/repository-factory';

let handler: ArtifactMcpHandler | undefined;

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '')
    throw new Error(`${name} is required for Artifact MCP`);
  return value;
}

function capabilityKeys(): readonly ArtifactCapabilityKey[] {
  const raw = required('ARTIFACT_CAPABILITY_KEYS_JSON');
  if (Buffer.byteLength(raw, 'utf8') > 16 * 1024)
    throw new Error('ARTIFACT_CAPABILITY_KEYS_JSON is too large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('ARTIFACT_CAPABILITY_KEYS_JSON must be valid JSON');
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 5)
    throw new Error(
      'ARTIFACT_CAPABILITY_KEYS_JSON must contain one to five keys',
    );
  return parsed.map((value) => {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      typeof (value as { keyId?: unknown }).keyId !== 'string' ||
      typeof (value as { secret?: unknown }).secret !== 'string'
    )
      throw new Error('ARTIFACT_CAPABILITY_KEYS_JSON contains an invalid key');
    return {
      keyId: (value as { keyId: string }).keyId,
      secret: (value as { secret: string }).secret,
    };
  });
}

function allowedOrigins(): readonly string[] {
  const values = required('ARTIFACT_MCP_ALLOWED_ORIGINS')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');
  if (values.length < 1 || values.length > 10)
    throw new Error('ARTIFACT_MCP_ALLOWED_ORIGINS is invalid');
  return values;
}

function r2Options(repository: DomainRepository): R2ArtifactStorageOptions {
  return {
    accountId: required('CLOUDFLARE_R2_ACCOUNT_ID'),
    bucket: required('CLOUDFLARE_R2_ARTIFACT_BUCKET'),
    accessKeyId: required('CLOUDFLARE_R2_ARTIFACT_ACCESS_KEY_ID'),
    secretAccessKey: required('CLOUDFLARE_R2_ARTIFACT_SECRET_ACCESS_KEY'),
    manifest: createDomainArtifactManifestStore(repository),
    cursorKeys: capabilityKeys(),
    ...(process.env.CLOUDFLARE_R2_JURISDICTION === undefined
      ? {}
      : {
          jurisdiction: process.env.CLOUDFLARE_R2_JURISDICTION as
            'default' | 'eu' | 'fedramp',
        }),
  };
}

export function artifactMcpHandler(): ArtifactMcpHandler {
  if (handler !== undefined) return handler;
  const repository = repositoryFromEnv();
  handler = createArtifactMcpHandler({
    // This credential must be bucket-scoped to GetObject and PutObject only.
    // Deletion uses a distinct control-plane administrator key.
    store: createR2ArtifactStore(r2Options(repository)),
    quotaStore: createDomainArtifactCapabilityQuotaStore(repository),
    capabilityVerifier: createArtifactCapabilityVerifier({
      keys: capabilityKeys(),
    }),
    audience: 'artifact-mcp',
    allowedOrigins: allowedOrigins(),
  });
  return handler;
}

export function setArtifactMcpHandlerForTests(
  replacement: ArtifactMcpHandler | undefined,
): void {
  if (process.env.NODE_ENV !== 'test')
    throw new Error('Artifact MCP test override is only available in tests');
  handler = replacement;
}
