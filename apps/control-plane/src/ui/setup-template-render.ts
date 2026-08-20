// src/ui/setup-template-render.ts
import { SETUP_CONFIG_TEMPLATE } from './setup-template';
import { SETUP_CONFIG_TEMPLATE_LOCAL } from './setup-template-local';

export type SetupProjectMode = 'github' | 'local';

export interface SetupProjectParams {
  readonly name: string;
  readonly defaultBranch?: string;
  readonly repository?: string;
  readonly localPath?: string;
}

function projectBlock(
  mode: SetupProjectMode,
  params: SetupProjectParams,
): string {
  const branch = params.defaultBranch ?? 'main';
  if (mode === 'github') {
    return `project:
  name: ${params.name}
  repository: ${params.repository ?? 'https://github.com/OWNER/REPOSITORY'}
  defaultBranch: ${branch}`;
  }
  return `project:
  name: ${params.name}
  localPath: ${params.localPath ?? '/REPLACE/WITH/ABSOLUTE/PATH'}
  defaultBranch: ${branch}`;
}

/** Replace the project block in a setup template with parameterized values. */
export function renderSetupConfig(
  mode: SetupProjectMode,
  params: SetupProjectParams,
): string {
  const template =
    mode === 'github' ? SETUP_CONFIG_TEMPLATE : SETUP_CONFIG_TEMPLATE_LOCAL;
  const block = projectBlock(mode, params);
  // Guard on the pattern, not on whether the output changed: rendering with
  // the template's own defaults produces a byte-identical document, and
  // comparing strings would report that correct result as a failed match.
  const projectBlockPattern = /^project:\n(?: {2}.*\n)+/m;
  if (!projectBlockPattern.test(template))
    throw new Error('setup template project block did not match');
  return template.replace(projectBlockPattern, `${block}\n`);
}
