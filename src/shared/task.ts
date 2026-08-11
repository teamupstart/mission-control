// Priority and label vocabulary for dispatched tasks, shared by the server (route
// validation, the roundup report, task sources) and the web app (the dispatch form,
// the board's backlog column, the roundup panel) so the two can never disagree about
// what a label is or which task outranks which.
//
// Both fields are OPTIONAL and default to nothing: `priority: null` and `labels: []`.
// Nothing in the product infers either one - a task carries a priority because a human
// or a task source said so, never because we guessed from its text.

import type { Session, Task, TaskKind, TaskPriority } from "./types.ts";

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

/** What a session's task pill has left to say once the constants and duplicates are dropped. */
export interface TaskPillParts {
  /**
   * The kind badge, or null when the kind is the one every writer defaults to. Absence
   * means `ship` unambiguously: `kind` is `NOT NULL`, so the pill only exists when there
   * is a task, and a task always has a kind.
   */
  kind: TaskKind | null;
  /** The task's title, or null when the session's own name already carries it. */
  title: string | null;
  /**
   * True when nothing the pill hosts on EVERY surface has anything to say - no kind
   * badge, no title, no outcome and no schedule origin.
   *
   * The pill is not an empty frame: it has a background, a border and a tone-coloured
   * left edge, so drawing one with nothing in it is a bar of chrome that says less than
   * nothing. That is the common case now that the two text parts above went conditional -
   * an ordinary running `ship` task on a session named after it - so the reduction is not
   * finished until the container goes with them.
   *
   * A surface that draws something of its OWN inside the pill has to say so: the card
   * adds a `dispatching…` / `failed` word that the console detail does not, and it ORs
   * that in at the point it draws it rather than being asserted here.
   *
   * `repoPrs` is deliberately NOT one of the operands, and it is the one a reader will
   * reach for. A multi-repo task's per-repo pull-request list is a SIBLING row, not
   * pill content - it is a separate row precisely because it is as wide as the repo
   * count while the pill's outcome link is pinned right - and it gates itself on being
   * non-empty. Folding it in here would draw a pill with nothing in it above that row,
   * which was measured in a browser: the pill hugs its content on a card, so an empty
   * one is a 14px stub rather than a bar, and the row reads better with nothing above it
   * than with that. The row is self-describing (each chip names its repo and its PR
   * state) and it still sits under the session's own title.
   */
  silent: boolean;
}

/** A session with no task at all: nothing to draw, and no pill either. */
const NO_PILL: TaskPillParts = { kind: null, title: null, silent: true };

/**
 * What the task pill should draw for a session.
 *
 * Both parts are usually silent, and for different reasons. `TaskKind` has two values and
 * every automated writer defaults to `ship` - the MCP `create_task` tool cannot even
 * produce a `scout` - so a badge rendered unconditionally reads `SHIP` in almost every
 * session, is not colour-differentiated in the console header, is frozen once the task
 * leaves `backlog`, and repeats the chip on the card you clicked through. Only `scout`
 * says anything, so only `scout` is drawn.
 *
 * The title is a duplicate because `dispatcher.ts` names a dispatched session after its
 * task, so the pill usually repeats the `h2` two rows above it. It is NOT always a
 * duplicate, which is why this is a comparison rather than a deletion: a session
 * re-assigned to a later task keeps the first task's title as its name, and the pill is
 * then the only place the task now executing appears (`test/task-multi-session.test.ts`).
 *
 * Shared rather than inlined at each call site because a session is drawn by four
 * components: the console detail and the card both render this pill, and a rule applied
 * to one of them would look right in one layout and wrong in the other.
 */
export function taskPillParts(session: Pick<Session, "name" | "task">): TaskPillParts {
  const task = session.task;
  if (!task) return NO_PILL;
  const kind = task.kind === "scout" ? task.kind : null;
  const title = task.title === session.name ? null : task.title;
  return {
    kind,
    title,
    // `scheduleId` rather than a call into `ScheduleOriginChip`: this module is browser-safe
    // shared logic and cannot import a component, and the chip's own gate is that one field
    // (`scheduleProvenance`). `task-pill.test.ts` pins the two answering together.
    silent: !kind && !title && !task.outcome && !task.scheduleId,
  };
}
