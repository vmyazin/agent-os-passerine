import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loadConfigurationMetadata } = vi.hoisted(() => ({
  loadConfigurationMetadata: vi.fn(),
}));

vi.mock('./configuration-loader', () => ({
  loadConfigurationMetadata,
  configurationYaml: (metadata: unknown) => JSON.stringify(metadata),
}));

import { loadConfigurationPageYaml } from './configuration-page-model';

describe('ConfigurationPage', () => {
  beforeEach(() => {
    loadConfigurationMetadata.mockReset().mockResolvedValue({
      version: 1,
      digest: 'safe-digest',
      provenance: { configuredPath: 'config/production.yaml' },
      counts: { models: 1 },
    });
  });

  it('loads authoritative safe metadata for the read-only page', async () => {
    const serialized = await loadConfigurationPageYaml();

    expect(loadConfigurationMetadata).toHaveBeenCalledOnce();
    expect(serialized).toContain('safe-digest');
    expect(serialized).toContain('config/production.yaml');
    expect(serialized).not.toContain('prompt');
    expect(serialized).not.toContain('secret');
  });
});
