import { readFile as nodeReadFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

import { canonicalConfigHash, loadAgentOsConfig } from '@agentos/core';
import { stringify } from 'yaml';

export interface ConfigurationMetadata {
  readonly version: 1;
  readonly digest: string;
  readonly provenance: {
    readonly configuredPath: string;
    readonly parser: '@agentos/core';
  };
  readonly project: {
    readonly name: string;
    readonly defaultBranch: string;
  };
  readonly runtime: { readonly provider: string };
  readonly counts: {
    readonly models: number;
    readonly agents: number;
    readonly environments: number;
    readonly pipelines: number;
    readonly steps: number;
  };
}

interface LoaderOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly readFile?: (path: string, encoding: 'utf8') => Promise<string>;
}

export async function loadConfigurationMetadata(
  options: LoaderOptions = {},
): Promise<ConfigurationMetadata> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const configuredPath = env.AGENTOS_CONFIG_PATH?.trim();
  if (env.NODE_ENV === 'production' && !configuredPath) {
    throw new Error('AGENTOS_CONFIG_PATH is required in production');
  }
  const source = configuredPath || 'agentos/example.yaml';
  const developmentRoot =
    basename(cwd) === 'control-plane' && basename(dirname(cwd)) === 'apps'
      ? resolve(cwd, '../..')
      : cwd;
  const absolutePath = isAbsolute(source)
    ? source
    : resolve(configuredPath ? cwd : developmentRoot, source);
  const yaml = await (options.readFile ?? nodeReadFile)(absolutePath, 'utf8');
  const config = loadAgentOsConfig(yaml);

  return {
    version: config.version,
    digest: canonicalConfigHash(config),
    provenance: {
      configuredPath: isAbsolute(source) ? basename(source) : source,
      parser: '@agentos/core',
    },
    project: {
      name: config.project.name,
      defaultBranch: config.project.defaultBranch,
    },
    runtime: { provider: config.runtime.provider },
    counts: {
      models: Object.keys(config.models).length,
      agents: Object.keys(config.agents).length,
      environments: Object.keys(config.environments).length,
      pipelines: Object.keys(config.pipelines).length,
      steps: Object.values(config.pipelines).reduce(
        (count, pipeline) => count + pipeline.steps.length,
        0,
      ),
    },
  };
}

export function configurationYaml(metadata: ConfigurationMetadata): string {
  return stringify(metadata, { sortMapEntries: true });
}
