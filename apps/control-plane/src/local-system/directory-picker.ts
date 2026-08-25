import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { isLocalhostBypassAllowed } from '../auth/auth';

const executeFile = promisify(execFile);
const MAX_PATH_BYTES = 4_096;
const PICKER_TIMEOUT_MS = 2 * 60_000;
const APPLE_SCRIPT = `try
  return POSIX path of (choose folder with prompt "Choose a local Git repository.")
on error number -128
  return ""
end try`;

interface RunFileOptions {
  readonly encoding: 'utf8';
  readonly maxBuffer: number;
  readonly shell: false;
  readonly timeout: number;
}

export type RunFile = (
  file: string,
  arguments_: readonly string[],
  options: RunFileOptions,
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

export type DirectoryPickerResult =
  | { readonly status: 'selected'; readonly path: string }
  | { readonly status: 'cancelled' };

export class DirectoryPickerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'DirectoryPickerError';
  }
}

export function isLocalDirectoryPickerAvailable(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'darwin' && isLocalhostBypassAllowed(environment);
}

const defaultRunFile: RunFile = async (file, arguments_, options) => {
  const result = await executeFile(file, [...arguments_], options);
  return { stdout: result.stdout, stderr: result.stderr };
};

function withoutFinalLineEnding(value: string): string {
  if (value.endsWith('\r\n')) return value.slice(0, -2);
  if (value.endsWith('\n')) return value.slice(0, -1);
  return value;
}

export async function selectLocalDirectory({
  runFile = defaultRunFile,
}: {
  readonly runFile?: RunFile;
} = {}): Promise<DirectoryPickerResult> {
  let stdout: string;
  try {
    ({ stdout } = await runFile('/usr/bin/osascript', ['-e', APPLE_SCRIPT], {
      encoding: 'utf8',
      maxBuffer: MAX_PATH_BYTES + 2,
      shell: false,
      timeout: PICKER_TIMEOUT_MS,
    }));
  } catch {
    throw new DirectoryPickerError(
      'directory_picker_failed',
      'Could not open the macOS folder picker.',
      503,
    );
  }

  const path = withoutFinalLineEnding(stdout);
  if (path === '') return { status: 'cancelled' };
  if (
    !path.startsWith('/') ||
    path.includes('\u0000') ||
    path.includes('\n') ||
    path.includes('\r') ||
    Buffer.byteLength(path, 'utf8') > MAX_PATH_BYTES
  ) {
    throw new DirectoryPickerError(
      'directory_picker_invalid_output',
      'The macOS folder picker returned an invalid path.',
      500,
    );
  }
  return { status: 'selected', path };
}
