/**
 * The models a run can be pointed at, and the providers that serve them.
 *
 * Which model a run uses was previously reachable only by editing a project's
 * YAML and applying a new configuration revision. This catalog is the other
 * half of a global setting: the operator picks one entry, and every feature
 * role runs on it.
 *
 * Adding a provider is two edits -- an entry here, and a transport keyed by
 * the same provider id where the runtime builds them -- because everything
 * downstream routes on `provider` alone.
 */

/** A model endpoint, and the environment that credentials it. */
export interface ModelProvider {
  readonly id: string;
  readonly label: string;
  /** Absent or blank in the environment means "this provider is unavailable". */
  readonly apiKeyEnv: string;
  /** Overrides the endpoint; each provider's transport supplies a default. */
  readonly baseUrlEnv: string;
  /**
   * Where the provider answers, when its transport has no default of its own.
   * Every provider here speaks the Anthropic Messages API.
   */
  readonly defaultBaseUrl?: string;
}

export const MODEL_PROVIDERS: readonly ModelProvider[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    baseUrlEnv: 'ANTHROPIC_BASE_URL',
    defaultBaseUrl: 'https://api.anthropic.com',
  },
  {
    id: 'kimi',
    label: 'Kimi',
    apiKeyEnv: 'KIMI_API_KEY',
    baseUrlEnv: 'KIMI_BASE_URL',
  },
];

export function findModelProvider(id: string): ModelProvider | undefined {
  return MODEL_PROVIDERS.find((provider) => provider.id === id);
}

/**
 * One selectable model, carrying everything a run needs to bill it.
 *
 * The prices are the same per-million-token figures a project's YAML carries,
 * because a globally selected model is written into the run's model profile
 * and priced by the identical path.
 */
export interface SelectableModel {
  /** Stable across price changes and label edits: this is what is stored. */
  readonly id: string;
  readonly providerId: string;
  readonly label: string;
  /** The model identifier sent to the provider. */
  readonly model: string;
  readonly inputMicrodollarsPerMillionTokens: number;
  readonly outputMicrodollarsPerMillionTokens: number;
  readonly runtimeMicrodollarsPerMinute: number;
}

export const SELECTABLE_MODELS: readonly SelectableModel[] = [
  {
    id: 'anthropic/claude-sonnet-4-6',
    providerId: 'anthropic',
    label: 'Claude Sonnet 4.6',
    model: 'claude-sonnet-4-6',
    inputMicrodollarsPerMillionTokens: 3_000_000,
    outputMicrodollarsPerMillionTokens: 15_000_000,
    runtimeMicrodollarsPerMinute: 0,
  },
  {
    id: 'anthropic/claude-haiku-4-5',
    providerId: 'anthropic',
    label: 'Claude Haiku 4.5',
    model: 'claude-haiku-4-5-20251001',
    inputMicrodollarsPerMillionTokens: 1_000_000,
    outputMicrodollarsPerMillionTokens: 5_000_000,
    runtimeMicrodollarsPerMinute: 0,
  },
  {
    id: 'kimi/kimi-k2.7-code',
    providerId: 'kimi',
    label: 'Kimi K2.7 Code',
    model: 'kimi-k2.7-code',
    inputMicrodollarsPerMillionTokens: 600_000,
    outputMicrodollarsPerMillionTokens: 2_500_000,
    runtimeMicrodollarsPerMinute: 0,
  },
];

export function findSelectableModel(id: string): SelectableModel | undefined {
  return SELECTABLE_MODELS.find((entry) => entry.id === id);
}

/**
 * Provider ids whose credential is present in this environment.
 *
 * A model whose provider is missing its key cannot run, so the operator is
 * shown which entries are usable rather than being allowed to pick one that
 * fails at the first request.
 */
export function configuredModelProviders(
  environment: Readonly<Record<string, string | undefined>>,
): ReadonlySet<string> {
  return new Set(
    MODEL_PROVIDERS.filter(
      (provider) => (environment[provider.apiKeyEnv] ?? '').trim() !== '',
    ).map((provider) => provider.id),
  );
}
