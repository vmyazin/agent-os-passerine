---
kind: external_dependency
name: Anthropic model provider
slug: anthropic
category: external_dependency
category_hints:
    - vendor_identity
    - auth_protocol
scope:
    - '**'
---

### Role
Primary LLM provider for agent sessions. Required for Managed Agents cloud execution; the key is injected via `ANTHROPIC_API_KEY`.

### Usage note
Sessions execute in a sandboxed process; the key is never exposed to browser code. A separate optional provider (Moonshot Kimi) can be routed via `KIMI_API_KEY` / `KIMI_BASE_URL`.