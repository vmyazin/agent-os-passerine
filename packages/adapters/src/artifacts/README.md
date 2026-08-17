# Scoped artifact storage

The artifact adapter stores immutable objects at authoritative keys derived from
the project, run, step, artifact name, version, and SHA-256 digest. Callers
provide bytes and identity fields; they cannot choose an arbitrary object key.
Writes use a create-only conditional request and reconcile a racing write by
reading and validating the existing object's digest and metadata.

The agent-facing MCP route implements the JSON response subset of MCP
Streamable HTTP pinned to protocol `2025-06-18`. It supports `initialize`, the
`notifications/initialized` lifecycle notification, `tools/list`, and
`tools/call`. Its only tools are `artifact.get`, `artifact.put`, and
`artifact.list`; batch requests, SSE-only clients, and every deletion method are
rejected. The framework-neutral handler keeps the provider SDK and credentials
out of its public API.

## Credentials and retention

Use a dedicated R2 credential for the MCP process with bucket-scoped
`ListBucket`, `GetObject`, and `PutObject` permissions only. Administrative
deletion is constructed separately with `createR2ArtifactAdminStore` and must
use a distinct control-plane credential. No admin deletion route is exposed by
the MCP server.

Configure R2 lifecycle cleanup for `source-bundle` and
`cloud-session-upload` objects no later than 24 hours after terminal completion.
Working artifacts default to a 30-day expiry. The object metadata records the
retention class and expiry, while the control-plane reconciliation job remains
responsible for prompt terminal cleanup. Audit metadata belongs in Postgres and
is not represented by an artifact retention class.

Cloudflare R2 encrypts objects at rest. The adapter sends an explicit SHA-256
request checksum, disables optional SDK checksum behavior that is not required
by R2, and independently verifies the digest after every read. ETags are never
treated as content digests.

Capabilities are short-lived, audience- and purpose-bound HMAC tokens with a
key ID for rotation. An immutable digest-keyed put can be replayed identically;
there is intentionally no in-memory nonce ledger that claims durable replay
prevention. A conflicting replay is rejected.
