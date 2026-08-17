import { open } from 'node:fs/promises';

import { loadAgentOsConfig, planConfigChange } from '@agentos/core';

import { ApiClient, ApiError } from './api-client.js';
import { CliError, parseCommand } from './args.js';
import { executeRemoteCommand } from './commands.js';
import { initConfiguration, readConfiguration } from './config-files.js';
import { renderResult } from './output.js';
import type { ApiRequest, Command } from './types.js';
import { resolveConfigurationPath } from './workspace.js';

export const VERSION = '0.0.0';
export const MAX_INPUT_BYTES = 64 * 1024;

export const HELP_TEXT = `Agent OS CLI

Usage:
  agentos init [--config PATH] [--force]
  agentos config validate|plan [--config PATH]
  agentos config apply [--config PATH] --idempotency-key KEY
  agentos feature start --project-id ID --title TEXT --description TEXT --repository-sha SHA --config-digest DIGEST --model-digest DIGEST --prompt-digest DIGEST --environment-digest DIGEST --policy-digest DIGEST --idempotency-key KEY
  agentos goal start --project-id ID --title TEXT --description TEXT --repository-sha SHA --config-digest DIGEST --model-digest DIGEST --prompt-digest DIGEST --environment-digest DIGEST --policy-digest DIGEST --criteria-json JSON --idempotency-key KEY
  agentos goal show ID
  agentos runs list
  agentos runs show ID
  agentos runs cancel ID --idempotency-key KEY
  agentos inbox list
  agentos inbox reply ID (--reply TEXT | --file PATH | stdin) --idempotency-key KEY
  agentos inbox approve ID --scope-hash HASH --idempotency-key KEY
  agentos inbox reject ID --scope-hash HASH --idempotency-key KEY

Global options:
  --url URL       Control-plane URL (or AGENTOS_URL)
  --token TOKEN   API token (or AGENTOS_API_TOKEN)
  --json          Stable machine-readable output
  -h, --help      Show help
  -V, --version   Show version
`;

export interface CliIo {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
  readonly env: NodeJS.ProcessEnv;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly readStdin: () => Promise<string>;
  readonly cwd?: string | undefined;
}

function connection(command: Command, io: CliIo): ApiClient {
  const url = command.url ?? io.env.AGENTOS_URL?.trim();
  const token = command.token ?? io.env.AGENTOS_API_TOKEN;
  if (!url)
    throw new CliError(
      'Agent OS URL is required; set AGENTOS_URL or use --url',
    );
  if (!token)
    throw new CliError(
      'Agent OS API token is required; set AGENTOS_API_TOKEN or use --token',
    );
  return new ApiClient({
    url,
    token,
    ...(io.fetch === undefined ? {} : { fetch: io.fetch }),
  });
}

function remote(client: ApiClient) {
  return {
    request: (request: ApiRequest) =>
      client.request(
        request.method,
        request.path,
        request.body,
        request.idempotencyKey,
      ),
  };
}

async function boundedFile(path: string): Promise<string> {
  let handle;
  try {
    handle = await open(path, 'r');
    const info = await handle.stat();
    if (!info.isFile()) throw new CliError(`reply path is not a file: ${path}`);
    if (info.size > MAX_INPUT_BYTES)
      throw new CliError('reply input is too large');
    const chunks: Buffer[] = [];
    let received = 0;
    while (received <= MAX_INPUT_BYTES) {
      const chunk = Buffer.allocUnsafe(
        Math.min(8 * 1024, MAX_INPUT_BYTES + 1 - received),
      );
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, received);
      if (bytesRead === 0) break;
      received += bytesRead;
      chunks.push(chunk.subarray(0, bytesRead));
    }
    if (received > MAX_INPUT_BYTES)
      throw new CliError('reply input is too large');
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks, received),
    );
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`reply file cannot be read: ${path}`);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function boundedReply(value: string): string {
  if (Buffer.byteLength(value) > MAX_INPUT_BYTES)
    throw new CliError('reply input is too large');
  const reply = value.trim();
  if (!reply)
    throw new CliError(
      'inbox reply requires --reply, --file, or non-empty stdin',
    );
  return reply;
}

function activeConfiguration(value: unknown): {
  readonly canonicalConfig: string;
  readonly digest: string;
  readonly revision: number;
} | null {
  if (value === null || typeof value !== 'object' || !('active' in value)) {
    throw new ApiError('server returned an invalid configuration projection');
  }
  const active = (value as { active: unknown }).active;
  if (active === null) return null;
  if (
    typeof active !== 'object' ||
    active === null ||
    typeof (active as { canonicalConfig?: unknown }).canonicalConfig !==
      'string' ||
    typeof (active as { digest?: unknown }).digest !== 'string' ||
    typeof (active as { revision?: unknown }).revision !== 'number'
  ) {
    throw new ApiError('server returned an invalid configuration projection');
  }
  return active as {
    canonicalConfig: string;
    digest: string;
    revision: number;
  };
}

async function execute(command: Command, io: CliIo): Promise<unknown> {
  switch (command.kind) {
    case 'help':
      return undefined;
    case 'version':
      return undefined;
    case 'init':
      return initConfiguration(
        await resolveConfigurationPath(command.config, io.cwd ?? process.cwd()),
        command.force,
      );
    case 'config.validate': {
      const path = await resolveConfigurationPath(
        command.config,
        io.cwd ?? process.cwd(),
      );
      const loaded = await readConfiguration(path);
      return { valid: true, path, digest: loaded.digest };
    }
    case 'config.plan': {
      const path = await resolveConfigurationPath(
        command.config,
        io.cwd ?? process.cwd(),
      );
      const [loaded, currentValue] = await Promise.all([
        readConfiguration(path),
        remote(connection(command, io)).request({
          method: 'GET',
          path: '/api/configuration',
        }),
      ]);
      const current = activeConfiguration(currentValue);
      if (current === null) {
        return {
          changed: true,
          fromHash: null,
          toHash: loaded.digest,
          changes: [{ kind: 'added', path: '$', after: loaded.config }],
        };
      }
      return planConfigChange(
        loadAgentOsConfig(current.canonicalConfig),
        loaded.config,
      );
    }
    case 'config.apply': {
      const path = await resolveConfigurationPath(
        command.config,
        io.cwd ?? process.cwd(),
      );
      const loaded = await readConfiguration(path);
      const client = remote(connection(command, io));
      const current = activeConfiguration(
        await client.request({ method: 'GET', path: '/api/configuration' }),
      );
      return client.request({
        method: 'POST',
        path: '/api/configuration/apply',
        body: {
          canonicalConfig: loaded.canonical,
          digest: loaded.digest,
          expectedRevision: current?.revision ?? null,
          expectedDigest: current?.digest ?? null,
        },
        idempotencyKey: command.idempotencyKey,
      });
    }
    case 'inbox.reply': {
      const raw =
        command.reply ??
        (command.file === undefined
          ? await io.readStdin()
          : await boundedFile(command.file));
      return executeRemoteCommand(
        { ...command, reply: boundedReply(raw) },
        remote(connection(command, io)),
      );
    }
    default:
      return executeRemoteCommand(command, remote(connection(command, io)));
  }
}

function errorCode(error: unknown): string {
  if (error instanceof ApiError && error.code) return error.code;
  if (error instanceof CliError)
    return error.exitCode === 2 ? 'usage_error' : 'request_error';
  return 'internal_error';
}

export async function runCli(
  argv: readonly string[],
  io: CliIo,
): Promise<number> {
  let command: Command | undefined;
  try {
    command = parseCommand(argv);
    if (command.kind === 'help') {
      io.stdout(HELP_TEXT);
      return 0;
    }
    if (command.kind === 'version') {
      io.stdout(`agentos ${VERSION}\n`);
      return 0;
    }
    const result = await execute(command, io);
    io.stdout(renderResult(result, command.json));
    return 0;
  } catch (error) {
    const safe =
      error instanceof Error ? error.message : 'an unexpected error occurred';
    const exitCode = error instanceof CliError ? error.exitCode : 1;
    if (command?.json === true || argv.includes('--json')) {
      io.stderr(
        renderResult(
          { error: { code: errorCode(error), message: safe } },
          true,
        ),
      );
    } else {
      io.stderr(`Error: ${safe}\n`);
    }
    return exitCode;
  }
}
