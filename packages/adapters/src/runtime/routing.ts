import type {
  RuntimeAgent,
  RuntimeEnvironment,
  RuntimeEvent,
  RuntimeFileResource,
  RuntimeHandle,
  RuntimeObservedCommand,
  RuntimeOutput,
  RuntimeProvider,
  RuntimeStartRequest,
  RuntimeUsage,
} from '@agentos/core';

/**
 * Thrown for fail-closed routing failures: an unknown constructor option,
 * `route()` returning a provider id that isn't registered, a handle whose
 * runtime prefix isn't registered, or a start request for an agent that was
 * never synced.
 */
export class RoutingRuntimeProviderError extends Error {
  override readonly name = 'RoutingRuntimeProviderError';
}

export interface RoutingRuntimeProviderOptions {
  readonly providers: Readonly<Record<string, RuntimeProvider>>;
  readonly defaultProvider: string; // key into providers
  readonly route: (agent: RuntimeAgent) => string | undefined; // runtime id or undefined -> default
}

const HANDLE_DELIMITER = ' ';

/**
 * Fans out a single `RuntimeProvider` port across multiple underlying
 * providers, routing each agent (via `route`, falling back to
 * `defaultProvider`) to the provider it was synced against, and wrapping
 * handles so later calls (events, cancel, cleanup, ...) reach the same
 * provider the session was started on.
 */
export function createRoutingRuntimeProvider(
  options: RoutingRuntimeProviderOptions,
): RuntimeProvider {
  const { providers, defaultProvider, route } = options;

  if (Object.keys(providers).length === 0) {
    throw new RoutingRuntimeProviderError('providers must not be empty');
  }
  if (!Object.prototype.hasOwnProperty.call(providers, defaultProvider)) {
    throw new RoutingRuntimeProviderError(
      `unknown default provider '${defaultProvider}'`,
    );
  }

  // agentId -> runtimeId, recorded at syncAgent time.
  const agentRuntimes = new Map<string, string>();

  function resolveProvider(runtimeId: string): RuntimeProvider {
    const provider = providers[runtimeId];
    if (!provider) {
      throw new RoutingRuntimeProviderError(
        `unknown runtime provider '${runtimeId}'`,
      );
    }
    return provider;
  }

  function wrapHandle(runtimeId: string, handle: RuntimeHandle): RuntimeHandle {
    return { id: `${runtimeId}${HANDLE_DELIMITER}${handle.id}` };
  }

  /**
   * Looks up the runtime recorded for `agentId` at `syncAgent` time.
   *
   * `start` requires a prior `syncAgent` call and throws when the agent is
   * unrecorded — starting a session for an unknown agent is always a bug.
   * `reconcileStart` instead falls back to `defaultProvider`: it exists to
   * recover in-flight sessions after a process restart, when `agentRuntimes`
   * may be empty even though the agent was synced (and routed) in a prior
   * process. Falling back lets the default provider report "no matching
   * session" (`undefined`) so the workflow's absence reconciliation can
   * proceed, instead of the routing facade itself blocking recovery.
   */
  function lookupRuntimeId(
    agentId: string,
    fallback: 'throw' | 'default',
  ): string {
    const recorded = agentRuntimes.get(agentId);
    if (recorded) {
      return recorded;
    }
    if (fallback === 'default') {
      return defaultProvider;
    }
    throw new RoutingRuntimeProviderError(
      `agent '${agentId}' was never synced`,
    );
  }

  function unwrapHandle(handle: RuntimeHandle): {
    runtimeId: string;
    provider: RuntimeProvider;
    inner: RuntimeHandle;
  } {
    const delimiterIndex = handle.id.indexOf(HANDLE_DELIMITER);
    if (delimiterIndex === -1) {
      throw new RoutingRuntimeProviderError(
        `malformed routed handle '${handle.id}'`,
      );
    }
    const runtimeId = handle.id.slice(0, delimiterIndex);
    const innerId = handle.id.slice(delimiterIndex + 1);
    const provider = resolveProvider(runtimeId);
    return { runtimeId, provider, inner: { id: innerId } };
  }

  return {
    async syncAgent(agent: RuntimeAgent): Promise<void> {
      const runtimeId = route(agent) ?? defaultProvider;
      const provider = resolveProvider(runtimeId);
      await provider.syncAgent(agent);
      agentRuntimes.set(agent.id, runtimeId);
    },

    async syncEnvironment(environment: RuntimeEnvironment): Promise<void> {
      // Fan-out is all-or-nothing: if any provider rejects, the whole call
      // rejects, but Promise.all still lets every provider's sync run (none
      // are skipped because an earlier one failed).
      await Promise.all(
        Object.values(providers).map((provider) =>
          provider.syncEnvironment(environment),
        ),
      );
    },

    async start(request: RuntimeStartRequest): Promise<RuntimeHandle> {
      const runtimeId = lookupRuntimeId(request.agentId, 'throw');
      const provider = resolveProvider(runtimeId);
      const handle = await provider.start(request);
      return wrapHandle(runtimeId, handle);
    },

    async reconcileStart(
      request: RuntimeStartRequest,
    ): Promise<RuntimeHandle | undefined> {
      const runtimeId = lookupRuntimeId(request.agentId, 'default');
      const provider = resolveProvider(runtimeId);
      if (!provider.reconcileStart) {
        return undefined;
      }
      const handle = await provider.reconcileStart(request);
      return handle ? wrapHandle(runtimeId, handle) : undefined;
    },

    events(handle: RuntimeHandle): AsyncIterable<RuntimeEvent> {
      const { provider, inner } = unwrapHandle(handle);
      return provider.events(inner);
    },

    async send(handle: RuntimeHandle, message: unknown): Promise<void> {
      const { provider, inner } = unwrapHandle(handle);
      await provider.send(inner, message);
    },

    async resume(handle: RuntimeHandle, input?: unknown): Promise<void> {
      const { provider, inner } = unwrapHandle(handle);
      await provider.resume(inner, input);
    },

    async cancel(handle: RuntimeHandle, reason?: string): Promise<void> {
      const { provider, inner } = unwrapHandle(handle);
      await provider.cancel(inner, reason);
    },

    async collectOutput(handle: RuntimeHandle): Promise<RuntimeOutput> {
      const { provider, inner } = unwrapHandle(handle);
      return provider.collectOutput(inner);
    },

    async usage(handle: RuntimeHandle): Promise<RuntimeUsage> {
      const { provider, inner } = unwrapHandle(handle);
      return provider.usage(inner);
    },

    async cleanup(handle: RuntimeHandle): Promise<void> {
      const { provider, inner } = unwrapHandle(handle);
      await provider.cleanup(inner);
    },

    async cleanupAccess(input: {
      readonly resources: readonly RuntimeFileResource[];
      readonly credentialRefs: readonly string[];
    }): Promise<void> {
      // Same all-or-nothing fan-out as syncEnvironment: a rejection from one
      // provider fails the call, but every provider that defines
      // cleanupAccess still gets invoked.
      await Promise.all(
        Object.values(providers).map((provider) =>
          provider.cleanupAccess ? provider.cleanupAccess(input) : undefined,
        ),
      );
    },

    async observeCommand(
      handle: RuntimeHandle,
      expectedCommand: string,
    ): Promise<RuntimeObservedCommand> {
      const { runtimeId, provider, inner } = unwrapHandle(handle);
      if (!provider.observeCommand) {
        throw new RoutingRuntimeProviderError(
          `runtime provider '${runtimeId}' does not support observeCommand`,
        );
      }
      return provider.observeCommand(inner, expectedCommand);
    },
  };
}
