// Priority and label vocabulary for dispatched tasks, shared by the server (route
// validation, the roundup report, task sources) and the web app (the dispatch form,
// the board's backlog column, the roundup panel) so the two can never disagree about
// what a label is or which task outranks which.
//
// Both fields are OPTIONAL and default to nothing: `priority: null` and `labels: []`.
// Nothing in the product infers either one - a task carries a priority because a human
// or a task source said so, never because we guessed from its text.

import type { Task, TaskPriority } from "./types.ts";

/**
 * The priorities, in ascending urgency. Array order is picker order, sort order, and
 * the order the README's table lists - one array so a fifth level is one edit.
 */
export const TASK_PRIORITIES = ["low", "med", "high", "blocker"] as const;

/** Human-facing label for each priority. Short, because these render inside a chip. */
export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: "Low",
  med: "Medium",
  high: "High",
  blocker: "Blocker",
};

/**
 * Sort rank, ascending. The interesting value is the one for *unset*, which sits
 * between `low` and `med` rather than at the bottom.
 *
 * Bottom would be the obvious choice and it is the wrong one: every task that exists
 * today is unset, so a single item somebody deliberately marked `low` would sort above
 * the entire backlog. Ranking unset just under `med` says the true thing instead -
 * `low` is an explicit demotion *below* the default, and everything above it is an
 * explicit promotion. A backlog nobody has triaged keeps the order it always had.
 */
const PRIORITY_RANK: Record<TaskPriority, number> = { low: 0, med: 2, high: 3, blocker: 4 };
const UNSET_RANK = 1;

/** Ascending rank for a task's priority, with unset landing between `low` and `med`. */
export function priorityRank(p: TaskPriority | null): number {
  return p == null ? UNSET_RANK : PRIORITY_RANK[p];
}

/** Longest a single label may be. Long enough for `type: needs-design`, short enough to chip. */
export const LABEL_MAX = 32;

/** How many labels one task may carry, so a sweep of a heavily-tagged issue can't flood a card. */
export const MAX_LABELS = 12;

/**
 * Clean a caller's labels into the canonical set stored on a task: trimmed, empties
 * dropped, deduped, capped.
 *
 * Dedupe is case-INSENSITIVE but the first spelling is what survives. Case-sensitive
 * dedupe would let `bug` and `Bug` both sit on one card as if they were different
 * tags, which is the bug this exists to prevent. Lowercasing everything would be
 * simpler and is deliberately not done: a task source maps an external system's tags
 * onto these, and GitHub labels like `Type: Bug` are authored with their case on
 * purpose - mangling them would make a swept task's labels stop matching the issue it
 * came from.
 */
export function normalizeLabels(raw: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const label = entry.trim().slice(0, LABEL_MAX);
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
    if (out.length >= MAX_LABELS) break;
  }
  return out;
}

/**
 * Order two tasks for the backlog: most urgent first, and oldest first within a
 * priority so a triaged batch still drains in the order it was authored.
 */
export function byPriorityThenAge(a: Task, b: Task): number {
  const rank = priorityRank(b.priority) - priorityRank(a.priority);
  return rank !== 0 ? rank : a.createdAt - b.createdAt;
}
