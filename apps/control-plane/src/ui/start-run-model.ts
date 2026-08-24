// src/ui/start-run-model.ts
export interface CriterionDraft {
  readonly description: string;
  readonly command: string;
}

/**
 * The criteria a draft would actually submit.
 *
 * A blank row is a row the operator has not filled in yet, not a criterion:
 * sending it fails the schema, and the operator sees "request did not match
 * the schema" next to a form that looks complete. Ids are numbered over the
 * kept rows so they stay unique and contiguous after the blanks are dropped.
 */
export function submittableCriteria(
  drafts: readonly CriterionDraft[],
): readonly {
  readonly id: string;
  readonly type: 'command';
  readonly description: string;
  readonly command: string;
}[] {
  return drafts
    .filter(
      (draft) => draft.description.trim() !== '' && draft.command.trim() !== '',
    )
    .map((draft, index) => ({
      id: `criterion-${String(index + 1)}`,
      type: 'command' as const,
      description: draft.description.trim(),
      command: draft.command,
    }));
}
