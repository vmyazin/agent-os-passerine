import { canonicalJsonValue } from '@agentos/core';

import type {
  KimiContentBlock,
  KimiLoopResult,
  KimiMessage,
  KimiToolDefinition,
  KimiToolExecutor,
  KimiTransport,
} from './types.js';

const DEFAULT_MAX_TURNS = 64;
// The Kimi Messages request shape requires max_tokens, but it is not exposed
// as a caller-configurable option in this task's interface; use a fixed
// generous budget for agent-loop turns.
const MAX_TOKENS = 8192;
const MAX_SUBMIT_RESULT_BYTES = 256 * 1024;
const STALL_PROMPT = 'Continue. Use submit_result to finish.';

export interface RunKimiAgentLoopOptions {
  readonly transport: KimiTransport;
  readonly model: string;
  readonly system?: string;
  readonly initialInput: unknown;
  readonly tools: readonly KimiToolDefinition[];
  readonly executor: KimiToolExecutor;
  readonly maxTurns?: number; // default 64
  readonly signal: AbortSignal;
  readonly onEvent: (event: {
    type: 'message' | 'tool_call' | 'tool_result';
    detail: string;
    /** Tool being called/answered, reported apart from the opaque detail. */
    name?: string;
    isError?: boolean;
  }) => void;
  /**
   * Invoked after every completed turn with the run's cumulative token
   * totals, so a caller can report real spend for a session that never
   * settles normally (cancelled, cleaned up, timed out) instead of the
   * zeroes a settle-only accumulation leaves behind.
   */
  readonly onUsage?: (usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  }) => void;
}

export async function runKimiAgentLoop(
  options: RunKimiAgentLoopOptions,
): Promise<KimiLoopResult> {
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const messages: KimiMessage[] = [
    {
      role: 'user',
      content: [{ type: 'text', text: JSON.stringify(options.initialInput) }],
    },
  ];
  let inputTokens = 0;
  let outputTokens = 0;
  let turns = 0;

  const cancelled = () =>
    Object.freeze({
      status: 'cancelled' as const,
      usage: Object.freeze({ inputTokens, outputTokens }),
      turns,
    });

  while (turns < maxTurns) {
    if (options.signal.aborted) {
      return cancelled();
    }
    turns += 1;

    const response = await options.transport.send(
      {
        model: options.model,
        ...(options.system === undefined ? {} : { system: options.system }),
        messages: [...messages],
        tools: options.tools,
        maxTokens: MAX_TOKENS,
      },
      // Threaded so a cancel mid-turn aborts the in-flight request rather
      // than letting this turn (and its tool calls) run to completion
      // against an already-torn-down session.
      { signal: options.signal },
    );

    inputTokens += response.usage.inputTokens;
    outputTokens += response.usage.outputTokens;
    options.onUsage?.({ inputTokens, outputTokens });

    messages.push({ role: 'assistant', content: response.content });

    for (const block of response.content) {
      if (block.type === 'text') {
        options.onEvent({ type: 'message', detail: block.text });
      }
    }

    const toolUseBlocks = response.content.filter(
      (block): block is Extract<KimiContentBlock, { type: 'tool_use' }> =>
        block.type === 'tool_use',
    );

    if (toolUseBlocks.length === 0) {
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: STALL_PROMPT }],
      });
      continue;
    }

    const resultBlocks: KimiContentBlock[] = [];
    let submitted: { readonly result: unknown } | undefined;

    for (const block of toolUseBlocks) {
      // Re-checked before every dispatch, not just once per turn: a cancel
      // that lands between two tool calls of the same turn must skip the
      // rest of them, or a post-cleanup write recreates the destroyed
      // workdir.
      if (options.signal.aborted) {
        return cancelled();
      }
      if (block.name === 'submit_result') {
        const validation = validateSubmitResult(block.input);
        if (validation.ok) {
          submitted = { result: block.input };
          break;
        }
        resultBlocks.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: validation.error,
          is_error: true,
        });
        continue;
      }

      options.onEvent({
        type: 'tool_call',
        name: block.name,
        detail: JSON.stringify({ name: block.name, input: block.input }),
      });
      const result = await options.executor.execute(block.name, block.input);
      options.onEvent({
        type: 'tool_result',
        name: block.name,
        isError: result.isError,
        detail: JSON.stringify({
          name: block.name,
          isError: result.isError,
          content: result.content,
        }),
      });
      resultBlocks.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: result.content,
        ...(result.isError ? { is_error: true } : {}),
      });
    }

    if (submitted !== undefined) {
      return Object.freeze({
        status: 'submitted' as const,
        result: submitted.result,
        usage: Object.freeze({ inputTokens, outputTokens }),
        turns,
      });
    }

    messages.push({ role: 'user', content: resultBlocks });
  }

  return Object.freeze({
    status: 'turn_limit' as const,
    usage: Object.freeze({ inputTokens, outputTokens }),
    turns,
  });
}

function validateSubmitResult(
  input: unknown,
): { readonly ok: true } | { readonly ok: false; readonly error: string } {
  let serialized: string;
  try {
    serialized = canonicalJsonValue(input);
  } catch {
    return { ok: false, error: 'submit_result input is not JSON-serializable' };
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SUBMIT_RESULT_BYTES) {
    return {
      ok: false,
      error: `submit_result payload exceeds ${MAX_SUBMIT_RESULT_BYTES} bytes`,
    };
  }
  return { ok: true };
}
