---
kind: external_dependency
name: Trigger.dev durable workflow coordination
slug: triggerdotdev
category: external_dependency
category_hints:
    - vendor_identity
    - sdk_real_api
scope:
    - '**'
---

### Role
Durable workflow engine that coordinates long-running agent runs (durable dispatch, waitpoints, retries). The control plane registers workflow tasks under `packages/adapters/src/trigger` and the runtime is configured in `trigger.config.ts`.

### Integration points
- `TRIGGER_PROJECT_REF` / `TRIGGER_SECRET_KEY` env vars gate durable mode at boot; without them the control plane falls back to in-process execution.
- `pnpm trigger:dev` starts the local Trigger.dev server; `pnpm trigger:deploy` publishes workflows.
- Runtime pinned to `node-22`, max duration 3600s, default retry policy (max 2 attempts, exponential backoff).

### Stable usage model
The project treats Trigger.dev as the production orchestrator for agent runs while keeping a memory/local path for development. Do not assume durable dispatch is always on — validate `TRIGGER_SECRET_KEY` presence before relying on it.