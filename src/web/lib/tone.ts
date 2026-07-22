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
 * `gateAlerts` is computed from the full fleet in App, even when `sessions` is the
 * filtered visible slice. A hidden sibling may still be driving the same no-mistakes
 * run, so recomputing from visible rows would turn filtering into a state change.
 */
export function groupByTone(
  sessions: readonly Session[],
  gateAlerts: ReadonlySet<string>,
): ToneGroup[] {
  const groups: ToneGroup[] = TONE_GROUPS.map((g) => ({ ...g, sessions: [] }));
  const byTone = new Map(groups.map((g) => [g.tone, g]));
  for (const s of sessions) {
    byTone.get(stateDisplay(s, gateAlerts.has(s.id)).tone)?.sessions.push(s);
  }
  return groups;
}

/** What the board does with one tone column, given how full it is. */
export type ColumnMode =
  /** Has sessions in it: an ordinary column. */
  | "sessions"
  /** Empty "needs you": kept, but narrowed, and reading as an all-clear. */
  | "calm"
  /** Empty and stowed in the rail; the board doesn't render it at all. */
  | "stashed"
  /** Empty, but pulled back out of the rail by the operator. */
  | "revealed";

/**
 * How each column is treated, given what's in it and what the operator has revealed.
 *
 * Pulled out of BoardView because it's the one genuinely rule-bound part of the
 * board's shape, and the rules are the sort that read as obviously right while being
 * wrong in exactly one state (a drill-in, an "attention" column that empties while
 * you're inside it). Pure, so those states can be asserted without a dashboard.
 *
 * `focused` is whether a session is open - during the drill-in NOTHING is stashed,
 * because the morph animates every column's width and they must all stay mounted
 * across it. See BoardView.
 */
export function boardColumnModes(
  groups: readonly ToneGroup[],
  revealed: ReadonlySet<Tone>,
  focused: boolean,
): Map<Tone, ColumnMode> {
  const out = new Map<Tone, ColumnMode>();
  for (const g of groups) {
    if (g.sessions.length > 0) out.set(g.tone, "sessions");
    else if (g.tone === "attention") out.set(g.tone, "calm");
    else if (revealed.has(g.tone) || focused) out.set(g.tone, "revealed");
    else out.set(g.tone, "stashed");
  }
  return out;
}
