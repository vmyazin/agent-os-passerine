import { DEFAULT_PROTECTED_PATHS } from './config.js';

export type ChangeOperation = 'add' | 'modify' | 'delete';

export interface NormalizedChange {
  readonly path: string;
  readonly operation: ChangeOperation;
  readonly sizeBytes: number;
  readonly binary: boolean;
  readonly symlink: boolean;
}

export interface ChangeManifest {
  readonly baseSha: string;
  readonly changes: readonly NormalizedChange[];
}

export interface PatchPolicy {
  readonly currentBaseSha: string;
  readonly protectedPaths?: readonly string[];
  readonly maxFileBytes?: number;
  readonly allowBinary?: boolean;
  readonly allowSymlinks?: boolean;
}

export type PatchViolationCode =
  | 'stale_base'
  | 'protected_path'
  | 'symlink'
  | 'binary'
  | 'oversized'
  | 'malformed_path';

export interface PatchViolation {
  readonly code: PatchViolationCode;
  readonly message: string;
  readonly path?: string;
}

export interface PatchPolicyResult {
  readonly allowed: boolean;
  readonly violations: readonly PatchViolation[];
}

function globPatternToRegex(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index += 1;
      }
    } else if (character === '*') {
      source += '[^/]*';
    } else {
      source += character?.replace(/[|\\{}()[\]^$+?.]/g, '\\$&') ?? '';
    }
  }
  return new RegExp(`${source}$`);
}

function isMalformedPath(path: string): boolean {
  if (
    path.length === 0 ||
    path.includes('\0') ||
    path.includes('\\') ||
    path.startsWith('/')
  )
    return true;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return true;
  }
  const parts = decoded.split('/');
  return parts.some((part) => part === '' || part === '.' || part === '..');
}

export function evaluatePatchPolicy(
  manifest: ChangeManifest,
  policy: PatchPolicy,
): PatchPolicyResult {
  const violations: PatchViolation[] = [];
  const protectedPaths = policy.protectedPaths ?? DEFAULT_PROTECTED_PATHS;
  const protectedMatchers = protectedPaths.map(globPatternToRegex);
  const maxFileBytes = policy.maxFileBytes ?? 1_000_000;

  if (manifest.baseSha !== policy.currentBaseSha) {
    violations.push({
      code: 'stale_base',
      message: 'Patch base SHA does not match the current base SHA',
    });
  }

  for (const change of manifest.changes) {
    if (isMalformedPath(change.path)) {
      violations.push({
        code: 'malformed_path',
        path: change.path,
        message: `Malformed repository path: ${change.path}`,
      });
      continue;
    }
    if (protectedMatchers.some((matcher) => matcher.test(change.path))) {
      violations.push({
        code: 'protected_path',
        path: change.path,
        message: `Protected path cannot be changed: ${change.path}`,
      });
    }
    if (change.symlink && policy.allowSymlinks !== true) {
      violations.push({
        code: 'symlink',
        path: change.path,
        message: `Symlink changes are not allowed: ${change.path}`,
      });
    }
    if (change.binary && policy.allowBinary !== true) {
      violations.push({
        code: 'binary',
        path: change.path,
        message: `Binary changes are not allowed: ${change.path}`,
      });
    }
    if (
      !Number.isSafeInteger(change.sizeBytes) ||
      change.sizeBytes < 0 ||
      change.sizeBytes > maxFileBytes
    ) {
      violations.push({
        code: 'oversized',
        path: change.path,
        message: `File exceeds the ${maxFileBytes} byte limit: ${change.path}`,
      });
    }
  }

  return { allowed: violations.length === 0, violations };
}

export const evaluatePatch = evaluatePatchPolicy;
