// apps/control-plane/src/ui/redact-configuration.test.ts
import { describe, expect, it } from 'vitest';

import {
  redactConfigurationForDisplay,
  REDACTED_VALUE,
} from './redact-configuration';

describe('redactConfigurationForDisplay', () => {
  it('masks environment variable values but keeps their names', () => {
    const rendered = redactConfigurationForDisplay(
      JSON.stringify({
        project: { name: 'demo' },
        environments: {
          default: {
            runtime: 'process',
            variables: { API_TOKEN: 'sk-live-super-secret', REGION: 'us-east-1' },
          },
          other: { runtime: 'process', variables: {} },
        },
      }),
    );
    expect(rendered).not.toContain('sk-live-super-secret');
    expect(rendered).not.toContain('us-east-1');
    expect(rendered).toContain('API_TOKEN');
    expect(rendered).toContain(REDACTED_VALUE);
    // Everything outside variables is untouched.
    expect(rendered).toContain('demo');
    expect(rendered).toContain('process');
  });

  it('fails closed rather than rendering unparseable input', () => {
    expect(redactConfigurationForDisplay('not json{')).toBe(
      '# configuration could not be rendered safely',
    );
  });

  it('passes through configurations without environments', () => {
    const rendered = redactConfigurationForDisplay(
      JSON.stringify({ project: { name: 'demo' } }),
    );
    expect(JSON.parse(rendered)).toEqual({ project: { name: 'demo' } });
  });
});
