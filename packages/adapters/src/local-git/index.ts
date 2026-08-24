export { assertContainedRepository, runGit, LocalGitError } from './git.js';
export { createLocalSourceSnapshotIngestor } from './source-snapshot.js';
export type {
  LocalSourceSnapshotBinding,
  LocalSourceSnapshotIngestorOptions,
} from './source-snapshot.js';
export { createLocalGitPublisher } from './publisher.js';
export type {
  LocalGitPublisherOptions,
  LocalPublicationResult,
} from './publisher.js';
export {
  initializeLocalRepository,
  LocalRepositoryAlreadyExistsError,
} from './initialize.js';
export {
  inspectLocalProjectSource,
  listLocalProjectCommits,
  LocalProjectSourceError,
} from './project-source.js';
export type {
  InitializeLocalRepositoryOptions,
  InitializeLocalRepositoryResult,
} from './initialize.js';
