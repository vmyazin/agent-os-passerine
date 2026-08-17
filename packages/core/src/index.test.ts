import { describe, expect, it } from 'vitest';

import {
  AgentOsConfigSchema,
  calculateUsageCost,
  createFeatureWorkflow,
  createVerifierRegistry,
  evaluatePatchPolicy,
  loadAgentOsConfig,
  reduceRunState,
} from './index.js';

describe('@agentos/core public API', () => {
  it('exports every domain surface from the package entry point', () => {
    expect(AgentOsConfigSchema).toBeDefined();
    expect(loadAgentOsConfig).toBeTypeOf('function');
    expect(reduceRunState).toBeTypeOf('function');
    expect(evaluatePatchPolicy).toBeTypeOf('function');
    expect(calculateUsageCost).toBeTypeOf('function');
    expect(createVerifierRegistry).toBeTypeOf('function');
    expect(createFeatureWorkflow({ maxRetries: 1 }).phase).toBe(
      'specification',
    );
  });
});
