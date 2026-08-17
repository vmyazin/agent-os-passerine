#!/usr/bin/env node

import { runCli } from './main.js';
import { CliError } from './args.js';

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > 64 * 1024) {
      process.stdin.destroy();
      throw new CliError('reply input is too large');
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

process.exitCode = await runCli(process.argv.slice(2), {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
  env: process.env,
  cwd: process.cwd(),
  readStdin,
});
