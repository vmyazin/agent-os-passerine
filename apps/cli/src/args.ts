import { parseArgs } from 'node:util';

import type {
  Command,
  GlobalOptions,
  GoalCommandCriterion,
  RunStartOptions,
} from './types.js';

export const EXIT_USAGE = 2;

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = EXIT_USAGE,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

const DEFAULT_CONFIG = 'agentos/agent-os.yaml';
const stringFlags = [
  'url',
  'token',
  'config',
  'project-id',
  'title',
  'description',
  'repository-sha',
  'config-digest',
  'model-digest',
  'prompt-digest',
  'environment-digest',
  'policy-digest',
  'idempotency-key',
  'criteria-json',
  'scope-hash',
  'reply',
  'file',
] as const;

type FlagName =
  (typeof stringFlags)[number] | 'json' | 'force' | 'help' | 'version';

function required(
  values: Record<string, string | boolean | undefined>,
  name: string,
  command: string,
  max = 10_000,
): string {
  const value = values[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CliError(`${command} requires --${name}`);
  }
  if (Buffer.byteLength(value) > max) {
    throw new CliError(`--${name} is too long`);
  }
  return value.trim();
}

function assertId(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new CliError(`${label} is invalid`);
  }
  return value;
}

function assertAllowed(
  values: Record<string, string | boolean | undefined>,
  allowed: readonly FlagName[],
): void {
  const base = new Set<FlagName>([
    'json',
    'url',
    'token',
    'help',
    'version',
    ...allowed,
  ]);
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined && !base.has(name as FlagName)) {
      throw new CliError(`--${name} is not valid for this command`);
    }
  }
}

function globals(
  values: Record<string, string | boolean | undefined>,
): GlobalOptions {
  const url = values.url;
  const token = values.token;
  return {
    json: values.json === true,
    ...(typeof url === 'string' ? { url } : {}),
    ...(typeof token === 'string' ? { token } : {}),
  };
}

function exactPositionals(
  actual: readonly string[],
  expected: readonly string[],
): void {
  if (
    actual.length !== expected.length ||
    actual.some((item, index) => item !== expected[index])
  ) {
    throw new CliError(`unknown command: ${actual.join(' ') || '(none)'}`);
  }
}

function runStart(
  values: Record<string, string | boolean | undefined>,
  kind: 'feature.start' | 'goal.start',
): Extract<Command, { kind: 'feature.start' | 'goal.start' }> {
  const label = kind.replace('.', ' ');
  assertAllowed(values, [
    'project-id',
    'title',
    'description',
    'repository-sha',
    'config-digest',
    'model-digest',
    'prompt-digest',
    'environment-digest',
    'policy-digest',
    'idempotency-key',
    ...(kind === 'goal.start' ? (['criteria-json'] as const) : []),
  ]);
  const repositorySha = required(values, 'repository-sha', label, 40);
  if (!/^[a-f0-9]{40}$/i.test(repositorySha)) {
    throw new CliError(
      '--repository-sha must be a 40-character hexadecimal SHA',
    );
  }
  const base: RunStartOptions = {
    ...globals(values),
    projectId: assertId(
      required(values, 'project-id', label, 128),
      'project id',
    ),
    title: required(values, 'title', label, 200),
    description: required(values, 'description', label),
    repositorySha,
    configDigest: required(values, 'config-digest', label, 256),
    modelDigest: required(values, 'model-digest', label, 256),
    promptDigest: required(values, 'prompt-digest', label, 256),
    environmentDigest: required(values, 'environment-digest', label, 256),
    policyDigest: required(values, 'policy-digest', label, 256),
    idempotencyKey: required(values, 'idempotency-key', label, 200),
  };
  return kind === 'goal.start'
    ? {
        kind,
        ...base,
        criteria: parseGoalCriteria(
          required(values, 'criteria-json', label, 64 * 1_024),
        ),
      }
    : { kind, ...base };
}

function parseGoalCriteria(value: string): readonly GoalCommandCriterion[] {
  const invalid = () => {
    throw new CliError(
      '--criteria-json must be a JSON array of 1 to 20 strict command criteria',
    );
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return invalid();
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 20)
    return invalid();
  const allowed = new Set(['id', 'type', 'description', 'required', 'command']);
  const ids = new Set<string>();
  return parsed.map((candidate): GoalCommandCriterion => {
    if (
      candidate === null ||
      typeof candidate !== 'object' ||
      Array.isArray(candidate)
    )
      return invalid();
    const source = candidate as Record<string, unknown>;
    if (Object.keys(source).some((key) => !allowed.has(key))) return invalid();
    if (
      source.type !== 'command' ||
      typeof source.id !== 'string' ||
      source.id.trim().length < 1 ||
      source.id.length > 128 ||
      ids.has(source.id) ||
      typeof source.description !== 'string' ||
      source.description.trim().length < 1 ||
      source.description.length > 1_000 ||
      typeof source.command !== 'string' ||
      source.command.trim().length < 1 ||
      source.command.length > 10_000 ||
      (source.required !== undefined && typeof source.required !== 'boolean')
    )
      return invalid();
    ids.add(source.id);
    return {
      id: source.id,
      type: 'command',
      description: source.description,
      command: source.command,
      ...(source.required === undefined
        ? {}
        : { required: source.required as boolean }),
    };
  });
}

export function parseCommand(argv: readonly string[]): Command {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'V' },
        json: { type: 'boolean' },
        force: { type: 'boolean' },
        ...Object.fromEntries(
          stringFlags.map((name) => [name, { type: 'string' as const }]),
        ),
      },
    });
  } catch (error) {
    throw new CliError(
      error instanceof Error ? error.message : 'invalid arguments',
    );
  }
  const values = parsed.values as Record<string, string | boolean | undefined>;
  if (values.help === true) return { kind: 'help', ...globals(values) };
  if (values.version === true) return { kind: 'version', ...globals(values) };
  const positionals = parsed.positionals;
  const [group, action, id] = positionals;

  if (group === 'init') {
    exactPositionals(positionals, ['init']);
    assertAllowed(values, ['config', 'force']);
    return {
      kind: 'init',
      ...globals(values),
      config:
        typeof values.config === 'string' ? values.config : DEFAULT_CONFIG,
      force: values.force === true,
    };
  }
  if (group === 'config' && (action === 'validate' || action === 'plan')) {
    exactPositionals(positionals, ['config', action]);
    assertAllowed(values, ['config']);
    return {
      kind: `config.${action}`,
      ...globals(values),
      config:
        typeof values.config === 'string' ? values.config : DEFAULT_CONFIG,
    };
  }
  if (group === 'config' && action === 'apply') {
    exactPositionals(positionals, ['config', 'apply']);
    assertAllowed(values, ['config', 'idempotency-key']);
    return {
      kind: 'config.apply',
      ...globals(values),
      config:
        typeof values.config === 'string' ? values.config : DEFAULT_CONFIG,
      idempotencyKey: required(values, 'idempotency-key', 'config apply', 200),
    };
  }
  if (group === 'feature' && action === 'start') {
    exactPositionals(positionals, ['feature', 'start']);
    return runStart(values, 'feature.start');
  }
  if (group === 'goal' && action === 'start') {
    exactPositionals(positionals, ['goal', 'start']);
    return runStart(values, 'goal.start');
  }
  if (group === 'goal' && action === 'show' && id !== undefined) {
    exactPositionals(positionals, ['goal', 'show', id]);
    assertAllowed(values, []);
    return {
      kind: 'goal.show',
      ...globals(values),
      id: assertId(id, 'run id'),
    };
  }
  if (group === 'runs' && action === 'list') {
    exactPositionals(positionals, ['runs', 'list']);
    assertAllowed(values, []);
    return { kind: 'runs.list', ...globals(values) };
  }
  if (group === 'runs' && action === 'show' && id !== undefined) {
    exactPositionals(positionals, ['runs', 'show', id]);
    assertAllowed(values, []);
    return {
      kind: 'runs.show',
      ...globals(values),
      id: assertId(id, 'run id'),
    };
  }
  if (group === 'runs' && action === 'cancel' && id !== undefined) {
    exactPositionals(positionals, ['runs', 'cancel', id]);
    assertAllowed(values, ['idempotency-key']);
    return {
      kind: 'runs.cancel',
      ...globals(values),
      id: assertId(id, 'run id'),
      idempotencyKey: required(values, 'idempotency-key', 'runs cancel', 200),
    };
  }
  if (group === 'inbox' && action === 'list') {
    exactPositionals(positionals, ['inbox', 'list']);
    assertAllowed(values, []);
    return { kind: 'inbox.list', ...globals(values) };
  }
  if (group === 'inbox' && action === 'reply' && id !== undefined) {
    exactPositionals(positionals, ['inbox', 'reply', id]);
    assertAllowed(values, ['reply', 'file', 'idempotency-key']);
    if (typeof values.reply === 'string' && typeof values.file === 'string') {
      throw new CliError('inbox reply accepts only one of --reply or --file');
    }
    return {
      kind: 'inbox.reply',
      ...globals(values),
      id: assertId(id, 'inbox id'),
      ...(typeof values.reply === 'string' ? { reply: values.reply } : {}),
      ...(typeof values.file === 'string' ? { file: values.file } : {}),
      idempotencyKey: required(values, 'idempotency-key', 'inbox reply', 200),
    };
  }
  if (
    group === 'inbox' &&
    (action === 'approve' || action === 'reject') &&
    id !== undefined
  ) {
    exactPositionals(positionals, ['inbox', action, id]);
    assertAllowed(values, ['scope-hash', 'idempotency-key']);
    return {
      kind: `inbox.${action}`,
      ...globals(values),
      id: assertId(id, 'approval id'),
      scopeHash: required(values, 'scope-hash', `inbox ${action}`, 256),
      idempotencyKey: required(
        values,
        'idempotency-key',
        `inbox ${action}`,
        200,
      ),
    };
  }
  throw new CliError(`unknown command: ${positionals.join(' ') || '(none)'}`);
}
