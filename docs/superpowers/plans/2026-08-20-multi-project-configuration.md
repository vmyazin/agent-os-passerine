# Multi-Project Configuration Implementation Plan (Phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make configuration project-scoped so a second (third, …) project can be created, configured, and targeted through the API, CLI, and wizard — removing the singleton that makes multi-project impossible.

**Architecture:** Fix the CAS precondition in both repository adapters to compare per-project instead of globally; change the `getLatestConfigRevision` port to take a `projectId`; derive project identity deterministically from the config's binding (`project.repository` / `project.localPath` / `project.name` fallback) with a legacy-project reuse rule; thread optional project selectors through `GET /api/configuration`, setup routes, run/inbox listings, the wizard's head fetch, and the CLI's `config plan`/`config apply`.

**Tech Stack:** TypeScript, Drizzle over Neon HTTP driver (raw SQL CTE in `applyConfigRevision`), Zod 4, Next.js route handlers, Vitest.

**Spec:** docs/superpowers/specs/2026-08-20-multi-project-parallel-design.md (Phase 1 section)

## Global Constraints

- Binding keys are built from the **literal** config values, never realpath: `repository:<url>` when `project.repository` is set, else `localPath:<path>` when `project.localPath` is set, else `name:<project.name>`. Project ids derive as `generateId('project', 'binding:' + bindingKey)`.
- The legacy singleton project id is `generateId('project', 'configuration')`. Existing deployments must keep that project and its revision history: when the binding-derived project does not exist but the legacy project's **latest revision** has the same binding key, reuse the legacy id.
- No database migration in this phase — the Neon change is adapter SQL only; the schema already has `unique(project_id, revision)`.
- New error codes: `project_not_found` (404), `project_required` (400), `project_mismatch` (409). Existing codes (`configuration_stale`, `config_snapshot_required`, …) keep their meanings.
- Query parameters are accepted only through the new `allowedQuery` helper; every route not listed here keeps `assertNoQuery`.
- All new service/adapter behavior gets tests (public API + latent-bug regression armor); UI markup does not.
- Commit after every task with a conventional-commit message ending in the trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Per-task verification runs package-scoped (`pnpm --filter <pkg> test`); Task 7 runs the full `pnpm lint && pnpm typecheck && pnpm test`.
- Neon-side parity behavior is verified by the same contract when `TEST_DATABASE_URL` is set (`pnpm test:integration`); without it the contract runs against the in-memory adapter only — state that explicitly in the task's verification note rather than claiming Postgres coverage.

---

### Task 1: Per-project CAS in both adapters (the bricking bug)

No port change yet — `applyConfigRevision` already receives the `project`. This task makes the precondition compare against that project's chain instead of the globally newest revision, and removes the deployment-wide advisory lock.

**Files:**
- Modify: `packages/adapters/src/persistence/neon-repository.ts:408-470` (the `applyConfigRevision` CTE)
- Modify: `packages/adapters/src/persistence/in-memory.ts:344-361` (the `active` selection in `applyConfigRevision`)
- Test: `packages/adapters/src/persistence/repository-parity-contract.ts`

**Interfaces:**
- Consumes: existing `applyConfigRevision(project, revision, precondition?)`.
- Produces: unchanged signature; preconditions now evaluate per `project.id`. `StaleConfigurationError` still thrown on a stale precondition **within the same project**.

- [ ] **Step 1: Write the failing contract tests**

Append inside the `describe` block of `repositoryParityContract` (after the `listProjects` pagination cases, ~line 905):

```ts
it('isolates configuration preconditions per project', async () => {
  const repository = await createRepository();
  const project = (key: 'cas-a' | 'cas-b') => ({
    id: persistenceId('project', `${implementation}-${key}`),
    name: key,
    createdAt: at,
    updatedAt: at,
  });
  const draft = (suffix: string, projectId: ReturnType<typeof persistenceId<'project'>>) => ({
    id: persistenceId('configRevision', `${implementation}-cas-${suffix}`),
    projectId,
    config: null,
    configDigest: `digest-${suffix}`,
    modelDigest: 'model',
    promptDigest: 'prompt',
    environmentDigest: 'environment',
    policyDigest: 'policy',
    repositorySha: 'sha',
    createdAt: at,
  });
  const a = project('cas-a');
  const b = project('cas-b');

  const a1 = await repository.applyConfigRevision(a, draft('a1', a.id), {
    revision: null,
    digest: null,
  });
  expect(a1.revision).toBe(1);

  // Second project's first apply must succeed while project A has revisions.
  const b1 = await repository.applyConfigRevision(b, draft('b1', b.id), {
    revision: null,
    digest: null,
  });
  expect(b1.revision).toBe(1);

  // Project A's CAS compares against A's own chain, not B's newer revision.
  const a2 = await repository.applyConfigRevision(a, draft('a2', a.id), {
    revision: 1,
    digest: 'digest-a1',
  });
  expect(a2.revision).toBe(2);

  // A stale precondition still fails within its own project.
  await expect(
    repository.applyConfigRevision(a, draft('a3', a.id), {
      revision: 1,
      digest: 'digest-a1',
    }),
  ).rejects.toMatchObject({ name: 'StaleConfigurationError' });
});
```

If `persistenceId<'project'>` as a type argument does not typecheck in the draft helper, type the parameter as `Parameters<DomainRepository['createProject']>[0]['id']` instead — the contract file already imports `DomainRepository`.

- [ ] **Step 2: Run the contract against the in-memory adapter and verify it fails**

Run: `pnpm --filter @agentos/adapters test -- repository`
Expected: the new case FAILS — today the second project's first apply throws `StaleConfigurationError` (its `revision: null` precondition requires the whole store to be empty).

- [ ] **Step 3: Scope the in-memory precondition**

In `in-memory.ts`, the `active` selection inside `applyConfigRevision` currently sorts **all** revisions. Filter to the target project first:

```ts
const active = [...this.#configRevisions.values()]
  .filter((entry) => entry.projectId === project.id)
  .sort(
    (left, right) =>
      right.createdAt.localeCompare(left.createdAt) ||
      right.revision - left.revision ||
      right.id.localeCompare(left.id),
  )[0];
```

- [ ] **Step 4: Scope the Neon precondition and drop the global lock**

In `neon-repository.ts` inside the `applyConfigRevision` CTE:

Remove the `global_configuration_lock` CTE entirely and start the lock chain at the idempotency lock (lock order becomes idempotency → project; two applies for the same project still serialize on the project lock, different projects share no locks):

```sql
with "idempotency_lock" as materialized (
  select pg_advisory_xact_lock(hashtextextended(${revision.id}, 0)) as "held"
),
"configuration_lock" as materialized (
  select pg_advisory_xact_lock(hashtextextended(${project.id}, 0)) as "held"
  from "idempotency_lock"
),
```

Add the project filter to `active_revision` (keep the cross join on `configuration_lock` — it forces the lock to be acquired before the read):

```sql
"active_revision" as materialized (
  select "active"."revision", "active"."config_digest"
  from "config_revisions" as "active", "configuration_lock"
  where "active"."project_id" = ${project.id}
  order by "active"."created_at" desc, "active"."revision" desc,
           "active"."id" collate "C" desc
  limit 1
),
```

Everything else in the statement (`existing_revision`, `precondition`, `project_row`, `next_revision`, `inserted_revision`) is already correct per-project and stays unchanged.

- [ ] **Step 5: Run the contract and the adapters suite**

Run: `pnpm --filter @agentos/adapters test`
Expected: PASS. Note in the task summary: the Neon side of this contract only executes under `TEST_DATABASE_URL` (`pnpm test:integration`) — run it if the database is available, otherwise state that it was not run.

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/src/persistence
git commit -m "fix(persistence): scope configuration CAS preconditions per project

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Project-scoped latest revision + binding-derived project identity

The port change and the service logic land together — the service's two `getLatestConfigRevision()` call sites cannot compile against the new signature without the identity logic that replaces them.

**Files:**
- Modify: `packages/core/src/persistence.ts:470` (port signature)
- Modify: `packages/adapters/src/persistence/neon-repository.ts:530-542`
- Modify: `packages/adapters/src/persistence/in-memory.ts:399-407`
- Modify: `packages/adapters/src/persistence/repository-parity-contract.ts` (one new case)
- Modify: `apps/control-plane/src/application/control-plane-service.ts` (`ConfigurationInput`, `getConfiguration`, `applyConfiguration`, new private helpers)
- Test: `apps/control-plane/src/application/control-plane-service.test.ts`

**Interfaces:**
- Consumes: Task 1's per-project CAS.
- Produces:
  - Port: `getLatestConfigRevision(projectId: ProjectId): Promise<ConfigRevision | undefined>` (the zero-arg form is gone).
  - `ConfigurationInput` gains `readonly projectId?: string` (integrity check only — identity always derives from the config).
  - `interface ProjectSelector { readonly projectId?: string; readonly repository?: string; readonly localPath?: string }` (exported).
  - `getConfiguration(includeCanonical = true, selector: ProjectSelector = {})` returns `{ active: ConfigurationProjection | null; projectId?: string }`.
  - Service errors: `project_not_found` 404 (unknown explicit `selector.projectId`), `project_required` 400 (no selector while >1 project exists), `project_mismatch` 409 (`input.projectId` disagrees with the derived project).

- [ ] **Step 1: Write the failing service tests**

Append to `control-plane-service.test.ts`. The file's `applyGoalConfiguration` helper and `createService` are reused; add a parameterized apply helper next to them:

```ts
async function applyProjectConfiguration(
  service: ControlPlaneService,
  key: string,
  projectLine: string,
  precondition: {
    expectedRevision: number | null;
    expectedDigest: string | null;
  } = { expectedRevision: null, expectedDigest: null },
) {
  const config = loadAgentOsConfig(`
version: 1
project: ${projectLine}
models: { standard: { provider: local, model: test } }
agents: { implementer: { model: standard } }
environments: { default: { runtime: process } }
pipelines: { feature: { steps: [{ id: implement, agent: implementer }] } }
policies: {}
budgets: { workflowMicrodollars: 1, dailyMicrodollars: 2, concurrency: 1 }
goals: { maxSteps: 2, maxRetries: 1, timeoutMs: 1000 }
runtime: { provider: local }
`);
  return service.applyConfiguration(key, {
    canonicalConfig: canonicalConfigJson(config),
    digest: canonicalConfigHash(config),
    ...precondition,
  });
}

describe('multi-project configuration', () => {
  it('creates one project per binding and keeps their revision chains independent', async () => {
    const repository = new InMemoryDomainRepository();
    const service = createService(repository);
    const a1 = await applyProjectConfiguration(
      service,
      'a1',
      '{ name: A, repository: https://github.com/team/a }',
    );
    const b1 = await applyProjectConfiguration(
      service,
      'b1',
      '{ name: B, repository: https://github.com/team/b }',
    );
    expect(a1.projectId).not.toBe(b1.projectId);
    expect(a1.revision).toBe(1);
    expect(b1.revision).toBe(1);

    // A's next apply preconditions against A's chain even though B is newer.
    const a2 = await applyProjectConfiguration(
      service,
      'a2',
      '{ name: A, repository: https://github.com/team/a }',
      { expectedRevision: 1, expectedDigest: a1.digest },
    );
    expect(a2.projectId).toBe(a1.projectId);
    expect(a2.revision).toBe(2);
    expect((await repository.listProjects()).length).toBe(2);
  });

  it('reuses the legacy singleton project when its latest binding matches', async () => {
    const repository = new InMemoryDomainRepository();
    const service = createService(repository);
    // Seed pre-multi-project state: the constant-id project with one revision
    // whose stored config carries the same repository binding.
    const legacyId = ids('project', 'configuration');
    const legacyConfig = loadAgentOsConfig(`
version: 1
project: { name: Legacy, repository: https://github.com/team/legacy }
models: { standard: { provider: local, model: test } }
agents: { implementer: { model: standard } }
environments: { default: { runtime: process } }
pipelines: { feature: { steps: [{ id: implement, agent: implementer }] } }
policies: {}
budgets: { workflowMicrodollars: 1, dailyMicrodollars: 2, concurrency: 1 }
goals: { maxSteps: 2, maxRetries: 1, timeoutMs: 1000 }
runtime: { provider: local }
`);
    await repository.createProject({
      id: legacyId,
      name: 'Legacy',
      repository: 'https://github.com/team/legacy',
      createdAt: now,
      updatedAt: now,
    });
    await repository.createConfigRevision({
      id: ids('configRevision', 'legacy-1'),
      projectId: legacyId,
      revision: 1,
      config: JSON.parse(canonicalConfigJson(legacyConfig)),
      configDigest: canonicalConfigHash(legacyConfig),
      modelDigest: 'model',
      promptDigest: 'prompt',
      environmentDigest: 'environment',
      policyDigest: 'policy',
      repositorySha: 'a'.repeat(40),
      createdAt: now,
    });

    const next = await applyProjectConfiguration(
      service,
      'legacy-2',
      '{ name: Legacy, repository: https://github.com/team/legacy }',
      {
        expectedRevision: 1,
        expectedDigest: canonicalConfigHash(legacyConfig),
      },
    );
    expect(next.projectId).toBe(legacyId);
    expect(next.revision).toBe(2);

    // A different binding still becomes a fresh project.
    const other = await applyProjectConfiguration(
      service,
      'other-1',
      '{ name: Other, repository: https://github.com/team/other }',
    );
    expect(other.projectId).not.toBe(legacyId);
  });

  it('rejects an apply whose declared projectId disagrees with the binding', async () => {
    const repository = new InMemoryDomainRepository();
    const service = createService(repository);
    const config = loadAgentOsConfig(`
version: 1
project: { name: A, repository: https://github.com/team/a }
models: { standard: { provider: local, model: test } }
agents: { implementer: { model: standard } }
environments: { default: { runtime: process } }
pipelines: { feature: { steps: [{ id: implement, agent: implementer }] } }
policies: {}
budgets: { workflowMicrodollars: 1, dailyMicrodollars: 2, concurrency: 1 }
goals: { maxSteps: 2, maxRetries: 1, timeoutMs: 1000 }
runtime: { provider: local }
`);
    await expect(
      service.applyConfiguration('mismatch', {
        canonicalConfig: canonicalConfigJson(config),
        digest: canonicalConfigHash(config),
        expectedRevision: null,
        expectedDigest: null,
        projectId: 'project-not-this-one',
      }),
    ).rejects.toMatchObject({ code: 'project_mismatch', status: 409 });
  });

  it('resolves getConfiguration selectors', async () => {
    const repository = new InMemoryDomainRepository();
    const service = createService(repository);
    const a = await applyProjectConfiguration(
      service,
      'sel-a',
      '{ name: A, repository: https://github.com/team/a }',
    );

    // Sole project: no selector needed.
    const sole = await service.getConfiguration(false);
    expect(sole.projectId).toBe(a.projectId);
    expect(sole.active?.digest).toBe(a.digest);

    await applyProjectConfiguration(
      service,
      'sel-b',
      '{ name: B, repository: https://github.com/team/b }',
    );

    // Two projects: a selector becomes mandatory.
    await expect(service.getConfiguration(false)).rejects.toMatchObject({
      code: 'project_required',
      status: 400,
    });

    // Explicit id and binding selectors both work.
    const byId = await service.getConfiguration(false, {
      projectId: a.projectId,
    });
    expect(byId.active?.digest).toBe(a.digest);
    const byBinding = await service.getConfiguration(false, {
      repository: 'https://github.com/team/a',
    });
    expect(byBinding.projectId).toBe(a.projectId);

    // Unknown explicit id is a 404; an un-applied binding resolves with no
    // active revision (that is how a first apply learns its precondition).
    await expect(
      service.getConfiguration(false, { projectId: 'project-unknown' }),
    ).rejects.toMatchObject({ code: 'project_not_found', status: 404 });
    const fresh = await service.getConfiguration(false, {
      repository: 'https://github.com/team/new',
    });
    expect(fresh.active).toBeNull();
    expect(typeof fresh.projectId).toBe('string');
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `pnpm --filter @agentos/control-plane test -- control-plane-service`
Expected: FAIL — `applyConfiguration` collapses both bindings into one project (`a1.projectId === b1.projectId`), and `getConfiguration` neither accepts a selector nor returns `projectId`.

- [ ] **Step 3: Change the port and both adapters**

`packages/core/src/persistence.ts:470`:

```ts
getLatestConfigRevision(
  projectId: ProjectId,
): Promise<ConfigRevision | undefined>;
```

`neon-repository.ts` (add the where clause):

```ts
async getLatestConfigRevision(
  projectId: ProjectId,
): Promise<ConfigRevision | undefined> {
  const [row] = await this.database
    .select(configRevisionSelection)
    .from(configRevisions)
    .where(eq(configRevisions.projectId, projectId))
    .orderBy(
      desc(configRevisions.createdAt),
      desc(configRevisions.revision),
      desc(bytewiseText(configRevisions.id)),
    )
    .limit(1);
  return row === undefined ? undefined : mapConfigRevisionRow(row);
}
```

`in-memory.ts`:

```ts
async getLatestConfigRevision(
  projectId: ProjectId,
): Promise<ConfigRevision | undefined> {
  const latest = [...this.#configRevisions.values()]
    .filter((revision) => revision.projectId === projectId)
    .sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) ||
        right.revision - left.revision ||
        right.id.localeCompare(left.id),
    )[0];
  return latest === undefined ? undefined : copy(latest);
}
```

Add one parity-contract case next to the Task 1 case (reuses its two-project seeding pattern):

```ts
it('scopes the latest configuration revision per project', async () => {
  const repository = await createRepository();
  const a = {
    id: persistenceId('project', `${implementation}-latest-a`),
    name: 'latest-a',
    createdAt: at,
    updatedAt: at,
  };
  const b = {
    id: persistenceId('project', `${implementation}-latest-b`),
    name: 'latest-b',
    createdAt: at,
    updatedAt: at,
  };
  const draft = (suffix: string, projectId: typeof a.id) => ({
    id: persistenceId('configRevision', `${implementation}-latest-${suffix}`),
    projectId,
    config: null,
    configDigest: `digest-${suffix}`,
    modelDigest: 'model',
    promptDigest: 'prompt',
    environmentDigest: 'environment',
    policyDigest: 'policy',
    repositorySha: 'sha',
    createdAt: at,
  });
  await repository.applyConfigRevision(a, draft('a1', a.id), {
    revision: null,
    digest: null,
  });
  await repository.applyConfigRevision(b, draft('b1', b.id), {
    revision: null,
    digest: null,
  });
  const latestA = await repository.getLatestConfigRevision(a.id);
  expect(latestA?.configDigest).toBe('digest-a1');
  const missing = await repository.getLatestConfigRevision(
    persistenceId('project', `${implementation}-latest-none`),
  );
  expect(missing).toBeUndefined();
});
```

- [ ] **Step 4: Implement identity derivation and the selector in the service**

In `control-plane-service.ts`:

Extend `ConfigurationInput`:

```ts
export interface ConfigurationInput {
  readonly canonicalConfig: string;
  readonly digest: string;
  readonly expectedRevision: number | null;
  readonly expectedDigest: string | null;
  /** Optional integrity check; identity always derives from the config. */
  readonly projectId?: string;
}
```

Add the selector type and helpers (module scope for the type, private methods on `ControlPlaneService`):

```ts
export interface ProjectSelector {
  readonly projectId?: string;
  readonly repository?: string;
  readonly localPath?: string;
}
```

```ts
private bindingKey(config: AgentOsConfig): string {
  if (config.project.repository !== undefined)
    return `repository:${config.project.repository}`;
  if (config.project.localPath !== undefined)
    return `localPath:${config.project.localPath}`;
  return `name:${config.project.name}`;
}

/**
 * Deterministic project identity from a binding key, with one carve-out:
 * deployments that predate multi-project keep their constant-id project
 * (and its whole revision history) as long as its latest revision still
 * carries the same binding.
 */
private async projectIdForBindingKey(
  key: string,
): Promise<PersistenceId<'project'>> {
  const derived = this.generateId('project', `binding:${key}`);
  if ((await this.repository.getProject(derived)) !== undefined)
    return derived;
  const legacyId = this.generateId('project', 'configuration');
  const legacy = await this.repository.getProject(legacyId);
  if (legacy !== undefined) {
    const latest = await this.repository.getLatestConfigRevision(legacyId);
    if (latest !== undefined) {
      try {
        if (this.bindingKey(parseAgentOsConfig(latest.config)) === key)
          return legacyId;
      } catch {
        // An unparseable legacy revision never captures new applies.
      }
    }
  }
  return derived;
}

private async resolveProjectId(
  selector: ProjectSelector,
): Promise<PersistenceId<'project'> | undefined> {
  if (selector.projectId !== undefined) {
    const id = persistenceId('project', selector.projectId);
    if ((await this.repository.getProject(id)) === undefined)
      throw new ServiceError('project_not_found', 'project not found', 404);
    return id;
  }
  if (selector.repository !== undefined)
    return this.projectIdForBindingKey(`repository:${selector.repository}`);
  if (selector.localPath !== undefined)
    return this.projectIdForBindingKey(`localPath:${selector.localPath}`);
  const projects = await this.repository.listProjects({ limit: 2 });
  if (projects.length > 1)
    throw new ServiceError(
      'project_required',
      'multiple projects exist; select one with projectId, repository, or localPath',
      400,
    );
  return projects[0]?.id;
}
```

`parseAgentOsConfig` is already imported at the top of the file. Replace `getConfiguration`:

```ts
async getConfiguration(
  includeCanonical = true,
  selector: ProjectSelector = {},
): Promise<{
  readonly active: ConfigurationProjection | null;
  readonly projectId?: string;
}> {
  const projectId = await this.resolveProjectId(selector);
  if (projectId === undefined) return { active: null };
  const active = await this.repository.getLatestConfigRevision(projectId);
  return {
    projectId,
    active:
      active === undefined
        ? null
        : configurationProjection(active, includeCanonical),
  };
}
```

In `applyConfiguration`, replace the collapse (currently `const active = await this.repository.getLatestConfigRevision(); const projectId = active?.projectId ?? this.generateId('project', 'configuration');`) with:

```ts
const projectId = await this.projectIdForBindingKey(this.bindingKey(config));
if (input.projectId !== undefined && input.projectId !== projectId)
  throw new ServiceError(
    'project_mismatch',
    'projectId does not match the configuration project',
    409,
  );
```

Import `PersistenceId` into the service's type imports if not already present (it is — `PersistenceId` and `PersistenceIdKind` are imported for `IdGenerator`).

- [ ] **Step 5: Run control-plane, adapters, and core suites**

Run: `pnpm --filter @agentos/control-plane test && pnpm --filter @agentos/adapters test && pnpm --filter @agentos/core test && pnpm typecheck`
Expected: PASS. Existing single-project tests keep passing because a sole project resolves without a selector, and identical bindings keep resolving to the same project.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/persistence.ts packages/adapters/src/persistence apps/control-plane/src/application
git commit -m "feat(control-plane): derive project identity from the configuration binding

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Project-aware service listings and a clean unknown-project error

**Files:**
- Modify: `apps/control-plane/src/application/control-plane-service.ts` (`listRuns`, `listInbox`, `listPendingApprovals`, `inboxDigest`, `createRun`; new `getConfigurationForConfig`)
- Test: `apps/control-plane/src/application/control-plane-service.test.ts`

**Interfaces:**
- Consumes: Task 2's `resolveProjectId`/`bindingKey`/`projectIdForBindingKey` and `ProjectSelector`.
- Produces:
  - `listRuns(limit = 50, projectId?: string)`, `listInbox(limit = 50, projectId?: string)`, `listPendingApprovals(limit = 50, includeSummaries = true, projectId?: string)`, `inboxDigest(limit = 50, projectId?: string)` — filters push down to `repository.listRuns({ projectId })`, which both adapters already implement.
  - `getConfigurationForConfig(config: AgentOsConfig, includeCanonical = false)` returning `{ projectId: string; active: ConfigurationProjection | null }` — the setup-apply route's per-project precondition source.
  - `createRun` throws `project_not_found` 404 when the target project does not exist (replaces the raw `workflow_runs.project_id` FK violation on the no-dispatch feature path).

- [ ] **Step 1: Write the failing tests**

```ts
describe('project-aware listings', () => {
  it('filters runs and rejects runs for unknown projects', async () => {
    const repository = new InMemoryDomainRepository();
    const service = createService(repository);
    const a = await applyProjectConfiguration(
      service,
      'runs-a',
      '{ name: A, repository: https://github.com/team/a }',
    );
    const b = await applyProjectConfiguration(
      service,
      'runs-b',
      '{ name: B, repository: https://github.com/team/b }',
    );
    const runInput = (projectId: string, digest: string) => ({
      projectId,
      title: 'Run',
      description: 'Run description.',
      repositorySha: 'a'.repeat(40),
      configDigest: digest,
      modelDigest: 'model',
      promptDigest: 'prompt',
      environmentDigest: 'env',
      policyDigest: 'policy',
    });
    await service.createFeatureRun('run-a', runInput(a.projectId, a.digest));
    await service.createFeatureRun('run-b', runInput(b.projectId, b.digest));

    expect((await service.listRuns()).length).toBe(2);
    const onlyA = await service.listRuns(50, a.projectId);
    expect(onlyA.length).toBe(1);
    expect(onlyA[0]?.projectId).toBe(a.projectId);

    await expect(
      service.createFeatureRun('run-x', runInput('project-missing', a.digest)),
    ).rejects.toMatchObject({ code: 'project_not_found', status: 404 });
  });

  it('resolves the apply precondition for a config via its binding', async () => {
    const repository = new InMemoryDomainRepository();
    const service = createService(repository);
    const applied = await applyProjectConfiguration(
      service,
      'for-config',
      '{ name: A, repository: https://github.com/team/a }',
    );
    const config = loadAgentOsConfig(`
version: 1
project: { name: A, repository: https://github.com/team/a }
models: { standard: { provider: local, model: test } }
agents: { implementer: { model: standard } }
environments: { default: { runtime: process } }
pipelines: { feature: { steps: [{ id: implement, agent: implementer }] } }
policies: {}
budgets: { workflowMicrodollars: 1, dailyMicrodollars: 2, concurrency: 1 }
goals: { maxSteps: 2, maxRetries: 1, timeoutMs: 1000 }
runtime: { provider: local }
`);
    const resolved = await service.getConfigurationForConfig(config);
    expect(resolved.projectId).toBe(applied.projectId);
    expect(resolved.active?.revision).toBe(1);
  });
});
```

Note the caller-provided digests in `runInput` must match the applied revision for the provenance check; `applyProjectConfiguration` returns them (`a.digest`), and the model/prompt/env/policy digests must be read from the applied provenance instead of literals if the provenance check rejects the literals — use `a.provenance.modelDigest` etc. exactly as the existing `createFeatureRun` tests in this file do (mirror the established pattern in the file; the run-creation tests around the `feature` fixture show the working shape).

- [ ] **Step 2: Implement**

`createRun` (before `createRunIdempotently`, right after computing `requestInput`):

```ts
const projectRecord = await this.repository.getProject(
  persistenceId('project', requestInput.projectId),
);
if (projectRecord === undefined)
  throw new ServiceError('project_not_found', 'project not found', 404);
```

Listings — thread the filter (repeat the same pattern in `listInbox`, `listPendingApprovals`, and `inboxDigest`, whose internal `this.repository.listRuns(...)` call gains the same conditional spread):

```ts
async listRuns(
  limit = 50,
  projectId?: string,
): Promise<readonly RunProjection[]> {
  const runs = await this.repository.listRuns({
    limit,
    order: 'desc',
    ...(projectId === undefined
      ? {}
      : { projectId: persistenceId('project', projectId) }),
  });
  return Promise.all(runs.map((run) => this.project(run)));
}
```

`getConfigurationForConfig`:

```ts
async getConfigurationForConfig(
  config: AgentOsConfig,
  includeCanonical = false,
): Promise<{
  readonly projectId: string;
  readonly active: ConfigurationProjection | null;
}> {
  const projectId = await this.projectIdForBindingKey(this.bindingKey(config));
  const active = await this.repository.getLatestConfigRevision(projectId);
  return {
    projectId,
    active:
      active === undefined
        ? null
        : configurationProjection(active, includeCanonical),
  };
}
```

- [ ] **Step 3: Run the suite**

Run: `pnpm --filter @agentos/control-plane test`
Expected: PASS, including all pre-existing run/inbox tests (no filter passed → unchanged behavior).

- [ ] **Step 4: Commit**

```bash
git add apps/control-plane/src/application
git commit -m "feat(control-plane): project filters for listings and clean unknown-project errors

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: HTTP surface — selectors on configuration, setup, runs, and inbox routes

**Files:**
- Modify: `apps/control-plane/src/http/contracts.ts` (new `allowedQuery`, `configurationQuerySchema`; extend `configurationApplySchema`, `activeConfigurationSchema`)
- Modify: `apps/control-plane/app/api/configuration/route.ts`
- Modify: `apps/control-plane/app/api/setup/apply/route.ts`
- Modify: `apps/control-plane/app/api/setup/repository-head/route.ts`
- Modify: `apps/control-plane/app/api/runs/route.ts`
- Modify: `apps/control-plane/app/api/inbox/route.ts`
- Modify: `apps/control-plane/src/ui/setup-wizard.tsx` (`fetchHead` URL)
- Test: `apps/control-plane/src/http/configuration-route.test.ts`, `apps/control-plane/src/http/contracts.test.ts`, `apps/control-plane/src/http/setup-routes.test.ts`

**Interfaces:**
- Consumes: `ProjectSelector`, `getConfiguration(includeCanonical, selector)`, `getConfigurationForConfig(config)`, `listRuns(limit, projectId?)`, `listInbox(limit, projectId?)`, `listPendingApprovals(limit, includeSummaries, projectId?)` from Tasks 2–3.
- Produces:
  - `allowedQuery(request: Request, allowed: readonly string[]): Record<string, string>` — throws the standard `{ code: 'validation_error', status: 422 }` object on unknown or duplicated params (same shape `assertNoQuery` throws today).
  - `GET /api/configuration?projectId=…|repository=…|localPath=…` (at most one selector; the response gains top-level `projectId` when resolved).
  - `POST /api/configuration/apply` accepts optional `projectId`.
  - `GET /api/setup/repository-head?projectId=…` (optional).
  - `GET /api/runs?projectId=…`, `GET /api/inbox?projectId=…` (optional).

- [ ] **Step 1: Write the failing route/contract tests**

In `contracts.test.ts` (follows the file's existing plain-function test style):

```ts
describe('allowedQuery', () => {
  const request = (query: string) =>
    new Request(`https://control.example/api/x${query}`);

  it('returns allowlisted parameters and rejects everything else', () => {
    expect(allowedQuery(request(''), ['projectId'])).toEqual({});
    expect(allowedQuery(request('?projectId=p1'), ['projectId'])).toEqual({
      projectId: 'p1',
    });
    expect(() => allowedQuery(request('?other=1'), ['projectId'])).toThrow(
      'query parameters are not supported',
    );
    expect(() =>
      allowedQuery(request('?projectId=a&projectId=b'), ['projectId']),
    ).toThrow('query parameters are not supported');
  });
});
```

In `configuration-route.test.ts`, after the existing cases (reuse its `request` helper, seeded auth env, and `body` fixture; a second config fixture with a different `project.repository` is applied through the same POST route):

```ts
it('scopes GET /api/configuration by project and requires a selector when ambiguous', async () => {
  const second = loadAgentOsConfig(`
version: 1
project: { name: Second, repository: https://github.com/team/second }
models: { standard: { provider: local, model: test } }
agents: { implementer: { model: standard } }
environments: { default: { runtime: process } }
pipelines: { feature: { steps: [{ id: implement, agent: implementer }] } }
policies: {}
budgets: { workflowMicrodollars: 1, dailyMicrodollars: 2, concurrency: 1 }
goals: { maxSteps: 2, maxRetries: 1, timeoutMs: 1000 }
runtime: { provider: local }
`);
  const applyFirst = await POST(
    request('/api/configuration/apply', {
      method: 'POST',
      headers: { 'idempotency-key': 'multi-1' },
      body: JSON.stringify(body),
    }),
  );
  expect(applyFirst.status).toBe(201);
  const first = (await applyFirst.json()) as { projectId: string };

  const applySecond = await POST(
    request('/api/configuration/apply', {
      method: 'POST',
      headers: { 'idempotency-key': 'multi-2' },
      body: JSON.stringify({
        canonicalConfig: canonicalConfigJson(second),
        digest: canonicalConfigHash(second),
        expectedRevision: null,
        expectedDigest: null,
      }),
    }),
  );
  expect(applySecond.status).toBe(201);

  const ambiguous = await GET(request('/api/configuration'));
  expect(ambiguous.status).toBe(400);
  expect(((await ambiguous.json()) as { error: { code: string } }).error.code)
    .toBe('project_required');

  const scoped = await GET(
    request(`/api/configuration?projectId=${first.projectId}`),
  );
  expect(scoped.status).toBe(200);
  expect(await scoped.json()).toMatchObject({ projectId: first.projectId });

  const byBinding = await GET(
    request(
      `/api/configuration?repository=${encodeURIComponent('https://github.com/team/second')}`,
    ),
  );
  expect(byBinding.status).toBe(200);
});
```

Note: the first apply's `body` fixture uses the file's existing `Route Test` config, which has **no** binding — its binding key falls back to `name:Route Test`, so it is a distinct project from `Second`. That is exactly the point of the test.

In `setup-routes.test.ts`, add one case asserting `GET /api/setup/repository-head?projectId=<unknown>` returns 404 `project_not_found`, following that file's existing request/env conventions.

- [ ] **Step 2: Run to verify the new route tests fail**

Run: `pnpm --filter @agentos/control-plane test -- http`
Expected: FAIL — the second apply currently lands on the first project (Task 2 fixed the service, so re-check: it now creates a second project; the GET assertions fail because the route still calls `assertNoQuery` and the response schema lacks `projectId`).

- [ ] **Step 3: Implement contracts and routes**

`contracts.ts`:

```ts
export function allowedQuery(
  request: Request,
  allowed: readonly string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of new URL(request.url).searchParams) {
    if (!allowed.includes(key) || key in result) {
      throw Object.assign(new Error('query parameters are not supported'), {
        code: 'validation_error',
        status: 422,
      });
    }
    result[key] = value;
  }
  return result;
}

export const configurationQuerySchema = z
  .object({
    projectId: id.optional(),
    repository: z.string().trim().min(1).max(2_048).optional(),
    localPath: z.string().trim().min(1).max(4_096).startsWith('/').optional(),
  })
  .strict()
  .refine(
    (value) => Object.values(value).filter((v) => v !== undefined).length <= 1,
    'pass at most one of projectId, repository, localPath',
  );
```

Extend `configurationApplySchema`'s object with `projectId: id.optional()` (inside the existing `.object({...})`, before `.strict()`), and `activeConfigurationSchema` becomes:

```ts
export const activeConfigurationSchema = z
  .object({
    active: configurationProjectionSchema.nullable(),
    projectId: id.optional(),
  })
  .strict();
```

`app/api/configuration/route.ts` — replace `assertNoQuery(request)` with:

```ts
const parsed = configurationQuerySchema.safeParse(
  allowedQuery(request, ['projectId', 'repository', 'localPath']),
);
if (!parsed.success) {
  throw Object.assign(new Error('query parameters are invalid'), {
    code: 'validation_error',
    status: 422,
  });
}
return controlPlaneService().getConfiguration(includeCanonical, parsed.data);
```

`app/api/setup/apply/route.ts` — replace the global precondition read:

```ts
const service = controlPlaneService();
const resolved = await service.getConfigurationForConfig(config);
return service.applyConfiguration(idempotencyKey(request), {
  canonicalConfig,
  digest,
  expectedRevision: resolved.active?.revision ?? null,
  expectedDigest: resolved.active?.digest ?? null,
  projectId: resolved.projectId,
});
```

(`config` is the already-parsed `loadAgentOsConfig(body.yaml)` result; hoist it out of the try block's scope so it is visible here.)

`app/api/setup/repository-head/route.ts` — replace the `getConfiguration(true)` call:

```ts
const query = allowedQuery(request, ['projectId']);
const active = await controlPlaneService().getConfiguration(
  true,
  query.projectId === undefined
    ? {}
    : { projectId: boundedPathId(query.projectId) },
);
```

`app/api/runs/route.ts` and `app/api/inbox/route.ts` — replace `assertNoQuery`:

```ts
const query = allowedQuery(request, ['projectId']);
const projectId =
  query.projectId === undefined ? undefined : boundedPathId(query.projectId);
```

then `listRuns(50, projectId)` in the runs route, and in the inbox route `service.listInbox(50, projectId)` / `service.listPendingApprovals(50, true, projectId)`.

`setup-wizard.tsx` `fetchHead`:

```ts
const response = await fetch(
  applied === undefined
    ? '/api/setup/repository-head'
    : `/api/setup/repository-head?projectId=${encodeURIComponent(applied.projectId)}`,
);
```

- [ ] **Step 4: Run the http and application suites plus typecheck**

Run: `pnpm --filter @agentos/control-plane test && pnpm --filter @agentos/control-plane typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/http apps/control-plane/app/api apps/control-plane/src/ui/setup-wizard.tsx
git commit -m "feat(control-plane): project selectors on configuration, setup, runs, and inbox APIs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: CLI — project-aware `config plan` / `config apply`

**Files:**
- Modify: `apps/cli/src/main.ts` (`activeConfiguration` parser, `config.plan`, `config.apply`)
- Test: `apps/cli/src/main.test.ts`

**Interfaces:**
- Consumes: `GET /api/configuration?repository=…|localPath=…` returning `{ active, projectId? }` and the apply body's optional `projectId` from Task 4.
- Produces: `configurationResponse(value): { projectId?: string; active: {canonicalConfig, digest, revision} | null }` replacing `activeConfiguration`; `config plan` output gains `projectId` when the server resolves one; `config apply` sends `projectId` when known. No new flags — the selector comes from the config file's own binding.

- [ ] **Step 1: Write the failing CLI test**

Following the `capture`/fetch-mock conventions already in `main.test.ts`:

```ts
it('scopes config plan and apply to the configuration binding', async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'agentos-multi-project-')),
  );
  const path = join(root, 'agent-os.yaml');
  await writeFile(join(root, '.git'), 'gitdir: test\n');
  await writeFile(
    path,
    `
version: 1
project:
  name: local-two
  localPath: /workspaces/local-two
  defaultBranch: main
models:
  standard:
    provider: local
    model: test-model
    inputMicrodollarsPerMillionTokens: 0
    outputMicrodollarsPerMillionTokens: 0
    runtimeMicrodollarsPerMinute: 0
agents:
  implementer: { model: standard, environment: default }
environments:
  default: { runtime: process }
pipelines:
  feature: { steps: [{ id: implement, agent: implementer }] }
policies: {}
budgets: { workflowMicrodollars: 1, dailyMicrodollars: 2, concurrency: 1 }
goals: { maxSteps: 2, maxRetries: 1, timeoutMs: 1000 }
runtime: { provider: local }
`,
  );
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetch = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      if (init?.method === 'GET')
        return Response.json({ active: null, projectId: 'project_two' });
      return Response.json({
        projectId: 'project_two',
        digest: 'b'.repeat(64),
        revision: 1,
        appliedAt: '2026-08-20T12:00:00.000Z',
        provenance: {
          repositorySha: 'a'.repeat(40),
          configDigest: 'b'.repeat(64),
          modelDigest: 'c'.repeat(64),
          promptDigest: 'd'.repeat(64),
          environmentDigest: 'e'.repeat(64),
          policyDigest: 'f'.repeat(64),
        },
      });
    },
  );
  const shared = {
    fetch: fetch as typeof globalThis.fetch,
    cwd: root,
    env: { AGENTOS_URL: 'https://control.example', AGENTOS_API_TOKEN: 't' },
  };

  const apply = capture(shared);
  expect(
    await runCli(
      ['config', 'apply', '--config', path, '--idempotency-key', 'multi'],
      apply.io,
    ),
  ).toBe(0);
  expect(requests[0]?.url).toBe(
    `https://control.example/api/configuration?localPath=${encodeURIComponent('/workspaces/local-two')}`,
  );
  expect(JSON.parse(String(requests[1]?.init?.body))).toMatchObject({
    projectId: 'project_two',
    expectedRevision: null,
    expectedDigest: null,
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @agentos/cli test -- main`
Expected: FAIL — the GET goes to bare `/api/configuration` and the apply body has no `projectId`.

- [ ] **Step 3: Implement**

In `main.ts`, add next to `activeConfiguration`:

```ts
function configurationQuery(config: {
  readonly project: { readonly repository?: string; readonly localPath?: string };
}): string {
  const params =
    config.project.repository !== undefined
      ? { repository: config.project.repository }
      : config.project.localPath !== undefined
        ? { localPath: config.project.localPath }
        : undefined;
  return params === undefined
    ? ''
    : `?${new URLSearchParams(params).toString()}`;
}
```

Extend the parser: rename `activeConfiguration(value)` to `configurationResponse(value)` returning `{ projectId?: string; active: {...} | null }` — keep all existing field validation for `active`, and read a top-level optional string `projectId` (reject non-string values with the same `ApiError`). Update both call sites:

- `config.plan`: GET `/api/configuration${configurationQuery(loaded.config)}`; when `response.active === null`, return the existing "added" plan shape plus `...(response.projectId === undefined ? {} : { projectId: response.projectId })`; otherwise spread the same `projectId` into the `planConfigChange(...)` result object.
- `config.apply`: GET with the same query; POST body gains `...(response.projectId === undefined ? {} : { projectId: response.projectId })` and preconditions come from `response.active` exactly as today (`response.active?.revision ?? null`).

A config with no binding (like `STARTER_CONFIG`) sends no query — the server's sole-project rule preserves today's behavior for single-project deployments, and with several projects the server answers `project_required`, which the CLI surfaces verbatim.

- [ ] **Step 4: Run the CLI suite**

Run: `pnpm --filter @agentos/cli test`
Expected: PASS, including the existing `config apply` precondition and feature-start tests (their fetch mocks return `{ active: null }` with no `projectId`, which stays valid).

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src
git commit -m "feat(cli): resolve the target project from the configuration binding

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Docs and full verification

**Files:**
- Modify: `docs/progress.md` (the "Local experiment projects are implemented" paragraph area)
- Modify: `docs/superpowers/specs/2026-08-20-multi-project-parallel-design.md` (status line)

**Interfaces:** none — documentation and gatekeeping only.

- [ ] **Step 1: Update docs**

Append after the local-experiment-projects paragraph in `docs/progress.md`:

```markdown
Multi-project configuration is implemented (Phase 1 of
[the multi-project design](./superpowers/specs/2026-08-20-multi-project-parallel-design.md)):
project identity derives from the configuration binding, CAS preconditions
and the latest-revision lookup are project-scoped in both repository
adapters, and the configuration/setup/runs/inbox APIs, wizard, and CLI
accept project selectors. Execution still serializes on the global agent
session and single-slot Trigger queues until Phase 2.
```

In the design spec, change `Status: draft for review` to `Status: Phase 1 implemented (see docs/superpowers/plans/2026-08-20-multi-project-configuration.md); later phases pending`.

- [ ] **Step 2: Full verification**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all green. If `TEST_DATABASE_URL` is available, also run `pnpm test:integration` (exercises the Neon CAS scoping and per-project latest-revision contract cases); otherwise record explicitly that Postgres integration was not executed.

- [ ] **Step 3: Commit**

```bash
git add docs
git commit -m "docs: record multi-project configuration (phase 1) status

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-review notes

- **Spec coverage (Phase 1 section):** port + adapter CAS scoping (Tasks 1–2), global-lock removal (Task 1), binding-derived identity with legacy reuse (Task 2), HTTP/CLI selector threading and `assertNoQuery` relaxation (Tasks 4–5), runs/inbox filters via the existing-but-unused `RunListFilter.projectId` (Tasks 3–4), the FK-violation cleanup (Task 3), and the two-project parity armor (Tasks 1–2). The wizard remains single-project by design until Phase 4; only its head-fetch learns to name the project it applied.
- **Deliberately not here:** the session lease, Trigger queues, Managed Agents namespacing, reconciliation sharding (Phase 2 plan); GitHub multi-repo binding and readiness split (Phase 3 plan); Projects-page UI (Phase 4 plan); budget threading (Phase 5 plan).
- **Known seam left behind:** `GET /api/configuration` with no selector on a multi-project deployment returns `project_required` — single-project deployments and fresh installs are unaffected. The configuration *page* still reads `AGENTOS_CONFIG_PATH`; it is repointed in Phase 4.
