import { canonicalJsonValue } from '@agentos/core';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

function display(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(canonical(value));
  return String(value);
}

function table(rows: readonly Record<string, unknown>[]): string {
  if (rows.length === 0) return 'No results.\n';
  const preferred = ['id', 'status', 'pipeline', 'projectId', 'createdAt'];
  const available = new Set(rows.flatMap((row) => Object.keys(row)));
  const columns = [
    ...preferred.filter((key) => available.has(key)),
    ...[...available].filter((key) => !preferred.includes(key)).sort(),
  ].slice(0, 6);
  const widths = columns.map((column) =>
    Math.min(
      48,
      Math.max(
        column.length,
        ...rows.map((row) => display(row[column]).length),
      ),
    ),
  );
  const line = (row: Record<string, unknown>) =>
    columns
      .map((column, index) => {
        const width = widths[index] ?? 0;
        return display(row[column]).slice(0, width).padEnd(width);
      })
      .join('  ')
      .trimEnd();
  const header = Object.fromEntries(
    columns.map((column) => [
      column,
      column.replace(/[A-Z]/g, (letter) => ` ${letter}`).toUpperCase(),
    ]),
  );
  return `${line(header)}\n${rows.map(line).join('\n')}\n`;
}

function goalLines(
  value: Record<string, unknown>,
): readonly string[] | undefined {
  const goal = value.goal;
  if (goal === null || typeof goal !== 'object' || Array.isArray(goal))
    return undefined;
  const source = goal as Record<string, unknown>;
  if (
    typeof source.currentStep !== 'number' ||
    typeof source.maxSteps !== 'number' ||
    !Array.isArray(source.criteria) ||
    !Array.isArray(source.latestResults) ||
    !Array.isArray(source.children)
  )
    return undefined;
  const results = new Map<string, Record<string, unknown>>();
  for (const result of source.latestResults) {
    if (result === null || typeof result !== 'object' || Array.isArray(result))
      continue;
    const candidate = result as Record<string, unknown>;
    if (typeof candidate.criterionId === 'string')
      results.set(candidate.criterionId, candidate);
  }
  const lines = [
    `Goal step: ${String(source.currentStep)}/${String(source.maxSteps)}`,
  ];
  for (const criterion of source.criteria) {
    if (
      criterion === null ||
      typeof criterion !== 'object' ||
      Array.isArray(criterion)
    )
      continue;
    const candidate = criterion as Record<string, unknown>;
    if (typeof candidate.id !== 'string') continue;
    const result = results.get(candidate.id);
    const status =
      typeof result?.status === 'string' ? result.status : 'pending';
    const code = typeof result?.code === 'string' ? ` (${result.code})` : '';
    const label =
      typeof candidate.description === 'string'
        ? candidate.description
        : candidate.id;
    lines.push(`${label}: ${status}${code}`);
  }
  for (const child of source.children) {
    if (child === null || typeof child !== 'object' || Array.isArray(child))
      continue;
    const candidate = child as Record<string, unknown>;
    if (
      typeof candidate.step !== 'number' ||
      typeof candidate.runId !== 'string'
    )
      continue;
    const status =
      typeof candidate.status === 'string' ? ` (${candidate.status})` : '';
    lines.push(
      `Attempt ${String(candidate.step)}: ${candidate.runId}${status}`,
    );
  }
  return lines;
}

export function renderResult(value: unknown, json: boolean): string {
  if (json) return `${canonicalJsonValue(value)}\n`;
  if (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        entry !== null && typeof entry === 'object' && !Array.isArray(entry),
    )
  ) {
    return table(value as Record<string, unknown>[]);
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    const goal = goalLines(object);
    const base = Object.entries(object)
      .filter(([key]) => key !== 'goal')
      .map(([key, entry]) => `${key}: ${display(entry)}`)
      .join('\n');
    return `${[base, ...(goal ?? [])].filter(Boolean).join('\n')}\n`;
  }
  return `${display(value)}\n`;
}
