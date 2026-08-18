import { describe, expect, it, vi } from 'vitest';

import { runKimiAgentLoop } from './loop.js';
import { createKimiHttpTransport } from './transport.js';
import type { KimiToolExecutor, KimiTransport } from './types.js';

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
      detail: JSON.stringify({ name: 'bash', input: { cmd: 'ls' } }),
    });
    expect(events[1]).toEqual({
      type: 'tool_result',
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

  it('throws KimiTransportError with a bounded body slice on a persistent non-2xx response', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response('x'.repeat(1000), { status: 500 }),
    );
    const transport = createKimiHttpTransport({
      apiKey: 'kimi-key',
      fetchImpl,
    });

    vi.useFakeTimers();
    try {
      const promise = transport.send({
        model: 'kimi-test',
        messages: [],
        tools: [],
        maxTokens: 1,
      });
      const assertion = expect(promise).rejects.toMatchObject({
        name: 'KimiTransportError',
        status: 500,
      });
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
      const rejection = await promise.catch((error: unknown) => error);
      expect((rejection as { body: string }).body).toHaveLength(500);
    } finally {
      vi.useRealTimers();
    }
  });
});
