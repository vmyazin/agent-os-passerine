---
kind: external_dependency
name: Cloudflare R2 artifact storage
slug: cloudflare-r2
category: external_dependency
category_hints:
    - vendor_identity
    - auth_protocol
scope:
    - '**'
---

### Role
Object store for run artifacts and MCP capability payloads. Uses scoped access keys (`CLOUDFLARE_R2_ARTIFACT_ACCESS_KEY_ID` / `SECRET`) restricted to GetObject/PutObject only; a separate admin key pair exists for retention deletion.

### Auth & jurisdiction
- Bucket name via `CLOUDFLARE_R2_ARTIFACT_BUCKET`.
- Optional `CLOUDFLARE_R2_JURISDICTION` accepts `default`, `eu`, or `fedramp` to select data residency.
- Vercel Cron authenticates the hourly cleanup route via `CRON_SECRET`.