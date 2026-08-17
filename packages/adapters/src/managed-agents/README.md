# Claude Managed Agents adapter

This adapter implements the core `RuntimeProvider` contract using Anthropic's
beta Managed Agents API. It pins `@anthropic-ai/sdk` to `0.117.1` and uses the
`managed-agents-2026-04-01` API family exposed under `client.beta`. The SDK adds
that beta header automatically.

The generated beta SDK types are deliberately isolated behind
`sdk-contract.ts`. Public AgentOS types do not import them, so an upstream beta
rename is contained to the adapter. Upgrade the SDK only with a review of that
facade, the official Managed Agents reference, and the full contract suite.

Importing the adapter performs no client construction or network I/O. The
async public factory validates configuration before constructing a client and
accepts a narrow transport override. SDK clients and clocks are injectable only
through a non-entrypoint test seam that runs the same validation path.

Remote agents and environments are declaratively keyed by
`agentos.local_id`/`agentos.config_digest` metadata. Agent updates include the
remote optimistic version. Environment updates reapply the full digest because
the API does not version environments. Cloud networking is limited by default;
unrestricted networking requires `allowUnrestrictedNetworking: true`.
Matching remotes must also carry this adapter's exact owner marker; ownerless
or foreign resources are never adopted.

Built-in `web_search` and `web_fetch` are disabled independently. They require
both `allowBuiltInWebEgress: true` and an unrestricted cloud environment; a
limited environment can never start an agent containing either tool. This
separate policy prevents an apparently restricted environment from acquiring
provider-hosted web egress.

Synchronization is single-flight per local agent/environment ID within one
provider instance. A create conflict is re-listed and reconciled before an
update, and true duplicates still fail closed. Cross-process synchronization
must be externally serialized (for example, with a deployment lock), because
the in-memory single-flight boundary cannot coordinate separate processes.

Environment runtime must be `cloud` or `self_hosted`. Managed Agents does not
provision the core port's `image` or `variables` fields, so the adapter rejects
them instead of recording an unapplied digest. Use provider vault credentials
for session secrets.

MCP tools keep the provider's explicit `always_ask` policy. Resolve a
`requires_action` event with `send(handle, { type: 'tool_confirmation',
toolUseId, result: 'allow' | 'deny' })`; the adapter never auto-approves tools
added later by an MCP server.

Every session handle contains a high-entropy ownership capability. Only its
hash, the provider-instance ID, and run/step bindings are stored in remote
metadata. Interrupt, archive, and delete validate that binding before acting;
the capability is never included in provider errors. Output artifacts come
only from bounded Files API metadata listed with the session ID and Managed
Agents beta, not from the session's input mount resources. File content is not
downloaded by `collectOutput`.

The opt-in smoke command requires both `ANTHROPIC_API_KEY` and
`AGENTOS_LIVE_TESTS=1`:

```sh
pnpm --filter @agentos/adapters smoke:managed-agents
```

Do not run it in routine CI. Contract tests use an in-memory fake SDK and make
no live calls.
