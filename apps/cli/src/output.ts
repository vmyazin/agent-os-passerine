function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
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

export function renderResult(value: unknown, json: boolean): string {
  if (json) return `${JSON.stringify(canonical(value))}\n`;
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
    return `${Object.entries(value)
      .map(([key, entry]) => `${key}: ${display(entry)}`)
      .join('\n')}\n`;
  }
  return `${display(value)}\n`;
}
