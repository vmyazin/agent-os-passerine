import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

/**
 * Refuses a Definition of Done whose acceptance tests cannot run.
 *
 * These files are the gate: trusted code overlays them onto the change set
 * and runs them, and the operator approves them before any implementation is
 * paid for. A file that cannot even parse fails every implementation,
 * including a correct one -- twice now it has, once on an import attribute
 * Node removed and once on a path that escaped the repository. Both were
 * discovered after a full run had been paid for, from an exit code with no
 * output.
 *
 * `node --check` parses a file and never executes it, so this is safe to run
 * on model-authored text in the trusted process, costs milliseconds, and
 * happens before the approval rather than after the implementation.
 *
 * What it cannot catch: a test that parses and then fails at runtime for its
 * own reasons. Those are still only visible at verification, which is why the
 * observed command now carries its output.
 */

const CHECK_TIMEOUT_MS = 10_000;
const MAX_REPORTED_TESTS = 5;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/g;

export interface AcceptanceTestFile {
  readonly path: string;
  readonly content: string;
}

export class AcceptanceTestSyntaxError extends Error {
  override readonly name = 'AcceptanceTestSyntaxError';

  constructor(
    message: string,
    readonly failures: readonly {
      readonly path: string;
      readonly reason: string;
    }[],
  ) {
    super(message);
  }
}

async function parses(
  directory: string,
  file: AcceptanceTestFile,
): Promise<string | undefined> {
  // Named after the original so the reported error points at a path the
  // operator recognises, and kept flat so no test can write outside the
  // temporary directory through its own path.
  const scratch = join(directory, basename(file.path));
  await writeFile(scratch, file.content, 'utf8');
  return new Promise<string | undefined>((resolve) => {
    execFile(
      process.execPath,
      ['--check', scratch],
      { timeout: CHECK_TIMEOUT_MS },
      (error, _stdout, stderr) => {
        if (error === null) {
          resolve(undefined);
          return;
        }
        const reported = (stderr || error.message)
          .replace(new RegExp(directory, 'g'), '')
          .replace(CONTROL_CHARACTERS, ' ')
          .trim()
          .slice(0, 300);
        resolve(reported.length > 0 ? reported : 'could not be parsed');
      },
    );
  });
}

/**
 * Throws when any acceptance test fails to parse. Resolves silently when they
 * all do, including when there are none.
 */
export async function assertAcceptanceTestsParse(
  tests: readonly AcceptanceTestFile[],
): Promise<void> {
  if (tests.length === 0) return;
  const directory = await mkdtemp(join(tmpdir(), 'agentos-dod-check-'));
  try {
    const failures: { path: string; reason: string }[] = [];
    for (const file of tests) {
      const reason = await parses(directory, file);
      if (reason !== undefined) failures.push({ path: file.path, reason });
    }
    if (failures.length === 0) return;
    const detail = failures
      .slice(0, MAX_REPORTED_TESTS)
      .map((failure) => `${failure.path}: ${failure.reason}`)
      .join('; ');
    throw new AcceptanceTestSyntaxError(
      `the specification wrote ${String(failures.length)} acceptance test${
        failures.length === 1 ? '' : 's'
      } that cannot be parsed, so they would fail every implementation: ${detail}`,
      failures,
    );
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}
