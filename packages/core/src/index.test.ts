import { describe, expect, it } from 'vitest';

import * as core from './index.js';

describe('@agentos/core workspace smoke test', () => {
  it('loads the intentionally empty public module', () => {
    expect(Object.keys(core)).toEqual([]);
  });
});
