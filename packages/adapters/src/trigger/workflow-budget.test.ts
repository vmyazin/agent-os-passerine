// packages/adapters/src/trigger/workflow-budget.test.ts
import { InMemoryDomainRepository } from '../persistence/in-memory.js';
import {
  canonicalConfigHash,
  canonicalConfigJson,
  isoTimestamp,
  loadAgentOsConfig,
  persistenceId,
} from '@agentos/core';
import { describe, expect, it } from 'vitest';

import {
  budgetLimitsForRun,
  budgetLimitsFromConfig,
  createProjectDailyUsageMicrodollars,
  deploymentDailyLimitFromEnv,
} from './workflow-budget.js';

const now = isoTimestamp('2026-08-17T12:00:00.000Z');

function budgetConfig() {
  const config = loadAgentOsConfig(`
version: 1
project: { name: demo }
models: { standard: { provider: local, model: test } }
agents: { implementer: { model: standard } }
environments: { default: { runtime: process } }
pipelines: { feature: { steps: [{ id: implement, agent: implementer }] } }
policies: {}
budgets:
  workflowMicrodollars: 999
  dailyMicrodollars: 888
  concurrency: 1
  admissionReservePercent: 50
goals: { maxSteps: 1, maxRetries: 0, timeoutMs: 1000 }
runtime: { provider: local }
`);
  return {
    config,
    configDigest: canonicalConfigHash(config),
    configJson: canonicalConfigJson(config),
  };
}

describe('workflow budget helpers', () => {
  it('reads per-project limits from config', () => {
    const { config } = budgetConfig();
    expect(budgetLimitsFromConfig(config)).toEqual({
      workflowLimitMicrodollars: 999,
      dailyLimitMicrodollars: 888,
      admissionNumerator: 50,
      admissionDenominator: 100,
    });
  });

  it('sums project daily usage across runs in the rolling window', async () => {
    const repository = new InMemoryDomainRepository();
    const projectId = persistenceId('project', 'project-1');
    await repository.createProject({
      id: projectId,
      name: 'demo',
      createdAt: now,
      updatedAt: now,
    });
    const runA = persistenceId('run', 'run-a');
    const runB = persistenceId('run', 'run-b');
    for (const runId of [runA, runB]) {
      await repository.createRun({
        id: runId,
        projectId,
        pipeline: 'feature',
        status: 'running',
        createdAt: now,
        updatedAt: now,
      });
    }
    await repository.appendUsage({
      idempotencyId: persistenceId('usage', 'usage-a'),
      runId: runA,
      model: 'test',
      pricingVersion: 'test-v1',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreation5mInputTokens: 0,
      cacheCreation1hInputTokens: 0,
      runtimeMs: 0,
      microdollars: 100,
      recordedAt: isoTimestamp('2026-08-17T11:30:00.000Z'),
    });
    await repository.appendUsage({
      idempotencyId: persistenceId('usage', 'usage-b'),
      runId: runB,
      model: 'test',
      pricingVersion: 'test-v1',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreation5mInputTokens: 0,
      cacheCreation1hInputTokens: 0,
      runtimeMs: 0,
      microdollars: 250,
      recordedAt: isoTimestamp('2026-08-17T11:45:00.000Z'),
    });
    const dailyUsage = createProjectDailyUsageMicrodollars(repository);
    await expect(dailyUsage(now, 'project-1')).resolves.toBe(350);
  });

  it('loads budget limits from the run config snapshot', async () => {
    const repository = new InMemoryDomainRepository();
    const { configJson, configDigest } = budgetConfig();
    const projectId = persistenceId('project', 'project-1');
    const runId = persistenceId('run', 'run-1');
    const revisionId = persistenceId('configRevision', 'revision-1');
    await repository.createProject({
      id: projectId,
      name: 'demo',
      createdAt: now,
      updatedAt: now,
    });
    await repository.createConfigRevision({
      id: revisionId,
      projectId,
      config: JSON.parse(configJson),
      configDigest,
      modelDigest: 'model-digest',
      promptDigest: 'prompt-digest',
      environmentDigest: 'environment-digest',
      policyDigest: 'policy-digest',
      repositorySha: 'a'.repeat(40),
      createdAt: now,
      revision: 1,
    });
    await repository.createRun({
      id: runId,
      projectId,
      pipeline: 'feature',
      status: 'running',
      createdAt: now,
      updatedAt: now,
    });
    await repository.createConfigSnapshot({
      id: persistenceId('configSnapshot', 'snapshot-1'),
      runId,
      configRevisionId: revisionId,
      config: JSON.parse(configJson),
      configDigest,
      modelDigest: 'model-digest',
      promptDigest: 'prompt-digest',
      environmentDigest: 'environment-digest',
      policyDigest: 'policy-digest',
      repositorySha: 'a'.repeat(40),
      createdAt: now,
    });
    await expect(budgetLimitsForRun(repository, 'run-1')).resolves.toEqual({
      workflowLimitMicrodollars: 999,
      dailyLimitMicrodollars: 888,
      admissionNumerator: 50,
      admissionDenominator: 100,
    });
  });

  it('parses an optional deployment daily cap from the environment', () => {
    expect(
      deploymentDailyLimitFromEnv({
        AGENTOS_DEPLOYMENT_DAILY_MICRODOLLARS: '50000000',
      }),
    ).toBe(50_000_000);
    expect(deploymentDailyLimitFromEnv({})).toBeUndefined();
    expect(() =>
      deploymentDailyLimitFromEnv({
        AGENTOS_DEPLOYMENT_DAILY_MICRODOLLARS: '0',
      }),
    ).toThrow(/positive integer/);
  });
});
