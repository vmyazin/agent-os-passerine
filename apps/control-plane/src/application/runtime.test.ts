import { describe, expect, it } from 'vitest';

import { assertKimiHandleSupported } from './runtime';

describe('assertKimiHandleSupported', () => {
  it('rejects a kimi-prefixed handle when kimi is not configured', () => {
    expect(() =>
      assertKimiHandleSupported({ id: 'kimi abc123' }, false),
    ).toThrow(
      /kimi runtime is not configured; cannot operate on handle 'kimi abc123'/,
    );
  });

  it('allows a kimi-prefixed handle when kimi is configured', () => {
    expect(() =>
      assertKimiHandleSupported({ id: 'kimi abc123' }, true),
    ).not.toThrow();
  });

  it('never rejects a bare managed handle id regardless of kimi configuration', () => {
    expect(() =>
      assertKimiHandleSupported({ id: 'session_abc123' }, false),
    ).not.toThrow();
    expect(() =>
      assertKimiHandleSupported({ id: 'session_abc123' }, true),
    ).not.toThrow();
  });

  it('only matches the exact "kimi " delimiter prefix, not any id merely starting with the letters kimi', () => {
    expect(() =>
      assertKimiHandleSupported({ id: 'kimichunk_abc123' }, false),
    ).not.toThrow();
  });
});
