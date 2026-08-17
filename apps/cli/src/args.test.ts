import { describe, expect, it } from 'vitest';

import { CliError, parseCommand } from './args.js';

describe('parseCommand', () => {
  const runFlags = [
    '--project-id',
    'project_1',
    '--title',
    'Ship',
    '--description',
    'Ship it safely',
    '--repository-sha',
    'a'.repeat(40),
    '--config-digest',
    'config',
    '--model-digest',
    'model',
    '--prompt-digest',
    'prompt',
    '--environment-digest',
    'environment',
    '--policy-digest',
    'policy',
    '--idempotency-key',
    'run-key',
  ];

  it('parses every supported command and global JSON mode', () => {
    expect(parseCommand(['--json', 'runs', 'show', 'run_1'])).toMatchObject({
      kind: 'runs.show',
      id: 'run_1',
      json: true,
    });
    expect(parseCommand(['config', 'validate'])).toMatchObject({
      kind: 'config.validate',
      config: 'agentos/agent-os.yaml',
    });
    expect(parseCommand(['init', '--force'])).toMatchObject({
      kind: 'init',
      force: true,
    });
  });

  it('requires mutation idempotency keys and approval scope hashes', () => {
    expect(() => parseCommand(['runs', 'cancel', 'run_1'])).toThrow(
      'requires --idempotency-key',
    );
    expect(() =>
      parseCommand([
        'inbox',
        'approve',
        'approval_1',
        '--idempotency-key',
        'approve-1',
      ]),
    ).toThrow('requires --scope-hash');
  });

  it('rejects unknown flags, unexpected positionals, and ambiguous reply input', () => {
    for (const argv of [
      ['runs', 'list', '--unknown'],
      ['runs', 'list', 'extra'],
      ['inbox', 'reply', 'msg_1', '--reply', 'yes', '--file', 'reply.txt'],
    ]) {
      expect(() => parseCommand(argv)).toThrow(CliError);
    }
  });

  it('supports help and version without requiring a command', () => {
    expect(parseCommand(['--help'])).toMatchObject({ kind: 'help' });
    expect(parseCommand(['--version'])).toMatchObject({ kind: 'version' });
  });

  it.each([
    [['init'], 'init'],
    [['config', 'validate'], 'config.validate'],
    [['config', 'plan'], 'config.plan'],
    [['config', 'apply', '--idempotency-key', 'apply-key'], 'config.apply'],
    [['feature', 'start', ...runFlags], 'feature.start'],
    [['goal', 'start', ...runFlags], 'goal.start'],
    [['runs', 'list'], 'runs.list'],
    [['runs', 'show', 'run_1'], 'runs.show'],
    [
      ['runs', 'cancel', 'run_1', '--idempotency-key', 'cancel-key'],
      'runs.cancel',
    ],
    [['inbox', 'list'], 'inbox.list'],
    [
      [
        'inbox',
        'reply',
        'message_1',
        '--reply',
        'yes',
        '--idempotency-key',
        'reply-key',
      ],
      'inbox.reply',
    ],
    [
      [
        'inbox',
        'approve',
        'approval_1',
        '--scope-hash',
        'scope',
        '--idempotency-key',
        'approve-key',
      ],
      'inbox.approve',
    ],
    [
      [
        'inbox',
        'reject',
        'approval_1',
        '--scope-hash',
        'scope',
        '--idempotency-key',
        'reject-key',
      ],
      'inbox.reject',
    ],
  ] as const)('parses command %s', (argv, kind) => {
    expect(parseCommand(argv)).toMatchObject({ kind });
  });

  it.each([
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
  ])('requires --%s for feature and goal start', (missing) => {
    const index = runFlags.indexOf(`--${missing}`);
    const incomplete = runFlags.filter(
      (_value, position) => position !== index && position !== index + 1,
    );
    for (const group of ['feature', 'goal']) {
      expect(() => parseCommand([group, 'start', ...incomplete])).toThrow(
        `requires --${missing}`,
      );
    }
  });

  it.each([
    ['config apply', ['config', 'apply'], 'idempotency-key'],
    ['runs cancel', ['runs', 'cancel', 'run_1'], 'idempotency-key'],
    [
      'inbox reply',
      ['inbox', 'reply', 'message_1', '--reply', 'yes'],
      'idempotency-key',
    ],
    [
      'inbox approve scope',
      ['inbox', 'approve', 'approval_1', '--idempotency-key', 'key'],
      'scope-hash',
    ],
    [
      'inbox approve key',
      ['inbox', 'approve', 'approval_1', '--scope-hash', 'scope'],
      'idempotency-key',
    ],
    [
      'inbox reject scope',
      ['inbox', 'reject', 'approval_1', '--idempotency-key', 'key'],
      'scope-hash',
    ],
    [
      'inbox reject key',
      ['inbox', 'reject', 'approval_1', '--scope-hash', 'scope'],
      'idempotency-key',
    ],
  ] as const)('rejects missing required flag for %s', (_label, argv, flag) => {
    expect(() => parseCommand(argv)).toThrow(`requires --${flag}`);
  });
});
