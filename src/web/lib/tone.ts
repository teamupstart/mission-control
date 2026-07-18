import type { Session } from "@shared/types.ts";
import { stateDisplay, type Tone } from "./format.ts";

/**
 * Sort priority: things needing you first, then busy, then calm, then unconfirmed
 * (uninstrumented "running"), then gone.
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
 * Every group is returned even when empty: the board draws a column per state, and
 * a column that vanishes when it empties would make the board's shape jump around
 * as sessions move - the empty "needs you" column IS the information.
 */
export function groupByTone(sessions: readonly Session[]): ToneGroup[] {
  const groups: ToneGroup[] = TONE_GROUPS.map((g) => ({ ...g, sessions: [] }));
  const byTone = new Map(groups.map((g) => [g.tone, g]));
  for (const s of sessions) byTone.get(stateDisplay(s).tone)?.sessions.push(s);
  return groups;
}
