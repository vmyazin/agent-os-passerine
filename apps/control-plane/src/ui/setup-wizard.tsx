'use client';

import { useEffect, useState } from 'react';

import { SETUP_CONFIG_TEMPLATE } from './setup-template';
import { SETUP_CONFIG_TEMPLATE_LOCAL } from './setup-template-local';

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
  readonly repository?: string;
  readonly groups: readonly ReadinessGroup[];
}

type ProjectMode = 'github' | 'local';

/** The pristine (operator-untouched) template text for a given mode. */
function templateForMode(mode: ProjectMode): string {
  return mode === 'github' ? SETUP_CONFIG_TEMPLATE : SETUP_CONFIG_TEMPLATE_LOCAL;
}

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
  const [mode, setMode] = useState<ProjectMode>('github');
  const [yaml, setYaml] = useState(SETUP_CONFIG_TEMPLATE);
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

  useEffect(() => {
    void loadReadiness();
  }, []);

  // Switching modes only swaps the textarea when it still holds the
  // pristine template for the mode being left — an operator's edits (in
  // either mode) are never overwritten.
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
      setYaml((current) =>
        current
          .replace(/^(\s*localPath:).*$/m, `$1 ${result.localPath}`)
          .replace(/^(\s*name:).*$/m, `$1 ${result.name}`),
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

  // One click sets up everything a fresh end-to-end walkthrough needs: a new
  // auto-numbered test repository (test-proj-01, -02, ...), the matching
  // project name and path in the YAML, and a small canned feature in step 4.
  // Apply, head resolution, and run start stay explicit so the flow is
  // still visible step by step.
  const fillTestProject = async () => {
    const created = await createRepository({ namePrefix: 'test-proj' });
    if (created === undefined) return;
    setTitle('Add greet module');
    setDescription(
      'Add src/greet.mjs exporting greet(name) returning the string Hello, <name>! and test/greet.test.mjs covering it with node:test, matching the existing test style.',
    );
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
      const response = await fetch('/api/setup/repository-head');
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

  return (
    <div className="page-stack">
      <section className="page-heading" aria-labelledby="setup-title">
        <p className="eyebrow">Guided setup</p>
        <h1 id="setup-title">New project</h1>
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
              {readiness.repository !== undefined
                ? ` Bound repository: ${readiness.repository}.`
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
            <button className="secondary" onClick={() => void loadReadiness()} type="button">
              Check again
            </button>
          </>
        ) : null}
      </section>

      <section aria-labelledby="setup-step-2">
        <StepHeading step={2} title="Apply configuration" done={applied !== undefined} />
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
                disabled={creatingLocalRepository || localName.trim() === ''}
                onClick={() => void createLocalRepository()}
                type="button"
              >
                {creatingLocalRepository ? 'Creating…' : 'Create local repository'}
              </button>
              <button
                className="secondary"
                disabled={creatingLocalRepository}
                onClick={() => void fillTestProject()}
                type="button"
              >
                {creatingLocalRepository
                  ? 'Creating…'
                  : 'Fill e2e test project'}
              </button>
            </div>
            <p>
              <small>
                Fill e2e test project creates the next test-proj-NN
                repository and pre-fills the configuration and a small
                first feature; you still apply, resolve the head, and start
                the run.
              </small>
            </p>
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
