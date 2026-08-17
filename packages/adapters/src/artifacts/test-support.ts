export type { R2Command, R2SdkClient } from './r2.js';
import { createInMemoryArtifactManifestStore } from './manifest.js';
import {
  createR2ArtifactStorageWithDependencies,
  type R2ArtifactStorageDependencies,
} from './r2.js';

export function createR2ArtifactStorageForTest(
  options: Omit<R2ArtifactStorageDependencies, 'manifest'> & {
    readonly manifest?: R2ArtifactStorageDependencies['manifest'];
  },
) {
  return createR2ArtifactStorageWithDependencies({
    ...options,
    manifest: options.manifest ?? createInMemoryArtifactManifestStore(),
  });
}
