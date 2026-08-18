# Kimi runtime provider

`packages/adapters/src/kimi/` adds a self-hosted `RuntimeProvider`
implementation that runs agent roles on Moonshot's Kimi K2 models, selected
per model profile alongside the existing Anthropic Managed Agents provider.
It owns its own agent loop against Moonshot's Anthropic-compatible Messages
API and executes agent tools in a local, path-confined process sandbox on
the worker. Every existing trust boundary — signed command observation,
bounded agent output, trusted publication — keeps its semantics; nothing in
the feature or goal workflow logic, approval gates, or draft-PR-only
publication path changed to support it.

## Agent loop and wire format

`runKimiAgentLoop` (`packages/adapters/src/kimi/loop.ts`) drives the loop
directly: it sends Anthropic-shaped Messages requests
(`role`/`content` with `text`, `tool_use`, and `tool_result` blocks) to
Moonshot and continues turn by turn until the agent calls `submit_result` or
`maxTurns` (default 64) is exhausted. There is no OpenAI-compatible client
anywhere in this path — `createKimiHttpTransport`
(`packages/adapters/src/kimi/transport.ts`) posts to
`{baseUrl}/v1/messages` with `x-api-key` and `anthropic-version: 2023-06-01`
headers, and its Zod schema strictly validates each content-block union
member while leaving the outer response envelope open for the additional
fields (`id`, `model`, cache token counts, etc.) a real Anthropic-compatible
endpoint returns. A single 429/5xx response is retried once after a fixed
1-second delay; any other non-2xx response or a schema failure throws
`KimiTransportError`.

The model the loop calls is whatever `model` string the agent's model
profile names — the same model-profile record used for Anthropic pricing,
just with a different provider value (see Routing below).

Five tools are exposed to the model: `bash`, `read`, `write`, `edit`, and
`submit_result`; `artifact_put`/`artifact_get` are added only when the
session was started with a credential (see Artifact access below).
`submit_result`'s payload is bounded to 256 KiB of canonically-serializable
JSON and, once accepted, ends the loop — its value becomes the session's
`collectOutput()` result verbatim. Model text/tool-call/tool-result turns
are surfaced as `RuntimeEvent`s through the same `events()` port every other
runtime exposes.

## Process sandbox and its limitations

`createKimiSandbox` (`packages/adapters/src/kimi/sandbox.ts`) materializes a
scratch working directory per session under `sandboxRoot` (default
`{os.tmpdir()}/agentos-kimi`, overridable via `AGENTOS_KIMI_SANDBOX_ROOT`).
Every tool-facing path is canonicalized against the workdir: absolute paths
are rejected, `..` escapes are rejected, and — because a relative path can
still escape through a symlink an agent wrote — the deepest existing real
path on the resolved target is also checked against the workdir's real
path, rejecting a symlink escape the same way. `bash` runs `/bin/bash -c
<command>` with the workdir as `cwd`, a timeout (default 120s, caller can
override per call), and stdout/stderr each capped at 64 KiB with a
`[truncated]` marker when Node's own `maxBuffer` cutoff fires. `edit`
requires the replacement text to match exactly one occurrence.

Stated limitations, not silent gaps:

- **Process/path isolation only.** This is confinement by path
  canonicalization and a dedicated OS process, not container or VM
  isolation. It is materially weaker than the isolation Anthropic-hosted
  Managed Agents containers provide.
- **`networking: limited` is not enforced.** The environment schema's
  `networking` field (`limited` with an allowed-host list, or
  `unrestricted`) exists for the Managed Agents path; the Kimi sandbox does
  not read or enforce it. A Kimi-routed agent's `bash` tool can reach any
  network the worker process can reach.
- **Sandbox TOCTOU is accepted for v1.** `resolveInside` resolves and
  validates a path (including walking it for a symlink escape) and returns
  it; the calling tool handler then separately acts on that same path
  (`fs.readFile`/`writeFile`/`stat`/etc.). That is a check-then-use pattern:
  nothing re-validates the path between the check and the use. A per-session
  mutex already serializes every tool call and `observeCommand` against each
  other (see Trusted command observation), which bounds _how_ concurrency
  can reach the sandbox, but it does not close the check-then-use gap
  itself — the path could still change on disk between resolution and use.
  This race is accepted for v1, not fixed.
- **`$HOME` is the agent-writable workdir.** `runBash`'s child-process
  environment sets `HOME: workdir` (alongside a minimal `PATH`/`LANG`) so
  the sandbox has _some_ home directory rather than the worker process's
  real one. The consequence: any command that consults dotfiles rooted at
  `$HOME` — `git config`, `.npmrc`, `.pnpmrc`, and similar — reads whatever
  the agent itself already wrote into the workdir during the same session.
  An agent can therefore steer the environment its own later commands (and
  a _trusted_ command observed via `observeCommand`, which shares the same
  workdir) run against. The verification role is therefore **unsupported on
  Kimi and enforced as such** — see Routing and composition below.

The agent-supplied `bash` `timeoutMs` is clamped to 120 s (advertised in the
tool schema and re-clamped in the executor, since a model may ignore the
schema), and every `runBash` — the agent's own calls and `observeCommand`'s
trusted one — is bound to the session's `AbortSignal`, so `cancel()` /
`cleanup()` kills the child instead of waiting the command out while holding
the per-session mutex the workdir destroy needs.

Sessions are worker-local process state (an in-memory `Map`, not anything
persisted): a worker restart loses every live Kimi session outright.
`reconcileStart` only ever looks in that in-memory map and returns
`undefined` when nothing is found, which is exactly the signal the existing
absence-reconciliation path already treats as "session is gone" — the run
fails closed the same way a lost Managed Agents session does. This is a
deliberate v1 boundary, not a bug to fix later: Kimi sessions never survive
a process restart, by design.

## Trusted command observation

`observeCommand(handle, expectedCommand)` is the trust anchor the whole
signed evidence chain (trusted-test-report attestations, the DoD verifier,
the goal workflow) depends on, and it is preserved exactly: the _provider_ —
trusted worker code, never the agent — executes `expectedCommand` in the
session's sandbox and returns the observed command string, exit code, and
timestamps. `session.sandbox.runBash` builds its own minimal environment
(`PATH`, `HOME`, `LANG` only) with no channel for `KIMI_API_KEY`,
`ANTHROPIC_API_KEY`, or any other inherited secret to reach the observed
process — the same secretless guarantee the Managed Agents sandbox
provides. `observeCommand` runs under the session's per-call mutex
(`withMutex`), the same mutex every tool call and `cleanup()` share, so the
agent loop can never execute concurrently with a trusted observation on the
same session — the observer role and the agent role are mutually excluded
by construction, not by convention.

Because the observed command, exit code, and timestamps have the same
shape the Managed Agents observer produces, the feature workflow's signed
trusted-test-report chain, its HMAC attestation keys, and the goal
verifier's kind-separated `definition-of-done-verification` attestations
work unchanged on Kimi-executed runs — only the executor moved, from
Anthropic's infrastructure to this worker process (already trusted code in
this architecture).

Agent output stays untrusted bounded JSON regardless of which runtime
produced it; the publication path, protected paths, and the draft-only PR
policy are unchanged and apply identically to Kimi-routed and
managed-routed roles.

## Routing and composition

`config.runtime.{provider, routing}` — previously present in the schema but
unwired — is now authoritative. `resolveRuntimeKey(config, agent)`
(`packages/adapters/src/trigger/production-handler.ts`) looks up the
agent's model profile's `provider` field in `config.runtime.routing`,
falling back to `config.runtime.provider` when that model provider has no
routing entry. `createRoutingRuntimeProvider`
(`packages/adapters/src/runtime/routing.ts`) wraps the named provider
registry behind the ordinary `RuntimeProvider` port: `syncAgent` records
which runtime each agent resolved to, `start` dispatches to that runtime,
and every `RuntimeHandle` it issues is prefixed with its owning runtime id
(`"managed <id>"` / `"kimi <id>"`) so later calls — `events`, `send`,
`resume`, `cancel`, `collectOutput`, `usage`, `observeCommand`, `cleanup` —
route back to the same provider the session was started on. Prefixing
preserves the rest of the handle object (`{...handle, id: prefixed}`): a
managed handle carries `ownershipCapability`, `runId`, `stepId`,
`credentialRefs`, `uploadedFileIds`, `deadlineAt`, and the managed provider
reads those back off the handle for ownership assertion and cleanup.

Incoming handles dispatch by exactly three rules:

1. `<runtimeId> <innerId>` → `providers[runtimeId]`, which receives the
   handle with its original unprefixed id and every other field intact.
2. **No delimiter → the default provider, passed through unchanged.** A
   composition only introduces the facade for a run that actually needs a
   non-default runtime, so every managed-only run's handle is bare; a bare
   handle is not malformed, it is a default-provider handle.
3. An unknown `<runtimeId>` fails closed (`RoutingRuntimeProviderError`).

`cleanupAccess` is partitioned by owning runtime rather than fanned out:
`kimi-file-*` / `kimi-cred-*` ids (minted by `KimiLocalAccessStore`) go to
the kimi provider only, everything else to the default provider, so neither
provider is ever asked to release ids it never issued.

Production composition
(`createProductionFeatureWorkflowFromEnv`) builds the Anthropic managed
provider exactly as before and builds the Kimi provider only when
`KIMI_API_KEY` is present and non-blank (`kimiFromEnv` treats a blank value
as absent, matching the existing dispatch-gate convention elsewhere in the
codebase). The routing facade itself is only introduced for a run whose
resolved role routing actually needs `kimi` — a managed-only run (the
common case, and every run before this feature existed) keeps producing the
exact same bare, unprefixed managed handle ids it always has, so existing
persisted/sealed handles are unaffected.

Four fail-closed rules apply at composition, before any session work
starts:

1. A run that resolves any role to the `kimi` runtime key while
   `KIMI_API_KEY` is absent throws a named error
   (`KIMI_API_KEY is required: config routes '<agent>' to the kimi
runtime`) — there is no silent fallback to the managed runtime.
2. Every resolved runtime key — not just `'kimi'` specifically — is checked
   against the actually-built provider set (`managed`, plus `kimi` when
   configured). A routing table naming an unbuilt or misspelled runtime
   fails the same way, instead of quietly defaulting that role onto
   `managed`.
3. **The `verification` role may not route to `kimi`.** Its trusted command
   (`exactTrustedCommand`) bakes container-absolute paths — `rm -rf
/workspace/repo`, `node /workspace/inputs/materialize.mjs` — which on the
   containerless Kimi sandbox would execute against the worker host's real
   filesystem. A config that resolves `verification` onto `kimi` throws
   `the verification role cannot route to the kimi runtime; route it to
managed`. This is enforced, not merely recommended.
4. **Behavior change:** this makes `config.runtime.provider` load-bearing
   for the first time. Any resolved runtime key outside `{managed, kimi}`
   now fails closed at composition — including the legacy starter value
   `provider: local`, which `agentos/example.yaml`'s `runtime.provider` used
   before this feature (when the routing section was present but unwired
   and nothing ever read it). Configurations must now name `provider:
managed` (or route a model provider to `kimi`); both
   `agentos/example.yaml` and the CLI's `STARTER_CONFIG`
   (`apps/cli/src/config-files.ts`) were updated accordingly.

The control plane's independent cancellation-path runtime
(`apps/control-plane/src/application/runtime.ts`,
`composeCancellationRuntime`) composes the same two providers whenever
`KIMI_API_KEY` is configured — not only for kimi-routed runs — so a stored
`kimi <id>` handle can still be cancelled/cleaned up outside the Trigger
worker that started it. Dispatch there is purely handle-id driven: a
`kimi <id>` handle reaches the kimi provider and a bare handle (what every
managed-only run persists) passes through to the managed provider unchanged.
`start`/`reconcileStart` deliberately bypass the facade and bind straight to
the managed provider, so this process can never persist a `managed <id>`
handle for a session the worker records bare. `assertKimiHandleSupported`
guards every handle-consuming call: if a persisted handle carries the
`kimi ` prefix but `KIMI_API_KEY` has since been removed from the
environment, the guard throws instead of letting the bare managed provider
receive the prefixed string as if it were one of its own session ids.

`.env.example` documents `KIMI_API_KEY` (required only when a model profile
routes to `kimi`), and the commented `KIMI_BASE_URL` (defaults to
`https://api.moonshot.ai/anthropic`) and `AGENTOS_KIMI_SANDBOX_ROOT`
overrides. `agentos/example.yaml` gains a commented `kimi` model profile
(`provider: kimi`, `model: kimi-k2-0905-preview`) and a commented
`routing: { kimi: kimi }` example mapping that model-profile provider onto
the `kimi` runtime.

## Sessions, usage, and accepted no-ops

Each `start()` derives a stable session id via an HMAC over
`ownershipSecret` and the run/step binding
(`kimi-session-id-v1` canonical JSON of `{runId, stepId}`), mirroring the
managed provider's ownership derivation so `reconcileStart` recognizes only
its own worker's sessions and never adopts a foreign one. Token usage
(`inputTokens`/`outputTokens`) accumulates from every Moonshot response and
is returned by `usage()` in the standard `RuntimeUsage` shape alongside
elapsed wall-clock `runtimeMs`, so the existing per-model pricing
configuration (input/output microdollars, runtime minutes) prices Kimi work
without any new billing code. The running total is pushed into the session
after **every** turn (`runKimiAgentLoop`'s `onUsage`), not only when the loop
settles, so a session that is cancelled or cleaned up mid-run still reports
the tokens it actually spent.

`cancel()`/`cleanup()` abort the session's `AbortSignal`, which now reaches
the in-flight Moonshot request (threaded through `KimiTransport.send`) and is
re-checked before every individual tool dispatch inside a turn — so a cancel
that lands between two tool calls skips the rest of them instead of letting a
post-cleanup `write` recreate the destroyed workdir.

Two provider behaviors are accepted v1 limitations, not implementation
mistakes:

- **`send`/`resume` are accepted no-ops.** They're accepted rather than
  rejected — `send` queues the message onto `session.pendingUserTurns` — but
  `runKimiAgentLoop` never reads that queue, so nothing injected through
  `send`/`resume` reaches an in-flight loop. `resume` merely forwards its
  `input` to `send`.
- **`maxCostMicrodollars` is not enforced by the provider.** Unlike the
  Managed Agents provider (`managedBudget` in
  `packages/adapters/src/managed-agents/provider.ts`), `start()` never
  reads `request.maxCostMicrodollars` at all. Spend is still bounded, but
  only by workflow-side budget reservation and settlement — the runtime
  itself performs no local budget check.

## Artifact access

Artifact reads/writes go through the same step-scoped Artifact MCP
capability the managed path uses, over HTTPS, using the same bearer
capability tokens the managed path issues — the raw bearer is resolved by
`artifactMcp.resolveCredential(ref)` inside provider code and is never
rendered into the model's context; the model only ever sees the tool
interface (`artifact_put`/`artifact_get`, added to the tool list only when
a credential is present). Every Artifact MCP call is bounded by
`AbortSignal.any([sessionSignal, AbortSignal.timeout(60_000)])`: cancelling
the session (or the session simply ending) or a fixed 60-second cap always
releases the per-session mutex the call runs under, so a stuck Artifact MCP
server can never hold `cancel()`/`cleanup()` open indefinitely.

Because a Kimi session never leaves the worker process,
`production-handler.ts`'s `runtimeAccess.prepare` stages the same
bytes/token the managed path would otherwise upload into
`KimiLocalAccessStore`
(`packages/adapters/src/kimi/access.ts`) — an in-process map from opaque
`kimi-file-*`/`kimi-cred-*` ids to bytes/bearer — instead of calling
`managedProvider.provisionSessionAccess`. Staging also rewrites the mount
paths: the caller hands over the same container-absolute paths the managed
uploader takes, and `toKimiSandboxMountPath` maps them onto the sandbox by
stripping the leading `/workspace/` (`/workspace/inputs/source-bundle.json`
→ `inputs/source-bundle.json`), because the per-session workdir _is_ that
session's `/workspace` and the sandbox rejects absolute paths outright. A
Kimi-routed agent therefore finds its inputs at workdir-relative
`inputs/…`. Discarding those staged entries
(`cleanupAccess`) is wired to `store.discard(...)` in the Trigger worker
process that actually staged them (`createKimiRuntimeProviderFromEnv`'s
default `wireAccessCleanup: true`); the control plane's own cancellation
runtime builds a separate, fresh `KimiLocalAccessStore` instance and passes
`wireAccessCleanup: false`, so its `cleanupAccess` call is a documented
no-op there — nothing it could stage ever appears in that instance to
discard. Real discard only ever happens worker-side.

## Verification boundary

All default gates stay no-cost, matching the rest of the codebase's
convention. Unit tests exercise the loop against a fake transport (multi-turn
tool use, bash/file tool dispatch, path-escape and symlink-escape rejection,
output truncation, `submit_result` contract enforcement including the byte
bound, secretless `observeCommand`, cancellation mid-request, usage
accumulation, and ownership-bound session reconciliation); the routing
facade is tested for dispatch, handle-affinity, and unknown-provider
failure; composition tests cover the `KIMI_API_KEY` fail-closed rules; and
configuration tests cover `runtime.routing` validation.

A live smoke script, `packages/adapters/scripts/kimi-smoke.mjs` (run via
`pnpm --filter @agentos/adapters smoke:kimi`), sends one real request
against the configured Kimi endpoint to prove credentials and wire
compatibility — no sandbox, no session. It follows the same opt-in
convention as the existing R2/Managed Agents smoke scripts: it exits 0
(printing a skip notice) unless both `AGENTOS_LIVE_TESTS=1` and
`KIMI_API_KEY` are set, so it never runs, and never spends anything, in the
default local or CI matrix. Typecheck, lint, build, and Playwright remain
unaffected and run in the standard matrix regardless of Kimi configuration.
