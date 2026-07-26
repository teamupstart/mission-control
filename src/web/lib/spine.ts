import type { ScheduleOccurrence, SchedulePreviewInstant } from "@shared/schedules.ts";

/**
 * How long a mission must have gone unclaimed before the rail BREAKS.
 *
 * Deliberately not `delayIsLate`'s one minute. That band decides whether a run wears a
 * "late" chip, which is a note about one run; a break is a much louder claim - that a due
 * instant remained unclaimed for this window - and spending it on two minutes of scheduler
 * latency is how a signature stops meaning anything. Fifteen minutes is past every
 * mechanical delay the local claim path produces (the tick interval and the overdue grace
 * are both well inside it) and short enough that a real sleep window always crosses it.
 *
 * A COALESCED fold breaks the rail regardless of this threshold: the ledger recording that
 * it folded instants away is direct evidence that they were missed, not a duration to judge.
 */
export const SPINE_GAP_MS = 15 * 60_000;

/**
 * The spine's row model: how a mission's occurrence ledger and its enumerated future become
 * one ordered time axis.
 *
 * Pure, and separate from the component, because this is the only part of the surface that
 * DERIVES anything. Everything else the spine draws was handed to it - the instants, the
 * statuses, the delays, the health - but where the rail BREAKS is a reading of the ledger,
 * and a reading is something that has to be checkable without a DOM.
 *
 * The rule it holds: **a gap is drawn from persisted facts only.** Windows are grouped by
 * their shared `claimedAt`, and each opens at the earliest `scheduledFor` in that claim.
 * The instants shown inside it are the ones the ledger itself says were represented by that
 * run (`coveredById`). Nothing here infers that the machine was asleep, off, or merely
 * stopped - the database does not record which, so no row may claim to know.
 *
 * Time reads DOWNWARD, oldest first, the same direction the transcript reads. History
 * arrives newest-first from the paged route, so the sort here is load-bearing rather than
 * cosmetic: reversed, every gap would be drawn against the run on the wrong side of it.
 */

export type SpineRow =
  | {
      kind: "gap";
      key: string;
      /** Earliest instant that came due unclaimed in this window. */
      from: number;
      /** When the run that ended the window was claimed. */
      to: number;
      /** Occurrences claimed together after waiting in this window. */
      waiting: ScheduleOccurrence[];
      /** Instants the ledger says this run represented. Empty is a legitimate answer. */
      missed: ScheduleOccurrence[];
    }
  | { kind: "past"; key: string; occurrence: ScheduleOccurrence }
  | { kind: "now"; key: string; at: number }
  | { kind: "future"; key: string; at: number; dstShift: boolean; collisions: string[] }
  | { kind: "stop"; key: string; reason: string };

export function buildSpineRows({
  occurrences,
  now,
  instants,
  stopReason,
  collisionsByInstant,
}: {
  occurrences: ScheduleOccurrence[];
  now: number;
  /** The daemon's enumerated future. Ignored entirely when `stopReason` is set. */
  instants: SchedulePreviewInstant[];
  /**
   * Why this mission has no future to draw - paused, archived, unreadable. A mission that
   * will not act on an instant must not be shown one, which is the whole reason this is a
   * reason string rather than an empty list: the row says WHY the axis stops.
   */
  stopReason: string | null;
  collisionsByInstant?: Map<number, string[]>;
}): SpineRow[] {
  const out: SpineRow[] = [];

  const past = [...occurrences].sort((a, b) => a.scheduledFor - b.scheduledFor);
  const foldedInto = new Map<string, ScheduleOccurrence[]>();
  for (const occurrence of past) {
    if (!occurrence.coveredById) continue;
    foldedInto.set(occurrence.coveredById, [
      ...(foldedInto.get(occurrence.coveredById) ?? []),
      occurrence,
    ]);
  }

  const gapByAnchor = new Map<
    string,
    { from: number; to: number; waiting: ScheduleOccurrence[]; missed: ScheduleOccurrence[] }
  >();
  const waitingByClaim = new Map<number, ScheduleOccurrence[]>();
  for (const occurrence of past) {
    if (occurrence.coveredById) continue;
    const missed = foldedInto.get(occurrence.id) ?? [];
    if (occurrence.delayMs < SPINE_GAP_MS && missed.length === 0) continue;
    waitingByClaim.set(occurrence.claimedAt, [
      ...(waitingByClaim.get(occurrence.claimedAt) ?? []),
      occurrence,
    ]);
  }
  for (const [claimedAt, waiting] of waitingByClaim) {
    const missed = waiting.flatMap((occurrence) => foldedInto.get(occurrence.id) ?? []);
    const anchor = waiting[0];
    if (!anchor) continue;
    gapByAnchor.set(anchor.id, {
      from: Math.min(
        ...waiting.map((occurrence) => occurrence.scheduledFor),
        ...missed.map((occurrence) => occurrence.scheduledFor),
      ),
      to: claimedAt,
      waiting,
      missed,
    });
  }

  for (const occurrence of past) {
    // A folded instant is not a run; it belongs inside the gap of the run that covered it.
    if (occurrence.coveredById) continue;
    const gap = gapByAnchor.get(occurrence.id);
    if (gap) {
      out.push({
        kind: "gap",
        key: `gap-${gap.to}`,
        ...gap,
      });
    }
    out.push({ kind: "past", key: occurrence.id, occurrence });
  }

  out.push({ kind: "now", key: "now", at: now });

  if (stopReason !== null) {
    out.push({ kind: "stop", key: "stop", reason: stopReason });
    return out;
  }
  for (const instant of instants) {
    // The daemon enumerates from its own clock; anything already behind ours belongs to the
    // history half or to nothing, never below the NOW marker.
    if (instant.at <= now) continue;
    out.push({
      kind: "future",
      key: `f-${instant.at}`,
      at: instant.at,
      dstShift: instant.dstShift,
      collisions: collisionsByInstant?.get(instant.at) ?? [],
    });
  }
  return out;
}
