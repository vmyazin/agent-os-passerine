// packages/core/src/acceptance-tests.ts
import { normalizeRepositoryPathSyntax } from './publication.js';

export const ACCEPTANCE_TEST_PREFIX = 'test/acceptance/';

export interface AcceptanceTestFile {
  readonly path: string;
  readonly mode: '100644';
  readonly content: string;
}

export type ChangeSetChange =
  | {
      readonly operation: 'add' | 'modify';
      readonly path: string;
      readonly mode: '100644' | '100755';
      readonly content: string;
    }
  | { readonly operation: 'delete'; readonly path: string };

export class AcceptancePathReservedError extends Error {
  readonly code = 'acceptance_path_reserved';
  constructor(readonly path: string) {
    super(`acceptance_path_reserved: ${path}`);
    this.name = 'AcceptancePathReservedError';
  }
}

function normalizedPath(path: string): string {
  return normalizeRepositoryPathSyntax(path).toLocaleLowerCase('en-US');
}

export function isAcceptanceTestPath(path: string): boolean {
  try {
    const normalized = normalizedPath(path);
    return (
      normalized === 'test/acceptance' ||
      normalized.startsWith(ACCEPTANCE_TEST_PREFIX)
    );
  } catch {
    return false;
  }
}

export function acceptanceTestPathForCriterion(id: string): string {
  return `${ACCEPTANCE_TEST_PREFIX}${id}.test.mjs`;
}

export function acceptanceTestsPairingError(
  criterionIds: readonly string[],
  paths: readonly string[],
): string | undefined {
  const expected = criterionIds.map(acceptanceTestPathForCriterion);
  if (expected.length !== paths.length) {
    return 'acceptance test pairing: criterion count must equal file count';
  }
  const remaining = new Set(paths.map((path) => normalizedPath(path)));
  for (const path of expected) {
    if (!remaining.delete(normalizedPath(path))) {
      return `acceptance test pairing: missing ${path}`;
    }
  }
  if (remaining.size > 0) {
    return `acceptance test pairing: unexpected ${[...remaining].join(', ')}`;
  }
  return undefined;
}

export function sealChangeSet(
  changes: readonly ChangeSetChange[],
  acceptanceTests: readonly AcceptanceTestFile[],
  sourcePaths: ReadonlySet<string> = new Set(),
): readonly ChangeSetChange[] {
  for (const change of changes) {
    if (isAcceptanceTestPath(change.path)) {
      throw new AcceptancePathReservedError(change.path);
    }
  }
  const overlay: ChangeSetChange[] = acceptanceTests.map((file) => {
    const path = normalizeRepositoryPathSyntax(file.path);
    const exists = [...sourcePaths].some(
      (candidate) => normalizedPath(candidate) === normalizedPath(path),
    );
    return {
      operation: exists ? 'modify' : 'add',
      path,
      mode: '100644',
      content: file.content,
    };
  });
  return [...changes, ...overlay];
}
