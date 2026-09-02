import { describe, expect, it, vi } from 'vitest';

import { createKimiHttpTransport } from './transport.js';
import { KimiTransportError } from './types.js';

const ok = () =>
  new Response(
    JSON.stringify({
      content: [{ type: 'text', text: 'fine' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const overloaded = (headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: { type: 'overloaded_error' } }), {
    status: 503,
    headers,
  });

const request = {
  model: 'kimi-k2.7-code',
  messages: [{ role: 'user' as const, content: [] }],
  tools: [],
  maxTokens: 16,
};

describe('kimi http transport retries', () => {
  it('rides out a run of overloads instead of giving up after one retry', async () => {
    // A provider shedding load recovers on its own schedule. Giving up after a
    // single one-second retry throws away whatever multi-turn conversation the
    // caller had already paid to build.
    const responses = [overloaded(), overloaded(), overloaded(), ok()];
    const fetchImpl = vi.fn(async () => responses.shift() ?? ok());
    const delays: number[] = [];
    const transport = createKimiHttpTransport({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: async (ms) => {
        delays.push(ms);
      },
    });

    await expect(transport.send(request)).resolves.toMatchObject({
      stopReason: 'end_turn',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    // Growing, so a provider under load is given progressively more room.
    expect(delays).toHaveLength(3);
    expect(delays[1]).toBeGreaterThan(delays[0]!);
    expect(delays[2]).toBeGreaterThan(delays[1]!);
  });

  it('honours the provider its own Retry-After', async () => {
    const responses = [overloaded({ 'retry-after': '7' }), ok()];
    const fetchImpl = vi.fn(async () => responses.shift() ?? ok());
    const delays: number[] = [];
    const transport = createKimiHttpTransport({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: async (ms) => {
        delays.push(ms);
      },
    });

    await transport.send(request);
    expect(delays).toEqual([7_000]);
  });

  it('gives up after the attempt budget and reports the last status', async () => {
    const fetchImpl = vi.fn(async () => overloaded());
    const transport = createKimiHttpTransport({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxAttempts: 3,
      sleepImpl: async () => {},
    });

    await expect(transport.send(request)).rejects.toBeInstanceOf(
      KimiTransportError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not retry a refusal the provider will keep refusing', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { type: 'invalid_request' } }), {
          status: 400,
        }),
    );
    const transport = createKimiHttpTransport({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: async () => {},
    });

    await expect(transport.send(request)).rejects.toBeInstanceOf(
      KimiTransportError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('stops spending requests once the session is cancelled', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => overloaded());
    const transport = createKimiHttpTransport({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: async () => {
        controller.abort();
      },
    });

    await expect(
      transport.send(request, { signal: controller.signal }),
    ).rejects.toThrow();
    // The first attempt, then the abort during the backoff -- never a second.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('forward compatibility', () => {
  it('accepts a known block carrying a field this transport does not read', async () => {
    // Anthropic added `caller` to tool_use blocks. A strict schema turned that
    // into a failed run after the turn had already been paid for.
    const transport = createKimiHttpTransport({
      apiKey: 'k',
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            content: [
              { type: 'text', text: 'thinking about it' },
              {
                type: 'tool_use',
                id: 'call_1',
                name: 'bash',
                input: { command: 'ls' },
                caller: 'assistant',
              },
            ],
            stop_reason: 'tool_use',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as typeof fetch,
    });
    const response = await transport.send({
      model: 'claude-sonnet-4-6',
      messages: [],
      tools: [],
      maxTokens: 16,
    });
    expect(response.content).toHaveLength(2);
    expect(response.content[1]).toMatchObject({
      type: 'tool_use',
      name: 'bash',
    });
  });

  it('still refuses an unknown block type', async () => {
    const transport = createKimiHttpTransport({
      apiKey: 'k',
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            content: [{ type: 'server_tool_use', id: 'x' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as typeof fetch,
    });
    await expect(
      transport.send({ model: 'm', messages: [], tools: [], maxTokens: 16 }),
    ).rejects.toThrow();
  });
});
