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
 * drawn - the board hides every empty column (see `boardColumnModes`) - but the
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
  /** Has a card in it: an ordinary column. */
  | "sessions"
  /** Empty: the board doesn't render it at all. */
  | "hidden";

/**
 * How each column is treated, given what's in it.
 *
 * Pulled out of BoardView because it's the one genuinely rule-bound part of the
 * board's shape, and the rules are the sort that read as obviously right while being
 * wrong in exactly one state (a dispatch whose session does not exist yet). Pure, so
 * those states can be asserted without a dashboard.
 *
 * Every tone follows the same rule, "needs you", "unconfirmed" and "gone" included: a
 * column exists for every tone, and it is drawn only while it has a card in it. An empty
 * column leaves no placeholder, chip, or slim rail behind - horizontal room on the board is
 * scarce, and anything drawn for an empty column spends it on nothing.
 *
 * That holds during a drill-in too. An empty column was not on the board before the session
 * opened, so there is no width to animate it away from; and when the open session's own
 * column is empty (a drawer resident, or a session a filter hides), no rail is drawn and
 * the detail takes the board, carrying its own way back. See BoardView.
 */
export function boardColumnModes(
  groups: readonly ToneGroup[],
  /** Provisioning tasks whose placeholders live in the Working column. */
  pending = 0,
): Map<Tone, ColumnMode> {
  const out = new Map<Tone, ColumnMode>();
  for (const g of groups) {
    if (g.sessions.length > 0) out.set(g.tone, "sessions");
    else if (g.tone === "working" && pending > 0) out.set(g.tone, "sessions");
    else out.set(g.tone, "hidden");
  }
  return out;
}

/**
 * The Backlog column's treatment, by the same rule as the tone columns: drawn while it has
 * cards, and not rendered at all when it has none.
 *
 * Hiding it costs no drop target. A Backlog card can only be dragged out of the Backlog
 * itself, so an empty Backlog has nothing that could be dropped into it, and a new task
 * arrives through the dispatch dialog, which brings the column straight back.
 */
export function backlogColumnMode(count: number): ColumnMode {
  return count > 0 ? "sessions" : "hidden";
}
