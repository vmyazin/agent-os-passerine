# Local Direct Runtime — implementation plan

Spec: [2026-09-02-local-direct-runtime-design.md](../specs/2026-09-02-local-direct-runtime-design.md)
Branch: `feat/local-direct-runtime`, based on `fix/pipeline-reliability-and-resume`
(the design needs `releaseRunForResume`, which exists only there —
`packages/adapters/src/trigger/types.ts:397`).

> **Follow-up decision — 2026-09-02, overrides the spec's "Local dispatcher"
> bullet on `retrieve`.** The spec said a lost execution returns
> `{status: 'lost'}` and that the outbox would treat it as an unreachable
> executor. Reading the code disproves it: `isExecutorUnavailable`
> (`packages/adapters/src/trigger/outbox.ts:278-285`) requires **both**
> `status === 'SYSTEM_FAILURE'` and an `error` containing
> `COULD_NOT_FIND_EXECUTOR`. The local dispatcher therefore returns exactly
> that shape for a lost execution, which is a faithful description rather than
> a workaround. Task 3 encodes it.

## File map

Create:

- `packages/adapters/src/artifacts/filesystem.ts` — filesystem `ArtifactStore` +
  `ArtifactAdminStore`
- `packages/adapters/src/artifacts/filesystem.test.ts`
- `packages/adapters/src/local-direct/approval-waiter.ts` + `.test.ts`
- `packages/adapters/src/local-direct/dispatcher.ts` + `.test.ts`
- `packages/adapters/src/local-direct/composition.ts` + `.test.ts`
- `packages/adapters/src/local-direct/index.ts`
- `packages/adapters/scripts/local-direct-smoke.mjs`

Modify, with the target region:

- `packages/adapters/src/artifacts/index.ts` — add the filesystem export
- `packages/core/src/ports.ts:6-12` — `RuntimeAgent.modelProvider?: string`
- `packages/adapters/src/kimi/types.ts`, `from-env.ts`, `provider.ts:~360-430`
  (resources), `provider.ts:~853-921` (`callArtifactMcp`), `provider.ts:~984`
  (URL validation) — transport registry, in-process MCP, source unpack
- `packages/adapters/src/trigger/production-handler.ts:236-241`
  (`exactTrustedCommand`), `:286-297` (`resolveRuntimeKey`), `:317-351`
  (`resolveRoleRuntimeKeys`), `:353-540` (extract shared helpers)
- `apps/control-plane/src/application/runtime.ts:471-500`
  (`workflowDispatchFromEnv`)
- `apps/control-plane/src/application/setup-readiness.ts` — executor reporting
- `.env.example`, `docs/architecture/kimi-runtime.md`,
  `docs/architecture/durable-feature-workflow.md`, `docs/progress.md`
- `packages/adapters/package.json` — `smoke:local-direct`

**Do not modify:**

- `packages/adapters/src/trigger/workflow.ts`
- `packages/adapters/src/trigger/outbox.ts`
- `packages/adapters/src/trigger/production-composition.ts` role rules
- `packages/adapters/src/managed-agents/**`
- `packages/adapters/src/github/**`
- `packages/adapters/src/local-git/**`
- `packages/adapters/src/trigger/verifier.ts`, `goal-verifier.ts`
- `packages/adapters/src/persistence/**`
- any file under `drizzle/`

## Tasks

- [ ] **1. Filesystem artifact store.** Creates `artifacts/filesystem.ts`,
      `filesystem.test.ts`; modifies `artifacts/index.ts`. Content-addressed
      under `<root>/artifacts/v1/<projectId>/<runId>/<stepId>/...`, same scope
      denial and size rules as `in-memory.ts`. Verify:
      `pnpm --filter @agentos/adapters test -- filesystem`
- [ ] **2. Local approval waiter.** Creates `local-direct/approval-waiter.ts`
      + test. Resolves on `wake`, on poll when the approval row is `consumed`,
      and `timed_out` past `expiresAt`. Verify:
      `pnpm --filter @agentos/adapters test -- approval-waiter`
- [ ] **3. Local dispatcher.** Creates `local-direct/dispatcher.ts` + test.
      Implements `TriggerWorkflowDispatcher`; reference
      `local-direct:<runId>:<generation>`; one transient retry; `startGoal`
      refuses; lost execution returns the `SYSTEM_FAILURE` /
      `COULD_NOT_FIND_EXECUTOR` shape per the follow-up decision above.
      Verify: `pnpm --filter @agentos/adapters test -- dispatcher`
- [ ] **4. Model-provider transports.** Modifies `core/src/ports.ts`,
      `kimi/types.ts`, `kimi/from-env.ts`, `kimi/provider.ts`,
      `trigger/production-handler.ts` (fill `modelProvider` on `syncAgent`).
      A registry keyed by model provider; missing key fails closed by name.
      Verify: `pnpm --filter @agentos/adapters test -- kimi && pnpm typecheck`
- [ ] **5. Source tree in the sandbox.** Modifies `kimi/provider.ts` resource
      materialization: unpack a `source-bundle-v1` body into `repo/` beside
      the JSON. Verify: `pnpm --filter @agentos/adapters test -- kimi`
- [ ] **6. In-process artifact MCP.** Modifies `kimi/provider.ts`
      (`artifactMcp.fetch` option, used instead of `globalThis.fetch` when
      given). Verify: `pnpm --filter @agentos/adapters test -- kimi`
- [ ] **7. Shared composition helpers + `process` alias.** Modifies
      `trigger/production-handler.ts`: export the key/sealer/allowlist/budget
      helpers the two compositions share; accept `process` as an alias of the
      `kimi` runtime key; workdir-relative trusted command for the local
      composition. Verify: `pnpm --filter @agentos/adapters test -- production`
- [ ] **8. Local composition.** Creates `local-direct/composition.ts` + test,
      `local-direct/index.ts`. Refuses a GitHub project and reports missing
      variables by name. Verify:
      `pnpm --filter @agentos/adapters test -- composition`
- [ ] **9. Control-plane wiring.** Modifies
      `apps/control-plane/src/application/runtime.ts`, `setup-readiness.ts`,
      `.env.example`. `AGENTOS_EXECUTOR=local-direct` selects the local
      dispatcher and waiter; setting it together with `TRIGGER_SECRET_KEY`
      fails at boot. Verify: `pnpm --filter @agentos/control-plane test`
- [ ] **10. Restart recovery.** Modifies `local-direct/dispatcher.ts`: on
      construction, resume runs in `running`/`waiting` whose effects carry an
      `ownerId` starting `workflow:local-direct:`. Verify:
      `pnpm --filter @agentos/adapters test -- dispatcher`
- [ ] **11. Live smoke.** Creates `scripts/local-direct-smoke.mjs`; modifies
      `packages/adapters/package.json`. Skips with exit 0 unless
      `AGENTOS_LIVE_TESTS=1` and a model key are set. Verify:
      `pnpm --filter @agentos/adapters smoke:local-direct` (skips)
- [ ] **12. Docs.** Modifies `docs/architecture/kimi-runtime.md`,
      `durable-feature-workflow.md`, `docs/progress.md`. Verify:
      `pnpm format:check`

## Whole-branch verification

```sh
pnpm typecheck && pnpm lint && pnpm test && pnpm format:check
```

The credential-free suite passing is **not** the exit gate. The gate is the
spec's: the rename feature succeeds on this repository three times from the
project page, each under fifteen minutes.
