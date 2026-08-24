# Existing Project Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` or
> `superpowers:executing-plans` task-by-task.

**Goal:** Import an existing GitHub/local repository and list its live commits.

**Architecture:** A durable one-to-one project-source registry is the trust and
identity boundary. Provider adapters inspect sources and page commits; the
control plane exposes authenticated contracts and a Radix-based operator flow.

**Tech stack:** TypeScript, Drizzle/Postgres, Next.js 16, React 19, Radix UI.

---

## File map

- `packages/core/src/persistence.ts`: source and commit domain contracts.
- `packages/adapters/src/persistence/`: durable/in-memory source storage.
- `packages/adapters/src/github/`: GitHub inspection and commit paging.
- `packages/adapters/src/local-git/`: exact-path inspection and commit paging.
- `apps/control-plane/src/application/`: import and commit application flow.
- `apps/control-plane/app/api/projects/`: authenticated HTTP routes.
- `apps/control-plane/src/ui/`: Radix wrappers, import dialog, commit feed.
- `apps/control-plane/app/projects/`: toolbar integration and inline history.

## Do not modify

- Source-snapshot ingestion.
- GitHub or local publication.
- Trigger tasks/workflow execution.
- Agent prompts or generated documentation/wiki content.

## Tasks

- [x] Add failing domain/persistence tests for source attachment and lookup.
- [x] Implement source domain types, migration, and repository parity.
- [x] Add failing GitHub/local adapter tests for inspection and commit paging.
- [x] Implement bounded provider adapters.
- [x] Add failing service and HTTP contract tests.
- [x] Implement authenticated inspection/import/commit endpoints.
- [x] Add Radix dependencies and UI components.
- [x] Integrate the dialog and inline feed with accessible loading/error states.
- [x] Document the source registry and update AGENTS/CLAUDE routing.
- [x] Run package, database, build, Playwright, and localhost smoke verification.
