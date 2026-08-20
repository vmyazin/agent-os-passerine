// apps/control-plane/src/ui/redact-configuration.ts

/**
 * `environments[].variables` is a free-form string map, so an operator can put
 * a credential in it. The configuration page renders an applied revision into
 * a browser session, while `GET /api/configuration` hands the same canonical
 * config only to CLI-token callers — so the values are masked before they
 * reach the page.
 */
export const REDACTED_VALUE = '[REDACTED]';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function redactConfigurationForDisplay(canonicalConfig: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonicalConfig);
  } catch {
    // Fail closed: input that cannot be parsed cannot be shown to be
    // secret-free, so it is never rendered verbatim.
    return '# configuration could not be rendered safely';
  }
  if (isRecord(parsed) && isRecord(parsed.environments)) {
    for (const environment of Object.values(parsed.environments)) {
      if (!isRecord(environment) || !isRecord(environment.variables)) continue;
      for (const key of Object.keys(environment.variables)) {
        environment.variables[key] = REDACTED_VALUE;
      }
    }
  }
  return JSON.stringify(parsed, null, 2);
}
