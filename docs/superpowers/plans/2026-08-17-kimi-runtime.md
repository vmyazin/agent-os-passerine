# Kimi Runtime Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run agent roles on Moonshot Kimi K2 models alongside Anthropic via a self-hosted process-sandbox runtime provider, routed by model-profile provider.

**Architecture:** A new `packages/adapters/src/kimi/` adapter implements the core `RuntimeProvider` port by owning the agent loop against Moonshot's Anthropic-compatible Messages API and executing tools in a path-confined per-session workdir. A routing facade dispatches each agent to its runtime by model-profile provider through `config.runtime.{provider, routing}`; production composition builds the Kimi provider only when `KIMI_API_KEY` is present and fails closed otherwise.

**Tech Stack:** TypeScript 6, Zod 4, Vitest, Node `fetch`/`node:crypto`/`node:child_process`, Trigger.dev v4, pnpm/Turborepo.

**Spec:** `docs/superpowers/specs/2026-08-17-kimi-runtime-design.md`

## Global Constraints

- **Ordering (user preference):** implement directly, then add tests in the same task for the high-value surfaces named in each task. Do not restructure into test-first.
- No new npm dependencies: use global `fetch`, `node:crypto`, `node:child_process`, `node:fs/promises`.
- Default Moonshot endpoint: `https://api.moonshot.ai/anthropic` (append `/v1/messages`); override via `KIMI_BASE_URL`.
- Blank env values are absent (match `workflowDispatchFromEnv` convention in `apps/control-plane/src/application/runtime.ts`).
- Fail closed everywhere; never silently fall back from Kimi to Anthropic.
- No secrets in sandbox process environments; `observeCommand` runs secretless.
- Bounds: bash/tool output ≤ 64 KiB captured; file reads ≤ 1 MiB; `submit_result` payload ≤ 256 KiB; loop ≤ 64 model turns.
- All code `pnpm format:check`-clean; suites colocated `*.test.ts`, run with `pnpm --filter @agentos/adapters exec vitest run <path>`.
- Commit style: house one-line conventional commits ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Kimi Messages transport and agent loop

**Files:**

- Create: `packages/adapters/src/kimi/types.ts`
- Create: `packages/adapters/src/kimi/transport.ts`
- Create: `packages/adapters/src/kimi/loop.ts`
- Test: `packages/adapters/src/kimi/loop.test.ts`

**Interfaces:**

- Consumes: nothing internal; wire shapes are Anthropic Messages (tool use).
- Produces (used by Task 3):

```ts
// types.ts
export interface KimiMessage {
  readonly role: 'user' | 'assistant';
  readonly content: readonly KimiContentBlock[];
}
export type KimiContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'tool_use';
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly type: 'tool_result';
      readonly tool_use_id: string;
      readonly content: string;
      readonly is_error?: boolean;
    };
export interface KimiTransport {
  send(request: {
    readonly model: string;
    readonly system?: string;
    readonly messages: readonly KimiMessage[];
    readonly tools: readonly {
      name: string;
      description: string;
      input_schema: unknown;
    }[];
    readonly maxTokens: number;
  }): Promise<{
    readonly content: readonly KimiContentBlock[];
    readonly stopReason: string;
    readonly usage: {
      readonly inputTokens: number;
      readonly outputTokens: number;
    };
  }>;
}
export interface KimiToolExecutor {
  execute(
    name: string,
    input: unknown,
  ): Promise<{ readonly content: string; readonly isError: boolean }>;
}
export interface KimiLoopResult {
  readonly status: 'submitted' | 'turn_limit' | 'cancelled';
  readonly result?: unknown; // submit_result payload when status === 'submitted'
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
  readonly turns: number;
}
export function runKimiAgentLoop(options: {
  readonly transport: KimiTransport;
  readonly model: string;
  readonly system?: string;
  readonly initialInput: unknown;
  readonly tools: readonly {
    name: string;
    description: string;
    input_schema: unknown;
  }[];
  readonly executor: KimiToolExecutor;
  readonly maxTurns?: number; // default 64
  readonly signal: AbortSignal;
  readonly onEvent: (event: {
    type: 'message' | 'tool_call' | 'tool_result';
    detail: string;
  }) => void;
}): Promise<KimiLoopResult>;
export function createKimiHttpTransport(options: {
  readonly apiKey: string;
  readonly baseUrl?: string; // default https://api.moonshot.ai/anthropic
  readonly fetchImpl?: typeof fetch;
}): KimiTransport;
```

- [ ] **Step 1: Implement `transport.ts`**

`createKimiHttpTransport` POSTs `${baseUrl}/v1/messages` with headers `content-type: application/json`, `x-api-key: <apiKey>`, `anthropic-version: 2023-06-01`; body `{model, system?, messages, tools, max_tokens: maxTokens}`. Non-2xx → throw `KimiTransportError` (define in `types.ts`, carrying `status` and a ≤500-char body slice). Parse response with a strict Zod schema accepting only the three content-block shapes above plus `stop_reason` and `usage.input_tokens/output_tokens`; unknown block types are a parse failure (fail closed). Retry once on 429/5xx after 1s.

- [ ] **Step 2: Implement `loop.ts`**

`runKimiAgentLoop`: seed `messages` with one user turn containing `JSON.stringify(initialInput)` as text. Each iteration: check `signal.aborted` → return `{status: 'cancelled', ...}`; call `transport.send`; accumulate usage; emit `onEvent({type: 'message', ...})` for text blocks. For each `tool_use` block: if `name === 'submit_result'`, validate the input is JSON-serializable and `canonicalJsonValue(input).length <= 256 * 1024` (import from `@agentos/core`) and return `{status: 'submitted', result: input, ...}`; otherwise call `executor.execute(name, input)` (emit `tool_call`/`tool_result` events) and append one `tool_result` block per call in a single user turn. If a response has no `tool_use` blocks, append a user turn `"Continue. Use submit_result to finish."` (models sometimes stall); after `maxTurns` iterations return `{status: 'turn_limit', ...}`.

- [ ] **Step 3: Add tests (`loop.test.ts`)**

Fake transport (scripted responses, no HTTP). Cover, at minimum:

1. two tool calls then `submit_result` → `status: 'submitted'`, result round-trips, usage sums across turns, events emitted in order;
2. parallel `tool_use` blocks in one response → all results returned in a single user turn (assert message shape);
3. executor error → `is_error: true` tool_result and the loop continues;
4. oversized `submit_result` payload → loop returns a `tool_result` error to the model, does not submit;
5. abort mid-loop → `status: 'cancelled'`;
6. turn limit reached → `status: 'turn_limit'`;
7. transport schema rejection: unknown content-block type from the fake → loop rejects (fail closed).

Also one `createKimiHttpTransport` test with a stubbed `fetchImpl` asserting URL, headers, body shape, and 429-then-200 retry.

- [ ] **Step 4: Run and commit**

Run: `pnpm --filter @agentos/adapters exec vitest run src/kimi/loop.test.ts` → all pass. Then `pnpm exec prettier --write packages/adapters/src/kimi/ && git add -A packages/adapters/src/kimi && git commit -m "feat: add kimi agent loop"`.

### Task 2: Local process sandbox

**Files:**

- Create: `packages/adapters/src/kimi/sandbox.ts`
- Test: `packages/adapters/src/kimi/sandbox.test.ts`

**Interfaces:**

- Produces (used by Task 3):

```ts
export interface KimiSandbox {
  readonly workdir: string;
  materialize(
    files: readonly { path: string; content: Uint8Array; readonly?: boolean }[],
  ): Promise<void>;
  readFile(relativePath: string): Promise<string>; // ≤ 1 MiB, UTF-8
  writeFile(relativePath: string, content: string): Promise<void>;
  editFile(
    relativePath: string,
    oldText: string,
    newText: string,
  ): Promise<void>; // exactly-one-occurrence
  runBash(
    command: string,
    options?: { timeoutMs?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  destroy(): Promise<void>;
}
export function createKimiSandbox(options: {
  readonly root: string; // sandboxRoot
  readonly sessionId: string; // becomes the workdir name (validated [A-Za-z0-9_-]+)
}): Promise<KimiSandbox>;
```

- [ ] **Step 1: Implement `sandbox.ts`**

Workdir = `path.join(root, sessionId)` (reject invalid sessionId; `fs.mkdir` recursive). Path confinement helper: `resolveInside(relative)` → `path.resolve(workdir, relative)`, then `fs.realpath` the deepest existing ancestor and require the resolved path (and real ancestor) start with `workdir + path.sep` — rejects `..`, absolute paths, and symlink escapes. `runBash` uses `child_process.execFile('/bin/bash', ['-c', command], {cwd: workdir, timeout, maxBuffer: 64 * 1024, env: {PATH: process.env.PATH ?? '', HOME: workdir, LANG: 'C.UTF-8'}})` — an explicitly constructed env, never `process.env` spread; timeout default 120s; on kill return exitCode 124. Truncate stdout/stderr at 64 KiB with a `\n[truncated]` marker. `destroy` = `fs.rm(workdir, {recursive: true, force: true})`.

- [ ] **Step 2: Add tests (`sandbox.test.ts`)**

Use a temp dir (`fs.mkdtemp`). Cover: write→read→edit round trip; edit rejects zero and multiple matches; `../escape`, absolute path, and symlink-out-of-workdir all rejected for read/write/edit; oversized read rejected; bash runs in workdir with only the constructed env (assert `process.env`-only variable like `TEST_SECRET=x` set in the test is NOT visible inside); bash timeout returns 124; output truncation marker; destroy removes the tree.

- [ ] **Step 3: Run and commit**

Run: `pnpm --filter @agentos/adapters exec vitest run src/kimi/sandbox.test.ts` → pass. Commit `feat: add kimi local sandbox`.

### Task 3: Kimi runtime provider

**Files:**

- Create: `packages/adapters/src/kimi/provider.ts`
- Create: `packages/adapters/src/kimi/index.ts` (re-export provider + types)
- Modify: `packages/adapters/src/index.ts` (add `export * from './kimi/index.js';`)
- Test: `packages/adapters/src/kimi/provider.test.ts`

**Interfaces:**

- Consumes: `runKimiAgentLoop`, `createKimiHttpTransport` (Task 1), `createKimiSandbox` (Task 2); core `RuntimeProvider`, `RuntimeStartRequest`, `RuntimeHandle`, `RuntimeEvent`, `RuntimeOutput`, `RuntimeUsage`, `RuntimeObservedCommand` from `@agentos/core`.
- Produces (used by Tasks 4–5):

```ts
export interface KimiRuntimeProviderOptions {
  readonly apiKey: string;
  readonly ownershipSecret: string; // ≥ 32 bytes
  readonly sandboxRoot: string;
  readonly baseUrl?: string;
  readonly transport?: KimiTransport; // test seam; default createKimiHttpTransport
  readonly resolveFile?: (fileId: string) => Promise<Uint8Array>; // resolves RuntimeFileResource fileIds
  readonly artifactMcp?: {
    readonly url: string; // AGENTOS_ARTIFACT_MCP_URL
    readonly resolveCredential: (ref: string) => Promise<string>; // credentialRef -> bearer capability
    readonly fetchImpl?: typeof fetch; // test seam
  };
  readonly clock?: () => string;
}
export function createKimiRuntimeProvider(
  options: KimiRuntimeProviderOptions,
): RuntimeProvider;
```

- [ ] **Step 1: Implement `provider.ts`**

In-memory session registry `Map<string, KimiSession>` where `KimiSession = {handle, sandbox, controller: AbortController, events: RuntimeEvent[], waiters, loopPromise, usage, result, status}`. Details:

- **Identity/ownership:** session id = `kimi_` + first 32 hex of `createHmac('sha256', ownershipSecret).update(`${runId}\0${stepId}\0${idempotencyKey ?? ''}`).digest('hex')`. `start` with an id already registered returns the existing handle (idempotent). `reconcileStart` recomputes the id and returns the registered handle or `undefined` (worker-local sessions; absence is the designed answer after restart).
- **syncAgent/syncEnvironment:** store the latest `RuntimeAgent`/`RuntimeEnvironment` by id in maps (the loop needs `agent.model` and `agent.instructions` as system prompt at `start`; unknown `agentId` at start → throw).
- **start:** create sandbox via `createKimiSandbox({root: sandboxRoot, sessionId})`; materialize `request.resources` through `options.resolveFile` (absent resolver + non-empty resources → throw, fail closed); build tools (`bash`, `read`, `write`, `edit`, `submit_result` with JSON input schemas; plus `artifact_put`/`artifact_get` when `artifactMcp` is configured AND `request.credentialRefs` is non-empty — they resolve the first credentialRef to a bearer via `resolveCredential` and call the Artifact MCP HTTP endpoint with it, mirroring the request/response shapes the MCP route in `apps/control-plane/src/http` serves; the bearer never appears in model-visible text, and a kimi-routed step whose request carries credentialRefs while `artifactMcp` is unconfigured throws, fail closed) whose executor delegates to the sandbox; launch `runKimiAgentLoop` (not awaited) with `signal: controller.signal`, `onEvent` appending `RuntimeEvent`s (`persistenceId`-style ids `kimiEvent_<n>`, types `message`/`tool_call`/`tool_result`); on loop resolution append `terminated` (submitted) or `error` (turn_limit) events. Return `Object.freeze({id: sessionId})`.
- **events:** async generator replaying buffered events then awaiting new ones until a terminal event; unknown handle → single `error` event then return (mirrors absence semantics).
- **send/resume:** enqueue user text into the loop (append a pending user turn consumed on the next iteration); no-op on terminal sessions.
- **cancel:** `controller.abort()`, append `terminated` event with reason.
- **collectOutput:** await `loopPromise`; `status === 'submitted'` → `{output: result}` in the existing `RuntimeOutput` shape; otherwise throw.
- **usage:** return accumulated token counts mapped into `RuntimeUsage` (input/output tokens; wall-clock minutes from start→now via `clock`).
- **cleanup:** abort if running, `sandbox.destroy()`, delete from registry.
- **observeCommand(handle, expectedCommand):** run `expectedCommand` through the session sandbox's `runBash` **with a freshly constructed secretless env** (same construction as Task 2 — assert no `apiKey` present), recording `startedAt`/`completedAt` from `clock` and returning `{command: expectedCommand, exitCode, startedAt, completedAt}` in the core `RuntimeObservedCommand` shape. The agent loop is paused during observation (take a per-session mutex; simplest: await a session-level promise chain).

Mirror the managed provider's freeze/validation idioms (`packages/adapters/src/managed-agents/provider.ts`): validate `apiKey`/`ownershipSecret` non-empty at construction, `ownershipSecret` ≥ 32 bytes.

- [ ] **Step 2: Add tests (`provider.test.ts`)**

Fake transport + temp sandbox root. Cover: full start→events→collectOutput happy path with a scripted write-file-then-submit session (assert the file exists in the workdir and the output round-trips); idempotent `start` and `reconcileStart` same-id recognition plus `undefined` for a foreign binding; unknown agentId start rejection; cancel mid-loop → terminal event + `collectOutput` throws; `usage()` token accumulation; `observeCommand` returns exit 0 for `true`, nonzero for `false`, and — high-value — an env-leak probe: run `observeCommand(handle, 'printenv KIMI_TEST_SECRET; true')` with `KIMI_TEST_SECRET` set in `process.env` for the test and assert empty observed output; an `artifact_put`/`artifact_get` round trip against a stubbed `fetchImpl` asserting the resolved bearer is sent as `Authorization` and never echoed into the tool result; cleanup removes the workdir and unregisters.

- [ ] **Step 3: Run, build, commit**

Run: `pnpm --filter @agentos/adapters exec vitest run src/kimi` → pass. `pnpm --filter @agentos/adapters build` (dist consumers). Commit `feat: add kimi runtime provider`.

### Task 4: Routing runtime facade

**Files:**

- Create: `packages/adapters/src/runtime/routing.ts`
- Create: `packages/adapters/src/runtime/routing.test.ts`
- Modify: `packages/adapters/src/index.ts` (export)

**Interfaces:**

- Consumes: core `RuntimeProvider` port only.
- Produces (used by Task 5):

```ts
export interface RoutingRuntimeProviderOptions {
  readonly providers: Readonly<Record<string, RuntimeProvider>>;
  readonly defaultProvider: string; // key into providers
  readonly route: (agent: RuntimeAgent) => string | undefined; // runtime id or undefined → default
}
export function createRoutingRuntimeProvider(
  options: RoutingRuntimeProviderOptions,
): RuntimeProvider;
```

- [ ] **Step 1: Implement `routing.ts`**

Constructor validates `defaultProvider` exists and `providers` non-empty. `syncAgent(agent)`: resolve `route(agent) ?? defaultProvider`; unknown key → throw `unknown runtime provider '<id>'` (fail closed, never fall back); record `agentId → runtimeId`; forward to that provider. `syncEnvironment`: forward to **all** providers (environments are provider-neutral). `start(request)`: look up the recorded runtime for `request.agentId` (unrecorded → throw); forward; wrap the returned handle as `{id: `${runtimeId}\0${handle.id}`}`. Handle-consuming methods (`events`, `send`, `resume`, `cancel`, `collectOutput`, `usage`, `cleanup`, `observeCommand`, `reconcileStart` result unwrap): split on the first `\0`; unknown prefix → throw; forward with the inner handle. `reconcileStart` consults the recorded runtime for the agent, else tries `defaultProvider`. Optional methods (`observeCommand`, `cleanupAccess`, `reconcileStart`) forward only when the target provider defines them; `cleanupAccess` fans out to all providers that define it.

- [ ] **Step 2: Add tests (`routing.test.ts`)**

Two stub providers recording calls. Cover: route by agent → start/events/cancel reach the right provider with the unwrapped handle; default routing when `route` returns `undefined`; unknown route id and unknown handle prefix both throw; syncEnvironment fan-out; observeCommand forwarded only when defined; wrapped handle id round-trips through events/collectOutput/cleanup.

- [ ] **Step 3: Run and commit**

Run: `pnpm --filter @agentos/adapters exec vitest run src/runtime/routing.test.ts` → pass. Commit `feat: route runtime sessions by provider`.

### Task 5: Production composition and fail-closed env wiring

**Files:**

- Create: `packages/adapters/src/kimi/access.ts` (local runtime-access preparer)
- Test: `packages/adapters/src/kimi/access.test.ts`
- Modify: `packages/adapters/src/trigger/production-handler.ts`
- Modify: `packages/adapters/src/trigger/production-handler.test.ts`
- Modify: `apps/control-plane/src/application/runtime.ts` (cancellation runtime path)
- Test: extend `packages/adapters/src/trigger/production-composition.test.ts`

**Interfaces:**

- Consumes: `createKimiRuntimeProvider` (Task 3), `createRoutingRuntimeProvider` (Task 4), existing `createManagedAgentsRuntimeProvider`, `parseAgentOsConfig`.
- Produces: no new exports; behavior change in `createProductionFeatureWorkflowFromEnv` and the control-plane cancellation runtime.

- [ ] **Step 1: Implement the local access preparer (`access.ts`)**

The managed path's `dependencies.runtimeAccess.prepare` uploads mounted files and capability credentials to Anthropic vaults; kimi sessions are local, so provide the local equivalent:

```ts
export interface KimiLocalAccessStore {
  readonly resolveFile: (fileId: string) => Promise<Uint8Array>;
  readonly resolveCredential: (ref: string) => Promise<string>;
  stage(input: {
    readonly files: readonly {
      readonly bytes: Uint8Array;
      readonly mountPath: string;
    }[];
    readonly credentials: readonly { readonly token: string }[];
  }): {
    readonly resources: RuntimeFileResource[];
    readonly credentialRefs: string[];
  };
  discard(refs: {
    readonly fileIds: readonly string[];
    readonly credentialRefs: readonly string[];
  }): void;
}
export function createKimiLocalAccessStore(): KimiLocalAccessStore;
```

`stage` generates opaque ids (`kimi-file-<hmac-free random hex>` / `kimi-cred-<hex>` via `crypto.randomBytes`), holds bytes/tokens in in-process maps, and returns the shapes `RuntimeStartRequest` already carries; `resolveFile`/`resolveCredential` throw on unknown ids. Wire it into a kimi-flavored `runtimeAccess.prepare` in composition (Step 2), routed by the same `resolveRuntimeKey` — the managed preparer keeps handling managed-routed roles, byte-identical. Tests (`access.test.ts`): stage→resolve round trip for files and credentials, unknown-id rejection, discard removes entries.

- [ ] **Step 2: Implement composition in `production-handler.ts`**

Add a helper next to the existing runtime construction:

```ts
function kimiFromEnv(
  environment: Environment,
): { apiKey: string; baseUrl?: string } | undefined {
  const apiKey = environment.KIMI_API_KEY?.trim();
  if (!apiKey) return undefined;
  const baseUrl = environment.KIMI_BASE_URL?.trim();
  return { apiKey, ...(baseUrl ? { baseUrl } : {}) };
}
```

Where the managed provider is built for the feature workflow, build instead a routing provider: `providers = {managed: managedProvider, ...(kimi ? {kimi: createKimiRuntimeProvider({...kimi, ownershipSecret, sandboxRoot})} : {})}` with `sandboxRoot` from `AGENTOS_KIMI_SANDBOX_ROOT?.trim() || os.tmpdir() + '/agentos-kimi'`. `defaultProvider` and `route` come from the run's applied config snapshot (the composition already parses it — reuse that `config`): `route = (agent) => resolveRuntimeKey(config, agent)` where `resolveRuntimeKey(config, agent)` is an exported pure helper that finds the agent definition whose id matches, reads `config.models[definition.model].provider`, and returns `config.runtime.routing[provider] ?? config.runtime.provider`. **Fail-closed rule:** while building roles, if any resolved runtime key is `kimi` and `kimiFromEnv` returned `undefined`, throw `new Error('KIMI_API_KEY is required: config routes <agent> to the kimi runtime')` before any session work. A runtime key that is neither `managed` nor a built provider throws the routing facade's unknown-provider error at sync time — also acceptable, but the composition-time check gives the operator the named error. Keep the managed-only path byte-identical when no model profile routes to kimi (routing facade with a single provider is fine — verify no behavior change via existing tests). Apply the same wiring to `cancellationRuntime()` in `apps/control-plane/src/application/runtime.ts` (cancel must reach whichever provider owns the handle; the wrapped handle prefix does the dispatch, so the control plane needs the same registry construction, kimi included only when the env provides the key).

- [ ] **Step 3: Add composition tests**

In `production-composition.test.ts` / `production-handler.test.ts` style (env-record in, assertions out): (1) no `KIMI_API_KEY` + config routing an agent's model provider to `kimi` → handler initialization rejects with the named error; (2) `KIMI_API_KEY` present → registry contains kimi and a kimi-routed agent's `start` produces a `kimi�`-prefixed handle (use the existing fake-injection seams; if the production path resists cheap fakes, test the extracted pure helper `resolveRuntimeKey(config, agent)` + `kimiFromEnv` directly and assert the error path through the composition); (3) blank `KIMI_API_KEY=''` treated as absent; (4) config with no kimi routing + no key → identical role/runtime construction as before (regression guard: existing production-handler tests stay green untouched).

- [ ] **Step 4: Run and commit**

Run: `pnpm --filter @agentos/adapters test && pnpm --filter @agentos/control-plane test` → pass. Commit `feat: compose kimi runtime with fail-closed routing`.

### Task 6: Operator surfaces — env template, example config, live smoke

**Files:**

- Modify: `.env.example`
- Modify: `agentos/example.yaml`
- Create: `packages/adapters/scripts/kimi-smoke.mjs`

**Interfaces:** none new; operator-facing only.

- [ ] **Step 1: Update templates**

`.env.example`, after the Anthropic block:

```
# Moonshot Kimi runtime. Sessions run in a local process sandbox on the
# worker; the key is required only when a model profile routes to kimi.
KIMI_API_KEY=
# KIMI_BASE_URL=https://api.moonshot.ai/anthropic
# AGENTOS_KIMI_SANDBOX_ROOT=/var/tmp/agentos-kimi
```

`agentos/example.yaml`: add a commented model-profile block under `models:` showing `provider: kimi`, `model: kimi-k2-0905-preview`, the three pricing fields, and a commented `runtime:` routing example mapping `kimi: kimi` — commented so checked-in starter digests and tests are unchanged (verify `pnpm --filter @agentos/core test` and control-plane config tests stay green).

- [ ] **Step 2: Add `kimi-smoke.mjs`**

Mirror `managed-agents-smoke.mjs` gating: exit 0 with a notice unless `AGENTOS_LIVE_TESTS === '1'` and `KIMI_API_KEY` present. Then: construct `createKimiHttpTransport` from env, send one 32-token request (`model: process.env.KIMI_SMOKE_MODEL ?? 'kimi-k2-0905-preview'`, user text "Reply with OK."), print stop reason and usage. No sandbox, no session — the smoke proves credentials + endpoint compatibility only.

- [ ] **Step 3: Verify and commit**

Run: `pnpm test` (root) → green; `node packages/adapters/scripts/kimi-smoke.mjs` without env → prints skip notice, exit 0. Commit `feat: expose kimi runtime operator surfaces`.

### Task 7: Documentation, full verification, and review

**Files:**

- Create: `docs/architecture/kimi-runtime.md`
- Modify: `docs/architecture/README.md`
- Modify: `docs/progress.md`

- [ ] **Step 1: Write `docs/architecture/kimi-runtime.md`**

House style (see `durable-goal-workflow.md`): sections for the agent loop and wire format (Anthropic-compatible Messages against Moonshot, strict schema, no OpenAI shape), the process sandbox and its stated limitations (process/path confinement, `networking: limited` not enforced, worker-local sessions failing closed via absence reconciliation), trusted command observation (provider-executed, secretless env, unchanged report/attestation chain), routing and composition (model-profile provider → `config.runtime.routing`, handle-embedded runtime ids, `KIMI_API_KEY`/`KIMI_BASE_URL`/`AGENTOS_KIMI_SANDBOX_ROOT`, fail-closed rules), and the verification boundary (no-cost default suite, `AGENTOS_LIVE_TESTS=1` + `KIMI_API_KEY` smoke). Link it from `docs/architecture/README.md`; update `docs/progress.md`: mark the self-hosted runtime slice started via the Kimi provider, list honest limitations, keep unimplemented stages unclaimed.

- [ ] **Step 2: Full verification matrix**

Run: `pnpm format:check && pnpm db:check && pnpm test && pnpm typecheck && pnpm lint && pnpm build && pnpm test:e2e` — all green. (`TEST_DATABASE_URL` from `.env.local` additionally enables `pnpm test:integration`; run it — persistence is untouched but the guard is cheap.)

- [ ] **Step 3: Final review and integrate**

Dispatch the code-review subagent over the branch range (base = commit before Task 1) with the spec + this plan as requirements; fix critical/important findings; re-run affected suites and the matrix; then use superpowers:finishing-a-development-branch. Commit docs as `docs: record kimi runtime provider`.
