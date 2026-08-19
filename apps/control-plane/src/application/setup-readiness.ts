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

export interface SetupReadiness {
  readonly ready: boolean;
  readonly readyForGitHub: boolean;
  readonly readyForLocal: boolean;
  readonly repository?: string;
  readonly groups: readonly SetupReadinessGroup[];
}

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

function boundRepository(environment: Environment): string | undefined {
  try {
    const parsed: unknown = JSON.parse(
      environment.GITHUB_SELECTED_REPOSITORIES_JSON ?? '',
    );
    if (!Array.isArray(parsed) || parsed.length !== 1) return undefined;
    const entry = parsed[0] as { owner?: unknown; name?: unknown };
    if (typeof entry.owner !== 'string' || typeof entry.name !== 'string')
      return undefined;
    return `${entry.owner}/${entry.name}`;
  } catch {
    return undefined;
  }
}

/**
 * Reports which subsystems the environment has configured, as booleans only.
 * The report never contains environment values: the wizard shows what is
 * missing, and the operator edits the environment file outside the app.
 */
export function setupReadiness(environment: Environment): SetupReadiness {
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
        'Enables durable dispatch; the dev worker must also be running.',
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
        'Reader repository binding',
        'Exactly one bound repository for the reader.',
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
        'Publisher repository binding',
        'Exactly one bound repository for the publisher.',
      ),
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
  const repository = boundRepository(environment);
  const github = groups.find((entry) => entry.id === 'github');
  const local = groups.find((entry) => entry.id === 'local');
  const ready = groups
    .filter((entry) => entry.id !== 'github' && entry.id !== 'local')
    .every((entry) => entry.ready);
  return {
    ready,
    readyForGitHub: ready && (github?.ready ?? false),
    readyForLocal: ready && (local?.ready ?? false),
    ...(repository === undefined ? {} : { repository }),
    groups,
  };
}
