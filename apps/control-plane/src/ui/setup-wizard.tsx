'use client';

import { useEffect, useRef, useState } from 'react';

import type { ProjectListProjection } from '../application/control-plane-service';
import { publishProjectCount } from './project-count-signal';
import { renderSetupConfig } from './setup-template-render';
import { Button } from './button';

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

type Pipeline = 'feature' | 'goal';

interface GoalCriterionDraft {
  readonly key: string;
  readonly description: string;
  readonly command: string;
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
  const [pipeline, setPipeline] = useState<Pipeline>('feature');
  const [trustedCommands, setTrustedCommands] = useState<readonly string[]>([]);
  const [commandsError, setCommandsError] = useState('');
  const [criteria, setCriteria] = useState<readonly GoalCriterionDraft[]>([]);

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
      const loaded =
        (await response.json()) as readonly ProjectListProjection[];
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
    if (body.active === undefined) {
      const empty = defaultWizardSnapshot('github');
      restoreWizard(empty);
      return empty;
    }
    // The configuration endpoint returns provenance but not the canonical
    // YAML, so the editor cannot be repopulated from an existing project.
    // Provenance is the part the remaining steps actually need -- it is what
    // pins a run to an applied revision -- so keep it and leave the editor on
    // whatever is loaded. Treating a missing config as "no project" reset the
    // wizard instead, which made the switcher look like it did nothing.
    const loaded: WizardSnapshot = {
      mode:
        body.active.canonicalConfig === undefined
          ? mode
          : modeFromYaml(body.active.canonicalConfig),
      yaml: body.active.canonicalConfig ?? yaml,
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

  // The allowlist is per project, so it has to follow the applied project --
  // switching projects mid-session must not leave the picker offering
  // commands the new project's policy rejects.
  const appliedProjectId = applied?.projectId;
  useEffect(() => {
    if (pipeline !== 'goal' || appliedProjectId === undefined) return;
    void loadTrustedCommands(appliedProjectId);
  }, [pipeline, appliedProjectId]);

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

  const fillTestProject = async (project: (typeof TEST_PROJECTS)[number]) => {
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
        ...(localRepositoryResult === undefined
          ? {}
          : { localRepositoryResult }),
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

  /**
   * The allowlist is resolved per project, so it is only meaningful once a
   * configuration has been applied. Loaded on demand rather than up front:
   * most runs are features and never need it.
   */
  const loadTrustedCommands = async (projectId: string) => {
    setCommandsError('');
    try {
      const response = await fetch(
        `/api/goals/commands?projectId=${encodeURIComponent(projectId)}`,
      );
      if (!response.ok) throw new Error(await readError(response));
      const body = (await response.json()) as { commands: readonly string[] };
      setTrustedCommands(body.commands);
      if (body.commands.length > 0 && criteria.length === 0)
        setCriteria([
          {
            key: crypto.randomUUID(),
            description: '',
            command: body.commands[0]!,
          },
        ]);
    } catch (error) {
      setTrustedCommands([]);
      setCommandsError(
        error instanceof Error
          ? error.message
          : 'command allowlist unavailable',
      );
    }
  };

  const selectPipeline = (next: Pipeline) => {
    if (next === pipeline) return;
    setPipeline(next);
    setStartError('');
  };

  const updateCriterion = (key: string, patch: Partial<GoalCriterionDraft>) =>
    setCriteria((current) =>
      current.map((criterion) =>
        criterion.key === key ? { ...criterion, ...patch } : criterion,
      ),
    );

  const startRun = async () => {
    if (starting || applied === undefined || head === undefined) return;
    setStarting(true);
    setStartError('');
    try {
      const response = await fetch(
        pipeline === 'goal' ? '/api/goals' : '/api/features',
        {
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
            ...(pipeline === 'goal'
              ? {
                  criteria: criteria.map((criterion, ordinal) => ({
                    // Stable, readable, and unique within the goal; the draft
                    // key is a UUID that would only clutter the run record.
                    id: `criterion-${ordinal + 1}`,
                    type: 'command' as const,
                    description: criterion.description.trim(),
                    command: criterion.command,
                  })),
                }
              : {}),
          }),
        },
      );
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
            <Button variant="secondary" onClick={() => void loadReadiness()}>
              Retry
            </Button>
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
                and deploy one with <code>pnpm trigger:deploy</code>. Nothing on
                this page can detect that worker, so a fully green check above
                does not by itself mean a run will execute.
              </p>
            ) : null}
            <Button variant="secondary" onClick={() => void loadReadiness()}>
              Check again
            </Button>
          </>
        ) : null}
      </section>

      <section aria-labelledby="setup-step-2">
        <StepHeading
          step={2}
          title="Apply configuration"
          done={applied !== undefined}
        />
        <nav aria-label="Project switcher" className="project-switcher">
          <Button
            aria-pressed={activeProjectKey === NEW_PROJECT_KEY}
            variant={
              activeProjectKey === NEW_PROJECT_KEY ? 'primary' : 'secondary'
            }
            onClick={() => void selectProject(NEW_PROJECT_KEY)}
          >
            New project
          </Button>
          {projects.map((project) => (
            <Button
              aria-pressed={activeProjectKey === project.id}
              variant={
                activeProjectKey === project.id ? 'primary' : 'secondary'
              }
              key={project.id}
              onClick={() => void selectProject(project.id)}
            >
              {project.name}
            </Button>
          ))}
        </nav>
        <div className="button-row" role="group" aria-label="Project type">
          <Button
            aria-pressed={mode === 'github'}
            variant={mode === 'github' ? 'primary' : 'secondary'}
            onClick={() => selectMode('github')}
          >
            GitHub project
          </Button>
          <Button
            aria-pressed={mode === 'local'}
            variant={mode === 'local' ? 'primary' : 'secondary'}
            onClick={() => selectMode('local')}
          >
            Local experiment
          </Button>
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
          {mode === 'local'
            ? 'the local repository path'
            : 'the repository URL'}
          , and the default branch. The agents, environments, prompts, and
          policies below are a working baseline.
        </p>
        {mode === 'local' ? (
          <div>
            <label>
              Local repository name
              <input
                onChange={(event) => setLocalName(event.target.value)}
                pattern="[a-z0-9][a-z0-9-]{0,63}"
                type="text"
                value={localName}
              />
            </label>
            <p>
              <small>Lowercase letters, digits, and hyphens.</small>
            </p>
            <div className="button-row">
              <Button
                variant="secondary"
                disabled={
                  creatingLocalRepository ||
                  localName.trim() === '' ||
                  localNotReady
                }
                onClick={() => void createLocalRepository()}
              >
                {creatingLocalRepository
                  ? 'Creating…'
                  : 'Create local repository'}
              </Button>
              {TEST_PROJECTS.map((project) => (
                <Button
                  variant="secondary"
                  disabled={creatingLocalRepository || localNotReady}
                  key={project.key}
                  onClick={() => void fillTestProject(project)}
                >
                  {creatingLocalRepository
                    ? 'Creating…'
                    : `Fill: ${project.label}`}
                </Button>
              ))}
            </div>
            <p>
              <small>
                Each Fill button creates the next numbered repository for that
                project type (todo-app-01, dashboard-01, snake-01, …) and
                pre-fills the configuration and a small dependency-free first
                feature; you still apply, resolve the head, and start the run.
                Later runs grow the same project one feature at a time.
              </small>
            </p>
            {localNotReady ? (
              <p>
                <small>
                  Set AGENTOS_LOCAL_WORKSPACES_ROOT to enable local experiments.
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
          className="code-field"
          onChange={(event) => setYaml(event.target.value)}
          rows={24}
          spellCheck={false}
          value={yaml}
        />
        <div className="button-row">
          <Button
            disabled={applying || !modeReady}
            onClick={() => void apply()}
          >
            {applying ? 'Applying…' : 'Apply configuration'}
          </Button>
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
        <StepHeading
          step={3}
          title="Repository head"
          done={head !== undefined}
        />
        <p>
          The run pins the exact commit it builds on — this works the same way
          for GitHub and local projects. Refresh after every merge so the base
          matches the repository.
        </p>
        <div className="button-row">
          <Button
            variant="secondary"
            disabled={fetchingHead || applied === undefined}
            onClick={() => void fetchHead()}
          >
            {fetchingHead ? 'Resolving…' : 'Resolve current head'}
          </Button>
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
        <div className="button-row" role="group" aria-label="Run type">
          <Button
            aria-pressed={pipeline === 'feature'}
            variant={pipeline === 'feature' ? 'primary' : 'secondary'}
            onClick={() => selectPipeline('feature')}
          >
            Feature
          </Button>
          <Button
            aria-pressed={pipeline === 'goal'}
            variant={pipeline === 'goal' ? 'primary' : 'secondary'}
            disabled={applied === undefined}
            onClick={() => selectPipeline('goal')}
          >
            Goal
          </Button>
        </div>
        <p>
          {pipeline === 'feature'
            ? 'Describe one small feature with clear, testable requirements. The specification agent writes the spec; you approve its scope in the inbox before any code is written.'
            : 'A goal adds acceptance criteria you write yourself. Each attempt is checked against them, and the goal retries — up to the project\u2019s step limit — until they pass. Because the criteria are yours, an attempt cannot pass by grading its own work.'}
        </p>
        <label>
          Title
          <input
            maxLength={200}
            onChange={(event) => setTitle(event.target.value)}
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
            value={description}
          />
        </label>
        {pipeline === 'goal' ? (
          <div>
            <h3>Acceptance criteria</h3>
            <p>
              <small>
                Each criterion runs a command from this project&rsquo;s trusted
                test allowlist. Commands are chosen, not typed: a goal naming
                anything outside the allowlist is rejected.
              </small>
            </p>
            {commandsError !== '' ? (
              <p role="alert">
                {commandsError}{' '}
                <Button
                  variant="secondary"
                  onClick={() =>
                    applied === undefined
                      ? undefined
                      : void loadTrustedCommands(applied.projectId)
                  }
                >
                  Retry
                </Button>
              </p>
            ) : null}
            {commandsError === '' && trustedCommands.length === 0 ? (
              <p>
                <small>
                  No trusted test commands are configured, so a goal has nothing
                  to verify against. Set AGENTOS_TRUSTED_TEST_COMMANDS_JSON, or
                  narrow it per project under <code>verification</code> in the
                  configuration.
                </small>
              </p>
            ) : null}
            {criteria.map((criterion, ordinal) => (
              <fieldset key={criterion.key}>
                <legend>Criterion {ordinal + 1}</legend>
                <label>
                  What it proves
                  <input
                    maxLength={1_000}
                    onChange={(event) =>
                      updateCriterion(criterion.key, {
                        description: event.target.value,
                      })
                    }
                    type="text"
                    value={criterion.description}
                  />
                </label>
                <label>
                  Command
                  <select
                    onChange={(event) =>
                      updateCriterion(criterion.key, {
                        command: event.target.value,
                      })
                    }
                    value={criterion.command}
                  >
                    {trustedCommands.map((command) => (
                      <option key={command} value={command}>
                        {command}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="button-row">
                  <Button
                    variant="secondary"
                    disabled={criteria.length === 1}
                    onClick={() =>
                      setCriteria((current) =>
                        current.filter((item) => item.key !== criterion.key),
                      )
                    }
                  >
                    Remove criterion
                  </Button>
                </div>
              </fieldset>
            ))}
            <div className="button-row">
              <Button
                variant="secondary"
                disabled={trustedCommands.length === 0 || criteria.length >= 20}
                onClick={() =>
                  setCriteria((current) => [
                    ...current,
                    {
                      key: crypto.randomUUID(),
                      description: '',
                      command: trustedCommands[0]!,
                    },
                  ])
                }
              >
                Add criterion
              </Button>
            </div>
          </div>
        ) : null}
        <div className="button-row">
          <Button
            disabled={
              starting ||
              applied === undefined ||
              head === undefined ||
              title.trim() === '' ||
              description.trim() === '' ||
              (pipeline === 'goal' &&
                (criteria.length === 0 ||
                  criteria.some(
                    (criterion) =>
                      criterion.description.trim() === '' ||
                      criterion.command === '',
                  )))
            }
            onClick={() => void startRun()}
          >
            {starting
              ? 'Starting…'
              : pipeline === 'goal'
                ? 'Start goal run'
                : 'Start feature run'}
          </Button>
        </div>
        {startError !== '' ? <p role="alert">{startError}</p> : null}
        {runId !== '' ? (
          <p>
            Run started: <a href={`/runs/${runId}`}>{runId}</a>.{' '}
            {pipeline === 'goal'
              ? 'That page tracks each criterion and every attempt against it.'
              : 'Watch its steps there.'}{' '}
            Grant the specification approval in the <a href="/inbox">inbox</a>{' '}
            when it appears
            {pipeline === 'goal' ? ' — once per attempt' : ''}.
            {mode === 'local' ? (
              <>
                {' '}
                When it succeeds, the result is a local branch — inspect it with{' '}
                <code>git log agentos/{runId}-…</code> in your repository.
              </>
            ) : null}
          </p>
        ) : null}
      </section>
    </div>
  );
}
