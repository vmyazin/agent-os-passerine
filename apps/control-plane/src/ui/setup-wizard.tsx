'use client';

import { useEffect, useRef, useState } from 'react';

import type { ProjectListProjection } from '../application/control-plane-service';
import { publishProjectCount } from './project-count-signal';
import { renderSetupConfig } from './setup-template-render';

interface ReadinessItem {
  readonly key: string;
  readonly label: string;
  readonly ready: boolean;
  readonly hint: string;
}

interface ReadinessGroup {
  readonly id: string;
  readonly title: string;
  readonly ready: boolean;
  readonly items: readonly ReadinessItem[];
}

interface Readiness {
  readonly ready: boolean;
  readonly readyForGitHub: boolean;
  readonly readyForLocal: boolean;
  readonly repositories?: readonly string[];
  readonly groups: readonly ReadinessGroup[];
}

type ProjectMode = 'github' | 'local';

interface LocalRepositoryResult {
  readonly localPath: string;
  readonly headSha: string;
}

interface AppliedConfiguration {
  readonly projectId: string;
  readonly revision: number;
  readonly provenance: {
    readonly repositorySha: string;
    readonly configDigest: string;
    readonly modelDigest: string;
    readonly promptDigest: string;
    readonly environmentDigest: string;
    readonly policyDigest: string;
  };
}

interface RepositoryHead {
  readonly repository: string;
  readonly branch: string;
  readonly repositorySha: string;
}

interface WizardSnapshot {
  readonly mode: ProjectMode;
  readonly yaml: string;
  readonly localName: string;
  readonly localRepositoryResult?: LocalRepositoryResult;
  readonly applied?: AppliedConfiguration;
  readonly head?: RepositoryHead;
  readonly title: string;
  readonly description: string;
  readonly runId: string;
}

const NEW_PROJECT_KEY = 'new';

function defaultWizardSnapshot(mode: ProjectMode = 'github'): WizardSnapshot {
  return {
    mode,
    yaml: renderSetupConfig(mode, { name: 'my-project' }),
    localName: '',
    title: '',
    description: '',
    runId: '',
  };
}

function templateForMode(mode: ProjectMode): string {
  return renderSetupConfig(mode, { name: 'my-project' });
}

function modeFromYaml(yaml: string): ProjectMode {
  return /^[^\S\n]*localPath:/m.test(yaml) ? 'local' : 'github';
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: { message?: string };
    };
    return body.error?.message ?? `request failed (${response.status})`;
  } catch {
    return `request failed (${response.status})`;
  }
}

function StepHeading({
  step,
  title,
  done,
}: {
  readonly step: number;
  readonly title: string;
  readonly done: boolean;
}) {
  return (
    <h2>
      {done ? '✓ ' : ''}Step {step} — {title}
    </h2>
  );
}

export function SetupWizard() {
  const [readiness, setReadiness] = useState<Readiness | undefined>();
  const [readinessError, setReadinessError] = useState('');
  const [projects, setProjects] = useState<readonly ProjectListProjection[]>(
    [],
  );
  const [activeProjectKey, setActiveProjectKey] = useState(NEW_PROJECT_KEY);
  const wizardByKey = useRef<Record<string, WizardSnapshot>>({
    [NEW_PROJECT_KEY]: defaultWizardSnapshot(),
  });
  const [mode, setMode] = useState<ProjectMode>('github');
  const [yaml, setYaml] = useState(templateForMode('github'));
  const [localName, setLocalName] = useState('');
  const [creatingLocalRepository, setCreatingLocalRepository] = useState(false);
  const [localRepositoryError, setLocalRepositoryError] = useState('');
  const [localRepositoryResult, setLocalRepositoryResult] = useState<
    LocalRepositoryResult | undefined
  >();
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState('');
  const [applied, setApplied] = useState<AppliedConfiguration | undefined>();
  const [head, setHead] = useState<RepositoryHead | undefined>();
  const [headError, setHeadError] = useState('');
  const [fetchingHead, setFetchingHead] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState('');
  const [runId, setRunId] = useState('');

  const snapshotWizard = (): WizardSnapshot => ({
    mode,
    yaml,
    localName,
    ...(localRepositoryResult === undefined ? {} : { localRepositoryResult }),
    ...(applied === undefined ? {} : { applied }),
    ...(head === undefined ? {} : { head }),
    title,
    description,
    runId,
  });

  const restoreWizard = (saved: WizardSnapshot) => {
    setMode(saved.mode);
    setYaml(saved.yaml);
    setLocalName(saved.localName);
    setLocalRepositoryResult(saved.localRepositoryResult);
    setApplied(saved.applied);
    setHead(saved.head);
    setTitle(saved.title);
    setDescription(saved.description);
    setRunId(saved.runId);
    setApplyError('');
    setHeadError('');
    setStartError('');
    setLocalRepositoryError('');
  };

  const loadProjects = async () => {
    try {
      const response = await fetch('/api/projects');
      if (!response.ok) return;
      const loaded = (await response.json()) as readonly ProjectListProjection[];
      setProjects(loaded);
      // Applying a configuration can create a project; tell the rail so its
      // badge stops disagreeing with the switcher right next to it.
      publishProjectCount(loaded.length);
    } catch {
      // Project listing is decoration for the switcher; never block setup.
    }
  };

  const loadReadiness = async () => {
    setReadinessError('');
    try {
      const response = await fetch('/api/setup/readiness');
      if (!response.ok) throw new Error(await readError(response));
      setReadiness((await response.json()) as Readiness);
    } catch (error) {
      setReadinessError(
        error instanceof Error ? error.message : 'readiness check failed',
      );
    }
  };

  const loadExistingProject = async (
    projectId: string,
  ): Promise<WizardSnapshot> => {
    const response = await fetch(
      `/api/configuration?projectId=${encodeURIComponent(projectId)}`,
    );
    if (!response.ok) throw new Error(await readError(response));
    const body = (await response.json()) as {
      active?: {
        canonicalConfig?: string;
        revision: number;
        provenance: AppliedConfiguration['provenance'];
      };
      projectId?: string;
    };
    if (body.active?.canonicalConfig === undefined) {
      const empty = defaultWizardSnapshot('github');
      restoreWizard(empty);
      return empty;
    }
    const nextMode = modeFromYaml(body.active.canonicalConfig);
    const loaded: WizardSnapshot = {
      mode: nextMode,
      yaml: body.active.canonicalConfig,
      localName: '',
      applied: {
        projectId: body.projectId ?? projectId,
        revision: body.active.revision,
        provenance: body.active.provenance,
      },
      title: '',
      description: '',
      runId: '',
    };
    restoreWizard(loaded);
    return loaded;
  };

  const selectProject = async (key: string) => {
    if (key === activeProjectKey) return;
    wizardByKey.current[activeProjectKey] = snapshotWizard();
    setActiveProjectKey(key);
    const saved = wizardByKey.current[key];
    if (saved !== undefined) {
      restoreWizard(saved);
      return;
    }
    if (key === NEW_PROJECT_KEY) {
      restoreWizard(defaultWizardSnapshot(mode));
      return;
    }
    try {
      wizardByKey.current[key] = await loadExistingProject(key);
    } catch (error) {
      restoreWizard(defaultWizardSnapshot(mode));
      setApplyError(
        error instanceof Error ? error.message : 'project load failed',
      );
    }
  };

  useEffect(() => {
    void loadReadiness();
    void loadProjects();
  }, []);

  const selectMode = (nextMode: ProjectMode) => {
    if (nextMode === mode) return;
    setYaml((current) =>
      current === templateForMode(mode) ? templateForMode(nextMode) : current,
    );
    setMode(nextMode);
  };

  const createRepository = async (
    body: { name: string } | { namePrefix: string },
  ) => {
    if (creatingLocalRepository) return;
    setCreatingLocalRepository(true);
    setLocalRepositoryError('');
    try {
      const response = await fetch('/api/setup/local-repository', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await readError(response));
      const result = (await response.json()) as {
        name: string;
        localPath: string;
        branch: string;
        headSha: string;
      };
      setLocalRepositoryResult({
        localPath: result.localPath,
        headSha: result.headSha,
      });
      setYaml(
        renderSetupConfig('local', {
          name: result.name,
          localPath: result.localPath,
        }),
      );
      return result;
    } catch (error) {
      setLocalRepositoryError(
        error instanceof Error
          ? error.message
          : 'local repository creation failed',
      );
      return undefined;
    } finally {
      setCreatingLocalRepository(false);
    }
  };

  const createLocalRepository = () => createRepository({ name: localName });

  const TEST_PROJECTS = [
    {
      key: 'todo',
      label: 'Todo app',
      namePrefix: 'todo-app',
      title: 'Add todo store module',
      description:
        'Add src/todo-store.mjs exporting createTodoStore() with add(text) returning the new todo {id, text, done}, complete(id) marking it done, and list() returning a deep defensive copy: neither the returned array nor the todo objects inside it (nor the object returned by add) may share identity with internal state, so mutating any of them must not change the store. Ids increment from 1; completing an unknown id throws. Keep it in-memory, ESM, and dependency-free. Add test/todo-store.test.mjs with node:test covering add, complete, list, the unknown-id error, and mutation tests proving that changing a returned todo object or the returned array does not alter the store.',
    },
    {
      key: 'dashboard',
      label: 'Marketing dashboard',
      namePrefix: 'dashboard',
      title: 'Add campaign metrics module',
      description:
        'Add src/metrics.mjs exporting summarizeCampaigns(events) where events is an array of {campaign, impressions, clicks, conversions, costCents}. Return {campaigns, totals}: per-campaign and total ctr (clicks/impressions), conversionRate (conversions/clicks), and cpaCents (costCents/conversions), each rounded to 4 decimals and 0 when the denominator is 0. Aggregate multiple events for the same campaign. ESM, dependency-free. Add test/metrics.test.mjs with node:test covering aggregation, the zero-denominator guards, and totals, matching the existing test style.',
    },
    {
      key: 'snake',
      label: 'Snake game',
      namePrefix: 'snake',
      title: 'Add snake game core',
      description:
        'Add src/snake.mjs exporting createGame({width, height, rng}) with state() returning {snake, food, score, alive, direction}, turn(direction) ignoring 180-degree reversals, and tick() advancing one step: the snake moves, grows and scores when eating food, and dies on wall or self collision. Place food with the injectable rng so tests are deterministic. ESM, dependency-free. Add test/snake.test.mjs with node:test covering movement, reversal rejection, eating and growth, and both collision deaths, matching the existing test style.',
    },
  ] as const;

  const fillTestProject = async (
    project: (typeof TEST_PROJECTS)[number],
  ) => {
    const created = await createRepository({ namePrefix: project.namePrefix });
    if (created === undefined) return;
    setTitle(project.title);
    setDescription(project.description);
  };

  const apply = async () => {
    if (applying) return;
    setApplying(true);
    setApplyError('');
    try {
      const response = await fetch('/api/setup/apply', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({ yaml }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const result = (await response.json()) as AppliedConfiguration;
      setApplied(result);
      setHead(undefined);
      setRunId('');
      setActiveProjectKey(result.projectId);
      wizardByKey.current[result.projectId] = {
        mode,
        yaml,
        localName,
        ...(localRepositoryResult === undefined ? {} : { localRepositoryResult }),
        applied: result,
        title,
        description,
        runId: '',
      };
      await loadProjects();
    } catch (error) {
      setApplyError(
        error instanceof Error ? error.message : 'configuration apply failed',
      );
    } finally {
      setApplying(false);
    }
  };

  const fetchHead = async () => {
    if (fetchingHead) return;
    setFetchingHead(true);
    setHeadError('');
    try {
      const response = await fetch(
        applied === undefined
          ? '/api/setup/repository-head'
          : `/api/setup/repository-head?projectId=${encodeURIComponent(applied.projectId)}`,
      );
      if (!response.ok) throw new Error(await readError(response));
      setHead((await response.json()) as RepositoryHead);
    } catch (error) {
      setHeadError(
        error instanceof Error ? error.message : 'head resolution failed',
      );
    } finally {
      setFetchingHead(false);
    }
  };

  const startRun = async () => {
    if (starting || applied === undefined || head === undefined) return;
    setStarting(true);
    setStartError('');
    try {
      const response = await fetch('/api/features', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          projectId: applied.projectId,
          title,
          description,
          repositorySha: head.repositorySha,
          configDigest: applied.provenance.configDigest,
          modelDigest: applied.provenance.modelDigest,
          promptDigest: applied.provenance.promptDigest,
          environmentDigest: applied.provenance.environmentDigest,
          policyDigest: applied.provenance.policyDigest,
        }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const run = (await response.json()) as { id: string };
      setRunId(run.id);
    } catch (error) {
      setStartError(
        error instanceof Error ? error.message : 'run start failed',
      );
    } finally {
      setStarting(false);
    }
  };

  const modeReady =
    readiness !== undefined &&
    (mode === 'github' ? readiness.readyForGitHub : readiness.readyForLocal);
  const localNotReady =
    mode === 'local' && readiness !== undefined && !readiness.readyForLocal;

  return (
    <div className="page-stack">
      <section className="page-heading" aria-labelledby="setup-title">
        <p className="eyebrow">Guided setup</p>
        <h1 id="setup-title">Projects</h1>
        <p>
          Four steps from an empty workspace to a running feature workflow.
          Approvals stay in the inbox; merging stays with you.
        </p>
      </section>

      <section aria-labelledby="setup-step-1">
        <StepHeading step={1} title="Environment readiness" done={modeReady} />
        {readiness === undefined && readinessError === '' ? (
          <p>Checking the environment…</p>
        ) : null}
        {readinessError !== '' ? (
          <p role="alert">
            {readinessError}{' '}
            <button className="secondary" onClick={() => void loadReadiness()} type="button">
              Retry
            </button>
          </p>
        ) : null}
        {readiness !== undefined ? (
          <>
            <p>
              {modeReady
                ? 'Every subsystem is configured.'
                : 'Set the missing variables in .env.local, restart the control plane, then check again.'}
              {readiness.repositories !== undefined &&
              readiness.repositories.length > 0
                ? ` Bound repositories: ${readiness.repositories.join(', ')}.`
                : ''}
            </p>
            <ul>
              {readiness.groups.map((group) => {
                const notRequiredForMode =
                  (mode === 'github' && group.id === 'local') ||
                  (mode === 'local' && group.id === 'github');
                return (
                  <li key={group.id}>
                    <strong>
                      {group.ready ? '✓' : '✗'} {group.title}
                      {!group.ready && notRequiredForMode
                        ? ' — not required for this project type'
                        : ''}
                    </strong>
                    {group.ready ? null : (
                      <ul>
                        {group.items
                          .filter((item) => !item.ready)
                          .map((item) => (
                            <li key={item.key}>
                              <code>{item.key}</code> — {item.hint}
                            </li>
                          ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
            {readiness.groups.some(
              (group) => group.id === 'dispatch' && group.ready,
            ) ? (
              <p className="notice">
                Workflow dispatch is configured, but these variables only
                enqueue work. Runs stay <strong>Pending</strong> until a
                Trigger.dev worker is connected: locally run{' '}
                <code>npx trigger.dev@latest dev</code> in a second terminal,
                and deploy one with <code>pnpm trigger:deploy</code>. Nothing
                on this page can detect that worker, so a fully green check
                above does not by itself mean a run will execute.
              </p>
            ) : null}
            <button className="secondary" onClick={() => void loadReadiness()} type="button">
              Check again
            </button>
          </>
        ) : null}
      </section>

      <section aria-labelledby="setup-step-2">
        <StepHeading step={2} title="Apply configuration" done={applied !== undefined} />
        <nav aria-label="Project switcher" className="project-switcher">
          <button
            aria-pressed={activeProjectKey === NEW_PROJECT_KEY}
            className={activeProjectKey === NEW_PROJECT_KEY ? undefined : 'secondary'}
            onClick={() => void selectProject(NEW_PROJECT_KEY)}
            type="button"
          >
            New project
          </button>
          {projects.map((project) => (
            <button
              aria-pressed={activeProjectKey === project.id}
              className={activeProjectKey === project.id ? undefined : 'secondary'}
              key={project.id}
              onClick={() => void selectProject(project.id)}
              type="button"
            >
              {project.name}
            </button>
          ))}
        </nav>
        <div className="button-row" role="group" aria-label="Project type">
          <button
            aria-pressed={mode === 'github'}
            className={mode === 'github' ? undefined : 'secondary'}
            onClick={() => selectMode('github')}
            type="button"
          >
            GitHub project
          </button>
          <button
            aria-pressed={mode === 'local'}
            className={mode === 'local' ? undefined : 'secondary'}
            onClick={() => selectMode('local')}
            type="button"
          >
            Local experiment
          </button>
        </div>
        {mode === 'local' ? (
          <p>
            <small>
              Local repository, cloud execution: agent sessions run in the
              Managed Agents sandbox and artifacts are stored in R2.
            </small>
          </p>
        ) : null}
        <p>
          Edit the template: set the project name,{' '}
          {mode === 'local' ? 'the local repository path' : 'the repository URL'},
          and the default branch. The agents, environments, prompts, and
          policies below are a working baseline.
        </p>
        {mode === 'local' ? (
          <div>
            <label>
              Local repository name
              <input
                onChange={(event) => setLocalName(event.target.value)}
                pattern="[a-z0-9][a-z0-9-]{0,63}"
                style={{ width: '100%' }}
                type="text"
                value={localName}
              />
            </label>
            <p>
              <small>Lowercase letters, digits, and hyphens.</small>
            </p>
            <div className="button-row">
              <button
                className="secondary"
                disabled={
                  creatingLocalRepository ||
                  localName.trim() === '' ||
                  localNotReady
                }
                onClick={() => void createLocalRepository()}
                type="button"
              >
                {creatingLocalRepository ? 'Creating…' : 'Create local repository'}
              </button>
              {TEST_PROJECTS.map((project) => (
                <button
                  className="secondary"
                  disabled={creatingLocalRepository || localNotReady}
                  key={project.key}
                  onClick={() => void fillTestProject(project)}
                  type="button"
                >
                  {creatingLocalRepository
                    ? 'Creating…'
                    : `Fill: ${project.label}`}
                </button>
              ))}
            </div>
            <p>
              <small>
                Each Fill button creates the next numbered repository for
                that project type (todo-app-01, dashboard-01, snake-01, …)
                and pre-fills the configuration and a small dependency-free
                first feature; you still apply, resolve the head, and start
                the run. Later runs grow the same project one feature at a
                time.
              </small>
            </p>
            {localNotReady ? (
              <p>
                <small>
                  Set AGENTOS_LOCAL_WORKSPACES_ROOT to enable local
                  experiments.
                </small>
              </p>
            ) : null}
            {localRepositoryError !== '' ? (
              <p role="alert">{localRepositoryError}</p>
            ) : null}
            {localRepositoryResult !== undefined ? (
              <p>
                Created <code>{localRepositoryResult.localPath}</code> at{' '}
                <code>{localRepositoryResult.headSha.slice(0, 12)}…</code>
              </p>
            ) : null}
          </div>
        ) : null}
        <textarea
          aria-label="Project configuration YAML"
          onChange={(event) => setYaml(event.target.value)}
          rows={24}
          spellCheck={false}
          style={{ width: '100%', fontFamily: 'monospace', fontSize: '0.8rem' }}
          value={yaml}
        />
        <div className="button-row">
          <button disabled={applying || !modeReady} onClick={() => void apply()} type="button">
            {applying ? 'Applying…' : 'Apply configuration'}
          </button>
        </div>
        {readiness !== undefined && !modeReady ? (
          <p>Complete step 1 before applying.</p>
        ) : null}
        {applyError !== '' ? <p role="alert">{applyError}</p> : null}
        {applied !== undefined ? (
          <p>
            Applied revision {applied.revision} for{' '}
            <code>{applied.projectId}</code>. Config digest{' '}
            <code>{applied.provenance.configDigest.slice(0, 12)}…</code>.
          </p>
        ) : null}
      </section>

      <section aria-labelledby="setup-step-3">
        <StepHeading step={3} title="Repository head" done={head !== undefined} />
        <p>
          The run pins the exact commit it builds on — this works the same
          way for GitHub and local projects. Refresh after every merge so the
          base matches the repository.
        </p>
        <div className="button-row">
          <button
            className="secondary"
            disabled={fetchingHead || applied === undefined}
            onClick={() => void fetchHead()}
            type="button"
          >
            {fetchingHead ? 'Resolving…' : 'Resolve current head'}
          </button>
        </div>
        {applied === undefined ? <p>Complete step 2 first.</p> : null}
        {headError !== '' ? <p role="alert">{headError}</p> : null}
        {head !== undefined ? (
          <p>
            {head.repository} @ {head.branch}:{' '}
            <code>{head.repositorySha.slice(0, 12)}…</code>
          </p>
        ) : null}
      </section>

      <section aria-labelledby="setup-step-4">
        <StepHeading step={4} title="Start the first run" done={runId !== ''} />
        <p>
          Describe one small feature with clear, testable requirements. The
          specification agent writes the spec; you approve its scope in the
          inbox before any code is written.
        </p>
        <label>
          Title
          <input
            maxLength={200}
            onChange={(event) => setTitle(event.target.value)}
            style={{ width: '100%' }}
            type="text"
            value={title}
          />
        </label>
        <label>
          Description
          <textarea
            maxLength={10_000}
            onChange={(event) => setDescription(event.target.value)}
            rows={5}
            style={{ width: '100%' }}
            value={description}
          />
        </label>
        <div className="button-row">
          <button
            disabled={
              starting ||
              applied === undefined ||
              head === undefined ||
              title.trim() === '' ||
              description.trim() === ''
            }
            onClick={() => void startRun()}
            type="button"
          >
            {starting ? 'Starting…' : 'Start feature run'}
          </button>
        </div>
        {startError !== '' ? <p role="alert">{startError}</p> : null}
        {runId !== '' ? (
          <p>
            Run started: <a href={`/runs/${runId}`}>{runId}</a>. Watch its
            steps there, and grant the specification approval in the{' '}
            <a href="/inbox">inbox</a> when it appears.
            {mode === 'local' ? (
              <>
                {' '}When it succeeds, the result is a local branch — inspect
                it with <code>git log agentos/{runId}-…</code> in your
                repository.
              </>
            ) : null}
          </p>
        ) : null}
      </section>
    </div>
  );
}
