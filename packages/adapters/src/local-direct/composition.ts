import * as path from 'node:path';

import {
  createArtifactCapabilityVerifier,
  type ArtifactCapabilityKey,
} from '@agentos/core';

import { createFilesystemArtifactStorage } from '../artifacts/filesystem.js';
import { createDomainArtifactManifestStore } from '../artifacts/manifest.js';
import { createArtifactMcpHandler } from '../artifacts/mcp.js';
import { createDomainArtifactCapabilityQuotaStore } from '../artifacts/quota.js';
import { createNeonDomainRepositoryFromEnv } from '../persistence/neon-repository.js';
import { createProductionFeatureWorkflowFromEnv } from '../trigger/production-handler.js';
import type { FeatureWorkflowTaskHandler } from '../trigger/types.js';
import { createLocalApprovalWaiter } from './approval-waiter.js';

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Origin the in-process artifact MCP answers on. It is never bound to a
 * socket: the value exists because sessions record the MCP endpoint they were
 * given, and because the handler validates its allow-list at construction. A
 * loopback origin is the honest description of a call that never leaves the
 * process, and it is the only non-HTTPS form the handler accepts.
 */
const LOCAL_ARTIFACT_MCP_ORIGIN = 'http://127.0.0.1';
const LOCAL_ARTIFACT_MCP_URL = `${LOCAL_ARTIFACT_MCP_ORIGIN}/api/mcp/artifacts`;

/** Variables the local executor needs beyond what both executors share. */
const LOCAL_DIRECT_VARIABLES = [
  'AGENTOS_LOCAL_STATE_DIR',
  'AGENTOS_LOCAL_WORKSPACES_ROOT',
  'AGENTOS_RUNTIME_OWNERSHIP_SECRET',
  'AGENTOS_RUNTIME_HANDLE_KEY',
  'AGENTOS_TRUSTED_TEST_COMMANDS_JSON',
  'AGENTOS_VERIFICATION_REGISTRY_HOSTS_JSON',
  'AGENTOS_TEST_REPORT_KEYS_JSON',
  'ARTIFACT_CAPABILITY_KEYS_JSON',
  'GITHUB_PUBLICATION_KEYS_JSON',
  'DATABASE_URL',
] as const;

export class LocalDirectCompositionError extends Error {
  override readonly name = 'LocalDirectCompositionError';
}

function requiredValue(environment: Environment, name: string): string {
  const value = environment[name];
  if (value === undefined || value.trim() === '')
    throw new LocalDirectCompositionError(
      `${name} is required by the local-direct executor`,
    );
  return value;
}

/**
 * Reports every missing variable at once. Discovering them one restart at a
 * time is the slowest possible way to configure an executor, and this one is
 * meant to be set up in a single sitting.
 */
export function missingLocalDirectVariables(
  environment: Environment,
): readonly string[] {
  const missing = LOCAL_DIRECT_VARIABLES.filter((name) => {
    const value = environment[name];
    return value === undefined || value.trim() === '';
  });
  const anthropic = environment.ANTHROPIC_API_KEY?.trim();
  const kimi = environment.KIMI_API_KEY?.trim();
  return anthropic || kimi
    ? missing
    : [...missing, 'ANTHROPIC_API_KEY or KIMI_API_KEY'];
}

function capabilityKeys(environment: Environment): ArtifactCapabilityKey[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      requiredValue(environment, 'ARTIFACT_CAPABILITY_KEYS_JSON'),
    );
  } catch {
    throw new LocalDirectCompositionError(
      'ARTIFACT_CAPABILITY_KEYS_JSON must contain valid JSON',
    );
  }
  if (!Array.isArray(parsed) || parsed.length < 1)
    throw new LocalDirectCompositionError(
      'ARTIFACT_CAPABILITY_KEYS_JSON must contain at least one key',
    );
  return parsed as ArtifactCapabilityKey[];
}

/**
 * The feature workflow, composed to run entirely in this process.
 *
 * Everything the deployed executor reaches over a network — Trigger.dev,
 * Managed Agents, the artifact MCP tunnel, R2 — is replaced by a local
 * equivalent behind the same port. Everything that decides whether a change
 * is safe — role isolation, budget admission, the sealed acceptance tests,
 * the signed test report, the publication authority — is the deployed code,
 * unchanged, because it is the same composition with a different profile.
 *
 * Postgres is still authoritative; only the coordination and execution edges
 * move.
 */
export async function createLocalDirectFeatureWorkflowFromEnv(
  environment: Environment,
): Promise<FeatureWorkflowTaskHandler> {
  const missing = missingLocalDirectVariables(environment);
  if (missing.length > 0)
    throw new LocalDirectCompositionError(
      `the local-direct executor is not configured: set ${missing.join(', ')}`,
    );

  const stateDirectory = requiredValue(environment, 'AGENTOS_LOCAL_STATE_DIR');
  if (!path.isAbsolute(stateDirectory))
    throw new LocalDirectCompositionError(
      'AGENTOS_LOCAL_STATE_DIR must be an absolute path',
    );
  const artifactRoot = path.join(stateDirectory, 'artifacts');
  const sandboxRoot =
    environment.AGENTOS_KIMI_SANDBOX_ROOT?.trim() ||
    path.join(stateDirectory, 'sandboxes');

  const repository = createNeonDomainRepositoryFromEnv(environment);
  const keys = capabilityKeys(environment);
  // Deliberately a second store instance over the same root and the same
  // database-backed manifest as the workflow's own: the manifest is the
  // authority for what exists, so the two agree by construction.
  const mcpStore = createFilesystemArtifactStorage({
    root: artifactRoot,
    manifest: createDomainArtifactManifestStore(repository),
    cursorKeys: keys,
  }).store;
  const mcp = createArtifactMcpHandler({
    store: mcpStore,
    quotaStore: createDomainArtifactCapabilityQuotaStore(repository),
    capabilityVerifier: createArtifactCapabilityVerifier({ keys }),
    audience: 'artifact-mcp',
    allowedOrigins: [LOCAL_ARTIFACT_MCP_ORIGIN],
  });

  return createProductionFeatureWorkflowFromEnv(environment, {
    kind: 'local-direct',
    artifactRoot,
    sandboxRoot,
    approval: createLocalApprovalWaiter({ repository }),
    artifactMcpUrl: LOCAL_ARTIFACT_MCP_URL,
    // The session's artifact tools call this instead of the network. The
    // request still carries its capability token and is still verified by the
    // same handler, so the capability boundary is unchanged; only the
    // transport is a function call.
    artifactMcpFetch: (async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(String(input), init);
      return mcp(request);
    }) as typeof fetch,
  });
}
