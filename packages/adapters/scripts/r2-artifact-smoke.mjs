import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { TextDecoder, TextEncoder } from 'node:util';

import { createR2ArtifactStore } from '../dist/index.js';

if (process.env.AGENTOS_LIVE_TESTS !== '1') {
  throw new Error(
    'Set AGENTOS_LIVE_TESTS=1 to run the destructive R2 smoke test',
  );
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const store = createR2ArtifactStore({
  accountId: required('CLOUDFLARE_R2_ACCOUNT_ID'),
  bucket: required('CLOUDFLARE_R2_ARTIFACT_BUCKET'),
  accessKeyId: required('CLOUDFLARE_R2_ARTIFACT_ACCESS_KEY_ID'),
  secretAccessKey: required('CLOUDFLARE_R2_ARTIFACT_SECRET_ACCESS_KEY'),
  ...(process.env.CLOUDFLARE_R2_ENDPOINT
    ? { endpoint: process.env.CLOUDFLARE_R2_ENDPOINT }
    : {}),
});
const scope = {
  projectId: 'agentos-smoke',
  runId: randomUUID(),
  stepId: 'r2',
};
const bytes = new TextEncoder().encode('agentos-r2-smoke');
const stored = await store.put({
  scope,
  artifactId: 'probe',
  version: 1,
  bytes,
  mediaType: 'text/plain',
  retentionClass: 'cloud-session-upload',
});
const read = await store.get({ scope, key: stored.key, maxBytes: 1024 });
if (new TextDecoder().decode(read?.bytes) !== 'agentos-r2-smoke') {
  throw new Error('R2 smoke read did not match the written bytes');
}
const listed = await store.list({ scope, limit: 10 });
if (!listed.items.some((item) => item.key === stored.key)) {
  throw new Error('R2 smoke object was not listed');
}
process.stdout.write(
  `${JSON.stringify({ ok: true, key: stored.key, expiresAt: stored.expiresAt })}\n`,
);
