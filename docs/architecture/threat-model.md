# Threat model

## Scope and assumptions

This model covers the planned Agent OS control plane, CLI, core orchestration,
adapters, repository-local `agentos` content, and external providers. The
foundation has no authentication, persistence, tool execution, or model calls;
the controls below are requirements for the stages that introduce them.

No browser request, CLI input, repository file, model output, tool result,
webhook, or provider response is trusted solely because it reached an internal
component. Human approval is a security boundary only when the human can see the
exact action, target, and consequences.

## Assets

- Provider credentials, session tokens, signing keys, and deployment secrets.
- Tenant data, agent definitions, prompts, tool inputs and outputs, and audit
  history.
- Authorization policy and approval state.
- Repository contents, local workspaces, generated artifacts, and deployment
  configuration.
- Availability and integrity of orchestration, provider accounts, and budgets.

## Trust boundaries and required controls

### Browser and operator to control plane

Network requests cross an unauthenticated boundary before identity and tenant
scope are established. The delivery stage must use secure session handling,
server-side authorization on every action, CSRF protection for mutations,
origin-aware redirects, schema validation, output encoding, and rate limits.
Sensitive values must never enter browser bundles or client-readable logs.

### CLI host to control plane

The CLI runs on a machine the service cannot trust and handles shell-provided
input. Tokens must use least privilege, secure OS storage where available, safe
redaction, explicit endpoint configuration, and bounded lifetimes. Commands must
avoid shell interpolation and clearly preview destructive or billable actions.

### Delivery surfaces to core

HTTP payloads, command arguments, and identity context cross into domain logic.
Apps must translate them into validated core inputs. Core policies remain the
source of truth; UI state, hidden fields, and CLI flags cannot grant authority.

### Core to agents, models, and tools

Prompts, retrieved content, model output, and tool results are untrusted data and
may contain prompt injection or malformed instructions. Planned orchestration
must use allowlisted capabilities, typed schemas, resource limits, timeouts,
idempotency, scoped approvals, and complete audit records. Model text must never
be interpreted directly as code, a shell command, authorization, or a secret.

### Core to adapters and external providers

Adapters cross network and account boundaries. They must isolate provider SDKs,
validate responses, constrain outbound destinations, set timeouts and retry
budgets, verify webhook signatures and replay windows, and map failures without
exposing secrets. Credentials must be scoped per provider and tenant and loaded
from a secret manager rather than repository files.

### Runtime to persistence

Persistence introduces tenant-isolation, integrity, rollback, and availability
risks. Queries and storage keys must be tenant scoped by construction. Encryption
in transit and at rest, migration review, backups, retention rules, optimistic
concurrency or transactions, and recovery tests are required before production
data is stored.

### Runtime to repository and filesystem

The `agentos` directory and generated files cross from potentially untrusted
repository content into the runtime. Readers must constrain paths to an explicit
workspace root, reject traversal and unsafe symlinks, cap file sizes, validate
formats, and use atomic writes. Loading a repository must not execute its code or
honor embedded instructions automatically.

### Source, dependencies, CI, and deployment

Contributor input and third-party packages cross the software supply-chain
boundary. Exact dependency versions and a frozen lockfile, protected review,
minimal CI permissions, secret scanning, provenance-aware artifacts, and staged
deployment reduce compromise risk. CI must not run untrusted pull-request code
with production credentials.

## Abuse cases to verify in later stages

- Cross-tenant reads or actions caused by forged identifiers.
- Prompt injection that requests credentials or expands tool authority.
- SSRF through provider URLs, webhooks, imports, or agent-configured tools.
- Replay or duplication of billable, destructive, or state-changing work.
- Path traversal or symlink escape from repository-local definitions.
- Secret exposure through errors, telemetry, generated output, or browser state.
- Resource exhaustion through loops, oversized inputs, retries, or parallel jobs.
- Confused-deputy approvals where the displayed action differs from execution.

Each later architecture stage must turn applicable controls into automated tests
and operational evidence before the affected boundary is considered production
ready.
