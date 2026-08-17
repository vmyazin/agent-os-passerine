# Scoped artifact storage

The artifact adapter stores immutable objects at authoritative keys derived from
the project, run, step, artifact name, version, and SHA-256 digest. Callers
provide bytes and identity fields; they cannot choose an arbitrary object key.
Writes use a create-only conditional request and reconcile a racing write by
reading and validating the existing object's digest and metadata.
An authoritative Postgres manifest atomically binds each logical
project/run/step/artifact/version to one digest. R2 remains the content-addressed
blob layer; reconstruction and enumeration use the manifest rather than object
listing or per-object HEAD requests.

The agent-facing MCP route implements the JSON response subset of MCP
Streamable HTTP pinned to protocol `2025-06-18`. It supports `initialize`, the
`notifications/initialized` lifecycle notification, `tools/list`, and
`tools/call`, plus HTTP DELETE only for session teardown. Its only tools are
`artifact.get`, `artifact.put`, and `artifact.list`; batch requests and every
artifact deletion method are rejected. Conformance is tested through the
exact-pinned official MCP SDK client.

Agent MCP transfers are capped at 1 MiB and returned once in structured
content, not duplicated into text content. Base64 size is checked before decode,
and GET size is checked before blob consumption. Larger artifacts are available
only to trusted control-plane services through the direct store contract;
agents must split them into bounded artifacts.

## Credentials and retention

Use a dedicated R2 credential for the MCP process with bucket-scoped
`GetObject` and `PutObject` permissions only. Administrative
deletion is constructed separately with `createR2ArtifactAdminStore` and must
use a distinct control-plane credential. No admin deletion route is exposed by
the MCP server.

The idempotent cleanup service selects expired manifest rows, deletes objects
with a separate administrator credential, and records deletion time and reason.
`source-bundle` and `cloud-session-upload` artifacts expire within 24 hours;
working artifacts default to 30 days. R2 lifecycle rules may be used as a
defense-in-depth backstop, while Postgres audit metadata remains authoritative.

Cloudflare R2 encrypts objects at rest. R2 does not support SHA-256 in
`FULL_OBJECT` checksum mode, so the adapter does not send `ChecksumSHA256` for
single-part PUTs. It retains SigV4, records the application SHA-256 in immutable
metadata, and independently recomputes digest and size after every bounded read.
ETags are never treated as content digests. The endpoint is derived only from a
validated account ID and `default`, `eu`, or `fedramp` jurisdiction; production
callers cannot supply an arbitrary endpoint.

Capabilities are short-lived, audience- and purpose-bound HMAC tokens with a
key ID for rotation. An immutable digest-keyed put can be replayed identically;
there is intentionally no in-memory nonce ledger that claims durable replay
prevention. A conflicting replay is rejected.
