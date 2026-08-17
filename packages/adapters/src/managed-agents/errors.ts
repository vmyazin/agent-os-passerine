export class ManagedAgentsConfigurationError extends Error {
  override readonly name = 'ManagedAgentsConfigurationError';
}

export class ManagedAgentsConflictError extends Error {
  override readonly name = 'ManagedAgentsConflictError';
}

export class ManagedAgentsLimitError extends Error {
  override readonly name = 'ManagedAgentsLimitError';
}

export class ManagedAgentsProviderError extends Error {
  override readonly name = 'ManagedAgentsProviderError';

  readonly status: number | undefined;
  readonly code: string | undefined;

  constructor(cause: unknown) {
    super('Provider request failed');
    const source = isRecord(cause) ? cause : {};
    this.status = safeInteger(source.status);
    this.code = safeCode(source.type);
  }
}

const PROVIDER_ERROR_CODES = new Set([
  'api_error',
  'authentication_error',
  'billing_error',
  'invalid_request_error',
  'not_found_error',
  'overloaded_error',
  'permission_error',
  'rate_limit_error',
  'timeout_error',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function safeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) ? (value as number) : undefined;
}

function safeCode(value: unknown): string | undefined {
  return typeof value === 'string' && PROVIDER_ERROR_CODES.has(value)
    ? value
    : undefined;
}
