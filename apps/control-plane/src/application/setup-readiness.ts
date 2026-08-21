import { loadAgentOsConfig, type AgentOsConfig } from '@agentos/core';

import {
  assertReaderPublisherRepositoryPairing,
  listGitHubRepositoryBindings,
  parseGitHubRepositoryAllowlist,
  selectGitHubRepositoryFromUrl,
} from '@agentos/adapters';

export interface SetupReadinessItem {
  readonly key: string;
  readonly label: string;
  readonly ready: boolean;
  readonly hint: string;
}

export interface SetupReadinessGroup {
  readonly id: string;
  readonly title: string;
  readonly ready: boolean;
  readonly items: readonly SetupReadinessItem[];
}

export interface DeploymentSetupReadiness {
  readonly ready: boolean;
  readonly readyForGitHub: boolean;
  readonly readyForLocal: boolean;
  readonly repositories?: readonly string[];
  readonly groups: readonly SetupReadinessGroup[];
}

export interface ProjectSetupReadiness {
  readonly ready: boolean;
  readonly repository?: string;
  readonly items: readonly SetupReadinessItem[];
}

/** Backward-compatible alias for the setup wizard's deployment step. */
export type SetupReadiness = DeploymentSetupReadiness;

type Environment = Readonly<Record<string, string | undefined>>;

function present(environment: Environment, name: string): boolean {
  const value = environment[name];
  return typeof value === 'string' && value.trim() !== '';
}

function item(
  environment: Environment,
  key: string,
  label: string,
  hint: string,
): SetupReadinessItem {
  return { key, label, ready: present(environment, key), hint };
}

function group(
  id: string,
  title: string,
  items: readonly SetupReadinessItem[],
): SetupReadinessGroup {
  return { id, title, ready: items.every((entry) => entry.ready), items };
}

function githubAllowlistReady(environment: Environment): boolean {
  try {
    const reader = parseGitHubRepositoryAllowlist(
      environment.GITHUB_READER_SELECTED_REPOSITORIES_JSON ?? '',
      'GITHUB_READER_SELECTED_REPOSITORIES_JSON',
    );
    const publisher = parseGitHubRepositoryAllowlist(
      environment.GITHUB_SELECTED_REPOSITORIES_JSON ?? '',
      'GITHUB_SELECTED_REPOSITORIES_JSON',
    );
    assertReaderPublisherRepositoryPairing(reader, publisher);
    return true;
  } catch {
    return false;
  }
}

/**
 * Deployment-wide readiness: database, dispatch, storage, GitHub Apps env,
 * local workspaces, and trust anchors. Never echoes secret values.
 */
export function deploymentSetupReadiness(
  environment: Environment,
): DeploymentSetupReadiness {
  const groups: SetupReadinessGroup[] = [
    group('database', 'Database', [
      item(
        environment,
        'DATABASE_URL',
        'Neon connection string',
        'Postgres connection string for the app database.',
      ),
      item(
        environment,
        'AGENTOS_REPOSITORY',
        'Repository backend',
        'Set to "neon" for durable runs.',
      ),
    ]),
    group('dispatch', 'Workflow dispatch', [
      item(
        environment,
        'TRIGGER_SECRET_KEY',
        'Trigger.dev secret key',
        'Enqueues durable dispatch. A connected worker still has to execute it: `npx trigger.dev@latest dev` locally, `pnpm trigger:deploy` for a deployment. This check cannot see that worker.',
      ),
      item(
        environment,
        'TRIGGER_PROJECT_REF',
        'Trigger.dev project',
        'Project reference from the Trigger.dev dashboard.',
      ),
    ]),
    group('models', 'Model access', [
      item(
        environment,
        'ANTHROPIC_API_KEY',
        'Anthropic API key',
        'Required for Managed Agents sessions.',
      ),
    ]),
    group('storage', 'Artifact storage', [
      item(
        environment,
        'CLOUDFLARE_R2_ACCOUNT_ID',
        'R2 account',
        'Cloudflare account that owns the artifact bucket.',
      ),
      item(
        environment,
        'CLOUDFLARE_R2_ARTIFACT_BUCKET',
        'R2 bucket',
        'Bucket that stores run artifacts.',
      ),
      item(
        environment,
        'CLOUDFLARE_R2_ARTIFACT_ACCESS_KEY_ID',
        'R2 access key',
        'Bucket-scoped access key ID.',
      ),
      item(
        environment,
        'CLOUDFLARE_R2_ARTIFACT_SECRET_ACCESS_KEY',
        'R2 secret key',
        'Bucket-scoped secret access key.',
      ),
    ]),
    group('github', 'GitHub Apps (GitHub projects)', [
      item(
        environment,
        'GITHUB_READER_APP_ID',
        'Reader app',
        'Read-only GitHub App for source snapshots.',
      ),
      item(
        environment,
        'GITHUB_READER_APP_PRIVATE_KEY',
        'Reader private key',
        'PEM key of the reader app.',
      ),
      item(
        environment,
        'GITHUB_READER_SELECTED_REPOSITORIES_JSON',
        'Reader repository allowlist',
        'One or more bound repositories for the reader app.',
      ),
      item(
        environment,
        'GITHUB_APP_ID',
        'Publisher app',
        'GitHub App that opens draft pull requests.',
      ),
      item(
        environment,
        'GITHUB_APP_PRIVATE_KEY',
        'Publisher private key',
        'PEM key of the publisher app.',
      ),
      item(
        environment,
        'GITHUB_SELECTED_REPOSITORIES_JSON',
        'Publisher repository allowlist',
        'One or more bound repositories for the publisher app.',
      ),
      {
        key: 'github.repository_pairing',
        label: 'Reader/publisher pairing',
        ready: githubAllowlistReady(environment),
        hint:
          'Reader and publisher allowlists must list the same repositories.',
      },
    ]),
    group('local', 'Local workspaces (experiments)', [
      item(
        environment,
        'AGENTOS_LOCAL_WORKSPACES_ROOT',
        'Local workspaces root',
        'Absolute directory that contains local experiment repositories.',
      ),
    ]),
    group('artifactMcp', 'Artifact MCP endpoint', [
      item(
        environment,
        'AGENTOS_ARTIFACT_MCP_URL',
        'Public MCP URL',
        'HTTPS URL that cloud sessions use to reach the artifact MCP.',
      ),
      item(
        environment,
        'ARTIFACT_MCP_ALLOWED_ORIGINS',
        'Allowed origins',
        'Comma-separated HTTPS origins for the MCP endpoint.',
      ),
      item(
        environment,
        'ARTIFACT_CAPABILITY_KEYS_JSON',
        'Capability keys',
        'HMAC keys for step-scoped artifact capabilities.',
      ),
    ]),
    group('trust', 'Trust anchors', [
      item(
        environment,
        'AGENTOS_RUNTIME_OWNERSHIP_SECRET',
        'Runtime ownership secret',
        'Binds runtime sessions to this control plane.',
      ),
      item(
        environment,
        'AGENTOS_RUNTIME_HANDLE_KEY',
        'Runtime handle key',
        'Seals persisted runtime handles.',
      ),
      item(
        environment,
        'AGENTOS_TEST_REPORT_KEYS_JSON',
        'Test report keys',
        'Signs trusted verification evidence.',
      ),
      item(
        environment,
        'GITHUB_PUBLICATION_KEYS_JSON',
        'Publication keys',
        'Signs publication authorizations.',
      ),
      item(
        environment,
        'AGENTOS_TRUSTED_TEST_COMMANDS_JSON',
        'Trusted test commands',
        'Allowlist of verification commands, for example "pnpm test".',
      ),
    ]),
  ];
  const repositories = listGitHubRepositoryBindings(
    environment.GITHUB_SELECTED_REPOSITORIES_JSON,
  );
  const github = groups.find((entry) => entry.id === 'github');
  const local = groups.find((entry) => entry.id === 'local');
  const ready = groups
    .filter((entry) => entry.id !== 'github' && entry.id !== 'local')
    .every((entry) => entry.ready);
  return {
    ready,
    readyForGitHub: ready && (github?.ready ?? false),
    readyForLocal: ready && (local?.ready ?? false),
    ...(repositories === undefined ? {} : { repositories }),
    groups,
  };
}

/** Per-project readiness for a GitHub-bound configuration. */
export function projectSetupReadiness(
  environment: Environment,
  config: AgentOsConfig,
): ProjectSetupReadiness {
  if (config.project.localPath !== undefined) {
    const localReady = present(environment, 'AGENTOS_LOCAL_WORKSPACES_ROOT');
    return {
      ready: localReady,
      items: [
        {
          key: 'project.localPath',
          label: 'Local repository binding',
          ready: localReady,
          hint: 'Local experiment projects require AGENTOS_LOCAL_WORKSPACES_ROOT.',
        },
      ],
    };
  }
  if (config.project.repository === undefined) {
    return {
      ready: false,
      items: [
        {
          key: 'project.repository',
          label: 'Project repository binding',
          ready: false,
          hint: 'Project must configure either repository or localPath.',
        },
      ],
    };
  }
  let allowlistReady: boolean;
  let selectedRepository: string | undefined;
  try {
    const publisher = parseGitHubRepositoryAllowlist(
      environment.GITHUB_SELECTED_REPOSITORIES_JSON ?? '',
      'GITHUB_SELECTED_REPOSITORIES_JSON',
    );
    const reader = parseGitHubRepositoryAllowlist(
      environment.GITHUB_READER_SELECTED_REPOSITORIES_JSON ?? '',
      'GITHUB_READER_SELECTED_REPOSITORIES_JSON',
    );
    assertReaderPublisherRepositoryPairing(reader, publisher);
    const selected = selectGitHubRepositoryFromUrl(
      config.project.repository,
      publisher,
    );
    allowlistReady = true;
    selectedRepository = `${selected.owner}/${selected.name}`;
  } catch {
    allowlistReady = false;
  }
  return {
    ready: allowlistReady,
    ...(selectedRepository === undefined ? {} : { repository: selectedRepository }),
    items: [
      {
        key: 'project.repository',
        label: 'GitHub repository allowlist',
        ready: allowlistReady,
        hint:
          'The configured repository URL must match an entry in the deployment allowlist.',
      },
    ],
  };
}

export function projectSetupReadinessFromYaml(
  environment: Environment,
  yaml: string,
): ProjectSetupReadiness {
  return projectSetupReadiness(environment, loadAgentOsConfig(yaml));
}

/** Deployment readiness report for the setup wizard step 1. */
export function setupReadiness(environment: Environment): SetupReadiness {
  return deploymentSetupReadiness(environment);
}
