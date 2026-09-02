import { describe, expect, it, vi } from 'vitest';

import { runKimiAgentLoop } from './loop.js';
import { createKimiHttpTransport } from './transport.js';
import type {
  KimiContentBlock,
  KimiToolExecutor,
  KimiTransport,
} from './types.js';

type SendRequest = Parameters<KimiTransport['send']>[0];
type SendResponse = Awaited<ReturnType<KimiTransport['send']>>;

function scriptedTransport(responses: readonly SendResponse[]): {
  readonly transport: KimiTransport;
  readonly calls: SendRequest[];
} {
  const calls: SendRequest[] = [];
  let index = 0;
  return {
    calls,
    transport: {
      async send(request) {
        calls.push(request);
        const response = responses[index];
        index += 1;
        if (response === undefined) {
          throw new Error('scriptedTransport: no more scripted responses');
        }
        return response;
      },
    },
  };
}

function neverAborted(): AbortSignal {
  return new AbortController().signal;
}

describe('runKimiAgentLoop', () => {
  it('runs two tool calls then submit_result to completion, summing usage and emitting events in order', async () => {
    const events: { type: string; detail: string }[] = [];
    const { transport } = scriptedTransport([
      {
        content: [
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'bash',
            input: { cmd: 'ls' },
          },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      {
        content: [
          {
            type: 'tool_use',
            id: 'call_2',
            name: 'read',
            input: { path: 'file.txt' },
          },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 8, outputTokens: 4 },
      },
      {
        content: [
          {
            type: 'tool_use',
            id: 'call_3',
            name: 'submit_result',
            input: { summary: 'done' },
          },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 6, outputTokens: 2 },
      },
    ]);
    const executor: KimiToolExecutor = {
      execute: vi.fn(async (name: string) => {
        if (name === 'bash') return { content: 'file.txt', isError: false };
        if (name === 'read') return { content: 'contents', isError: false };
        throw new Error(`unexpected tool ${name}`);
      }),
    };

    const result = await runKimiAgentLoop({
      transport,
      model: 'kimi-test',
      initialInput: { task: 'do it' },
      tools: [],
      executor,
      signal: neverAborted(),
      onEvent: (event) => events.push(event),
    });

    expect(result).toEqual({
      status: 'submitted',
      result: { summary: 'done' },
      usage: { inputTokens: 24, outputTokens: 11 },
      turns: 3,
    });
    expect(events.map((event) => event.type)).toEqual([
      'tool_call',
      'tool_result',
      'tool_call',
      'tool_result',
    ]);
    expect(events[0]).toEqual({
      type: 'tool_call',
      name: 'bash',
      detail: JSON.stringify({ name: 'bash', input: { cmd: 'ls' } }),
    });
    expect(events[1]).toEqual({
      type: 'tool_result',
      name: 'bash',
      isError: false,
      detail: JSON.stringify({
        name: 'bash',
        isError: false,
        content: 'file.txt',
      }),
    });
  });

  it('returns parallel tool_use results in a single user turn', async () => {
    const { transport, calls } = scriptedTransport([
      {
        content: [
          { type: 'tool_use', id: 'call_a', name: 'toolA', input: { n: 1 } },
          { type: 'tool_use', id: 'call_b', name: 'toolB', input: { n: 2 } },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      {
        content: [
          {
            type: 'tool_use',
            id: 'call_c',
            name: 'submit_result',
            input: { ok: true },
          },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);
    const executor: KimiToolExecutor = {
      execute: vi.fn(async (name: string) => ({
        content: `${name}-result`,
        isError: false,
      })),
    };

    const result = await runKimiAgentLoop({
      transport,
      model: 'kimi-test',
      initialInput: {},
      tools: [],
      executor,
      signal: neverAborted(),
      onEvent: () => {},
    });

    expect(result.status).toBe('submitted');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.messages.at(-1)).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_a', content: 'toolA-result' },
        { type: 'tool_result', tool_use_id: 'call_b', content: 'toolB-result' },
      ],
    });
  });

  it('marks executor errors as is_error tool_result and continues the loop', async () => {
    const { transport, calls } = scriptedTransport([
      {
        content: [{ type: 'tool_use', id: 'call_1', name: 'toolC', input: {} }],
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      {
        content: [
          {
            type: 'tool_use',
            id: 'call_2',
            name: 'submit_result',
            input: { done: true },
          },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);
    const executor: KimiToolExecutor = {
      execute: vi.fn(async () => ({ content: 'boom', isError: true })),
    };

    const result = await runKimiAgentLoop({
      transport,
      model: 'kimi-test',
      initialInput: {},
      tools: [],
      executor,
      signal: neverAborted(),
      onEvent: () => {},
    });

    expect(result.status).toBe('submitted');
    expect(calls[1]?.messages.at(-1)).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call_1',
          content: 'boom',
          is_error: true,
        },
      ],
    });
  });

  it('rejects an oversized submit_result payload with a tool_result error and does not submit', async () => {
    const oversized = { data: 'a'.repeat(300_000) };
    const { transport, calls } = scriptedTransport([
      {
        content: [
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'submit_result',
            input: oversized,
          },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      {
        content: [
          {
            type: 'tool_use',
            id: 'call_2',
            name: 'submit_result',
            input: { ok: true },
          },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);
    const executor: KimiToolExecutor = { execute: vi.fn() };

    const result = await runKimiAgentLoop({
      transport,
      model: 'kimi-test',
      initialInput: {},
      tools: [],
      executor,
      signal: neverAborted(),
      onEvent: () => {},
    });

    expect(result).toMatchObject({
      status: 'submitted',
      result: { ok: true },
      turns: 2,
    });
    expect(executor.execute).not.toHaveBeenCalled();
    const rejectionTurn = calls[1]?.messages.at(-1);
    expect(rejectionTurn).toMatchObject({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call_1',
          is_error: true,
        },
      ],
    });
  });

  it('returns cancelled when the signal aborts mid-loop', async () => {
    const controller = new AbortController();
    const { transport } = scriptedTransport([
      {
        content: [{ type: 'tool_use', id: 'call_1', name: 'toolX', input: {} }],
        stopReason: 'tool_use',
        usage: { inputTokens: 3, outputTokens: 2 },
      },
      {
        content: [
          {
            type: 'tool_use',
            id: 'call_2',
            name: 'submit_result',
            input: {},
          },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 100, outputTokens: 100 },
      },
    ]);
    const executor: KimiToolExecutor = {
      execute: vi.fn(async () => {
        controller.abort();
        return { content: 'ok', isError: false };
      }),
    };

    const result = await runKimiAgentLoop({
      transport,
      model: 'kimi-test',
      initialInput: {},
      tools: [],
      executor,
      signal: controller.signal,
      onEvent: () => {},
    });

    expect(result).toEqual({
      status: 'cancelled',
      usage: { inputTokens: 3, outputTokens: 2 },
      turns: 1,
    });
  });

  it('skips the remaining tool calls of a turn once the signal aborts mid-turn', async () => {
    const controller = new AbortController();
    const { transport } = scriptedTransport([
      {
        content: [
          { type: 'tool_use', id: 'call_1', name: 'write', input: { n: 1 } },
          { type: 'tool_use', id: 'call_2', name: 'write', input: { n: 2 } },
          { type: 'tool_use', id: 'call_3', name: 'write', input: { n: 3 } },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 3, outputTokens: 2 },
      },
    ]);
    const executed: unknown[] = [];
    const executor: KimiToolExecutor = {
      execute: vi.fn(async (_name: string, input: unknown) => {
        executed.push(input);
        // A cancel/cleanup landing between two tool calls of the same turn.
        controller.abort();
        return { content: 'ok', isError: false };
      }),
    };

    const result = await runKimiAgentLoop({
      transport,
      model: 'kimi-test',
      initialInput: {},
      tools: [],
      executor,
      signal: controller.signal,
      onEvent: () => {},
    });

    expect(executed).toEqual([{ n: 1 }]);
    expect(result).toEqual({
      status: 'cancelled',
      usage: { inputTokens: 3, outputTokens: 2 },
      turns: 1,
    });
  });

  it('reports cumulative usage after every turn, not only at settlement', async () => {
    const snapshots: { inputTokens: number; outputTokens: number }[] = [];
    const { transport } = scriptedTransport([
      {
        content: [{ type: 'tool_use', id: 'call_1', name: 'bash', input: {} }],
        stopReason: 'tool_use',
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      {
        content: [
          {
            type: 'tool_use',
            id: 'call_2',
            name: 'submit_result',
            input: { ok: true },
          },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 6, outputTokens: 2 },
      },
    ]);
    const executor: KimiToolExecutor = {
      execute: async () => ({ content: 'ok', isError: false }),
    };

    await runKimiAgentLoop({
      transport,
      model: 'kimi-test',
      initialInput: {},
      tools: [],
      executor,
      signal: neverAborted(),
      onEvent: () => {},
      onUsage: (usage) => snapshots.push({ ...usage }),
    });

    expect(snapshots).toEqual([
      { inputTokens: 10, outputTokens: 5 },
      { inputTokens: 16, outputTokens: 7 },
    ]);
  });

  it('threads the loop signal into the transport so a cancel aborts the in-flight request', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          expect(init?.signal).toBeDefined();
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('aborted by signal')),
          );
        }),
    );
    const transport = createKimiHttpTransport({
      apiKey: 'kimi-key',
      fetchImpl,
    });

    const promise = runKimiAgentLoop({
      transport,
      model: 'kimi-test',
      initialInput: {},
      tools: [],
      executor: { execute: async () => ({ content: '', isError: false }) },
      signal: controller.signal,
      onEvent: () => {},
    });
    controller.abort();

    await expect(promise).rejects.toThrow('aborted by signal');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns turn_limit after exhausting maxTurns', async () => {
    const responses: SendResponse[] = Array.from({ length: 3 }, (_, index) => ({
      content: [
        { type: 'tool_use', id: `call_${index}`, name: 'toolLoop', input: {} },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const { transport, calls } = scriptedTransport(responses);
    const executor: KimiToolExecutor = {
      execute: vi.fn(async () => ({ content: 'again', isError: false })),
    };

    const result = await runKimiAgentLoop({
      transport,
      model: 'kimi-test',
      initialInput: {},
      tools: [],
      executor,
      signal: neverAborted(),
      onEvent: () => {},
      maxTurns: 3,
    });

    expect(result).toEqual({
      status: 'turn_limit',
      usage: { inputTokens: 3, outputTokens: 3 },
      turns: 3,
    });
    expect(calls).toHaveLength(3);
  });

  it('surfaces a transport parse rejection instead of swallowing it', async () => {
    const parseError = new Error('unknown content block type');
    const transport: KimiTransport = {
      send: vi.fn(async () => {
        throw parseError;
      }),
    };
    const executor: KimiToolExecutor = { execute: vi.fn() };

    await expect(
      runKimiAgentLoop({
        transport,
        model: 'kimi-test',
        initialInput: {},
        tools: [],
        executor,
        signal: neverAborted(),
        onEvent: () => {},
      }),
    ).rejects.toBe(parseError);
  });
});

describe('createKimiHttpTransport', () => {
  it('POSTs the Messages endpoint with expected headers/body and retries once on 429', async () => {
    let callCount = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      callCount += 1;
      if (callCount === 1) return new Response('rate limited', { status: 429 });
      return Response.json({
        content: [{ type: 'text', text: 'hi' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 11, output_tokens: 22 },
      });
    });
    const transport = createKimiHttpTransport({
      apiKey: 'kimi-key',
      fetchImpl,
    });

    vi.useFakeTimers();
    try {
      const promise = transport.send({
        model: 'kimi-test',
        system: 'sys',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        ],
        tools: [],
        maxTokens: 111,
      });
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const [url, init] = fetchImpl.mock.calls[0]!;
      expect(url).toBe('https://api.moonshot.ai/anthropic/v1/messages');
      expect(init).toMatchObject({
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'kimi-key',
          'anthropic-version': '2023-06-01',
        },
      });
      expect(JSON.parse(init!.body as string)).toEqual({
        model: 'kimi-test',
        system: 'sys',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        ],
        tools: [],
        max_tokens: 111,
      });
      expect(result).toEqual({
        content: [{ type: 'text', text: 'hi' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 11, outputTokens: 22 },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts thinking blocks from reasoning models and replays them', async () => {
    const calls: unknown[] = [];
    const transport = {
      send: async (request: {
        messages: readonly unknown[];
      }): Promise<{
        content: readonly KimiContentBlock[];
        stopReason: string | null;
        usage: { inputTokens: number; outputTokens: number };
      }> => {
        calls.push(request.messages);
        return calls.length === 1
          ? {
              content: [
                { type: 'thinking', thinking: 'Let me consider.' },
                {
                  type: 'tool_use',
                  id: 'tu-1',
                  name: 'submit_result',
                  input: { done: true },
                },
              ],
              stopReason: 'tool_use',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          : {
              content: [],
              stopReason: 'end_turn',
              usage: { inputTokens: 0, outputTokens: 0 },
            };
      },
    };
    const result = await runKimiAgentLoop({
      transport,
      model: 'kimi-test',
      initialInput: { task: 'x' },
      tools: [],
      executor: { execute: async () => ({ content: '', isError: false }) },
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    expect(result.status).toBe('submitted');
  });

  it('accepts a realistic full Anthropic Messages envelope with extra fields', async () => {
    // Real Anthropic-compatible responses carry many fields beyond the four
    // this transport cares about; a strict outer schema would reject this.
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({
        id: 'msg_01XyZAbCdEfGhIjKlMnOpQrS',
        type: 'message',
        role: 'assistant',
        model: 'kimi-k2-turbo-preview',
        content: [{ type: 'text', text: 'hello' }],
        stop_reason: null,
        stop_sequence: null,
        container: null,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation: {
            ephemeral_5m_input_tokens: 0,
            ephemeral_1h_input_tokens: 0,
          },
        },
      }),
    );
    const transport = createKimiHttpTransport({
      apiKey: 'kimi-key',
      fetchImpl,
    });

    const result = await transport.send({
      model: 'kimi-k2-turbo-preview',
      messages: [],
      tools: [],
      maxTokens: 32,
    });

    expect(result).toEqual({
      content: [{ type: 'text', text: 'hello' }],
      stopReason: null,
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  });

  it('classifies an empty successful response as a transient transport failure', async () => {
    const transport = createKimiHttpTransport({
      apiKey: 'kimi-key',
      fetchImpl: vi.fn<typeof fetch>(
        async () =>
          new Response('', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    });

    await expect(
      transport.send({
        model: 'kimi-test',
        messages: [],
        tools: [],
        maxTokens: 32,
      }),
    ).rejects.toMatchObject({
      name: 'KimiTransportError',
      status: 502,
      body: 'invalid JSON response from Kimi',
    });
  });

  it('throws KimiTransportError with a bounded body slice on a persistent non-2xx response', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response('x'.repeat(1000), { status: 500 }),
    );
    const transport = createKimiHttpTransport({
      apiKey: 'kimi-key',
      fetchImpl,
      // This test is about the error it raises once retries are exhausted, not
      // about the retry schedule -- see transport.test.ts for that -- so the
      // backoff is skipped rather than waited out.
      sleepImpl: async () => {},
    });

    const promise = transport.send({
      model: 'kimi-test',
      messages: [],
      tools: [],
      maxTokens: 1,
    });
    await expect(promise).rejects.toMatchObject({
      name: 'KimiTransportError',
      status: 500,
    });
    const rejection = await promise.catch((error: unknown) => error);
    expect((rejection as { body: string }).body).toHaveLength(500);
  });
});
