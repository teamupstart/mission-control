import { WORKTREE_INVENTORY_LIMITS } from "@shared/worktrees.ts";

/** The most slots one bulk destroy may name; the request schema refuses one more. */
export const BULK_SELECTION_LIMIT = WORKTREE_INVENTORY_LIMITS.bulkSlots;

export interface SelectionChange {
  next: ReadonlySet<string>;
  /** Ids the operator asked to add that did not fit under the limit. */
  refused: number;
}

/**
 * Apply one tick, untick, or Select all to the bulk selection without ever exceeding the
 * limit. Adding is in the order given, so Select all fills the remaining room with the
 * pool's first slots and reports the rest as refused rather than building a request the
 * server can only reject. Removing is never limited.
 */
export function changeSelection(
  current: ReadonlySet<string>,
  slotIds: readonly string[],
  selected: boolean,
  limit: number = BULK_SELECTION_LIMIT,
): SelectionChange {
  const next = new Set(current);
  if (!selected) {
    for (const id of slotIds) next.delete(id);
    return { next, refused: 0 };
  }
  let refused = 0;
  for (const id of slotIds) {
    if (next.has(id)) continue;
    if (next.size >= limit) refused += 1;
    else next.add(id);
  }
  return { next, refused };
}
