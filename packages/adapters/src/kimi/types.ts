export interface KimiMessage {
  readonly role: 'user' | 'assistant';
  readonly content: readonly KimiContentBlock[];
}

export type KimiContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'tool_use';
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly type: 'tool_result';
      readonly tool_use_id: string;
      readonly content: string;
      readonly is_error?: boolean;
    };

export interface KimiToolDefinition {
  name: string;
  description: string;
  input_schema: unknown;
}

export interface KimiTransport {
  send(request: {
    readonly model: string;
    readonly system?: string;
    readonly messages: readonly KimiMessage[];
    readonly tools: readonly KimiToolDefinition[];
    readonly maxTokens: number;
  }): Promise<{
    readonly content: readonly KimiContentBlock[];
    readonly stopReason: string;
    readonly usage: {
      readonly inputTokens: number;
      readonly outputTokens: number;
    };
  }>;
}

export interface KimiToolExecutor {
  execute(
    name: string,
    input: unknown,
  ): Promise<{ readonly content: string; readonly isError: boolean }>;
}

export interface KimiLoopResult {
  readonly status: 'submitted' | 'turn_limit' | 'cancelled';
  readonly result?: unknown; // submit_result payload when status === 'submitted'
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
  readonly turns: number;
}

/**
 * Thrown by {@link KimiTransport} implementations when the Kimi Messages
 * endpoint returns a non-2xx response (after the single 429/5xx retry) or
 * when the response body fails schema validation.
 */
export class KimiTransportError extends Error {
  override readonly name = 'KimiTransportError';
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`Kimi transport request failed with status ${status}`);
    this.status = status;
    this.body = body;
  }
}
