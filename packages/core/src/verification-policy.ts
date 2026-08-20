// packages/core/src/verification-policy.ts
import type { AgentOsConfig } from './config.js';

export interface DeploymentVerificationAllowlist {
  readonly trustedTestCommands: ReadonlySet<string>;
  readonly registryHosts: readonly string[];
}

export interface ProjectVerificationPolicy {
  readonly trustedTestCommands: readonly string[];
  readonly registryHosts: readonly string[];
}

function assertSubset(
  values: readonly string[],
  allowlist: ReadonlySet<string> | readonly string[],
  label: string,
): void {
  const allowed =
    allowlist instanceof Set ? allowlist : new Set(allowlist);
  for (const value of values) {
    if (!allowed.has(value))
      throw new Error(`${label} ${value} is outside the deployment allowlist`);
  }
}

/** Resolve per-project verification policy against the deployment allowlist. */
export function resolveProjectVerificationPolicy(
  config: AgentOsConfig,
  deployment: DeploymentVerificationAllowlist,
): ProjectVerificationPolicy {
  const configuredCommands = config.verification?.trustedTestCommands;
  const configuredHosts = config.verification?.registryHosts;
  const trustedTestCommands =
    configuredCommands === undefined || configuredCommands.length === 0
      ? [...deployment.trustedTestCommands]
      : configuredCommands;
  const registryHosts =
    configuredHosts === undefined || configuredHosts.length === 0
      ? [...deployment.registryHosts]
      : configuredHosts;
  assertSubset(
    trustedTestCommands,
    deployment.trustedTestCommands,
    'trusted test command',
  );
  assertSubset(registryHosts, deployment.registryHosts, 'registry host');
  return { trustedTestCommands, registryHosts };
}
