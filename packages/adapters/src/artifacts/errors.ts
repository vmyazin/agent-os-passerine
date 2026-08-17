export class ArtifactStoreAdapterError extends Error {
  constructor(
    readonly code:
      | 'artifact_conflict'
      | 'artifact_scope_denied'
      | 'artifact_integrity_error'
      | 'artifact_store_unavailable'
      | 'artifact_too_large'
      | 'invalid_artifact',
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'ArtifactStoreAdapterError';
  }
}
