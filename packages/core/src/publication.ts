import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { AttestationVerifier, SignedAttestation } from './attestation.js';
import { canonicalJsonValue, DEFAULT_PROTECTED_PATHS } from './config.js';

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY = /^(?!\.)(?!.*\.git$)[A-Za-z0-9._-]{1,100}$/i;
const FORBIDDEN_PATH_CODEPOINT = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const BINARY_CONTENT = /\0/;

export const PUBLICATION_MAX_FILES = 200;
export const PUBLICATION_MAX_FILE_BYTES = 1_000_000;
export const PUBLICATION_MAX_TOTAL_BYTES = 5_000_000;
export const PUBLICATION_AUTHORIZATION_MAX_TTL_MS = 15 * 60 * 1_000;

const publicationPolicyPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      /^[\x20-\x7e]+$/.test(value) &&
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !value.includes('%') &&
      !value.split('/').some((part) => part === '..' || part === '.'),
    'invalid protected path glob',
  );

export const publicationPolicySnapshotSchema = z
  .object({
    version: z.literal('publication-policy-v1'),
    protectedPaths: z.array(publicationPolicyPathSchema).max(256),
    maxFiles: z.number().int().positive().max(PUBLICATION_MAX_FILES),
    maxFileBytes: z.number().int().positive().max(PUBLICATION_MAX_FILE_BYTES),
    maxTotalBytes: z.number().int().positive().max(PUBLICATION_MAX_TOTAL_BYTES),
    allowBinary: z.literal(false),
    allowSymlinks: z.literal(false),
    allowDeletes: z.boolean(),
    allowedModes: z
      .array(z.enum(['100644', '100755']))
      .min(1)
      .max(2),
  })
  .strict();

export type PublicationPolicySnapshot = z.infer<
  typeof publicationPolicySnapshotSchema
>;

export const DEFAULT_PUBLICATION_POLICY: PublicationPolicySnapshot =
  Object.freeze({
    version: 'publication-policy-v1',
    protectedPaths: Object.freeze([
      ...DEFAULT_PROTECTED_PATHS,
    ]) as unknown as string[],
    maxFiles: PUBLICATION_MAX_FILES,
    maxFileBytes: PUBLICATION_MAX_FILE_BYTES,
    maxTotalBytes: PUBLICATION_MAX_TOTAL_BYTES,
    allowBinary: false,
    allowSymlinks: false,
    allowDeletes: true,
    allowedModes: Object.freeze(['100644', '100755']) as unknown as (
      '100644' | '100755'
    )[],
  });

const digestSchema = z
  .string()
  .regex(SHA256, 'must be a lowercase SHA-256 digest');
const idSchema = z.string().regex(IDENTIFIER, 'must be a safe identifier');
const branchSchema = z
  .string()
  .min(1)
  .max(244)
  .refine((value) => {
    if (
      value.startsWith('/') ||
      value.endsWith('.') ||
      value.includes('..') ||
      value.includes('//') ||
      value.includes('@{') ||
      value.includes('\\')
    )
      return false;
    for (const character of value) {
      const code = character.codePointAt(0) ?? 0;
      if (code <= 0x20 || code === 0x7f || '~^:?*[]'.includes(character))
        return false;
    }
    return true;
  }, 'invalid base branch');
const repositorySchema = z
  .object({
    owner: z.string().regex(OWNER, 'invalid repository owner'),
    name: z.string().regex(REPOSITORY, 'invalid repository name'),
    installationId: z.number().int().positive().safe(),
    repositoryId: z.number().int().positive().safe(),
  })
  .strict();
const expectedBaseSchema = z
  .object({
    branch: branchSchema,
    sha: z.string().regex(GIT_SHA, 'invalid base SHA'),
  })
  .strict();
const testEvidenceSchema = z
  .object({
    kind: z.enum(['test-report', 'policy-report']),
    artifactDigest: digestSchema,
  })
  .strict();
const writeChangeSchema = z
  .object({
    operation: z.enum(['add', 'modify']),
    path: z.string().min(1).max(1024),
    mode: z.enum(['100644', '100755']),
    content: z.string(),
  })
  .strict();
const deleteChangeSchema = z
  .object({
    operation: z.literal('delete'),
    path: z.string().min(1).max(1024),
  })
  .strict();
const changeSchema = z.discriminatedUnion('operation', [
  writeChangeSchema,
  deleteChangeSchema,
]);

export const publicationManifestBodySchema = z
  .object({
    version: z.literal('publication-manifest-v1'),
    projectId: idSchema,
    runId: idSchema,
    stepId: idSchema,
    repository: repositorySchema,
    expectedBase: expectedBaseSchema,
    configDigest: digestSchema,
    policyDigest: digestSchema,
    sourceSnapshotDigest: digestSchema,
    testEvidence: z.array(testEvidenceSchema).min(1).max(20),
    changes: z.array(changeSchema).min(1).max(PUBLICATION_MAX_FILES),
  })
  .strict();

export type PublicationManifestBody = z.infer<
  typeof publicationManifestBodySchema
>;
export type PublicationChange = PublicationManifestBody['changes'][number];

export interface PublicationAuthorizationClaims {
  readonly purpose: 'publish-draft-pr';
  readonly audience: 'github-publisher';
  readonly projectId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly repository: PublicationManifestBody['repository'];
  readonly expectedBase: PublicationManifestBody['expectedBase'];
  readonly configDigest: string;
  readonly policyDigest: string;
  readonly sourceSnapshotDigest: string;
  readonly testEvidenceDigest: string;
  readonly manifestDigest: string;
  readonly nonce: string;
  readonly expiresAt: string;
}

const authorizationClaimsSchema = z
  .object({
    purpose: z.literal('publish-draft-pr'),
    audience: z.literal('github-publisher'),
    projectId: idSchema,
    runId: idSchema,
    stepId: idSchema,
    repository: repositorySchema,
    expectedBase: expectedBaseSchema,
    configDigest: digestSchema,
    policyDigest: digestSchema,
    sourceSnapshotDigest: digestSchema,
    testEvidenceDigest: digestSchema,
    manifestDigest: digestSchema,
    nonce: z.string().regex(IDENTIFIER, 'invalid authorization nonce'),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();

const signedAuthorizationSchema = z
  .object({
    version: z.literal(1),
    keyId: z.string().min(1).max(128),
    kind: z.literal('github-publication'),
    subject: z.string().min(1).max(512),
    claims: authorizationClaimsSchema,
    claimHash: digestSchema,
    issuedAt: z.iso.datetime({ offset: true }),
    signature: digestSchema,
  })
  .strict();

export interface ParsedPublicationManifest {
  readonly manifest: PublicationManifestBody;
  readonly manifestDigest: string;
  readonly authorization: SignedAttestation<PublicationAuthorizationClaims>;
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
  return new RegExp(`${source}$`, 'iu');
}

export function normalizePublicationPolicySnapshot(
  input: unknown,
): PublicationPolicySnapshot {
  const parsed = publicationPolicySnapshotSchema.parse(input);
  const folded = new Set(
    parsed.protectedPaths.map((path) => path.toLocaleLowerCase('en-US')),
  );
  for (const required of DEFAULT_PROTECTED_PATHS) {
    if (!folded.has(required.toLocaleLowerCase('en-US')))
      throw new Error(`Default protected path is not removable: ${required}`);
  }
  return Object.freeze({
    ...parsed,
    protectedPaths: [...new Set(parsed.protectedPaths)].sort(compareCodeUnits),
    allowedModes: [...new Set(parsed.allowedModes)].sort(compareCodeUnits),
  });
}

export function canonicalPublicationPolicyDigest(input: unknown): string {
  return createHash('sha256')
    .update(
      canonicalJsonValue(normalizePublicationPolicySnapshot(input)),
      'utf8',
    )
    .digest('hex');
}

export function evaluatePublicationPolicy(
  changes: readonly PublicationChange[],
  input: unknown,
): PublicationPolicySnapshot {
  const policy = normalizePublicationPolicySnapshot(input);
  if (changes.length > policy.maxFiles)
    throw new Error('Publication policy file count exceeded');
  const matchers = policy.protectedPaths.map(globPatternToRegex);
  let totalBytes = 0;
  for (const change of changes) {
    const path = normalizeRepositoryPathSyntax(change.path);
    if (matchers.some((matcher) => matcher.test(path)))
      throw new Error(`Publication policy denied path: ${path}`);
    if (change.operation === 'delete') {
      if (!policy.allowDeletes)
        throw new Error(`Publication policy denied delete: ${path}`);
      continue;
    }
    if (!policy.allowedModes.includes(change.mode))
      throw new Error(`Publication policy denied mode: ${path}`);
    assertWellFormedText(change.content, path);
    const size = Buffer.byteLength(change.content, 'utf8');
    if (size > policy.maxFileBytes)
      throw new Error(`Publication policy file size exceeded: ${path}`);
    totalBytes += size;
    if (totalBytes > policy.maxTotalBytes)
      throw new Error('Publication policy aggregate size exceeded');
  }
  return policy;
}

const protectedMatchers = [...DEFAULT_PROTECTED_PATHS, '.git/**'].map(
  globPatternToRegex,
);

export function normalizeRepositoryPathSyntax(input: string): string {
  if (
    input.length === 0 ||
    input.startsWith('/') ||
    input.includes('\\') ||
    input.includes('%') ||
    FORBIDDEN_PATH_CODEPOINT.test(input) ||
    input.normalize('NFC') !== input ||
    /[^\x20-\x7e]/.test(input)
  ) {
    throw new Error(`Malformed repository path: ${JSON.stringify(input)}`);
  }
  const parts = input.split('/');
  if (
    parts.some(
      (part) =>
        part === '' ||
        part === '.' ||
        part === '..' ||
        part.trim() !== part ||
        part.endsWith(' ') ||
        part.endsWith('.'),
    )
  ) {
    throw new Error(`Malformed repository path: ${JSON.stringify(input)}`);
  }
  return input;
}

export function normalizeRepositoryPath(input: string): string {
  const normalized = normalizeRepositoryPathSyntax(input);
  if (protectedMatchers.some((matcher) => matcher.test(normalized))) {
    throw new Error(`Protected repository path: ${input}`);
  }
  return normalized;
}

function assertWellFormedText(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        throw new Error(`Malformed UTF-8 text for ${path}`);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error(`Malformed UTF-8 text for ${path}`);
    }
  }
  if (BINARY_CONTENT.test(value))
    throw new Error(`Binary content is forbidden for ${path}`);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalManifestValue(value: unknown): unknown {
  const manifestResult = publicationManifestBodySchema.safeParse(value);
  if (!manifestResult.success) return value;
  return {
    ...manifestResult.data,
    changes: [...manifestResult.data.changes].sort((left, right) =>
      compareCodeUnits(
        left.path.toLocaleLowerCase('en-US'),
        right.path.toLocaleLowerCase('en-US'),
      ),
    ),
    testEvidence: [...manifestResult.data.testEvidence].sort((left, right) =>
      compareCodeUnits(
        `${left.kind}:${left.artifactDigest}`,
        `${right.kind}:${right.artifactDigest}`,
      ),
    ),
  };
}

export function canonicalPublicationManifestDigest(value: unknown): string {
  return createHash('sha256')
    .update(canonicalJsonValue(canonicalManifestValue(value)), 'utf8')
    .digest('hex');
}

export function parsePublicationManifest(
  input: unknown,
): ParsedPublicationManifest {
  const envelope = z
    .object({
      manifest: publicationManifestBodySchema,
      authorization: signedAuthorizationSchema,
    })
    .strict()
    .parse(input);
  let aggregateBytes = 0;
  const caseFoldedPaths = new Set<string>();
  for (const change of envelope.manifest.changes) {
    const path = normalizeRepositoryPath(change.path);
    const folded = path.toLocaleLowerCase('en-US');
    if (caseFoldedPaths.has(folded))
      throw new Error(`Case-insensitive path collision: ${path}`);
    for (const existing of caseFoldedPaths) {
      if (
        folded.startsWith(`${existing}/`) ||
        existing.startsWith(`${folded}/`)
      )
        throw new Error(`File and directory shape collision: ${path}`);
    }
    caseFoldedPaths.add(folded);
    if (change.operation !== 'delete') {
      assertWellFormedText(change.content, path);
      const size = Buffer.byteLength(change.content, 'utf8');
      if (size > PUBLICATION_MAX_FILE_BYTES)
        throw new Error(`File exceeds publication size limit: ${path}`);
      aggregateBytes += size;
      if (aggregateBytes > PUBLICATION_MAX_TOTAL_BYTES)
        throw new Error('Publication exceeds aggregate size limit');
    }
  }
  const manifestDigest = canonicalPublicationManifestDigest(envelope.manifest);
  return Object.freeze({
    manifest: envelope.manifest,
    manifestDigest,
    authorization:
      envelope.authorization as SignedAttestation<PublicationAuthorizationClaims>,
  });
}

export function validatePublicationAuthorization(
  parsed: ParsedPublicationManifest,
  verifier: AttestationVerifier<PublicationAuthorizationClaims>,
  now: Date,
): PublicationAuthorizationClaims {
  const manifest = parsed.manifest;
  const subject = `${manifest.projectId}:${manifest.runId}:${parsed.manifestDigest}`;
  const claims = verifier.verify(parsed.authorization, { subject });
  const expected = {
    purpose: 'publish-draft-pr',
    audience: 'github-publisher',
    projectId: manifest.projectId,
    runId: manifest.runId,
    stepId: manifest.stepId,
    repository: manifest.repository,
    expectedBase: manifest.expectedBase,
    configDigest: manifest.configDigest,
    policyDigest: manifest.policyDigest,
    sourceSnapshotDigest: manifest.sourceSnapshotDigest,
    testEvidenceDigest: canonicalPublicationManifestDigest(
      manifest.testEvidence,
    ),
    manifestDigest: parsed.manifestDigest,
  } as const;
  const valid = authorizationClaimsSchema.safeParse(claims);
  const actualBinding = valid.success
    ? {
        purpose: valid.data.purpose,
        audience: valid.data.audience,
        projectId: valid.data.projectId,
        runId: valid.data.runId,
        stepId: valid.data.stepId,
        repository: valid.data.repository,
        expectedBase: valid.data.expectedBase,
        configDigest: valid.data.configDigest,
        policyDigest: valid.data.policyDigest,
        sourceSnapshotDigest: valid.data.sourceSnapshotDigest,
        testEvidenceDigest: valid.data.testEvidenceDigest,
        manifestDigest: valid.data.manifestDigest,
      }
    : undefined;
  if (
    !valid.success ||
    canonicalJsonValue(actualBinding) !== canonicalJsonValue(expected)
  ) {
    throw new Error('Publication authorization is invalid');
  }
  if (Date.parse(valid.data.expiresAt) <= now.getTime())
    throw new Error('Publication authorization has expired');
  const issuedAt = Date.parse(parsed.authorization.issuedAt);
  const expiresAt = Date.parse(valid.data.expiresAt);
  if (
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > PUBLICATION_AUTHORIZATION_MAX_TTL_MS
  )
    throw new Error('Publication authorization validity window is invalid');
  if (issuedAt > now.getTime() + 60_000)
    throw new Error('Publication authorization is not yet valid');
  return valid.data;
}
