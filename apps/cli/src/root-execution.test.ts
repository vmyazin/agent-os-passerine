import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const workspaceRoot = resolve(import.meta.dirname, '../../..');

describe('root CLI execution', () => {
  it.each([
    ['--help', 'Agent OS CLI'],
    ['--version', '0.0.0'],
  ])(
    'runs pnpm agentos %s from the workspace root',
    async (flag, output) => {
      const result = await execute('pnpm', ['agentos', flag], {
        cwd: workspaceRoot,
        timeout: 30_000,
      });

      expect(result.stdout).toContain(output);
    },
    // This spawns pnpm, which resolves the workspace and may build the CLI
    // first. Vitest's 5s default is shorter than the 30s the subprocess is
    // allowed, so under load the test failed while the command it is
    // testing was still working -- a red suite that says nothing about the
    // code. Give the assertion the same budget as the process it waits on.
    35_000,
  );
});
