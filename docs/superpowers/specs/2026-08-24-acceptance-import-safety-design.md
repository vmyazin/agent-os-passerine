# Frozen acceptance-test import safety

Status: Approved design

## Follow-up decision — 2026-08-24

The pure validator will use `es-module-lexer` as a direct `@agentos/core`
dependency. This preserves the bounded module-specifier contract while avoiding a
regex or partial JavaScript parser that could treat comments and string contents as
imports. It adds `packages/core/package.json` and `pnpm-lock.yaml` to the implementation
boundary but does not broaden which imports are accepted or rejected.

## Context

The first Kimi run to reach the spec/Definition-of-Done approval gate produced valid
artifact metadata and strong behavioral assertions, but both frozen files imported
`../../../src/todo-store.mjs` from `test/acceptance/`. That resolves above the
repository. The correct relative import is `../../src/todo-store.mjs`. The current DoD
schema validates file placement, size, pairing, mode, and NUL bytes, but not where code
inside the test resolves imports. The operator correctly rejected the approval.

## Goals

- Reject a Definition of Done before approval when a static relative ESM import in an
  acceptance test resolves outside the repository root.
- Keep repository-internal imports, Node built-ins such as `node:test`, and package
  specifiers valid.
- Make the specifier prompt concrete about the directory relationship that caused the
  live failure.
- Return a bounded schema error that names the acceptance-test entry without storing
  or echoing agent-authored source content.

## Non-goals

- Proving that an implementation file already exists; acceptance tests commonly name
  the file the implementer will create.
- Executing acceptance tests before approval; their expected baseline behavior is to
  fail because the requested feature is absent.
- Building a general JavaScript parser, module resolver, linter, or dependency policy.
- Rewriting or silently correcting agent-authored test files.
- Broadening the acceptance-test directory, modes, dependencies, or verifier contract.

## Scope and implementation boundary

`packages/core/src/acceptance-tests.ts` gains a small pure validator for module
specifiers found in static ESM forms used by these dependency-free tests: `import ...
from`, side-effect `import`, `export ... from`, and literal `import(...)`. For relative
specifiers, it resolves from the acceptance file's directory under a sentinel
repository root. A resolved path outside that sentinel is invalid. Absolute filesystem
specifiers are invalid; bare and `node:` specifiers remain allowed.

`packages/adapters/src/trigger/schemas.ts` calls that validator while refining each DoD
acceptance-test entry. It adds a custom issue at that entry's content path without
including the source or offending specifier in the durable message.

The specifier text in `agentos/passerine.yaml`,
`apps/control-plane/src/ui/setup-template.ts`, and
`apps/control-plane/src/ui/setup-template-local.ts` adds one exact example: a module at
repository path `src/example.mjs` is imported from
`test/acceptance/<id>.test.mjs` as `../../src/example.mjs`.

Do not modify artifact storage, approval consumption, trusted test execution, source
snapshot ingestion, change-set sealing, or publication.

## Error handling

The validator is conservative only about the bounded contract above. It does not try
to resolve whether a repository-internal target exists. A detected escape makes the
DoD artifact fail its existing schema gate, so no approval is created and no operator
can accidentally authorize a test that imports outside the repository.

The error identifies `acceptanceTests.<index>.content` through the existing safe schema
failure formatter. Agent-authored code and paths from inside the source remain out of
the run's durable error text.

## Verification

- Core unit cases cover the live `../../../src/...` escape, the correct
  `../../src/...` import, side-effect imports, exports, dynamic literal imports, Node
  built-ins, bare packages, and absolute paths.
- The DoD schema regression uses the exact rejected live shape and must fail before
  implementation, then pass after changing only the import to `../../src/...`.
- Prompt rendering tests assert the same concrete example appears in all three
  configuration sources so newly applied revisions cannot drift.
- Adapter and control-plane package suites remain credential-free; no paid model call
  is needed for this verification.
