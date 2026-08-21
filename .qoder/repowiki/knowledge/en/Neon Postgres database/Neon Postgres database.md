---
kind: external_dependency
name: Neon Postgres database
slug: neon-postgres
category: external_dependency
category_hints:
    - vendor_identity
    - client_constraint
scope:
    - '**'
---

### Role
Production relational datastore behind Drizzle ORM (`drizzle-kit migrate`). Local dev defaults to an in-memory repository when `AGENTOS_REPOSITORY=memory`; production requires Neon with `DATABASE_URL` set.

### Client constraint
Neon is accessed via a standard PostgreSQL connection string; the repo never pins a Neon-specific client library beyond the Postgres DSN. Jurisdiction is not forced by this project — choose the Neon region at the platform level.