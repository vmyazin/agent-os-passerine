# Validation System

<cite>
**Referenced Files in This Document**
- [config.ts](file://packages/core/src/config.ts)
- [config.test.ts](file://packages/core/src/config.test.ts)
- [config-files.ts](file://apps/cli/src/config-files.ts)
- [workspace.ts](file://apps/cli/src/workspace.ts)
- [contracts.ts](file://apps/control-plane/src/http/contracts.ts)
- [api.ts](file://apps/control-plane/src/http/api.ts)
- [schemas.ts](file://packages/adapters/src/trigger/schemas.ts)
- [validation.ts](file://packages/adapters/src/persistence/validation.ts)
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

## Introduction
This document explains the configuration validation system used by Agent OS Passerine to ensure that configurations are correct, secure, and safe to apply at runtime. The system is built on Zod schemas with strict mode enabled to reject unknown keys, custom refinements for cross-field rules, and dedicated validators for agent references, environment dependencies, pipeline step dependencies, and circular dependency detection. It also covers size limits, canonicalization, hashing, and how validation errors are surfaced from CLI parsing through API boundaries into user-facing messages.

## Project Structure
The validation system spans several layers:
- Core schema definitions and cross-field validations live in the core package.
- CLI reads and validates configuration files before applying or sending them to the control plane.
- Control plane HTTP contracts validate incoming payloads and enforce size and consistency constraints.
- Adapters define workflow artifact schemas and persistence-level assertions.

```mermaid
graph TB
subgraph "CLI"
C1["Read bounded file<br/>size + trust checks"]
C2["Parse YAML + Zod parse"]
C3["Canonicalize + hash"]
end
subgraph "Core"
K1["Zod schemas<br/>strict + superRefine"]
K2["Cross-field checks:<br/>model/env refs,<br/>pipeline deps,<br/>cycles"]
K3["Canonical JSON + SHA-256"]
end
subgraph "Control Plane"
H1["HTTP body parser<br/>size limit + JSON parse"]
H2["Zod contract schemas<br/>apply/query projections"]
end
subgraph "Adapters"
A1["Workflow artifact schemas"]
A2["Persistence assertions"]
end
C1 --> C2 --> C3
C3 --> H1 --> H2
H2 --> A1
H2 --> A2
K1 --> K2 --> K3
```

**Diagram sources**
- [config.ts:165-337](file://packages/core/src/config.ts#L165-L337)
- [config-files.ts:141-234](file://apps/cli/src/config-files.ts#L141-L234)
- [api.ts:28-91](file://apps/control-plane/src/http/api.ts#L28-L91)
- [contracts.ts:56-107](file://apps/control-plane/src/http/contracts.ts#L56-L107)
- [schemas.ts:11-187](file://packages/adapters/src/trigger/schemas.ts#L11-L187)
- [validation.ts:12-84](file://packages/adapters/src/persistence/validation.ts#L12-L84)

**Section sources**
- [config.ts:165-337](file://packages/core/src/config.ts#L165-L337)
- [config-files.ts:141-234](file://apps/cli/src/config-files.ts#L141-L234)
- [api.ts:28-91](file://apps/control-plane/src/http/api.ts#L28-L91)
- [contracts.ts:56-107](file://apps/control-plane/src/http/contracts.ts#L56-L107)
- [schemas.ts:11-187](file://packages/adapters/src/trigger/schemas.ts#L11-L187)
- [validation.ts:12-84](file://packages/adapters/src/persistence/validation.ts#L12-L84)

## Core Components
- Core Zod schemas define the shape of Agent OS configuration, including project, models, agents, environments, pipelines, policies, budgets, goals, runtime routing, and optional verification settings. All schemas use strict mode to reject unknown fields.
- Cross-field validations in a single superRefine block enforce:
  - Agent model references must exist in models.
  - Agent environment references must exist in environments.
  - Pipeline steps reference existing agents and environments.
  - Duplicate step IDs are rejected.
  - Step dependencies must exist and cannot be self-references.
  - Dependency cycles are detected using a depth-first traversal per pipeline.
- Canonicalization and hashing produce deterministic JSON and SHA-256 digests for stable comparison and change planning.
- CLI enforces trusted file paths, size limits, and formats validation errors into readable messages.
- Control plane HTTP layer enforces payload size limits, parses JSON, validates against request/response schemas, and maps validation failures to structured errors.
- Adapter schemas validate workflow artifacts (specifications, plans, implementations, reviews, publications).
- Persistence validators assert numeric ranges and structural invariants for domain records.

**Section sources**
- [config.ts:165-337](file://packages/core/src/config.ts#L165-L337)
- [config-files.ts:141-234](file://apps/cli/src/config-files.ts#L141-L234)
- [api.ts:28-91](file://apps/control-plane/src/http/api.ts#L28-L91)
- [contracts.ts:56-107](file://apps/control-plane/src/http/contracts.ts#L56-L107)
- [schemas.ts:11-187](file://packages/adapters/src/trigger/schemas.ts#L11-L187)
- [validation.ts:12-84](file://packages/adapters/src/persistence/validation.ts#L12-L84)

## Architecture Overview
The validation flow proceeds from file read to runtime enforcement:

```mermaid
sequenceDiagram
participant User as "User / CI"
participant CLI as "CLI config-files"
participant Core as "Core config schemas"
participant CP as "Control Plane API"
participant Contracts as "HTTP contracts"
participant Adapters as "Adapter schemas"
User->>CLI : Provide path to agent-os.yaml
CLI->>CLI : Read bounded file (size + trust)
CLI->>Core : loadAgentOsConfig(yaml)
Core-->>CLI : Parsed AgentOsConfig or throws
CLI->>CLI : canonicalConfigJson + hash
CLI->>CP : POST /configuration/apply {canonicalConfig, digest}
CP->>Contracts : parseBody(schema)
Contracts-->>CP : Validated payload or error
CP->>Adapters : Persist projection + provenance
CP-->>CLI : Apply result or error
```

**Diagram sources**
- [config-files.ts:141-234](file://apps/cli/src/config-files.ts#L141-L234)
- [config.ts:331-337](file://packages/core/src/config.ts#L331-L337)
- [api.ts:28-91](file://apps/control-plane/src/http/api.ts#L28-L91)
- [contracts.ts:56-107](file://apps/control-plane/src/http/contracts.ts#L56-L107)

**Section sources**
- [config-files.ts:141-234](file://apps/cli/src/config-files.ts#L141-L234)
- [config.ts:331-337](file://packages/core/src/config.ts#L331-L337)
- [api.ts:28-91](file://apps/control-plane/src/http/api.ts#L28-L91)
- [contracts.ts:56-107](file://apps/control-plane/src/http/contracts.ts#L56-L107)

## Detailed Component Analysis

### Core Configuration Schema and Cross-Field Validation
- Strict schemas prevent unknown keys at every level, reducing drift and accidental misconfiguration.
- Cross-field validations include:
  - Model profile existence for each agent.
  - Environment existence for agents and pipeline steps.
  - Pipeline step uniqueness and valid agent/environment references.
  - Dependency validity and cycle detection per pipeline.
- Canonicalization sorts object keys deterministically and serializes to JSON; hashing uses SHA-256 to create stable identifiers for configuration versions.

```mermaid
flowchart TD
Start(["Start parse"]) --> ParseYAML["Parse YAML to object"]
ParseYAML --> ZodStrict["Zod strict parse<br/>reject unknown keys"]
ZodStrict --> Refs{"References valid?"}
Refs --> |No| AddIssues["Add issues for missing model/env/agent"]
Refs --> |Yes| Deps{"Dependencies valid?"}
Deps --> |No| AddDeps["Add issues for unknown/self/cycle"]
Deps --> |Yes| Canonical["Canonicalize + Hash"]
AddIssues --> End(["Throw validation error"])
AddDeps --> End
Canonical --> Success(["Return parsed config"])
```

**Diagram sources**
- [config.ts:165-337](file://packages/core/src/config.ts#L165-L337)

**Section sources**
- [config.ts:165-337](file://packages/core/src/config.ts#L165-L337)

### CLI File Reading, Size Limits, and Error Formatting
- Reads configuration files with bounded size and trust checks to prevent reading arbitrary files outside the workspace.
- Enforces maximum source and canonical sizes.
- Formats Zod validation issues into concise human-readable messages, limiting the number of reported issues.

```mermaid
flowchart TD
RStart(["readConfiguration(path)"]) --> Bound["Open file with trust + size bounds"]
Bound --> LoadYAML["loadAgentOsConfig(yaml)"]
LoadYAML --> |Success| Canon["canonicalConfigJson(config)"]
LoadYAML --> |Error| Format["formatValidationError(error)"]
Canon --> CheckSize{"Canonical size <= limit?"}
CheckSize --> |No| TooLarge["Throw oversized canonical config"]
CheckSize --> |Yes| Digest["canonicalConfigHash(config)"]
TooLarge --> REnd(["Exit with error"])
Format --> REnd
Digest --> Return(["{ config, canonical, digest }"])
```

**Diagram sources**
- [config-files.ts:141-234](file://apps/cli/src/config-files.ts#L141-L234)

**Section sources**
- [config-files.ts:141-234](file://apps/cli/src/config-files.ts#L141-L234)

### Control Plane HTTP Validation and Payload Safety
- Body parser enforces content-length and streaming size limits, decodes UTF-8 safely, parses JSON, then validates against a Zod schema.
- Configuration apply schema enforces digest format, canonical config size, and mutual exclusivity/invariance between expected revision and digest.
- Query and projection schemas validate inputs and outputs consistently across endpoints.

```mermaid
sequenceDiagram
participant Client as "Client"
participant API as "parseBody()"
participant Contract as "configurationApplySchema"
Client->>API : Request with JSON body
API->>API : Check content-length/stream bytes
API->>API : Decode UTF-8 + JSON.parse
API->>Contract : schema.safeParse(value)
Contract-->>API : success or issues
API-->>Client : Parsed data or validation_error(422)
```

**Diagram sources**
- [api.ts:28-91](file://apps/control-plane/src/http/api.ts#L28-L91)
- [contracts.ts:56-82](file://apps/control-plane/src/http/contracts.ts#L56-L82)

**Section sources**
- [api.ts:28-91](file://apps/control-plane/src/http/api.ts#L28-L91)
- [contracts.ts:56-107](file://apps/control-plane/src/http/contracts.ts#L56-L107)

### Workflow Artifact Schemas and Custom Rules
- Workflow input, specification, plan, implementation, review, publication, and test evidence schemas enforce versioned structures, identifier formats, and size constraints.
- Change set schema includes a custom refinement to cap total content bytes and validate operations.
- Trusted command observation schema ensures timestamps, digests, and exit codes are well-formed.

```mermaid
classDiagram
class FeatureWorkflowInput {
+string version
+string runId
+string projectId
+Feature feature
+Source source
+Digests digests
}
class SpecificationOutput {
+string version
+ArtifactReference specification
+ArtifactReference definitionOfDone
}
class ChangeSet {
+string version
+Change[] changes
}
class TestEvidence {
+string version
+boolean passed
+string command
+number exitCode
}
FeatureWorkflowInput --> SpecificationOutput : "produces"
SpecificationOutput --> ChangeSet : "consumes"
ChangeSet --> TestEvidence : "validated by"
```

**Diagram sources**
- [schemas.ts:11-187](file://packages/adapters/src/trigger/schemas.ts#L11-L187)

**Section sources**
- [schemas.ts:11-187](file://packages/adapters/src/trigger/schemas.ts#L11-L187)

### Persistence Assertions
- Numeric fields are asserted to be safe integers within PostgreSQL integer ranges where applicable.
- Domain events, artifacts, config revisions, step runs, goal criteria, and progress are validated before persistence to prevent invalid state.

```mermaid
flowchart TD
PStart(["Persist record"]) --> AssertInt["assertPostgresInteger / assertNonNegativeSafeInteger"]
AssertInt --> ValidateDomain{"Record valid?"}
ValidateDomain --> |No| Throw["Throw TypeError"]
ValidateDomain --> |Yes| Save["Write to storage"]
```

**Diagram sources**
- [validation.ts:12-84](file://packages/adapters/src/persistence/validation.ts#L12-L84)

**Section sources**
- [validation.ts:12-84](file://packages/adapters/src/persistence/validation.ts#L12-L84)

## Dependency Analysis
- Core schemas depend only on Zod and YAML parsing utilities. They provide reusable types and functions consumed by CLI and control plane.
- CLI depends on core for parsing, canonicalization, and hashing, and adds filesystem trust and size enforcement.
- Control plane HTTP layer depends on core constants for size limits and defines its own Zod schemas for API contracts.
- Adapters define workflow-specific schemas and persistence assertions used by execution and storage layers.

```mermaid
graph LR
Core["@agentos/core config.ts"] --> CLI["apps/cli config-files.ts"]
Core --> CP_API["apps/control-plane http/api.ts"]
CP_Contracts["apps/control-plane http/contracts.ts"] --> CP_API
CP_API --> Adapters_Schemas["packages/adapters trigger/schemas.ts"]
CP_API --> Adapters_Validation["packages/adapters persistence/validation.ts"]
```

**Diagram sources**
- [config.ts:165-337](file://packages/core/src/config.ts#L165-L337)
- [config-files.ts:141-234](file://apps/cli/src/config-files.ts#L141-L234)
- [api.ts:28-91](file://apps/control-plane/src/http/api.ts#L28-L91)
- [contracts.ts:56-107](file://apps/control-plane/src/http/contracts.ts#L56-L107)
- [schemas.ts:11-187](file://packages/adapters/src/trigger/schemas.ts#L11-L187)
- [validation.ts:12-84](file://packages/adapters/src/persistence/validation.ts#L12-L84)

**Section sources**
- [config.ts:165-337](file://packages/core/src/config.ts#L165-L337)
- [config-files.ts:141-234](file://apps/cli/src/config-files.ts#L141-L234)
- [api.ts:28-91](file://apps/control-plane/src/http/api.ts#L28-L91)
- [contracts.ts:56-107](file://apps/control-plane/src/http/contracts.ts#L56-L107)
- [schemas.ts:11-187](file://packages/adapters/src/trigger/schemas.ts#L11-L187)
- [validation.ts:12-84](file://packages/adapters/src/persistence/validation.ts#L12-L84)

## Performance Considerations
- Bounded file reads and streaming body parsing prevent memory exhaustion from large inputs.
- Strict Zod schemas avoid expensive fallback handling by failing fast on unexpected fields.
- Canonicalization sorts keys deterministically; this is O(n log n) over object keys but ensures stable hashes for caching and diffing.
- Cycle detection per pipeline is linear in the number of steps and edges, suitable for typical pipeline sizes.

[No sources needed since this section provides general guidance]

## Troubleshooting Guide
Common validation errors and resolutions:
- Unknown model profile referenced by an agent: Ensure the agent’s model exists under models.
- Unknown environment referenced by an agent or pipeline step: Define the environment under environments or remove the reference.
- Unknown pipeline dependency: Verify all dependsOn entries match existing step ids within the same pipeline.
- Self-dependency in a pipeline step: Remove the step from its own dependsOn list.
- Dependency cycle detected: Reorder steps so that dependencies form a DAG without cycles.
- Excessive canonical configuration size: Reduce configuration complexity or split concerns; the system enforces a maximum byte size for canonical forms.
- Invalid JSON or oversized request body in API: Ensure requests are valid JSON and within allowed size limits.

Resolution tips:
- Use the CLI’s formatted validation output to locate exact paths and messages.
- For API errors, check status 422 responses and adjust payloads according to contract schemas.
- When encountering persistent cycles, draw the dependency graph and identify back edges to break.

**Section sources**
- [config.test.ts:152-201](file://packages/core/src/config.test.ts#L152-L201)
- [config-files.ts:187-234](file://apps/cli/src/config-files.ts#L187-L234)
- [api.ts:28-91](file://apps/control-plane/src/http/api.ts#L28-L91)
- [contracts.ts:56-107](file://apps/control-plane/src/http/contracts.ts#L56-L107)

## Conclusion
The configuration validation system combines strict Zod schemas, targeted cross-field validations, and robust boundary checks to ensure Agent OS Passerine configurations are correct and secure before they reach runtime. By enforcing reference integrity, preventing cycles, and bounding sizes, it minimizes operational risk while providing clear, actionable error messages. The layered approach—CLI, core, control plane, and adapters—ensures consistent validation from file ingestion through API boundaries to persistence.