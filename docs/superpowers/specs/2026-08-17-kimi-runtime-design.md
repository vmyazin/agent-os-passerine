# Kimi Runtime Provider Design

## Objective

Run agent roles on Moonshot's Kimi K2 models alongside Anthropic, selected per
model profile through the existing configuration surface. A new self-hosted
runtime provider owns the agent loop against Moonshot's Anthropic-compatible
Messages API and executes agent tools in a local, path-confined process
sandbox, while every existing trust boundary — signed command observation,
bounded agent output, trusted publication — keeps its semantics.

## Scope

Version one supports:

- A `kimi` runtime provider implementing the existing core `RuntimeProvider`
  port, driven by `KIMI_API_KEY` against
  `https://api.moonshot.ai/anthropic` (overridable via `KIMI_BASE_URL`).
- Routing by model-profile provider: agents whose model profile declares
  `provider: kimi` run on the Kimi runtime; `provider: anthropic` (and the
  current default) stays on Anthropic Managed Agents. The
  existing-but-unwired `config.runtime.{provider, routing}` section becomes
  authoritative: `provider` names the default runtime and `routing` maps
  model-provider identifiers to runtime identifiers.
- A per-session local process sandbox for tool execution.

Non-goals for version one, stated deliberately: container or VM isolation,
enforcement of `networking: limited` inside the sandbox, Kimi session
survival across worker restarts (the existing absence-reconciliation path
already fails lost sessions closed and cleans up), and any change to the
feature/goal workflow logic, approval gates, publication policy, or
draft-PR-only boundary.

## Runtime provider adapter

`packages/adapters/src/kimi/` exports
`createKimiRuntimeProvider(options)` with `apiKey`, `ownershipSecret`,
`sandboxRoot`, optional `baseUrl`, and an injectable HTTP transport plus
clock for tests.

**Agent loop.** The provider owns the loop: it sends Anthropic-shaped
Messages requests with tool definitions to Moonshot, executes returned
`tool_use` blocks, and continues until the agent submits its result or a
bound is hit. The model string comes from the agent's model profile. Requests
and responses use the same wire shapes the codebase already handles; no
OpenAI-compatible client is introduced.

**Tools.** The model sees `bash`, `read`, `write`, `edit`, and
`submit_result`. All file paths are canonicalized and must remain under the
session workdir; escapes are rejected as tool errors. Bash runs with the
workdir as cwd, a timeout, and bounded captured output. `submit_result`
accepts only the bounded JSON result contract; its payload becomes
`collectOutput()`. Artifact reads and writes go through the existing
step-scoped Artifact MCP capability over HTTPS, using the same capability
tokens the managed path issues; the raw tokens are used by provider code,
never rendered into the model's context beyond the tool interface.

**Sessions.** Each start creates a scratch workdir under `sandboxRoot`,
materializes the source bundle and verified upstream artifacts from the
start request into it, and registers a session whose identity is derived
with an HMAC over `ownershipSecret` and the run/step/idempotency binding —
mirroring the managed provider so `reconcileStart` recognizes its own
sessions on the same worker and never adopts foreign ones. `events` streams
loop progress as the existing `RuntimeEvent` shapes; `send`/`resume` feed
queued input into the loop; `cancel` aborts the in-flight request and marks
the session terminal; `cleanup` removes the workdir. Sessions are
worker-local: after a process restart the session is gone, reconciliation
observes absence, and the run fails closed exactly as a lost managed session
does.

**Usage.** Token counts accumulate from every Moonshot response and are
returned by `usage()` in the existing `RuntimeUsage` shape, so the current
per-model pricing configuration (input/output microdollars, runtime minutes)
prices Kimi work with no new billing code.

## Trusted command observation

`observeCommand(handle, expectedCommand)` preserves the trust anchor: the
provider — trusted worker code, never the agent — executes the exact
expected command in the session sandbox with a secretless environment (no
`KIMI_API_KEY`, no `ANTHROPIC_API_KEY`, no inherited secrets) and returns
the observed command string, exit code, and timestamps. The feature
workflow's signed trusted-test-report chain, the report attestation keys,
and the goal verifier therefore work unchanged on Kimi-executed runs: the
observer role moves from Anthropic's infrastructure to our worker process,
which is already trusted code in this architecture.

Agent output remains untrusted bounded JSON. The publication path, protected
paths, and the draft-only PR policy are unchanged.

Stated limitation: process/path confinement is weaker isolation than
Anthropic-hosted containers, and environment `networking: limited` is not
enforced inside the sandbox. Both are documented operator-facing trade-offs
of version one, not silent gaps.

## Routing and composition

`createRoutingRuntimeProvider({providers, defaultProvider, routing})` wraps
named providers behind the `RuntimeProvider` port. Dispatch happens at
`start`/`syncAgent` time using the agent's model-profile provider resolved
through `config.runtime.routing`, defaulting to `config.runtime.provider`.
Every issued `RuntimeHandle` embeds its runtime identifier so `events`,
`send`, `resume`, `cancel`, `collectOutput`, `usage`, `observeCommand`, and
`cleanup` route to the owning provider; a handle naming an unknown provider
fails closed.

Production composition builds the registry lazily: the Anthropic managed
provider exactly as today, and the Kimi provider only when `KIMI_API_KEY`
is present. Fail-closed rules:

- An applied configuration that routes any agent to the `kimi` runtime while
  `KIMI_API_KEY` is absent fails at composition with a named error; there is
  no silent fallback to Anthropic.
- Blank environment values are treated as absent (matching the existing
  dispatch-gate convention).
- Composition rejects a `runtime.routing` entry that names a runtime
  identifier with no registered provider; configuration validation enforces
  shape only, since the provider registry is composition-time knowledge.

`.env.example` gains `KIMI_API_KEY` and commented `KIMI_BASE_URL`;
`agentos/example.yaml` gains a commented `provider: kimi` model-profile
example with pricing fields.

## Verification

All default gates stay no-cost. Unit tests drive the loop through a fake
transport: multi-turn tool use, bash/file tool dispatch, path-escape
rejection, output bounding, `submit_result` contract enforcement, secretless
`observeCommand`, cancellation mid-request, usage accumulation, and
ownership-bound reconciliation. The routing facade is tested for dispatch,
handle-affinity, and unknown-provider failure. Composition tests cover the
fail-closed `KIMI_API_KEY` rules; configuration tests cover routing
validation. A live Kimi smoke script (`packages/adapters/scripts/`)
gates behind `AGENTOS_LIVE_TESTS=1` plus `KIMI_API_KEY`, following the
existing R2/Managed Agents smoke convention. Typecheck, lint, build, and
Playwright remain in the standard matrix.
