import { describe, expect, it } from 'vitest';

import {
  GLOBAL_MODEL_PROFILE,
  UnknownGlobalModelError,
  withGlobalRunModel,
} from './global-model.js';
import type { ConfigSnapshot } from '@agentos/core';

const snapshot = {
  id: 'snapshot-1',
  runId: 'run-1',
  configRevisionId: 'revision-1',
  configDigest: 'config',
  modelDigest: 'model',
  promptDigest: 'prompt',
  environmentDigest: 'environment',
  policyDigest: 'policy',
  repositorySha: 'sha',
  createdAt: '2026-09-03T12:00:00.000Z',
  config: {
    models: {
      house: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    },
    agents: {
      specifier: { model: 'house', environment: 'spec' },
      implementer: { model: 'house', environment: 'impl' },
    },
  },
} as unknown as ConfigSnapshot;

const configOf = (value: ConfigSnapshot) =>
  value.config as unknown as {
    models: Record<string, { provider: string; model: string }>;
    agents: Record<string, { model: string; environment: string }>;
  };

describe('withGlobalRunModel', () => {
  it('points every agent at the selected model', () => {
    const result = withGlobalRunModel(snapshot, 'kimi/kimi-k2.7-code');
    const config = configOf(result);
    expect(config.models[GLOBAL_MODEL_PROFILE]).toMatchObject({
      provider: 'kimi',
      model: 'kimi-k2.7-code',
    });
    expect(Object.values(config.agents).map((agent) => agent.model)).toEqual([
      GLOBAL_MODEL_PROFILE,
      GLOBAL_MODEL_PROFILE,
    ]);
    // Everything else about an agent is the project's business.
    expect(config.agents.specifier?.environment).toBe('spec');
  });

  it('leaves the project profile in place beside the override', () => {
    // Nothing else in the config is rewritten, so a profile the project
    // defines is still there to read -- the override adds, it does not erase.
    const config = configOf(
      withGlobalRunModel(snapshot, 'kimi/kimi-k2.7-code'),
    );
    expect(config.models.house).toMatchObject({ provider: 'anthropic' });
  });

  it('changes nothing when no model is selected', () => {
    expect(withGlobalRunModel(snapshot, undefined)).toBe(snapshot);
  });

  it('refuses a model this build does not have', () => {
    // Running a different model than the one chosen is worse than not
    // running: the operator would be billed for a choice they did not make.
    expect(() => withGlobalRunModel(snapshot, 'openai/gpt-9')).toThrow(
      UnknownGlobalModelError,
    );
  });

  it('keeps the snapshot provenance it was given', () => {
    // The digests describe the project's applied revision, which is what
    // they are for; the override is not a configuration change.
    const result = withGlobalRunModel(snapshot, 'kimi/kimi-k2.7-code');
    expect(result.configDigest).toBe(snapshot.configDigest);
    expect(result.configRevisionId).toBe(snapshot.configRevisionId);
  });
});
