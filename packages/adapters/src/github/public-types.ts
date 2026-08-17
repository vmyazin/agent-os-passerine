export interface PublicationResult {
  readonly status: 'succeeded';
  readonly branch: string;
  readonly commitSha: string;
  readonly pullRequestNumber: number;
  readonly pullRequestUrl: string;
  readonly draft: true;
}

export type PublicationPhase =
  | 'claimed'
  | 'blobs_created'
  | 'tree_created'
  | 'commit_created'
  | 'ref_created'
  | 'pr_created'
  | 'succeeded'
  | 'cancelled'
  | 'failed';

export interface PublicationStatusResult {
  readonly status: PublicationPhase | 'not_found';
  readonly branch?: string;
  readonly commitSha?: string;
  readonly pullRequestNumber?: number;
  readonly pullRequestUrl?: string;
  readonly draft?: true;
}
