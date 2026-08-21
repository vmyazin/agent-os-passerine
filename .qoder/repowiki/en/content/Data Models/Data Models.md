# Data Models

<cite>
**Referenced Files in This Document**
- [schema.ts](file://packages/adapters/src/persistence/schema.ts)
- [0000_domain_persistence.sql](file://drizzle/0000_domain_persistence.sql)
- [_journal.json](file://drizzle/meta/_journal.json)
- [0016_complete_usage_pricing.sql](file://drizzle/0016_complete_usage_pricing.sql)
- [0017_restore_usage_defaults.sql](file://drizzle/0017_restore_usage_defaults.sql)
- [0018_bounded_goal_records.sql](file://drizzle/0018_bounded_goal_records.sql)
- [0019_project_session_leases.sql](file://drizzle/0019_project_session_leases.sql)
- [0020_deployment_daily_budget.sql](file://drizzle/0020_deployment_daily_budget.sql)
- [repository-factory.ts](file://apps/control-plane/src/persistence/repository-factory.ts)
- [neon-repository.ts](file://packages/adapters/src/persistence/neon-repository.ts)
- [artifact-cleanup.ts](file://apps/control-plane/src/application/artifact-cleanup.ts)
</cite>

## Table of Contents
1. [Introduction](#introduction)
2. [Project Structure](#project-structure)
3. [Core Components](#core-components)
4. [Architecture Overview](#architecture-overview)
5. [Detailed Component Analysis](#detailed-component-analysis)
6. [Dependency Analysis](#dependency-analysis)
7. [Performance Considerations](#performance-considerations)
8. [Troubleshooting Guide](#troubleshooting-guide)
9. [Conclusion](#conclusion)
10. [Appendices](#appendices)

## Introduction
This document describes the data models for Agent OS Passerine, focusing on the PostgreSQL schema defined via Drizzle ORM and migrations. It covers entity relationships, field definitions, types, constraints, indexes, validation rules enforced at the database level, and how schema changes evolve through Drizzle migrations. It also outlines data access patterns, caching strategies, performance considerations, retention and archival policies, and backup guidance grounded in the repository’s implementation.

## Project Structure
The data model is defined in a single schema module and materialized as SQL migrations under drizzle/. The application uses a repository abstraction to interact with the database, with Neon as the production target and an in-memory store for tests.

```mermaid
graph TB
subgraph "Schema Definition"
S["packages/adapters/src/persistence/schema.ts"]
end
subgraph "Migrations"
M0["drizzle/0000_domain_persistence.sql"]
M16["drizzle/0016_complete_usage_pricing.sql"]
M17["drizzle/0017_restore_usage_defaults.sql"]
M18["drizzle/0018_bounded_goal_records.sql"]
M19["drizzle/0019_project_session_leases.sql"]
M20["drizzle/0020_deployment_daily_budget.sql"]
J["drizzle/meta/_journal.json"]
end
subgraph "Access Layer"
RF["apps/control-plane/src/persistence/repository-factory.ts"]
NR["packages/adapters/src/persistence/neon-repository.ts"]
end
S --> M0
M0 --> M16
M16 --> M17
M17 --> M18
M18 --> M19
M19 --> M20
J --> M0
J --> M16
J --> M17
J --> M18
J --> M19
J --> M20
RF --> NR
NR --> S
```

**Diagram sources**
- [schema.ts:1-799](file://packages/adapters/src/persistence/schema.ts#L1-L799)
- [0000_domain_persistence.sql:1-216](file://drizzle/0000_domain_persistence.sql#L1-L216)
- [_journal.json:1-154](file://drizzle/meta/_journal.json#L1-L154)
- [0016_complete_usage_pricing.sql:1-10](file://drizzle/0016_complete_usage_pricing.sql#L1-L10)
- [0017_restore_usage_defaults.sql:1-4](file://drizzle/0017_restore_usage_defaults.sql#L1-L4)
- [0018_bounded_goal_records.sql:1-13](file://drizzle/0018_bounded_goal_records.sql#L1-L13)
- [0019_project_session_leases.sql:1-140](file://drizzle/0019_project_session_leases.sql#L1-L140)
- [0020_deployment_daily_budget.sql:1-92](file://drizzle/0020_deployment_daily_budget.sql#L1-L92)
- [repository-factory.ts:1-44](file://apps/control-plane/src/persistence/repository-factory.ts#L1-L44)
- [neon-repository.ts:1824-1842](file://packages/adapters/src/persistence/neon-repository.ts#L1824-L1842)

**Section sources**
- [schema.ts:1-799](file://packages/adapters/src/persistence/schema.ts#L1-L799)
- [_journal.json:1-154](file://drizzle/meta/_journal.json#L1-L154)

## Core Components
The schema centers around workflow execution, configuration, artifacts, goals, usage accounting, and operational leases. Key entities include:

- Projects: top-level tenants for runs and configurations.
- Config revisions and snapshots: immutable configuration versions and per-run captures.
- Workflow runs and effects: durable orchestration state, inputs/outputs/errors, lifecycle timestamps, cleanup scheduling, and idempotency fingerprints.
- Step runs: atomic steps within runs, with attempt tracking and optional external session linkage.
- External sessions: provider-managed sessions tied to runs/steps with status and state.
- Approvals: gatekeeping approvals scoped by run and fingerprint.
- Inbox messages: asynchronous messages linked to runs/steps with reply support.
- Domain events and sequences: append-only event log per run with sequence guarantees.
- Artifacts: file-like outputs with keys, digests, sizes, URIs, retention classes, and deletion lifecycle fields.
- Usage records: token and runtime accounting with pricing versioning and cache token breakdowns.
- Publication records and events: Git-based publication pipeline state and audit trail.
- Operational tables: reconciliation cursors, budget reservations, session leases, capability quotas, artifact cleanup leases, webhook receipts.

Primary keys, foreign keys, unique constraints, and check constraints enforce integrity across these entities. Timestamps are stored as timestamp with time zone and normalized to ISO strings in the ORM layer.

**Section sources**
- [schema.ts:79-799](file://packages/adapters/src/persistence/schema.ts#L79-L799)
- [0000_domain_persistence.sql:1-216](file://drizzle/0000_domain_persistence.sql#L1-L216)

## Architecture Overview
Data flows from application code through a repository abstraction into PostgreSQL. The repository factory selects Neon for production and an in-memory store for tests. Drizzle generates typed queries against the schema. Migrations define the evolving schema and include functions for admission control and settlement.

```mermaid
sequenceDiagram
participant App as "Control Plane"
participant Repo as "Repository Factory"
participant Neon as "Neon Repository"
participant DB as "PostgreSQL"
App->>Repo : createRepository(env)
Repo-->>App : DomainRepository (Neon or InMemory)
App->>Neon : insert/update/query entities
Neon->>DB : execute SQL (Drizzle-generated)
DB-->>Neon : rows / command results
Neon-->>App : domain objects
```

**Diagram sources**
- [repository-factory.ts:9-28](file://apps/control-plane/src/persistence/repository-factory.ts#L9-L28)
- [neon-repository.ts:1824-1842](file://packages/adapters/src/persistence/neon-repository.ts#L1824-L1842)
- [schema.ts:1-799](file://packages/adapters/src/persistence/schema.ts#L1-L799)

## Detailed Component Analysis

### Entities and Relationships
```mermaid
erDiagram
PROJECTS {
text id PK
text name
text repository
timestamptz created_at
timestamptz updated_at
}
CONFIG_REVISIONS {
text id PK
text project_id FK
integer revision
jsonb config
text config_digest
text model_digest
text prompt_digest
text environment_digest
text policy_digest
text repository_sha
timestamptz created_at
}
WORKFLOW_RUNS {
text id PK
text project_id FK
text config_revision_id FK
text pipeline
enum status
jsonb input
jsonb output
jsonb error
timestamptz created_at
timestamptz updated_at
timestamptz started_at
timestamptz completed_at
timestamptz cleanup_at
integer state_version
text idempotency_fingerprint
}
STEP_RUNS {
text id PK
text run_id FK
text step_key
integer attempt
enum status
jsonb input
jsonb output
jsonb error
text external_session_id FK
timestamptz created_at
timestamptz updated_at
timestamptz started_at
timestamptz completed_at
timestamptz cleanup_at
}
EXTERNAL_SESSIONS {
text id PK
text run_id FK
text step_run_id FK
text provider
text external_id
enum status
jsonb state
timestamptz created_at
timestamptz updated_at
timestamptz cleanup_at
}
APPROVALS {
text id PK
text run_id FK
text scope
text fingerprint
enum status
timestamptz created_at
timestamptz expires_at
timestamptz consumed_at
}
INBOX_MESSAGES {
text id PK
text run_id FK
text step_run_id FK
enum status
jsonb body
jsonb reply
timestamptz created_at
timestamptz replied_at
}
DOMAIN_EVENTS {
text run_id FK
text event_id
text fingerprint
bigint sequence
text type
jsonb payload
timestamptz occurred_at
}
ARTIFACTS {
text id PK
text run_id FK
text step_run_id FK
text key
text media_type
bigint size_bytes
text digest
text uri
text retention_class
timestamptz created_at
timestamptz cleanup_at
timestamptz deleted_at
text deletion_reason
text deletion_state
timestamptz deletion_requested_at
text write_lease_id
timestamptz write_lease_expires_at
text manifest_version
}
USAGE_RECORDS {
text idempotency_id PK
text run_id FK
text step_run_id FK
text model
text pricing_version
bigint input_tokens
bigint output_tokens
bigint cache_read_input_tokens
bigint cache_creation_5m_input_tokens
bigint cache_creation_1h_input_tokens
bigint runtime_ms
bigint microdollars
timestamptz recorded_at
}
PUBLICATION_RECORDS {
text publication_key PK
text binding_key
text project_id FK
text run_id FK
bigint repository_id
text manifest_digest
text policy_digest
text base_sha
text branch
text phase
jsonb blob_shas
text tree_sha
text commit_sha
bigint pull_request_number
text pull_request_url
boolean draft
text error_code
bigint revision
timestamptz created_at
timestamptz updated_at
}
PUBLICATION_EVENTS {
bigserial sequence PK
text publication_key FK
text phase
timestamptz at
jsonb details
}
WORKFLOW_EFFECTS {
text effect_key PK
text run_id FK
text kind
text input_fingerprint
enum status
text external_ref
jsonb output
text error
text owner_id
integer lease_version
timestamptz lease_expires_at
timestamptz created_at
timestamptz updated_at
}
WORKFLOW_BUDGET_RESERVATIONS {
text reservation_key PK
text run_id FK
text project_id FK
text step_key
bigint estimated_microdollars
timestamptz expires_at
timestamptz created_at
}
WORKFLOW_SESSION_LEASES {
text lease_key PK
text run_id FK
text step_key
timestamptz expires_at
timestamptz updated_at
}
GOAL_CRITERIA {
text id PK
text run_id FK
integer ordinal
text description
jsonb definition
enum status
timestamptz created_at
}
GOAL_PROGRESS {
text id PK
text run_id FK
text criterion_id FK
integer step
enum status
text detail
jsonb payload
timestamptz recorded_at
}
WORKFLOW_RECONCILIATION_CURSORS {
text cursor_key PK
timestamptz cursor_at
text cursor_id
timestamptz updated_at
}
ARTIFACT_CAPABILITY_QUOTAS {
text purpose
text audience
text nonce
text fingerprint
timestamptz not_before
timestamptz expires_at
bigint calls
bigint cumulative_bytes
timestamptz updated_at
}
ARTIFACT_CLEANUP_LEASES {
text name PK
text owner
timestamptz expires_at
timestamptz updated_at
}
WEBHOOK_RECEIPTS {
text source
text delivery_id
text fingerprint
timestamptz received_at
timestamptz expires_at
}
RUN_EVENT_SEQUENCES {
text run_id PK
bigint next_sequence
}
PROJECTS ||--o{ WORKFLOW_RUNS : "has many"
PROJECTS ||--o{ CONFIG_REVISIONS : "has many"
CONFIG_REVISIONS ||--o{ WORKFLOW_RUNS : "referenced by"
CONFIG_REVISIONS ||--o{ CONFIG_SNAPSHOTS : "captured by"
WORKFLOW_RUNS ||--o{ STEP_RUNS : "contains"
WORKFLOW_RUNS ||--o{ EXTERNAL_SESSIONS : "owns"
WORKFLOW_RUNS ||--o{ APPROVALS : "requires"
WORKFLOW_RUNS ||--o{ INBOX_MESSAGES : "receives"
WORKFLOW_RUNS ||--o{ DOMAIN_EVENTS : "emits"
WORKFLOW_RUNS ||--o{ USAGE_RECORDS : "produces"
WORKFLOW_RUNS ||--o{ ARTIFACTS : "creates"
WORKFLOW_RUNS ||--o{ WORKFLOW_EFFECTS : "generates"
WORKFLOW_RUNS ||--o{ WORKFLOW_BUDGET_RESERVATIONS : "reserves"
WORKFLOW_RUNS ||--o{ WORKFLOW_SESSION_LEASES : "leases"
STEP_RUNS ||--o{ EXTERNAL_SESSIONS : "links"
STEP_RUNS ||--o{ INBOX_MESSAGES : "produces"
STEP_RUNS ||--o{ USAGE_RECORDS : "produces"
STEP_RUNS ||--o{ ARTIFACTS : "produces"
GOAL_CRITERIA ||--o{ GOAL_PROGRESS : "tracked by"
PUBLICATION_RECORDS ||--o{ PUBLICATION_EVENTS : "emits"
```

**Diagram sources**
- [schema.ts:79-799](file://packages/adapters/src/persistence/schema.ts#L79-L799)
- [0000_domain_persistence.sql:1-216](file://drizzle/0000_domain_persistence.sql#L1-L216)

### Schema Evolution Through Drizzle Migrations
- 0000_domain_persistence.sql: initial schema with core tables, enums, foreign keys, and indexes.
- 0016_complete_usage_pricing.sql: adds pricing version and cache token columns to usage_records with non-negative checks.
- 0017_restore_usage_defaults.sql: restores defaults for pricing_version and cache token columns.
- 0018_bounded_goal_records.sql: migrates goal-related tables to bounded steps and adds definition column; resets legacy goal runs.
- 0019_project_session_leases.sql: scopes session leases per project and introduces admission/settlement functions for concurrency and budget enforcement.
- 0020_deployment_daily_budget.sql: extends admission function to support deployment-wide daily spend caps.

The journal tracks migration order and tags, ensuring deterministic evolution.

**Section sources**
- [0000_domain_persistence.sql:1-216](file://drizzle/0000_domain_persistence.sql#L1-L216)
- [0016_complete_usage_pricing.sql:1-10](file://drizzle/0016_complete_usage_pricing.sql#L1-L10)
- [0017_restore_usage_defaults.sql:1-4](file://drizzle/0017_restore_usage_defaults.sql#L1-L4)
- [0018_bounded_goal_records.sql:1-13](file://drizzle/0018_bounded_goal_records.sql#L1-L13)
- [0019_project_session_leases.sql:1-140](file://drizzle/0019_project_session_leases.sql#L1-L140)
- [0020_deployment_daily_budget.sql:1-92](file://drizzle/0020_deployment_daily_budget.sql#L1-L92)
- [_journal.json:1-154](file://drizzle/meta/_journal.json#L1-L154)

### Data Validation Rules and Business Constraints
- Enum constraints: run_status, external_session_status, approval_status, inbox_status, goal_status, workflow_effect_status restrict allowed states.
- Positive and safe integer checks: ensure numeric fields like attempts, sequences, tokens, runtime, costs fit within safe integer bounds and are non-negative where required.
- Unique constraints: prevent duplicate keys such as step_runs per attempt, goal_criteria per ordinal, artifacts per run+key, usage_records idempotency, publication records binding key.
- Foreign keys: cascade or set null semantics maintain referential integrity across runs, steps, sessions, and publications.
- Check constraints: validate ranges and formats (e.g., publication phases, git SHAs, branch naming).
- Idempotency: idempotency_id primary keys and fingerprints protect against duplicate processing.

These constraints are enforced at the database level, providing strong guarantees beyond application logic.

**Section sources**
- [schema.ts:46-799](file://packages/adapters/src/persistence/schema.ts#L46-L799)
- [0000_domain_persistence.sql:1-216](file://drizzle/0000_domain_persistence.sql#L1-L216)

### Data Access Patterns and Caching Strategies
- Repository abstraction: the control plane constructs a Neon repository in production and an in-memory repository in tests, isolating persistence concerns.
- Drizzle ORM: typed queries generated from schema ensure type safety and consistent access patterns.
- Lease-based coordination: artifact cleanup and session leases use durable locks to coordinate concurrent workers and avoid race conditions.
- Budget admission: server-side functions compute thresholds and reserve budgets atomically, preventing overcommitment.

```mermaid
flowchart TD
Start(["Workflow Admission"]) --> Compute["Compute thresholds<br/>and reserved amounts"]
Compute --> CheckLimits{"Within limits?"}
CheckLimits --> |No| Deny["Return 'workflow_budget' or 'daily_budget'"]
CheckLimits --> |Yes| AcquireLease["Acquire advisory lock<br/>and update session lease"]
AcquireLease --> Reserve["Insert budget reservation"]
Reserve --> Admit["Return 'admitted'"]
```

**Diagram sources**
- [0019_project_session_leases.sql:18-98](file://drizzle/0019_project_session_leases.sql#L18-L98)
- [0020_deployment_daily_budget.sql:4-90](file://drizzle/0020_deployment_daily_budget.sql#L4-L90)

**Section sources**
- [repository-factory.ts:9-28](file://apps/control-plane/src/persistence/repository-factory.ts#L9-L28)
- [neon-repository.ts:1824-1842](file://packages/adapters/src/persistence/neon-repository.ts#L1824-L1842)
- [artifact-cleanup.ts:35-66](file://apps/control-plane/src/application/artifact-cleanup.ts#L35-L66)
- [0019_project_session_leases.sql:18-98](file://drizzle/0019_project_session_leases.sql#L18-L98)
- [0020_deployment_daily_budget.sql:4-90](file://drizzle/0020_deployment_daily_budget.sql#L4-L90)

### Retention Policies, Archival Rules, and Cleanup
- Artifact retention: artifacts carry retention_class, cleanup_at, deletion lifecycle fields, and a dedicated cleanup index targeting eligible rows. A cleanup job claims a lease, inspects expired artifacts, and deletes them safely.
- Run and step cleanup: workflow_runs and step_runs include cleanup_at timestamps and filtered indexes to schedule background cleanup.
- External sessions and inbox messages: similar cleanup_at fields and indexes enable periodic purging.
- Webhook receipts: expiry-based indexes support timely removal of stale receipts.

Cleanup processes rely on durable leases to ensure only one worker processes a batch at a time, avoiding duplication.

**Section sources**
- [schema.ts:463-511](file://packages/adapters/src/persistence/schema.ts#L463-L511)
- [schema.ts:134-180](file://packages/adapters/src/persistence/schema.ts#L134-L180)
- [schema.ts:275-314](file://packages/adapters/src/persistence/schema.ts#L275-L314)
- [schema.ts:316-354](file://packages/adapters/src/persistence/schema.ts#L316-L354)
- [schema.ts:385-417](file://packages/adapters/src/persistence/schema.ts#L385-L417)
- [schema.ts:644-658](file://packages/adapters/src/persistence/schema.ts#L644-L658)
- [artifact-cleanup.ts:35-66](file://apps/control-plane/src/application/artifact-cleanup.ts#L35-L66)

### Backup and Recovery Guidance
- Use PostgreSQL-native backups (logical or physical) aligned with your deployment strategy. Ensure consistent snapshots during peak workloads to minimize impact.
- For event-sourced components (domain_events, publication_events), consider point-in-time recovery to reconstruct state if needed.
- Validate restore integrity using checksums and schema version checks derived from the Drizzle journal and latest migration tag.

[No sources needed since this section provides general guidance]

## Dependency Analysis
The repository factory depends on environment variables to select the persistence backend. The Neon repository wraps Drizzle with custom timestamp parsers and connects to the configured database URL. Migrations depend on the schema definition and each other via the journal ordering.

```mermaid
graph LR
RF["repository-factory.ts"] --> NR["neon-repository.ts"]
NR --> S["schema.ts"]
S --> M0["0000_domain_persistence.sql"]
M0 --> M16["0016_complete_usage_pricing.sql"]
M16 --> M17["0017_restore_usage_defaults.sql"]
M17 --> M18["0018_bounded_goal_records.sql"]
M18 --> M19["0019_project_session_leases.sql"]
M19 --> M20["0020_deployment_daily_budget.sql"]
```

**Diagram sources**
- [repository-factory.ts:9-28](file://apps/control-plane/src/persistence/repository-factory.ts#L9-L28)
- [neon-repository.ts:1824-1842](file://packages/adapters/src/persistence/neon-repository.ts#L1824-L1842)
- [schema.ts:1-799](file://packages/adapters/src/persistence/schema.ts#L1-L799)
- [_journal.json:1-154](file://drizzle/meta/_journal.json#L1-L154)

**Section sources**
- [repository-factory.ts:9-28](file://apps/control-plane/src/persistence/repository-factory.ts#L9-L28)
- [neon-repository.ts:1824-1842](file://packages/adapters/src/persistence/neon-repository.ts#L1824-L1842)
- [_journal.json:1-154](file://drizzle/meta/_journal.json#L1-L154)

## Performance Considerations
- Indexes: targeted indexes on cleanup_at, status, created_at, and composite keys optimize common queries (cleanup jobs, listing runs, pending inbox messages).
- Collation: byte-wise collation on certain columns ensures stable ordering for IDs and keys.
- JSONB: flexible payloads reduce schema churn but should be queried judiciously to avoid full table scans.
- Constraints: check constraints and unique indexes prevent invalid writes early, reducing application-level validation overhead.
- Functions: admission and settlement functions centralize budget logic and reduce contention by using advisory locks and row-level locking.

[No sources needed since this section provides general guidance]

## Troubleshooting Guide
- Missing parent foreign keys: tests assert that repositories reject inserts referencing missing parents, indicating strict referential integrity.
- Duplicate key violations: unique constraints on idempotency keys and ordinals surface conflicts; handle retries or idempotent updates accordingly.
- Stale leases: session leases and cleanup leases expire; reconcile or retry operations when encountering concurrency errors.
- Budget denials: admission functions return specific reasons (workflow_budget, daily_budget, concurrency); adjust estimates or limits based on feedback.

**Section sources**
- [repository-parity-contract.ts:58-80](file://packages/adapters/src/persistence/repository-parity-contract.ts#L58-L80)
- [neon-repository.test.ts:121-142](file://packages/adapters/src/persistence/neon-repository.test.ts#L121-L142)
- [0019_project_session_leases.sql:18-98](file://drizzle/0019_project_session_leases.sql#L18-L98)
- [0020_deployment_daily_budget.sql:4-90](file://drizzle/0020_deployment_daily_budget.sql#L4-L90)

## Conclusion
Agent OS Passerine’s data model is robustly defined with clear entities, strong constraints, and carefully designed indexes. Drizzle migrations provide a transparent evolution path, while repository abstractions and server-side functions encapsulate complex workflows like budgeting and cleanup. Following the outlined retention, indexing, and backup practices will help maintain data integrity and performance at scale.

[No sources needed since this section summarizes without analyzing specific files]

## Appendices

### Migration Journal Summary
The journal enumerates migration indices, tags, and timestamps, enabling reproducible deployments and audits.

**Section sources**
- [_journal.json:1-154](file://drizzle/meta/_journal.json#L1-L154)