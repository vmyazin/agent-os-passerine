---
kind: error_handling
name: Layered Error Types with Centralized HTTP Wrapping and Secret Redaction
category: error_handling
scope:
    - '**'
source_files:
    - apps/cli/src/args.ts
    - apps/cli/src/api-client.ts
    - packages/core/src/artifacts.ts
    - packages/adapters/src/artifacts/errors.ts
    - packages/adapters/src/artifacts/mcp.ts
    - apps/control-plane/src/application/control-plane-service.ts
    - apps/control-plane/src/http/api.ts
    - apps/control-plane/app/error.tsx
---

## Overview

Agent OS uses a layered, typed error model across the monorepo. Each layer defines its own `Error` subclass carrying a machine-readable `code`, a human-readable `message`, and an HTTP `status` (where applicable). Errors are thrown as exceptions and caught by a single HTTP wrapper that serializes them into a uniform `{ error: { code, message } }` JSON envelope. Secrets in error messages are redacted before being surfaced.

## Error type hierarchy

### CLI (`apps/cli`)
- `CliError` (`apps/cli/src/args.ts`) — base for all CLI failures; carries an `exitCode` (default `EXIT_USAGE = 2`). All argument validation, URL/token validation, and unknown-command paths throw it.
- `ApiError` (`apps/cli/src/api-client.ts`) — extends `CliError`; adds `status?` and `code?`. Exit code is forced to `4` for 401/403 responses and `3` otherwise. Used for network errors, timeouts, oversized responses, invalid JSON, and non-`ok` HTTP responses.
- `RequestValidationError` (`apps/cli/src/api-client.ts`) — extends `CliError`; used when request body fails local validation (non-serializable, too large).

The CLI's `ApiClient.request` wraps every fetch in a try/catch that re-throws `RequestValidationError` unchanged, converts abort signals to `ApiError('request timed out')`, and otherwise wraps raw errors via `redact(message, this.#token)`.

### Core domain (`packages/core`)
- `ArtifactValidationError` (`packages/core/src/artifacts.ts`) — thrown by artifact key parsing, scope normalization, media-type validation, digest checks, and `prepareArtifactPut`. Has a fixed `code = 'invalid_artifact'`.
- `ArtifactCapabilityError` (`packages/core/src/artifact-capability.ts`) — capability-layer validation error.

These are pure domain/validation errors with no HTTP semantics; adapters wrap or translate them where needed.

### Adapters (`packages/adapters`)
- `ArtifactStoreAdapterError` (`packages/adapters/src/artifacts/errors.ts`) — adapter-level failure with a discriminated union of codes (`artifact_conflict`, `artifact_quota_exhausted`, `artifact_scope_denied`, `artifact_integrity_error`, `artifact_store_unavailable`, `artifact_too_large`, `invalid_artifact`) and a default `status = 400`. Throw sites live in `in-memory.ts`, `manifest.ts`, and `cursor.ts`.
- `McpTransportError` / `JsonRpcCallError` (`packages/adapters/src/artifacts/mcp.ts`) — transport-layer errors for the Artifact MCP endpoint. `McpTransportError` carries `(status, code, message)` and is thrown for malformed JSON-RPC, bad content types, origin denial, missing auth, oversized bodies, etc. `JsonRpcCallError` carries a numeric JSON-RPC error code.

### Control-plane application (`apps/control-plane`)
- `ServiceError` (`apps/control-plane/src/application/control-plane-service.ts`) — the central business-layer error. Constructor takes `(code: string, message: string, status: number)`. Business logic throughout `control-plane-service.ts` throws it for not-found, state transitions, budget violations, etc.
- `AuthError` (`apps/control-plane/src/auth/auth.ts`) — authentication failures; handled alongside `ServiceError` by the HTTP wrapper.

## HTTP error handling convention

All Next.js API routes go through `handleApi` (`apps/control-plane/src/http/api.ts`), which:
1. Runs optional `authorize()`.
2. Streams the request body with a byte limit (`MAX_BODY_BYTES` or per-route `maxBodyBytes`); oversized bodies throw `ServiceError('payload_too_large', ..., 413)`.
3. Parses JSON and validates against a Zod schema; parse/schema failures throw `ServiceError('invalid_json' | 'validation_error', ..., 400|422)`.
4. Calls the handler and validates output against `contract.output`.
5. In the catch block, matches `AuthError` or `ServiceError` and returns `NextResponse.json({ error: { code, message } }, status)`. Any other error falls back to `{ error: { code: 'internal_error', message: 'an unexpected error occurred' } }` with status 500.

This means **every route must throw one of these typed errors**; unhandled exceptions are always mapped to `internal_error`.

## Remote error code whitelisting (CLI)

The CLI maintains an explicit allowlist `REMOTE_CODES` (`apps/cli/src/api-client.ts`) of server-side error codes it will forward verbatim to callers (`approval_already_decided`, `authentication_required`, `configuration_digest_mismatch`, `not_found`, `payload_too_large`, `validation_error`, etc.). Any other server-provided code is normalized to `'remote_error'` via `remoteCode()`, preventing accidental leakage of internal server error strings to clients.

## Secret redaction

Secrets are stripped from error messages at two layers:
- CLI `ApiClient` uses `redact(value, token)` to scrub bearer tokens, query params, and known secret patterns (GitHub tokens, Stripe keys, AWS access keys) before throwing `ApiError`.
- Control plane `redactText` applies a shared set of regexes (`VALUE_SECRET_PATTERNS`) to sanitize error messages before they reach the client.

## Validation strategy

Validation errors are thrown early with descriptive messages rather than returning null/undefined:
- CLI args use helper functions (`required`, `assertId`, `assertAllowed`, `exactPositionals`) that throw `CliError`.
- Core artifact helpers (`segment`, `positiveVersion`, `sha256`, `timestamp`, `parseArtifactKey`) throw `ArtifactValidationError` on malformed input.
- The control-plane HTTP layer uses Zod schemas declared per route via `ApiContract.body`/`output`; validation failures map to `validation_error`.

## Frontend error page

The Next.js app includes a top-level `app/error.tsx` that renders a generic "Something went wrong" UI with a retry button. This catches unhandled React component errors; it does not handle API errors, which are returned as JSON envelopes by the backend.

## Key files

- `apps/cli/src/args.ts` — `CliError`, exit code, argument validation
- `apps/cli/src/api-client.ts` — `ApiError`, `RequestValidationError`, remote code whitelist, secret redaction
- `packages/core/src/artifacts.ts` — `ArtifactValidationError`
- `packages/adapters/src/artifacts/errors.ts` — `ArtifactStoreAdapterError`
- `packages/adapters/src/artifacts/mcp.ts` — `McpTransportError`, `JsonRpcCallError`
- `apps/control-plane/src/application/control-plane-service.ts` — `ServiceError`
- `apps/control-plane/src/http/api.ts` — `handleApi`, unified error-to-JSON mapping
- `apps/control-plane/app/error.tsx` — Next.js global error page

## Conventions observed

- Every subsystem defines its own `*Error` class extending `Error` with a stable `name` property.
- Domain/validation errors carry a `code` string; HTTP-facing errors additionally carry a numeric `status`.
- Business logic throws typed errors; presentation layers (HTTP wrappers, CLI exit) decide how to render them.
- Unknown/unexpected errors are never leaked — they collapse to `internal_error` (HTTP) or a non-zero exit code (CLI).
- Sensitive data is redacted before any error leaves the process boundary.