import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('artifact retention schedule', () => {
  it('declares an hourly durable production cron', () => {
    const path = resolve(process.cwd(), '../../vercel.json');
    expect(existsSync(path)).toBe(true);
    const config = existsSync(path)
      ? (JSON.parse(readFileSync(path, 'utf8')) as {
          crons?: Array<{ path: string; schedule: string }>;
        })
      : {};
    expect(config.crons).toContainEqual({
      path: '/api/internal/artifacts/cleanup',
      schedule: '17 * * * *',
    });
  });
});
