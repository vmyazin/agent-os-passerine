import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  canonicalConfigHash,
  canonicalConfigJson,
  loadAgentOsConfig,
  MAX_AGENT_OS_CONFIG_SOURCE_BYTES,
  MAX_CANONICAL_CONFIG_BYTES,
  type AgentOsConfig,
} from '@agentos/core';

import { CliError } from './args.js';
import {
  assertTrustedConfigurationDirectories,
  findWorkspaceRoot,
} from './workspace.js';

export const MAX_CONFIG_BYTES = MAX_AGENT_OS_CONFIG_SOURCE_BYTES;

async function assertCanonicalParent(path: string): Promise<void> {
  const parent = dirname(path);
  try {
    if ((await realpath(parent)) !== parent) {
      throw new CliError('configuration path contains a symbolic link');
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`cannot inspect configuration path: ${path}`);
  }
}

async function configurationWorkspaceRoot(path: string): Promise<string> {
  let current = dirname(path);
  while (true) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new CliError(
          `configuration path contains a symbolic link: ${current}`,
        );
      }
      if (!info.isDirectory()) {
        throw new CliError(`workspace path is not a directory: ${current}`);
      }
      return await findWorkspaceRoot(current);
    } catch (error) {
      if (error instanceof CliError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new CliError(`cannot inspect configuration path: ${path}`);
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new CliError(
        'workspace root not found; run agentos inside a repository',
      );
    }
    current = parent;
  }
}

async function assertTrustedBoundary(path: string): Promise<void> {
  const root = await configurationWorkspaceRoot(path);
  await assertTrustedConfigurationDirectories(root, path);
}

export const STARTER_CONFIG = `version: 1
project:
  name: example
  defaultBranch: main
models:
  standard:
    provider: local
    model: test-model
    inputMicrodollarsPerMillionTokens: 0
    outputMicrodollarsPerMillionTokens: 0
    runtimeMicrodollarsPerMinute: 0
agents:
  implementer:
    model: standard
    environment: default
    tools: []
    mcps: []
    retries: 0
    timeoutMs: 900000
environments:
  default:
    runtime: process
    variables: {}
    tools: []
    mcps: []
pipelines:
  feature:
    steps:
      - id: implement
        agent: implementer
policies:
  protectedPaths:
    - .github/workflows/**
    - CODEOWNERS
    - '**/CODEOWNERS'
    - .gitmodules
    - .env*
    - '**/.env*'
    - agentos/**
  allowBinary: false
  allowSymlinks: false
  maxFileBytes: 1000000
  tools:
    allow: []
    deny: []
  mcp:
    allow: []
    deny: []
budgets:
  workflowMicrodollars: 1000000
  dailyMicrodollars: 10000000
  concurrency: 2
  admissionReservePercent: 80
goals:
  maxSteps: 3
  maxRetries: 2
  timeoutMs: 3600000
runtime:
  provider: local
  routing: {}
`;

async function readBounded(path: string): Promise<string> {
  let handle;
  try {
    await assertTrustedBoundary(path);
    await assertCanonicalParent(path);
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile())
      throw new CliError(`configuration is not a file: ${path}`);
    if (info.size > MAX_CONFIG_BYTES) {
      throw new CliError(
        `configuration is too large (maximum ${MAX_CONFIG_BYTES} bytes)`,
      );
    }
    const chunks: Buffer[] = [];
    let received = 0;
    while (received <= MAX_CONFIG_BYTES) {
      const chunk = Buffer.allocUnsafe(
        Math.min(8 * 1024, MAX_CONFIG_BYTES + 1 - received),
      );
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, received);
      if (bytesRead === 0) break;
      received += bytesRead;
      chunks.push(chunk.subarray(0, bytesRead));
    }
    if (received > MAX_CONFIG_BYTES) {
      throw new CliError(
        `configuration is too large (maximum ${MAX_CONFIG_BYTES} bytes)`,
      );
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks, received),
    );
  } catch (error) {
    if (error instanceof CliError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw new CliError(
      code === 'ENOENT'
        ? `configuration not found: ${path}`
        : `cannot read configuration: ${path}`,
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function formatValidationError(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'issues' in error &&
    Array.isArray((error as { issues: unknown }).issues)
  ) {
    return (
      error as { issues: { path?: PropertyKey[]; message?: string }[] }
    ).issues
      .slice(0, 10)
      .map(
        (issue) =>
          `${issue.path?.join('.') || 'configuration'}: ${issue.message || 'invalid'}`,
      )
      .join('; ');
  }
  return error instanceof Error ? error.message : 'invalid configuration';
}

export async function readConfiguration(path: string): Promise<{
  readonly config: AgentOsConfig;
  readonly canonical: string;
  readonly digest: string;
}> {
  const yaml = await readBounded(path);
  let config: AgentOsConfig;
  try {
    config = loadAgentOsConfig(yaml);
  } catch (error) {
    throw new CliError(
      `invalid configuration: ${formatValidationError(error)}`,
    );
  }
  const canonical = canonicalConfigJson(config);
  if (
    new TextEncoder().encode(canonical).byteLength > MAX_CANONICAL_CONFIG_BYTES
  ) {
    throw new CliError(
      `canonical configuration is too large (maximum ${MAX_CANONICAL_CONFIG_BYTES} bytes)`,
    );
  }
  return {
    config,
    canonical,
    digest: canonicalConfigHash(config),
  };
}

export async function initConfiguration(
  path: string,
  force: boolean,
): Promise<{ readonly created: true; readonly path: string }> {
  await assertTrustedBoundary(path);
  if (!force) {
    try {
      await stat(path);
      throw new CliError(
        `configuration already exists: ${path}; use --force to overwrite`,
      );
    } catch (error) {
      if (error instanceof CliError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new CliError(`cannot inspect configuration path: ${path}`);
      }
    }
  }
  const parent = dirname(path);
  await assertTrustedBoundary(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await assertTrustedBoundary(path);
  await assertCanonicalParent(path);
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(STARTER_CONFIG, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertTrustedBoundary(path);
    await assertCanonicalParent(path);
    if (force) {
      await rename(temporary, path);
    } else {
      await link(temporary, path);
      await unlink(temporary);
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    if (error instanceof CliError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new CliError(
        `configuration already exists: ${path}; use --force to overwrite`,
      );
    }
    throw new CliError(`could not write configuration: ${path}`);
  }
  return { created: true, path };
}
