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

Environment runtime must be `cloud` or `self_hosted`. Managed Agents does not
provision the core port's `image` or `variables` fields, so the adapter rejects
them instead of recording an unapplied digest. Use provider vault credentials
for session secrets.

MCP tools keep the provider's explicit `always_ask` policy. Resolve a
`requires_action` event with `send(handle, { type: 'tool_confirmation',
toolUseId, result: 'allow' | 'deny' })`; the adapter never auto-approves tools
added later by an MCP server.

The opt-in smoke command requires both `ANTHROPIC_API_KEY` and
`AGENTOS_LIVE_TESTS=1`:

```sh
pnpm --filter @agentos/adapters smoke:managed-agents
```

Do not run it in routine CI. Contract tests use an in-memory fake SDK and make
no live calls.
