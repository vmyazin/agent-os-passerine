import process from 'node:process';

import { createKimiHttpTransport, kimiFromEnv } from '../dist/index.js';

const environment = process.env;
const kimi = kimiFromEnv(environment);

// Blank/absent KIMI_API_KEY is treated as "kimi is not configured" (see
// kimiFromEnv). Unlike the other smoke scripts, this one exits 0 instead of
// throwing: it runs as a routine operator check, not a gated destructive
// test, so a missing opt-in should be quiet rather than fail a build.
if (environment.AGENTOS_LIVE_TESTS !== '1' || kimi === undefined) {
  process.stdout.write(
    'Skipping Kimi smoke test: set AGENTOS_LIVE_TESTS=1 and KIMI_API_KEY to run it.\n',
  );
  process.exit(0);
}

const transport = createKimiHttpTransport(kimi);
const model = environment.KIMI_SMOKE_MODEL?.trim() || 'kimi-k2-0905-preview';

// No sandbox, no session: this only proves credentials + endpoint
// compatibility against the Kimi Messages endpoint.
const response = await transport.send({
  model,
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'Reply with OK.' }] },
  ],
  tools: [],
  maxTokens: 32,
});

process.stdout.write(
  `${JSON.stringify({ stopReason: response.stopReason, usage: response.usage })}\n`,
);
