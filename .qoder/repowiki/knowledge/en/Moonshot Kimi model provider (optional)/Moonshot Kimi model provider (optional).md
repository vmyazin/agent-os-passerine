---
kind: external_dependency
name: Moonshot Kimi model provider (optional)
slug: moonshot-kimi
category: external_dependency
category_hints:
    - vendor_identity
    - auth_protocol
scope:
    - '**'
---

### Role
Optional secondary model provider. Sessions route to Kimi only when a model profile selects it; `KIMI_API_KEY` is required and `KIMI_BASE_URL` defaults to `https://api.moonshot.ai/anthropic`. Execution runs in a local process sandbox rooted at `AGENTOS_KIMI_SANDBOX_ROOT`.

### Constraint
Kimi is gated behind a separate API key from Anthropic's key — do not reuse `ANTHROPIC_API_KEY`.