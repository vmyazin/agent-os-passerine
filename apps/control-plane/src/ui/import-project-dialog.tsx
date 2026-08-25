'use client';

import { useId, useRef, useState } from 'react';

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from './dialog';
import { RadioGroup } from './radio-group';

interface Inspection {
  readonly kind: 'github' | 'local';
  readonly canonicalLocation: string;
  readonly suggestedName: string;
  readonly defaultBranch: string;
  readonly headSha: string;
  readonly publisherReady?: boolean;
}

async function apiError(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as {
    readonly error?: { readonly message?: unknown };
  };
  return typeof body.error?.message === 'string'
    ? body.error.message
    : fallback;
}

export function ImportProjectDialog({
  triggerLabel = 'Import project',
  localPickerAvailable = false,
}: {
  readonly triggerLabel?: string;
  readonly localPickerAvailable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<'github' | 'local'>('github');
  const [location, setLocation] = useState('');
  const [inspection, setInspection] = useState<Inspection>();
  const [defaultBranch, setDefaultBranch] = useState('');
  const [pending, setPending] = useState<'choose' | 'inspect' | 'import'>();
  const [message, setMessage] = useState('');
  const pathInputRef = useRef<HTMLInputElement>(null);
  const locationInputId = useId();

  const changeKind = (value: string) => {
    if (value !== 'github' && value !== 'local') return;
    setKind(value);
    setInspection(undefined);
    setMessage('');
  };

  const inspect = async () => {
    if (pending !== undefined || location.trim() === '') return;
    setPending('inspect');
    setMessage('');
    setInspection(undefined);
    try {
      const response = await fetch('/api/projects/import/inspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          kind === 'github'
            ? { kind, repositoryUrl: location.trim() }
            : { kind, localPath: location.trim() },
        ),
      });
      if (!response.ok) {
        setMessage(
          await apiError(response, 'Could not inspect this repository.'),
        );
        return;
      }
      const result = (await response.json()) as Inspection;
      setInspection(result);
      setDefaultBranch(result.defaultBranch);
    } catch {
      setMessage('Could not inspect this repository.');
    } finally {
      setPending(undefined);
    }
  };

  const chooseDirectory = async () => {
    if (pending !== undefined) return;
    setPending('choose');
    try {
      const response = await fetch(
        '/api/projects/import/select-directory',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        },
      );
      if (!response.ok) {
        setMessage(
          await apiError(response, 'Could not open the macOS folder picker.'),
        );
        return;
      }
      const result = (await response.json()) as
        | { readonly status: 'selected'; readonly path?: unknown }
        | { readonly status: 'cancelled' };
      if (result.status === 'cancelled') return;
      if (typeof result.path !== 'string' || result.path === '') {
        setMessage('The macOS folder picker returned an invalid path.');
        return;
      }
      setLocation(result.path);
      setInspection(undefined);
      setMessage('');
      pathInputRef.current?.focus();
    } catch {
      setMessage('Could not open the macOS folder picker.');
    } finally {
      setPending(undefined);
    }
  };

  const importProject = async () => {
    if (pending !== undefined || inspection === undefined) return;
    setPending('import');
    setMessage('');
    try {
      const response = await fetch('/api/projects/import', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify(
          kind === 'github'
            ? { kind, repositoryUrl: inspection.canonicalLocation }
            : {
                kind,
                localPath: inspection.canonicalLocation,
                defaultBranch: defaultBranch.trim(),
              },
        ),
      });
      if (!response.ok) {
        setMessage(
          await apiError(response, 'Could not import this repository.'),
        );
        return;
      }
      const result = (await response.json()) as {
        readonly project?: { readonly id?: unknown };
      };
      if (typeof result.project?.id !== 'string') {
        setMessage('The imported project response was incomplete.');
        return;
      }
      window.location.assign(`/projects/${result.project.id}`);
    } catch {
      setMessage('Could not import this repository.');
    } finally {
      setPending(undefined);
    }
  };

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        <button type="button">{triggerLabel}</button>
      </DialogTrigger>
      <DialogContent aria-describedby="import-project-description">
        <div className="dialog-heading">
          <div>
            <DialogTitle>Import an existing project</DialogTitle>
            <DialogDescription id="import-project-description">
              Inspect a GitHub repository or an exact local Git working tree
              before adding it to the project directory.
            </DialogDescription>
          </div>
          <DialogClose
            aria-label="Close import dialog"
            className="dialog-close"
          >
            ×
          </DialogClose>
        </div>
        <RadioGroup
          label="Repository source"
          onValueChange={changeKind}
          options={[
            {
              value: 'github',
              label: 'GitHub repository',
              description: 'Use its canonical github.com URL.',
            },
            {
              value: 'local',
              label: 'Local repository',
              description: 'Trust one exact working-tree path.',
            },
          ]}
          value={kind}
        />
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void inspect();
          }}
        >
          <div className="form-field">
            <label htmlFor={locationInputId}>
              {kind === 'github' ? 'Repository URL' : 'Repository path'}
            </label>
            <div
              className={
                kind === 'local' && localPickerAvailable
                  ? 'repository-path-control'
                  : undefined
              }
            >
              <input
                autoComplete="off"
                id={locationInputId}
                onChange={(event) => {
                  setLocation(event.target.value);
                  setInspection(undefined);
                  setMessage('');
                }}
                placeholder={
                  kind === 'github'
                    ? 'https://github.com/owner/repository'
                    : '/absolute/path/to/repository'
                }
                ref={kind === 'local' ? pathInputRef : undefined}
                spellCheck={false}
                value={location}
              />
              {kind === 'local' && localPickerAvailable ? (
                <button
                  className="secondary"
                  disabled={pending !== undefined}
                  onClick={() => void chooseDirectory()}
                  type="button"
                >
                  {pending === 'choose' ? 'Choosing…' : 'Choose folder…'}
                </button>
              ) : null}
            </div>
          </div>
          <button
            disabled={pending !== undefined || location.trim() === ''}
            type="submit"
          >
            {pending === 'inspect' ? 'Inspecting…' : 'Inspect repository'}
          </button>
        </form>
        {inspection === undefined ? null : (
          <section aria-label="Inspection result" className="import-inspection">
            <strong>Repository found</strong>
            <span>{inspection.canonicalLocation}</span>
            <span>
              Head <code>{inspection.headSha.slice(0, 12)}</code>
            </span>
            {kind === 'local' ? (
              <label>
                Default branch
                <input
                  onChange={(event) => setDefaultBranch(event.target.value)}
                  value={defaultBranch}
                />
              </label>
            ) : (
              <span>
                Default branch <strong>{inspection.defaultBranch}</strong> ·{' '}
                {inspection.publisherReady === true
                  ? 'publishing access ready'
                  : 'publishing access not installed'}
              </span>
            )}
            <button
              disabled={
                pending !== undefined ||
                (kind === 'local' && defaultBranch.trim() === '')
              }
              onClick={() => void importProject()}
              type="button"
            >
              {pending === 'import' ? 'Importing…' : 'Import and open project'}
            </button>
          </section>
        )}
        {message === '' ? null : (
          <p aria-live="polite" className="notice error">
            {message}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
