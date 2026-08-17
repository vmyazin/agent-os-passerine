import { DEFAULT_PROTECTED_PATHS } from './config.js';

export type ChangeOperation = 'add' | 'modify' | 'delete';

export interface NormalizedChange {
  readonly path: string;
  readonly operation: ChangeOperation;
  readonly sizeBytes: number;
  readonly binary: boolean;
  readonly symlink: boolean;
  readonly metadataTrusted: true;
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
  | 'malformed_path'
  | 'untrusted_metadata';

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
  return new RegExp(`${source}$`, 'i');
}

function normalizeChangePath(path: string): string | undefined {
  let normalized = path;
  let fullyDecoded = false;
  try {
    for (let pass = 0; pass < 16; pass += 1) {
      const decoded = decodeURIComponent(normalized);
      if (decoded === normalized) {
        fullyDecoded = true;
        break;
      }
      normalized = decoded;
    }
  } catch {
    return undefined;
  }
  if (!fullyDecoded) return undefined;
  if (
    normalized.length === 0 ||
    normalized.includes('\0') ||
    normalized.includes('\\') ||
    normalized.startsWith('/')
  )
    return undefined;
  const parts = normalized.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..'))
    return undefined;
  return normalized;
}

export function evaluatePatchPolicy(
  manifest: ChangeManifest,
  policy: PatchPolicy,
): PatchPolicyResult {
  const violations: PatchViolation[] = [];
  const protectedPaths = policy.protectedPaths ?? DEFAULT_PROTECTED_PATHS;
  const protectedMatchers = protectedPaths.map(globPatternToRegex);
  const maxFileBytes = policy.maxFileBytes ?? 1_000_000;
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0)
    throw new Error('Maximum file byte limit must be a positive safe integer');
  if (
    (policy.allowBinary !== undefined &&
      typeof policy.allowBinary !== 'boolean') ||
    (policy.allowSymlinks !== undefined &&
      typeof policy.allowSymlinks !== 'boolean')
  )
    throw new Error('Patch policy allow limits must be boolean');

  if (manifest.baseSha !== policy.currentBaseSha) {
    violations.push({
      code: 'stale_base',
      message: 'Patch base SHA does not match the current base SHA',
    });
  }

  for (const change of manifest.changes) {
    const normalizedPath = normalizeChangePath(change.path);
    if (normalizedPath === undefined) {
      violations.push({
        code: 'malformed_path',
        path: change.path,
        message: `Malformed repository path: ${change.path}`,
      });
      continue;
    }
    if (
      change.metadataTrusted !== true ||
      typeof change.binary !== 'boolean' ||
      typeof change.symlink !== 'boolean' ||
      !Number.isSafeInteger(change.sizeBytes) ||
      change.sizeBytes < 0
    ) {
      violations.push({
        code: 'untrusted_metadata',
        path: change.path,
        message: `Trusted binary, symlink, and size metadata is required: ${change.path}`,
      });
      continue;
    }
    if (protectedMatchers.some((matcher) => matcher.test(normalizedPath))) {
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
    if (change.sizeBytes > maxFileBytes) {
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
