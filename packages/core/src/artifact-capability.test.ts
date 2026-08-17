import { describe, expect, it } from 'vitest';

import {
  ArtifactCapabilityError,
  createArtifactCapabilityIssuer,
  createArtifactCapabilityVerifier,
} from './artifact-capability.js';

const now = new Date('2026-08-17T00:00:00.000Z');
const primary = { keyId: 'primary', secret: 'p'.repeat(32) };
const old = { keyId: 'old', secret: 'o'.repeat(32) };
const claims = {
  purpose: 'agent-artifact-access',
  audience: 'artifact-mcp',
  methods: ['artifact.get', 'artifact.put', 'artifact.list'] as const,
  projectId: 'project-1',
  runId: 'run-1',
  stepId: 'step-1',
  prefix: 'spec',
  maxBytes: 1024,
  expiresAt: '2026-08-17T00:10:00.000Z',
  notBefore: '2026-08-17T00:00:00.000Z',
  nonce: 'nonce-1234567890',
};

describe('artifact capabilities', () => {
  it('round-trips canonical signed claims and supports key rotation', () => {
    const token = createArtifactCapabilityIssuer(old).issue(claims, now);
    const verified = createArtifactCapabilityVerifier({
      keys: [primary, old],
    }).verify(token, {
      audience: 'artifact-mcp',
      purpose: 'agent-artifact-access',
      method: 'artifact.get',
      now,
      projectId: 'project-1',
      runId: 'run-1',
      stepId: 'step-1',
      artifactId: 'spec',
      bytes: 1,
    });

    expect(verified).toEqual(claims);
  });

  it.each([
    ['purpose', { purpose: 'other-purpose' }],
    ['audience', { audience: 'other' }],
    ['method', { method: 'artifact.delete' }],
    ['project', { projectId: 'project-2' }],
    ['run', { runId: 'run-2' }],
    ['step', { stepId: 'step-2' }],
    ['prefix', { artifactId: 'other' }],
    ['bytes', { bytes: 2048 }],
  ])('denies a mismatched %s without exposing token data', (_label, change) => {
    const token = createArtifactCapabilityIssuer(primary).issue(claims, now);
    const verifier = createArtifactCapabilityVerifier({ keys: [primary] });
    expect(() =>
      verifier.verify(token, {
        audience: 'artifact-mcp',
        purpose: 'agent-artifact-access',
        method: 'artifact.get',
        now,
        projectId: 'project-1',
        runId: 'run-1',
        stepId: 'step-1',
        artifactId: 'spec',
        bytes: 1,
        ...change,
      }),
    ).toThrow(ArtifactCapabilityError);
    try {
      verifier.verify(token, {
        audience: 'other',
        purpose: 'agent-artifact-access',
        method: 'artifact.get',
        now,
      });
    } catch (error) {
      expect(String(error)).not.toContain(token);
      expect(String(error)).not.toContain(primary.secret);
    }
  });

  it('denies expired, excessively future, tampered, unknown-key, and malformed tokens', () => {
    const issuer = createArtifactCapabilityIssuer(primary);
    const verifier = createArtifactCapabilityVerifier({ keys: [primary] });
    const token = issuer.issue(claims, now);

    expect(() =>
      verifier.verify(token, {
        audience: 'artifact-mcp',
        purpose: 'agent-artifact-access',
        method: 'artifact.get',
        now: new Date('2026-08-17T00:11:00.000Z'),
      }),
    ).toThrow(/expired/i);
    expect(() =>
      issuer.issue({ ...claims, notBefore: '2026-08-17T00:06:00.000Z' }, now),
    ).toThrow(/future/i);
    expect(() =>
      verifier.verify(`${token.slice(0, -1)}x`, {
        audience: 'artifact-mcp',
        purpose: 'agent-artifact-access',
        method: 'artifact.get',
        now,
      }),
    ).toThrow(ArtifactCapabilityError);
    const unknown = createArtifactCapabilityIssuer({
      keyId: 'unknown',
      secret: 'u'.repeat(32),
    }).issue(claims, now);
    expect(() =>
      verifier.verify(unknown, {
        audience: 'artifact-mcp',
        purpose: 'agent-artifact-access',
        method: 'artifact.get',
        now,
      }),
    ).toThrow(ArtifactCapabilityError);
    expect(() =>
      verifier.verify('not-a-token', {
        audience: 'artifact-mcp',
        purpose: 'agent-artifact-access',
        method: 'artifact.get',
        now,
      }),
    ).toThrow(ArtifactCapabilityError);
  });

  it('refuses delete grants, invalid clock windows, weak keys, and duplicate key IDs', () => {
    expect(() =>
      createArtifactCapabilityIssuer(primary).issue(
        { ...claims, methods: ['artifact.delete'] as never },
        now,
      ),
    ).toThrow(/method/i);
    expect(() =>
      createArtifactCapabilityIssuer(primary).issue(
        { ...claims, expiresAt: '2026-08-18T01:00:00.000Z' },
        now,
      ),
    ).toThrow(/lifetime/i);
    expect(() =>
      createArtifactCapabilityIssuer({ keyId: 'weak', secret: 'weak' }),
    ).toThrow(/32 bytes/i);
    expect(() =>
      createArtifactCapabilityVerifier({ keys: [primary, primary] }),
    ).toThrow(/duplicate/i);
  });
});
