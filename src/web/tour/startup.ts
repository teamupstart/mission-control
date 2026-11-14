import { ANNOUNCED_TOURS } from "@shared/protocol.ts";
import type { TourId } from "./contracts.ts";

/** App's document-lifetime latch is settled only by an opening, a launch, or disabled startup. */
export function startupTourDecision(state: {
  handled: boolean;
  hydrated: boolean;
  enabled: boolean;
  /**
   * The profile is owed an announcement of a new tour. It opens the picker once even when the
   * saved preference is off: that opt-out was made about the catalog the operator had seen.
   */
  announcing: boolean;
  hasTours: boolean;
  busy: boolean;
}): "wait" | "settle" | "open" {
  if (state.handled || !state.hydrated) return "wait";
  if (!(state.enabled || state.announcing) || !state.hasTours) return "settle";
  return state.busy ? "wait" : "open";
}

/** `ANNOUNCED_TOURS`, held to the tour union: an id that names no tour fails to compile here. */
const ANNOUNCEMENTS: readonly TourId[] = ANNOUNCED_TOURS satisfies readonly TourId[];

/**
 * The tour the startup picker owes this profile an announcement of, or null.
 *
 * The newest one wins when several are owed, and only a tour the catalog actually offers can
 * be announced - a featured row the picker cannot draw would be an opening that says nothing.
 */
export function pendingTourAnnouncement(
  announced: readonly string[],
  available: readonly TourId[],
): TourId | null {
  for (let index = ANNOUNCEMENTS.length - 1; index >= 0; index -= 1) {
    const id = ANNOUNCEMENTS[index]!;
    if (!announced.includes(id) && available.includes(id)) return id;
  }
  return null;
}

/**
 * The record after a picker opening has announced what was owed: every announced tour seen.
 *
 * Owned whole by this one writer, like `trustStaged`, so the patch is the complete list. Ids
 * this build does not know - a tour a newer build announced - are kept, so a downgrade and
 * upgrade never announces the same tour twice.
 */
export function recordTourAnnouncements(announced: readonly string[]): string[] {
  return [...new Set([...announced, ...ANNOUNCEMENTS])];
}

/**
 * The record after an announced tour was dismissed midway: owed again, so the next window's
 * picker features it once more. A tour that is not announced, or not yet recorded, has nothing
 * to give back, and the same list is returned so the caller can skip the write.
 */
export function rearmTourAnnouncement(announced: readonly string[], id: TourId): readonly string[] {
  if (!ANNOUNCEMENTS.includes(id) || !announced.includes(id)) return announced;
  return announced.filter((candidate) => candidate !== id);
}

/**
 * The daemon's record with this browser's owed announcements taken back out of it: what the
 * startup picker reads when a midway dismissal could not be saved. Owed ids only ever make a
 * tour owed again; they never mark one as seen.
 */
export function withOwedAnnouncements(
  announced: readonly string[],
  owed: readonly string[],
): readonly string[] {
  return owed.length ? announced.filter((id) => !owed.includes(id)) : announced;
}
