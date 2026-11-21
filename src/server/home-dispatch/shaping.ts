import type { Task } from "@shared/types.ts";

// Owner: P4. Task shaping's state for an inbox item (spec v20, 7.7, D60): the "Shaping context"
// wait (up to 10 s) and the "Context degraded" marker the dashboard shows for a task. The inbox
// carries it as the optional `shaping { state, summary }` so the pane and `mctl get tasks` show the
// same thing; the pane draws the marker (P12).

/** What an item's `shaping` field holds. */
export interface InboxShaping {
  state: string;
  summary: string;
}

/**
 * The shaping state of a task, or undefined when there is nothing to show.
 *
 * STUB until task-shaping Phase 2 merges: `src/shared/shaping.ts` and its `currentShaping(task)`
 * are not on `main` yet, so every task answers undefined and no item carries the field. When that
 * phase lands, this body becomes `const s = currentShaping(task); return s ? { state: s.state,
 * summary: s.summary } : undefined;` and nothing that calls it changes.
 */
export function shapingFor(_task: Task): InboxShaping | undefined {
  return undefined;
}
