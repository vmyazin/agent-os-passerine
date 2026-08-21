# Task 5 Report: Specifier, implementer, and reviewer prompts

**Status:** DONE  
**Commit:** `6146c31` — Ask the specifier to write frozen acceptance tests.

## Changes

Updated identical prompt strings in all three mirror files:

- `agentos/passerine.yaml`
- `apps/control-plane/src/ui/setup-template.ts`
- `apps/control-plane/src/ui/setup-template-local.ts`

### Specifier

1. DoD artifact body upgraded from `definition-of-done-v1` to `definition-of-done-v2` with `acceptanceTests` array.
2. Added instruction after "Keep scope to exactly what is asked." requiring one criterion + one `node:test` file per requirement at `test/acceptance/<id>.test.mjs`.
3. Specifier tools unchanged: `read`, `glob`, `grep` only.

### Implementer

Added after "Keep the diff minimal and complete.":

> Do not add, modify, or delete files under test/acceptance/; trusted code overlays the approved acceptance tests.

### Reviewer

Replaced DoD review paragraph with acceptance-test-aware guidance:

> The Definition of Done artifact contains acceptance test files. Approve only if the change set would make those files pass; otherwise request changes with concrete findings. Review is advisory — sealed verification will run the files.

## Verification

```bash
rg -n "definition-of-done-v1" agentos/passerine.yaml apps/control-plane/src/ui/setup-template.ts apps/control-plane/src/ui/setup-template-local.ts
# Expected: no matches — PASS (exit 1)

rg -n "definition-of-done-v2" agentos/passerine.yaml apps/control-plane/src/ui/setup-template.ts apps/control-plane/src/ui/setup-template-local.ts
# Expected: one hit per file — PASS (3 hits)
```

## Diff stats

3 files changed, 15 insertions(+), 12 deletions(-)
