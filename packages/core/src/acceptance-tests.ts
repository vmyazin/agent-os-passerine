// packages/core/src/acceptance-tests.ts
import path from 'node:path';

import { initSync, parse } from 'es-module-lexer';

import { normalizeRepositoryPathSyntax } from './publication.js';

export const ACCEPTANCE_TEST_PREFIX = 'test/acceptance/';
const ACCEPTANCE_IMPORT_SAFETY_ERROR =
  'acceptance test import resolves outside repository';
const REPOSITORY_SENTINEL_ROOT = '/repository';

initSync();

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

function isAbsoluteFilesystemSpecifier(specifier: string): boolean {
  return (
    path.posix.isAbsolute(specifier) ||
    /^[A-Za-z]:[\\/]/u.test(specifier) ||
    specifier.startsWith('\\\\') ||
    specifier.startsWith('file:')
  );
}

function resolvesOutsideRepository(
  filePath: string,
  specifier: string,
): boolean {
  if (isAbsoluteFilesystemSpecifier(specifier)) return true;
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return false;
  const importingFile = path.posix.resolve(REPOSITORY_SENTINEL_ROOT, filePath);
  const target = path.posix.resolve(
    path.posix.dirname(importingFile),
    specifier,
  );
  const relative = path.posix.relative(REPOSITORY_SENTINEL_ROOT, target);
  return (
    relative === '..' ||
    relative.startsWith('../') ||
    path.posix.isAbsolute(relative)
  );
}

export function acceptanceTestImportSafetyError(input: {
  readonly path: string;
  readonly content: string;
}): string | undefined {
  try {
    const [imports] = parse(input.content, input.path);
    return imports.some(
      (entry) =>
        entry.n !== undefined && resolvesOutsideRepository(input.path, entry.n),
    )
      ? ACCEPTANCE_IMPORT_SAFETY_ERROR
      : undefined;
  } catch {
    // The schema boundary must fail closed without persisting parser details or
    // any agent-authored source text in the run error.
    return ACCEPTANCE_IMPORT_SAFETY_ERROR;
  }
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
