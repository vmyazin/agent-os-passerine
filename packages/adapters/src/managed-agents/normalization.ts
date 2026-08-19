import type { RuntimeEvent } from '@agentos/core';

import { ManagedAgentsLimitError } from './errors.js';
import type { ManagedAgentsEvent } from './sdk-contract.js';

const ERROR_TYPES = new Set([
  'unknown_error',
  'model_overloaded_error',
  'model_rate_limited_error',
  'model_request_failed_error',
  'mcp_connection_failed_error',
  'mcp_authentication_failed_error',
  'billing_error',
  'credential_host_unreachable_error',
]);

const SUPPORTED_EVENT_TYPES = new Set([
  'agent.message',
  'agent.thinking',
  'agent.thread_context_compacted',
  'agent.custom_tool_use',
  'agent.tool_use',
  'agent.mcp_tool_use',
  'agent.tool_result',
  'agent.mcp_tool_result',
  'session.status_running',
  'session.status_rescheduled',
  'session.status_terminated',
  'session.status_idle',
  'session.error',
  'session.usage',
  'span.model_request_end',
  'span.model_request_start',
  'span.outcome_evaluation_start',
  'span.outcome_evaluation_ongoing',
  'span.outcome_evaluation_end',
  'session.thread_created',
  'session.thread_status_running',
  'session.thread_status_idle',
  'session.thread_status_rescheduled',
  'session.thread_status_terminated',
  'agent.thread_message_received',
  'agent.thread_message_sent',
  'user.message',
  'user.interrupt',
  'user.tool_confirmation',
  'user.tool_result',
  'user.custom_tool_result',
  'user.define_outcome',
  'system.message',
  'session.updated',
  'session.deleted',
]);

export function normalizeEvent(
  event: ManagedAgentsEvent,
  maxEventBytes: number,
  fallbackOccurredAt: Date,
): RuntimeEvent | undefined {
  assertEventSize(event, maxEventBytes);
  const type = requiredString(event.type);
  if (type === 'event_start' || type === 'event_delta') return undefined;
  if (!SUPPORTED_EVENT_TYPES.has(type)) {
    throw new Error('Unsupported provider event');
  }
  const id = requiredString(event.id);
  const occurredAt = parsedDate(event.processed_at, fallbackOccurredAt);
  const base = { id, occurredAt };
  const fingerprint = optionalBoundedString(event.fingerprint, 128);
  const withFingerprint = <T extends Record<string, unknown>>(payload: T) =>
    fingerprint === undefined
      ? payload
      : { ...payload, providerFingerprint: fingerprint };

  switch (type) {
    case 'agent.message':
      return {
        ...base,
        type: 'message',
        payload: withFingerprint({ text: textContent(event.content) }),
      };
    case 'agent.thinking':
      return { ...base, type: 'progress', payload: withFingerprint({}) };
    case 'agent.thread_context_compacted':
      return {
        ...base,
        type: 'message_summary',
        payload: withFingerprint({ compacted: true }),
      };
    case 'agent.custom_tool_use':
    case 'agent.tool_use':
    case 'agent.mcp_tool_use':
      return {
        ...base,
        type: 'tool_call',
        payload: withFingerprint({
          toolUseId: id,
          name: requiredBoundedString(event.name, 128),
          ...optionalId('sessionThreadId', event.session_thread_id),
          ...(type === 'agent.mcp_tool_use'
            ? optionalId('mcpServerName', event.mcp_server_name)
            : {}),
        }),
      };
    case 'agent.tool_result':
    case 'agent.mcp_tool_result':
      return {
        ...base,
        type: 'tool_result',
        payload: withFingerprint({
          isError: event.is_error === true,
          ...linkedToolId(event),
        }),
      };
    case 'session.status_running':
      return { ...base, type: 'running', payload: withFingerprint({}) };
    case 'session.status_rescheduled':
      return { ...base, type: 'rescheduling', payload: withFingerprint({}) };
    case 'session.status_terminated':
      return { ...base, type: 'terminated', payload: withFingerprint({}) };
    case 'session.status_idle':
      return normalizeIdle(base, event, fingerprint);
    case 'session.error':
      return {
        ...base,
        type: 'error',
        payload: withFingerprint(normalizedError(event.error)),
      };
    case 'session.usage':
      return {
        ...base,
        type: 'usage',
        payload: withFingerprint(normalizedUsage(event.usage)),
      };
    case 'span.model_request_end':
      return {
        ...base,
        type: 'usage',
        payload: withFingerprint(normalizedUsage(event.model_usage)),
      };
    case 'span.model_request_start':
    case 'span.outcome_evaluation_start':
    case 'span.outcome_evaluation_ongoing':
    case 'span.outcome_evaluation_end':
      return { ...base, type: 'progress', payload: withFingerprint({}) };
    case 'session.thread_created':
      return {
        ...base,
        type: 'thread_created',
        payload: withFingerprint(
          optionalId('sessionThreadId', event.session_thread_id),
        ),
      };
    case 'session.thread_status_running':
      return threadStatus(base, event, 'running', fingerprint);
    case 'session.thread_status_idle':
      return threadStatus(base, event, 'idle', fingerprint);
    case 'session.thread_status_rescheduled':
      return threadStatus(base, event, 'rescheduling', fingerprint);
    case 'session.thread_status_terminated':
      return threadStatus(base, event, 'terminated', fingerprint);
    case 'agent.thread_message_received':
    case 'agent.thread_message_sent':
      return {
        ...base,
        type: 'thread_message',
        payload: withFingerprint({ delivered: true }),
      };
    case 'user.message':
    case 'user.interrupt':
    case 'user.tool_confirmation':
    case 'user.tool_result':
    case 'user.custom_tool_result':
    case 'user.define_outcome':
    case 'system.message':
      return {
        ...base,
        type: 'input_acknowledged',
        payload: withFingerprint({}),
      };
    case 'session.updated':
      return { ...base, type: 'session_updated', payload: withFingerprint({}) };
    case 'session.deleted':
      return { ...base, type: 'deleted', payload: withFingerprint({}) };
    default:
      throw new Error('Unsupported provider event');
  }
}

function normalizeIdle(
  base: { id: string; occurredAt: Date },
  event: ManagedAgentsEvent,
  fingerprint: string | undefined,
): RuntimeEvent {
  if (!isRecord(event.stop_reason)) throw new Error('Malformed provider event');
  const reason = requiredString(event.stop_reason.type);
  const providerFingerprint =
    fingerprint === undefined ? {} : { providerFingerprint: fingerprint };
  if (reason === 'end_turn' || reason === 'budget_reached') {
    return {
      ...base,
      type: 'idle',
      payload: { stopReason: reason, ...providerFingerprint },
    };
  }
  if (reason === 'requires_action') {
    const ids = Array.isArray(event.stop_reason.event_ids)
      ? event.stop_reason.event_ids.map((value) =>
          requiredBoundedString(value, 128),
        )
      : undefined;
    if (ids === undefined) throw new Error('Malformed provider event');
    return {
      ...base,
      type: 'requires_action',
      payload: { eventIds: ids, ...providerFingerprint },
    };
  }
  if (reason === 'retries_exhausted') {
    return {
      ...base,
      type: 'retries_exhausted',
      payload: providerFingerprint,
    };
  }
  throw new Error('Unsupported provider event');
}

function threadStatus(
  base: { id: string; occurredAt: Date },
  event: ManagedAgentsEvent,
  status: 'running' | 'idle' | 'rescheduling' | 'terminated',
  fingerprint: string | undefined,
): RuntimeEvent {
  return {
    ...base,
    type: `thread_${status}`,
    payload: {
      ...optionalId('sessionThreadId', event.session_thread_id),
      ...(fingerprint === undefined
        ? {}
        : { providerFingerprint: fingerprint }),
    },
  };
}

function normalizedError(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Malformed provider event');
  const type = requiredString(value.type);
  if (!ERROR_TYPES.has(type)) throw new Error('Unsupported provider event');
  if (!isRecord(value.retry_status))
    throw new Error('Malformed provider event');
  const retryStatus = value.retry_status.type;
  if (
    retryStatus !== 'retrying' &&
    retryStatus !== 'exhausted' &&
    retryStatus !== 'terminal'
  ) {
    throw new Error('Unsupported provider event');
  }
  return {
    code: type,
    retryStatus,
  };
}

function normalizedUsage(value: unknown): Record<string, number> {
  if (!isRecord(value)) throw new Error('Malformed provider event');
  const cache = isRecord(value.cache_creation) ? value.cache_creation : {};
  const cache5m = nonnegativeNumber(cache.ephemeral_5m_input_tokens);
  const cache1h = nonnegativeNumber(cache.ephemeral_1h_input_tokens);
  const undifferentiatedCacheCreation = nonnegativeNumber(
    value.cache_creation_input_tokens,
  );
  return {
    inputTokens: nonnegativeNumber(value.input_tokens),
    outputTokens: nonnegativeNumber(value.output_tokens),
    cacheReadInputTokens: nonnegativeNumber(value.cache_read_input_tokens),
    cacheCreation5mInputTokens: cache5m,
    // Older/partial provider events do not expose TTL. Charge that bucket at
    // the conservative 1h rate, but never add a total on top of its breakdown.
    cacheCreation1hInputTokens:
      cache1h +
      (cache5m === 0 && cache1h === 0 ? undifferentiatedCacheCreation : 0),
    // Streamed usage events may omit active_seconds entirely; runtime billing
    // comes from the session-level usage() call, so absence here is not an
    // error and must not abort the event stream.
    runtimeMs:
      value.active_seconds === undefined
        ? 0
        : normalizeRuntimeMilliseconds(value.active_seconds),
  };
}

export function normalizeRuntimeMilliseconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new Error('Provider runtime usage is invalid');
  const milliseconds = Math.ceil(value * 1000);
  if (!Number.isSafeInteger(milliseconds))
    throw new Error('Provider runtime usage is invalid');
  return milliseconds;
}

function linkedToolId(event: ManagedAgentsEvent): Record<string, string> {
  for (const key of ['custom_tool_use_id', 'tool_use_id', 'mcp_tool_use_id']) {
    if (event[key] !== undefined) {
      return { toolUseId: requiredBoundedString(event[key], 128) };
    }
  }
  return {};
}

function textContent(value: unknown): string {
  if (!Array.isArray(value)) throw new Error('Malformed provider event');
  return value
    .filter(
      (block): block is { type: 'text'; text: string } =>
        isRecord(block) &&
        block.type === 'text' &&
        typeof block.text === 'string',
    )
    .map((block) => block.text)
    .join('');
}

function parsedDate(value: unknown, fallback: Date): Date {
  if (value === undefined || value === null) return new Date(fallback);
  if (typeof value !== 'string') throw new Error('Malformed provider event');
  const result = new Date(value);
  if (Number.isNaN(result.getTime()))
    throw new Error('Malformed provider event');
  return result;
}

function assertEventSize(event: ManagedAgentsEvent, limit: number): void {
  const serialized = JSON.stringify(event);
  if (
    serialized === undefined ||
    Buffer.byteLength(serialized, 'utf8') > limit
  ) {
    throw new ManagedAgentsLimitError('Provider event exceeds maxEventBytes');
  }
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Malformed provider event');
  }
  return value;
}

function requiredBoundedString(value: unknown, limit: number): string {
  const result = requiredString(value);
  if (result.length > limit) throw new Error('Malformed provider event');
  return result;
}

function optionalBoundedString(
  value: unknown,
  limit: number,
): string | undefined {
  return value === undefined ? undefined : requiredBoundedString(value, limit);
}

function optionalId(key: string, value: unknown): Record<string, string> {
  return value === undefined || value === null
    ? {}
    : { [key]: requiredBoundedString(value, 128) };
}

function nonnegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
