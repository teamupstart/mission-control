import type { Session } from "@shared/types.ts";
import { stateDisplay, type Tone } from "./format.ts";

/**
 * Sort priority: things needing you first, then busy, then calm, then unconfirmed
 * (no fresh lifecycle reading), then gone.
 *
 * The grid spends this on a sort you can't see - the cards just come out in an
 * order. The console and the board spend it on structure you can: rail sections
 * and columns. Same ranking either way, so a session can never sit in a different
 * place depending on which layout you happen to be in.
 */
export const TONE_ORDER: Record<Tone, number> = {
  attention: 0,
  working: 1,
  idle: 2,
  neutral: 3,
  exited: 4,
};

/** Display order + heading for the layouts that group by tone. */
export const TONE_GROUPS: { tone: Tone; label: string }[] = [
  { tone: "attention", label: "needs you" },
  { tone: "working", label: "working" },
  { tone: "idle", label: "idle" },
  { tone: "neutral", label: "unconfirmed" },
  { tone: "exited", label: "gone" },
];

export interface ToneGroup {
  tone: Tone;
  label: string;
  sessions: Session[];
}

/**
 * The sessions split into their tone groups, in TONE_GROUPS order, preserving the
 * order they arrive in within each group.
 *
 * Every group is returned even when empty. That is NOT the same as every group being
 * drawn - the board hides most empty columns (see `boardColumnModes`) - but the
 * decision of what to do with an empty group belongs to the view, and one consumer
 * needs them all regardless: App derives the board's arrow-key columns from this, and
 * `moveSelection` relies on the indices lining up with the tone order whether or not
 * a column happens to be on screen.
 *
 */
export function groupByTone(
  sessions: readonly Session[],
  toneFor: (session: Session) => Tone = (session) => stateDisplay(session).tone,
): ToneGroup[] {
  const groups: ToneGroup[] = TONE_GROUPS.map((g) => ({ ...g, sessions: [] }));
  const byTone = new Map(groups.map((g) => [g.tone, g]));
  for (const s of sessions) {
    byTone.get(toneFor(s))?.sessions.push(s);
  }
  return groups;
}

/** What the board does with one tone column, given how full it is. */
export type ColumnMode =
  /** Has sessions in it: an ordinary column. */
  | "sessions"
  /** Empty and stowed in the rail; the board doesn't render it at all. */
  | "stashed"
  /** Empty, but pulled back out of the rail by the operator. */
  | "revealed";

/**
 * How each column is treated, given what's in it and what the operator has revealed.
 *
 * Pulled out of BoardView because it's the one genuinely rule-bound part of the
 * board's shape, and the rules are the sort that read as obviously right while being
 * wrong in exactly one state (a drill-in, a dispatch whose session does not exist yet).
 * Pure, so those states can be asserted without a dashboard.
 *
 * Every tone follows the same rule, "needs you" included: an empty column is stashed.
 * Horizontal room on the board is scarce, and a slim placeholder for an empty column
 * spends it on a column with nothing in it.
 *
 * `focused` is the tone of the drill-in rail while a session is open, else null. During the
 * drill-in NOTHING is stashed, because the morph animates every column's width and they must
 * all stay mounted across it. An empty column that is itself the rail is drawn as a revealed
 * column - its head and "Nothing here" - like any other. See BoardView.
 */
export function boardColumnModes<Id extends string>(
  /**
   * The Board's columns by id, each with every session it draws: a tone column, or the Blocked
   * column (`FleetColumn`). A Needs you column holding a Blocked lane counts the lane's sessions
   * too, so it is drawn while either lane has a card and stashed only when both are empty.
   */
  columns: readonly { id: Id; sessions: readonly unknown[] }[],
  revealed: ReadonlySet<Id>,
  focused: Id | null,
  /** Provisioning tasks whose placeholders live in the Working column. */
  pending = 0,
): Map<Id, ColumnMode> {
  const out = new Map<Id, ColumnMode>();
  for (const c of columns) {
    if (c.sessions.length > 0) out.set(c.id, "sessions");
    else if (c.id === "working" && pending > 0) out.set(c.id, "sessions");
    else if (revealed.has(c.id) || focused !== null) out.set(c.id, "revealed");
    else out.set(c.id, "stashed");
  }
  return out;
}

/**
 * The Backlog column's treatment, by the same rule as the tone columns: drawn while it has
 * cards, stashed when it has none, and pulled back out by the operator or by a drill-in.
 *
 * Hiding it costs no drop target. A Backlog card can only be dragged out of the Backlog
 * itself, so an empty Backlog has nothing that could be dropped into it, and a new task
 * arrives through the dispatch dialog, which brings the column straight back.
 */
export function backlogColumnMode(
  count: number,
  revealed: boolean,
  focused: boolean,
): ColumnMode {
  if (count > 0) return "sessions";
  if (revealed || focused) return "revealed";
  return "stashed";
}
