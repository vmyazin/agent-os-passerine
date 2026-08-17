import { describe, expect, it } from 'vitest';

import { CliError, parseCommand } from './args.js';

describe('parseCommand', () => {
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
});
