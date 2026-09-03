import {
  findSelectableModel,
  type ConfigSnapshot,
  type JsonValue,
  type SelectableModel,
} from '@agentos/core';

/**
 * The model profile a globally selected model is written into.
 *
 * A name a project is unlikely to have chosen, so the override adds a profile
 * rather than quietly redefining one the project already uses for something
 * else.
 */
export const GLOBAL_MODEL_PROFILE = 'agentos-global-model';

/** A stored setting naming a model this build does not know. */
export class UnknownGlobalModelError extends Error {
  constructor(readonly modelId: string) {
    super(
      `the selected run model '${modelId}' is not in this build's catalog; choose another in Configuration`,
    );
    this.name = 'UnknownGlobalModelError';
  }
}

function withProfile(
  config: Record<string, unknown>,
  model: SelectableModel,
): Record<string, unknown> {
  const models = { ...(config.models as Record<string, unknown>) };
  models[GLOBAL_MODEL_PROFILE] = {
    provider: model.providerId,
    model: model.model,
    inputMicrodollarsPerMillionTokens: model.inputMicrodollarsPerMillionTokens,
    outputMicrodollarsPerMillionTokens:
      model.outputMicrodollarsPerMillionTokens,
    runtimeMicrodollarsPerMinute: model.runtimeMicrodollarsPerMinute,
  };
  const agents = Object.fromEntries(
    Object.entries(config.agents as Record<string, unknown>).map(
      ([id, definition]) => [
        id,
        { ...(definition as object), model: GLOBAL_MODEL_PROFILE },
      ],
    ),
  );
  return { ...config, models, agents };
}

/**
 * Points every agent in a run's configuration at the globally selected model.
 *
 * Which model a run uses was reachable only by editing a project's YAML and
 * applying a revision. The global setting is the other way in, and it applies
 * here -- to the snapshot both the config and the role definitions are read
 * from -- so the two cannot disagree about what is running.
 *
 * The snapshot's provenance digests still describe the project's applied
 * revision, which is what they are for; they are not recomputed, because the
 * override is not a configuration change. What actually ran is recorded per
 * step from the provider's own reported model.
 *
 * No setting means no rewrite, which is exactly how runs behaved before this
 * existed. A setting naming a model this build does not have fails the run
 * rather than falling back: silently running a different model than the one
 * chosen is worse than not running.
 */
export function withGlobalRunModel(
  snapshot: ConfigSnapshot,
  modelId: string | undefined,
): ConfigSnapshot {
  if (modelId === undefined) return snapshot;
  const model = findSelectableModel(modelId);
  if (model === undefined) throw new UnknownGlobalModelError(modelId);
  const config = snapshot.config;
  if (
    typeof config !== 'object' ||
    config === null ||
    Array.isArray(config) ||
    typeof (config as Record<string, unknown>).models !== 'object' ||
    typeof (config as Record<string, unknown>).agents !== 'object'
  )
    return snapshot;
  return {
    ...snapshot,
    config: withProfile(
      config as Record<string, unknown>,
      model,
    ) as unknown as JsonValue,
  };
}
