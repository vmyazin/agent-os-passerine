'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { CommitPage, CommitSummary } from '@agentos/core';

import { formatDisplayDate } from './format-timestamp';

export function CommitFeed({
  projectId,
  defaultBranch,
  initialPage,
  initialUnavailable = false,
  timeZone,
}: {
  readonly projectId: string;
  readonly defaultBranch: string;
  readonly initialPage?: CommitPage;
  readonly initialUnavailable?: boolean;
  readonly timeZone: string;
}) {
  const [items, setItems] = useState<readonly CommitSummary[]>(
    initialPage?.items ?? [],
  );
  const [nextCursor, setNextCursor] = useState(initialPage?.nextCursor);
  const [failed, setFailed] = useState(initialUnavailable);
  const [pending, setPending] = useState(
    initialPage === undefined && !initialUnavailable,
  );
  const initialLoadStarted = useRef(false);

  const load = useCallback(async () => {
    setPending(true);
    setFailed(false);
    try {
      const query =
        nextCursor === undefined
          ? ''
          : `?cursor=${encodeURIComponent(nextCursor)}`;
      const response = await fetch(
        `/api/projects/${projectId}/commits${query}`,
      );
      if (!response.ok) {
        setFailed(true);
        return;
      }
      const page = (await response.json()) as CommitPage;
      setItems((current) => {
        const seen = new Set(current.map((commit) => commit.sha));
        return [
          ...current,
          ...page.items.filter((commit) => !seen.has(commit.sha)),
        ];
      });
      setNextCursor(page.nextCursor);
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }, [nextCursor, projectId]);

  useEffect(() => {
    if (
      initialPage !== undefined ||
      initialUnavailable ||
      initialLoadStarted.current
    )
      return;
    initialLoadStarted.current = true;
    void load();
  }, [initialPage, initialUnavailable, load]);

  return (
    <div className="commit-feed">
      <p className="commit-feed-branch">
        <span>Default branch</span> <code>{defaultBranch}</code>
      </p>
      {items.length === 0 && !failed ? (
        <p className="commit-feed-empty">
          {pending
            ? 'Loading commit history…'
            : 'No commits found on this branch.'}
        </p>
      ) : (
        <ol className="commit-feed-list">
          {items.map((commit) => (
            <li className="commit-feed-item" key={commit.sha}>
              <code>{commit.sha.slice(0, 8)}</code>
              <span>
                <strong>{commit.subject || 'Untitled commit'}</strong>
                <small>
                  {commit.authorName} ·{' '}
                  {formatDisplayDate(commit.committedAt, timeZone)}
                </small>
              </span>
              {commit.url === undefined ? null : (
                <a href={commit.url} rel="noreferrer" target="_blank">
                  View on GitHub
                </a>
              )}
            </li>
          ))}
        </ol>
      )}
      {failed ? (
        <div className="commit-feed-error" role="status">
          <span>
            {items.length === 0
              ? 'Commit history is unavailable.'
              : 'Could not load more commits.'}
          </span>
          <button
            className="secondary"
            disabled={pending}
            onClick={() => void load()}
            type="button"
          >
            {pending ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      ) : nextCursor === undefined ? null : (
        <button
          className="secondary"
          disabled={pending}
          onClick={() => void load()}
          type="button"
        >
          {pending ? 'Loading…' : 'Load 25 more'}
        </button>
      )}
    </div>
  );
}
