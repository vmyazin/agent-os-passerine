# Existing Project Import and Commit History

Status: Approved design

## Context

Projects are currently created only as a side effect of applying Agent OS
configuration. Repository trust lives in deployment environment variables, and
the operator UI has no commit-history surface.

## Goals

- Register an existing GitHub or local Git working tree before configuration.
- Persist one exact, credential-free source binding per project.
- List live default-branch commits on the project detail page.
- Use small app-owned Radix Dialog and Radio Group wrappers for import.
- Preserve existing projects and attach explicitly imported matching sources.

## Non-goals

- Making imported projects runnable.
- Changing source snapshots, publication, Trigger workflows, prompts, or agent
  documentation context.
- Mirroring commits, backfilling existing projects, or adding Radix Themes,
  Tailwind, shadcn, or unused confirmation components.

## Scope and implementation boundary

The feature lives in the project persistence/application/UI flow:
`packages/core/src/persistence.ts`, source-specific GitHub/local adapters,
`ControlPlaneService`, authenticated project API routes, and project UI
components.

Do not modify workflow execution, source-snapshot ingestion, GitHub/local
publication, Trigger tasks, model prompts, or generated repository wiki output.

## Approved behavior

- Import uses inspect then persist. Submitting Import is the trust grant.
- GitHub reader access is required; missing publisher access is non-blocking.
- Local paths are exact canonical working-tree roots; the detected branch must
  be confirmed.
- Duplicate/concurrent imports converge on one project/source.
- Commit history is live, newest first, includes merges, and pages by 25.
- The full feed renders inline after project provenance and before backlogs.
- Provider failures stay local to the import or commit-history surface.
