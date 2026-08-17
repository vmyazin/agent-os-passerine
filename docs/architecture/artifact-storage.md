# Scoped artifact storage

Agent-facing artifact access is a stateless MCP Streamable HTTP JSON-response
endpoint. It exposes only `artifact.get`, `artifact.put`, and `artifact.list`.
Every call needs a short-lived HMAC capability bound to purpose, audience,
method, project, run, step, optional artifact prefix, byte limits, call limits,
expiry, and nonce. Postgres atomically enforces the per-capability call and
cumulative-byte ledger across serverless cold starts.

Postgres is the authoritative logical-version manifest. One
`(project, run, step, artifact, version)` tuple can bind to only one immutable
digest and metadata record. Deleted versions remain tombstoned. R2 object names
remain content-addressed, and all collision reconciliation re-reads bounded
object bytes and recomputes SHA-256; ETags and provider checksums are never used
as application content identity.

The R2 adapter derives the exact Cloudflare endpoint from the configured account
and jurisdiction and rejects endpoint overrides. AWS SDK request and response
checksum calculation are set to `WHEN_REQUIRED`: R2 does not accept the SDK's
optional full-object `ChecksumSHA256` request shape, while SigV4 still protects
transport and Agent OS verifies its own SHA-256 before and after storage.

Agent-facing R2 credentials are bucket-scoped to read/write only. The hourly
Vercel cron uses `CRON_SECRET`, a Postgres lease, and separate control-plane R2
delete credentials. It deletes source bundles and cloud-session uploads within
24 hours and working artifacts after 30 days, recording the deletion reason and
timestamp in the manifest. Legacy artifact rows without the
`artifact-manifest-v1` discriminator are excluded from retention scans. Audit
metadata remains in Postgres after the object is removed.

The MCP surface is capped at 1 MiB per artifact and 1.5 MiB per request and
response. Larger artifacts can use the direct trusted artifact-store contract;
they are intentionally unavailable through agent MCP until a chunked protocol
is introduced.
