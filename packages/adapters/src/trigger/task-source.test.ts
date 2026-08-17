import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('Trigger task registration', () => {
  it('pins a versioned task, one retry, global concurrency, and a domain deadline', async () => {
    const taskSource = await readFile(
      resolve(process.cwd(), 'src/trigger/task.ts'),
      'utf8',
    );
    const goalTaskSource = await readFile(
      resolve(process.cwd(), 'src/trigger/goal-task.ts'),
      'utf8',
    );
    const configSource = await readFile(
      resolve(process.cwd(), '../../trigger.config.ts'),
      'utf8',
    );
    expect(taskSource).toContain("id: 'agentos-feature-workflow-v1'");
    expect(taskSource).toContain('maxAttempts: 2');
    expect(taskSource).toContain('concurrencyLimit: 1');
    expect(taskSource).toContain('maxDuration: 3_600');
    expect(taskSource).toContain('featureTaskPayloadSchema.safeParse');
    expect(taskSource).toContain('AbortTaskRunError');
    expect(taskSource).toContain('FeatureWorkflowTaskTransientError');
    expect(taskSource).toContain('context.ctx.deployment?.version');
    expect(goalTaskSource).toContain("id: 'agentos-goal-workflow-v1'");
    expect(goalTaskSource).toContain('goalTaskPayloadSchema.safeParse');
    expect(goalTaskSource).toContain('AbortTaskRunError');
    expect(goalTaskSource).toContain('GoalWorkflowTaskTransientError');
    expect(goalTaskSource).toContain('maxDuration: 3_600');
    expect(configSource).toContain('defineConfig');
    expect(configSource).toContain("runtime: 'node-22'");
    expect(configSource).toContain("dirs: ['./packages/adapters/src/trigger']");
  });
});
