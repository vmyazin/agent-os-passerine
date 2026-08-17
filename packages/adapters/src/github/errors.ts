export type GitHubPublisherErrorCode =
  | 'publication_rejected'
  | 'publication_collision'
  | 'publication_cancelled'
  | 'publication_busy'
  | 'github_unavailable'
  | 'publication_store_conflict';

export class GitHubPublisherError extends Error {
  readonly code: GitHubPublisherErrorCode;

  constructor(code: GitHubPublisherErrorCode, message: string) {
    super(message);
    this.name = 'GitHubPublisherError';
    this.code = code;
  }
}

export function rejected(message = 'Publication was rejected'): never {
  throw new GitHubPublisherError('publication_rejected', message);
}

export function collision(message = 'Publication ownership collision'): never {
  throw new GitHubPublisherError('publication_collision', message);
}
