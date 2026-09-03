# Three-Step Pipeline

Status: Approved design (operator approved 2026-09-02, "let's implement your
recommended plan")
Date: 2026-09-03
Approach: make two roles optional and move the advisory one after the gate;
change no trust boundary

## Context

The local-direct executor ran four real features on 2026-09-02. Three
delivered working branches. The fourth failed at "final review after fix must
be approved": the reviewer claimed `port ?? process.env.PORT ?? 3000` treats
`0` as missing, which is true of `||` and false of `??`. Seven of the eight
frozen acceptance tests passed on the code it rejected. Because review runs
before verification, the objective check never ran.

Per step, what four runs showed:

- **specification** froze the acceptance tests that later vindicated the
  rejected code. Earns its place.
- **planning** produced a 554-byte list of strings that the implementer
  re-derived anyway, and was the step that failed the first Sonnet run on a
  prompt mismatch. A paid session for ceremony.
- **implementation** is the work.
- **review** is documented as advisory ("sealed verification will run the
  files") and is fatal in code (`workflow.ts` throws on a `changes_requested`
  re-review). An advisory step holding a veto, placed before the gate.
- **verification** is the objective gate and runs last. On the process runtime
  it also starts a model session that contributes nothing, so trusted code can
  observe a command.

Five to seven sessions per feature. Two are load-bearing.

## Goal

A feature pipeline of `specification` → operator approval → `implementation` →
trusted `verification` → publish. `planning` and `review` become optional
steps a project may declare. When declared, review runs after verification,
its findings are shown on the run page, and it never blocks publication. On
the process runtime, verification observes its command without a model
session.

Exit gate: the "Serve a health endpoint" feature that review wrongly blocked
succeeds on a three-step configuration, and the existing five-step
configuration still succeeds.

## Non-goals

- Changing what trusted verification checks, signs, or requires.
- Changing the approval gate, budgets, sealing, or publication authority.
- Removing planning or review from the schema. A project that wants them keeps
  them by declaring the steps.
- Changing the goal workflow's use of feature runs.
- A fix-and-re-review loop. A review that finds something after verification
  is a note for the operator, who is the one who merges. Iteration is a new
  run.

## Design

### Roles

`FeatureWorkflowRoles` (`trigger/types.ts:60`) becomes three required roles
plus two optional. `FeatureRole` is unchanged. A step is present when the
config's feature pipeline declares a step whose id is the role name; absent
otherwise. `resolveFeatureRolesFromSnapshot`
(`trigger/production-composition.ts:44`) requires `specification`,
`implementation`, `verification`, and resolves `planning` and `review` only
when declared. The distinct-environment check counts resolved roles.
`resolveRoleRuntimeKeys` already iterates whatever roles exist.

### Sequence

`createDurableFeatureWorkflow` (`trigger/workflow.ts`) becomes:

1. specification, approval gate — unchanged.
2. planning — only when `roles.planning` is defined. Unchanged when present.
3. implementation — its request carries the specification and Definition of
   Done artifacts always, and the plan artifact only when planning ran.
   `planDigest`/`planArtifact` become optional in the request; the schema the
   implementer answers with is unchanged.
4. seal, verification, verifier — unchanged, except that the verifier no
   longer receives or requires a review (`trigger/verifier.ts:53-60`: the
   `review` parse and "final trusted review is not approved" check are
   removed; `review` leaves the evidence body).
5. review — only when `roles.review` is defined. Runs after the verifier
   passed. Any outcome, including a session failure, is recorded on the step
   and does not fail the run: a step failure becomes a progress note and the
   run continues. `changes_requested` is a finding, not a verdict.
6. publication — unchanged.

The `fix` and `review-after-fix` steps and the "final review after fix must be
approved" error are removed.

### Verification without a model session

The process runtime (`kimi/provider.ts`) recognizes a start whose input is
`trusted-verification-request-v1`. It materializes the sandbox exactly as
today and does not run the agent loop: the session is marked `submitted` with
an empty result, usage stays zero, and `observeCommand` executes the trusted
command under the session mutex as it does now. The workflow does not change;
the managed provider does not change. A verification role is still configured
(its environment is what the sandbox is built from), it just costs nothing.

### Operator surface

The run page's review findings, added 2026-09-02 for failed runs, are shown
for any run that has a review artifact, under "Review notes" for a succeeded
run and "The review asked for these changes" for a failed one. The caveat
that findings come from a model and can be wrong stays.

### Configuration

`agentos/ld-smoke.yaml` and `agentos/passerine.yaml` drop the `planning` step
and keep `review` declared, so review's post-verification placement is
exercised by the exit gate. `agentos/example.yaml` shows the three-step
minimum.

## Scope and implementation boundary

Lives in: `trigger/types.ts` (roles type), `trigger/production-composition.ts`
(role resolution), `trigger/workflow.ts` (sequence; only the regions named
above), `trigger/schemas.ts` (implementation request shape),
`trigger/verifier.ts` (review requirement), `kimi/provider.ts` (no-loop
verification), `apps/control-plane/app/runs/[id]/page.tsx` (review notes),
tests beside each, the three `agentos/*.yaml` files, and the runbook.

Must not touch: `trigger/outbox.ts`, the checkpoint stores, budgets, sealing
(`sealChangeSet`, `putSealedChanges`), `publicationAuthority`, the publishers,
the managed-agents provider, migrations.

## Testing

Credential-free: the workflow fixture runs both a three-step and a five-step
role set; review after verification with `changes_requested` still publishes
and records the finding; a review session that throws still publishes; no
`fix` step is ever created; the verifier accepts evidence without a review;
the process provider observes a trusted command with zero usage and no
transport call; composition refuses a config missing any of the three
required steps and accepts one missing the optional two.

Live: the exit gate above, on the local executor.
