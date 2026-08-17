import { randomUUID } from 'node:crypto';

import { createManagedAgentsRuntimeProvider } from '../dist/index.js';

const environment = globalThis.process.env;

if (environment.AGENTOS_LIVE_TESTS !== '1' || !environment.ANTHROPIC_API_KEY) {
  throw new Error(
    'Managed Agents smoke test requires ANTHROPIC_API_KEY and AGENTOS_LIVE_TESTS=1',
  );
}

const suffix = randomUUID();
const provider = await createManagedAgentsRuntimeProvider({
  apiKey: environment.ANTHROPIC_API_KEY,
});

await provider.syncAgent({
  id: `smoke-agent-${suffix}`,
  model: 'claude-sonnet-4-6',
  instructions: 'Reply with the single word ok.',
  tools: [],
  mcps: [],
});
await provider.syncEnvironment({
  id: `smoke-environment-${suffix}`,
  runtime: 'cloud',
  variables: {},
});

const handle = await provider.start({
  runId: `smoke-run-${suffix}`,
  stepId: 'smoke-step',
  agentId: `smoke-agent-${suffix}`,
  environmentId: `smoke-environment-${suffix}`,
  input: 'Reply now.',
});

try {
  for await (const event of provider.events(handle)) {
    if (event.type === 'idle' || event.type === 'terminated') break;
  }
  const output = await provider.collectOutput(handle);
  if (output.text?.trim().toLowerCase() !== 'ok') {
    throw new Error('Managed Agents smoke test returned an unexpected output');
  }
} finally {
  await provider.cleanup(handle);
}
