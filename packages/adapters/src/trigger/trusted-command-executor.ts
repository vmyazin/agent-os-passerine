import { spawn } from 'node:child_process';

import type { JsonValue } from '@agentos/core';

import type {
  FeatureWorkflowInput,
  TrustedCommandObservation,
} from './types.js';

interface TestOnlyCommandExecutor {
  execute(input: {
    readonly workflow: FeatureWorkflowInput;
    readonly stepId: string;
    readonly command: string;
    readonly changeSet: JsonValue;
    readonly changeSetDigest: string;
  }): Promise<TrustedCommandObservation>;
}

export interface TrustedWorkspaceMaterializer {
  prepare(input: {
    readonly workflow: FeatureWorkflowInput;
    readonly stepId: string;
    readonly changeSet: JsonValue;
  }): Promise<{ readonly cwd: string; cleanup(): Promise<void> }>;
}

export interface TrustedCommandDefinition {
  readonly executable: string;
  readonly arguments: readonly string[];
}

export function createNodeTrustedCommandExecutor(options: {
  readonly materializer: TrustedWorkspaceMaterializer;
  readonly allowedCommands: Readonly<Record<string, TrustedCommandDefinition>>;
  readonly clock: () => string;
  readonly timeoutMs?: number;
}): TestOnlyCommandExecutor {
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 20 * 60_000
  )
    throw new Error('trusted command timeout is invalid');
  return Object.freeze({
    async execute(input: Parameters<TestOnlyCommandExecutor['execute']>[0]) {
      const definition = options.allowedCommands[input.command];
      if (definition === undefined)
        throw new Error('test command is not in the trusted allowlist');
      const workspace = await options.materializer.prepare({
        workflow: input.workflow,
        stepId: input.stepId,
        changeSet: input.changeSet,
      });
      const startedAt = options.clock();
      let exitCode: number;
      try {
        exitCode = await new Promise<number>((resolve, reject) => {
          const child = spawn(
            definition.executable,
            [...definition.arguments],
            {
              cwd: workspace.cwd,
              env: { PATH: process.env.PATH ?? '' },
              shell: false,
              stdio: ['ignore', 'ignore', 'ignore'],
            },
          );
          const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error('trusted test command timed out'));
          }, timeoutMs);
          timer.unref?.();
          child.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.once('exit', (code, signal) => {
            clearTimeout(timer);
            if (signal !== null)
              reject(new Error('trusted test command was terminated'));
            else resolve(code ?? 1);
          });
        });
      } finally {
        await workspace.cleanup();
      }
      return {
        runId: input.workflow.runId,
        stepId: input.stepId,
        command: input.command,
        exitCode,
        startedAt,
        completedAt: options.clock(),
        repositorySha: input.workflow.source.repositorySha,
        sourceSnapshotDigest: input.workflow.source.sourceSnapshotDigest,
        changeSetDigest: input.changeSetDigest,
        configDigest: input.workflow.digests.config,
      };
    },
  });
}
