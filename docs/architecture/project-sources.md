# Project sources and live commit history

Status: Implemented architecture

## Purpose

`project_sources` is the durable, one-to-one registry that says which exact
repository an AgentOS project may inspect. It records repository identity and
the confirmed default branch, but never credentials, installation tokens, or a
source mirror.

Import-time trust is intentionally narrow: it authorizes repository inspection
and live commit browsing only. An imported project with no applied configuration
is not runnable, and the source registry does not grant workflow execution,
source ingestion, or publication rights.

## Architecture map

| Layer         | Canonical implementation                                                  | Responsibility                                                                                                       |
| ------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Domain        | `packages/core/src/project-source.ts`                                     | Provider union, inspection/commit contracts, validation, normalized source keys                                      |
| Persistence   | `packages/adapters/src/persistence/{in-memory,neon-repository,schema}.ts` | Atomic project-plus-source attachment and unique source identity                                                     |
| GitHub reader | `packages/adapters/src/github/project-source.ts`                          | App-JWT installation discovery, exact contents-read token scope, repository identity verification, live commit pages |
| Local reader  | `packages/adapters/src/local-git/project-source.ts`                       | Real-path/top-level validation, branch resolution, bounded allowlisted Git reads, live commit pages                  |
| Application   | `apps/control-plane/src/application/control-plane-service.ts`             | Inspection/import orchestration, deterministic identity, safe projections and errors                                 |
| HTTP/UI       | `apps/control-plane/app/api/projects/` and `apps/control-plane/src/ui/`   | Authenticated contracts, Radix import dialog, resilient inline commit feed                                           |

## Durable identity and atomic import

- GitHub identity is `github:<lowercase-owner>/<lowercase-name>` and is backed
  by GitHub's immutable numeric repository ID.
- Local identity is `local:<canonical-real-path>`. Trust applies to that exact
  path, never its parent directory or an unresolved symlink spelling.
- `project_sources.project_id` is both the primary key and a foreign key to
  `projects`; `source_key` and the non-null GitHub `repository_id` are
  independently unique. A renamed or recreated repository cannot silently
  replace the immutable identity that was inspected.
- `project_source_import_requests` durably records each import idempotency key,
  request fingerprint, source key, and resulting project. Reusing a key with a
  different request returns a conflict, including across process restarts.
- Neon import is one SQL statement guarded by transaction-scoped advisory
  locks derived from the source key, immutable GitHub repository ID, and
  idempotency key. The project, source, and import ledger therefore commit or
  roll back together; bounded retries acquire a fresh statement snapshot after
  a concurrent uniqueness race.
- Provider inspection happens before persistence. Once inspection succeeds,
  project creation or attachment and source insertion happen atomically.
- A matching configuration-created project is retained, including its revisions
  and run history. Otherwise the project ID is deterministically derived from
  the normalized source key.

## Provider boundaries

GitHub accepts only `https://github.com/{owner}/{repository}`. The reader App
JWT discovers the installation, then mints a selected-repository token with
`contents: read` only. Repository ID, owner/name, canonical URL, default branch,
and head SHA must agree before import. Publisher-App discovery is readiness
decoration and never blocks reader import.

Local inspection resolves the submitted absolute path, rejects bare repositories
and nested working-tree paths, and confirms a branch that resolves to a commit.
Commit reads use fixed Git operations with bounded arguments, output, execution
time, cursor depth, and parsed field sizes. Both providers return newest-first
default-branch history, including merges, in pages of 25 without claiming a
stored total.

Commit retrieval is deliberately non-critical. A provider failure renders an
inline unavailable/retry state; it must not fail project detail, discard already
loaded rows, or imply that the source disappeared.

## Future slices (not authorized by source import)

1. Task-runtime binding: create a trusted checkout/snapshot boundary for imported
   projects before allowing runs.
2. Agent commit context: choose a bounded commit window and explicitly add it to
   agent/task prompts.
3. Documentation generation: derive and refresh project documentation from an
   immutable source revision.
4. Bug-specific workflows: add reproduction, regression-test, and fix orchestration
   without broadening import-time trust.

Those slices require their own specs and threat boundaries. Do not reuse
`project_sources` as evidence that execution, mutation, publication, or prompt
inclusion has been authorized.
