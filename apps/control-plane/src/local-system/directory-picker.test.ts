import { describe, expect, it, vi } from 'vitest';

import {
  DirectoryPickerError,
  isLocalDirectoryPickerAvailable,
  selectLocalDirectory,
  type RunFile,
} from './directory-picker';

const localEnvironment = {
  NODE_ENV: 'development',
  AGENTOS_PUBLIC_URL: 'http://localhost:3010',
} as NodeJS.ProcessEnv;

describe('local macOS directory picker', () => {
  it('is available only for a non-production macOS localhost runtime', () => {
    expect(isLocalDirectoryPickerAvailable(localEnvironment, 'darwin')).toBe(
      true,
    );
    expect(isLocalDirectoryPickerAvailable(localEnvironment, 'linux')).toBe(
      false,
    );
    expect(
      isLocalDirectoryPickerAvailable(
        { ...localEnvironment, NODE_ENV: 'production' },
        'darwin',
      ),
    ).toBe(false);
    expect(
      isLocalDirectoryPickerAvailable(
        {
          ...localEnvironment,
          AGENTOS_PUBLIC_URL: 'https://control.example',
        },
        'darwin',
      ),
    ).toBe(false);
  });

  it('runs one fixed AppleScript and returns the selected path', async () => {
    const runFile = vi.fn<RunFile>(async () => ({
      stdout: '/Users/operator/repository with spaces\n',
      stderr: '',
    }));

    await expect(selectLocalDirectory({ runFile })).resolves.toEqual({
      status: 'selected',
      path: '/Users/operator/repository with spaces',
    });
    expect(runFile).toHaveBeenCalledOnce();
    expect(runFile).toHaveBeenCalledWith(
      '/usr/bin/osascript',
      ['-e', expect.stringContaining('choose folder')],
      expect.objectContaining({
        shell: false,
        timeout: expect.any(Number),
        maxBuffer: expect.any(Number),
      }),
    );
    expect(runFile.mock.calls[0]?.[1]?.[1]).toContain('on error number -128');
  });

  it('represents Finder cancellation without throwing', async () => {
    const runFile = vi.fn<RunFile>(async () => ({
      stdout: '\n',
      stderr: '',
    }));

    await expect(selectLocalDirectory({ runFile })).resolves.toEqual({
      status: 'cancelled',
    });
  });

  it('rejects unsafe or oversized native output', async () => {
    const unsafe = vi.fn<RunFile>(async () => ({
      stdout: '/Users/operator/repo\u0000hidden\n',
      stderr: '',
    }));
    const oversized = vi.fn<RunFile>(async () => ({
      stdout: `/${'a'.repeat(4_096)}\n`,
      stderr: '',
    }));
    const multiline = vi.fn<RunFile>(async () => ({
      stdout: '/Users/operator/repo\nsecond-line\n',
      stderr: '',
    }));

    await expect(
      selectLocalDirectory({ runFile: unsafe }),
    ).rejects.toMatchObject({
      code: 'directory_picker_invalid_output',
      status: 500,
    });
    await expect(
      selectLocalDirectory({ runFile: oversized }),
    ).rejects.toMatchObject({
      code: 'directory_picker_invalid_output',
      status: 500,
    });
    await expect(
      selectLocalDirectory({ runFile: multiline }),
    ).rejects.toMatchObject({
      code: 'directory_picker_invalid_output',
      status: 500,
    });
  });

  it('sanitizes native command failures', async () => {
    const runFile = vi.fn<RunFile>(async () => {
      throw new Error('private local stderr');
    });

    await expect(selectLocalDirectory({ runFile })).rejects.toEqual(
      new DirectoryPickerError(
        'directory_picker_failed',
        'Could not open the macOS folder picker.',
        503,
      ),
    );
  });
});
