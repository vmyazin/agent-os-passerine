# Agent OS architecture

Agent OS is organized as a small TypeScript monorepo so domain decisions remain
independent from delivery surfaces and third-party integrations.

## Monorepo boundaries

- `packages/core` owns platform-independent domain types, policies, and
  orchestration. It must not import UI frameworks, provider SDKs, or
  infrastructure implementations.
- `packages/adapters` is the integration boundary for persistence, model
  providers, tools, and other external systems. Adapters may depend on core
  contracts; core never depends on adapters.
- `apps/control-plane` is the Next.js operator interface. It composes core and
  adapters at the application boundary and owns HTTP and browser concerns.
- `apps/cli` is the terminal delivery surface. It owns argument parsing,
  presentation, and process exit behavior, not domain policy.
- `agentos` is reserved for repository-local Agent OS definitions and managed
  artifacts. Its formats are not established by this foundation scaffold.
- `docs/architecture` records decisions that apply across packages and apps.

Dependencies point inward: delivery apps and adapters can depend on core, while
core stays portable. Apps do not import one another, and provider-specific types
must not leak through public core APIs.

## Staged architecture

1. **Foundation:** establish strict tooling, empty package boundaries, delivery
   shells, continuous integration, and the threat model.
2. **Domain:** define core entities, policies, lifecycle transitions, and ports
   with tests before adding infrastructure.
3. **Integration:** implement adapters behind those ports, including explicit
   credential and failure handling.
4. **Delivery:** connect the CLI and control plane to stable use cases without
   duplicating policy in either interface.
5. **Operations:** add persistence migrations, observability, deployment,
   recovery, and security controls with end-to-end verification.

This repository currently implements only stage one. The empty core and adapter
exports are intentional; they prevent the scaffold from guessing at later domain
behavior.
