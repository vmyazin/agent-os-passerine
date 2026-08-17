export const DEFAULT_LIST_LIMIT = 100;
export const MAX_LIST_LIMIT = 100;

export function boundedListLimit(requested?: number): number {
  if (requested === undefined) return DEFAULT_LIST_LIMIT;
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    throw new TypeError('list limit must be a positive safe integer');
  }
  return Math.min(requested, MAX_LIST_LIMIT);
}
