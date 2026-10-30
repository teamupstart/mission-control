import type { CSSProperties } from "react";
import {
  residentMarker,
  type ResidentMarker,
  type ResidentMarkerColorId,
  type ResidentProfile,
  type ResidentRunSummary,
} from "@shared/residents.ts";
import type { Session } from "@shared/types.ts";

/**
 * What a resident's label chip draws, and nothing more: the name it is called, the revision the
 * marker comes from, and the marker itself. A profile in the dock and a running session both
 * have one; only a session is a `ResidentSessionMark`.
 */
export interface ResidentChipMark extends ResidentMarker {
  name: string;
  /** The revision the marker was read from: a run's pinned one, or a profile's current one. */
  revision: number;
}

/**
 * Everything a board surface draws for a resident's session: its marker and pin from the run's
 * PINNED revision, and whether the profile has moved on since.
 *
 * Joined here rather than added to `Session`: a session does not know it is a resident, its
 * task does, and the run that launched the task carries the settings. One join, in App, handed
 * to every layout - so the card, the rail row, the Console band and the column order read the
 * same answer.
 */
export interface ResidentSessionMark extends ResidentChipMark {
  runId: string;
  profileId: string;
  personaName: string;
  /**
   * The profile's current revision when it is newer than the pinned one, else null. Read only to
   * say "profile changed since launch"; nothing the run draws or does follows it.
   */
  changedTo: number | null;
}

/**
 * Join each session to its live resident run through the session's task id. Sessions that are
 * not residents are absent, so a fleet with none gets an empty map.
 */
export function residentMarksBySession(
  sessions: readonly Session[],
  runs: readonly ResidentRunSummary[],
  profiles: readonly ResidentProfile[],
): ReadonlyMap<string, ResidentSessionMark> {
  const out = new Map<string, ResidentSessionMark>();
  if (runs.length === 0) return out;
  const runByTask = new Map(runs.map((run) => [run.taskId, run]));
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  for (const session of sessions) {
    const taskId = session.task?.id;
    const run = taskId ? runByTask.get(taskId) : undefined;
    if (!run) continue;
    out.set(session.id, residentSessionMark(run, profileById.get(run.profileId) ?? null));
  }
  return out;
}

export function residentSessionMark(
  run: ResidentRunSummary,
  profile: ResidentProfile | null,
): ResidentSessionMark {
  const marker = residentMarker(run.settings);
  return {
    runId: run.id,
    profileId: run.profileId,
    name: run.settings.identity.name,
    personaName: run.personaName,
    ...marker,
    revision: run.profileRevision,
    changedTo: profile && profile.revision > run.profileRevision ? profile.revision : null,
  };
}

/**
 * The marker a profile's CURRENT revision would launch with - for the dock's profile list. A
 * chip mark, not a session mark: a profile has no run, persona snapshot or pinned revision.
 */
export function residentProfileMark(profile: ResidentProfile): ResidentChipMark {
  return { name: profile.name, ...residentMarker(profile.settings), revision: profile.revision };
}

/** The sessions that sort first in their column: residents whose pinned revision pins them. */
export function pinnedResidentSessions(
  marks: ReadonlyMap<string, ResidentSessionMark> | undefined,
): ReadonlySet<string> {
  const pinned = new Set<string>();
  for (const [sessionId, mark] of marks ?? []) if (mark.pin) pinned.add(sessionId);
  return pinned;
}

/**
 * A marker color as the inline `--resident` custom property, the way `kindAccentStyle` hands a
 * task kind its `--kind`. The value is always a palette token, never a raw color.
 */
export function residentAccentStyle(colorId: ResidentMarkerColorId): CSSProperties {
  return { "--resident": `var(--resident-${colorId})` } as CSSProperties;
}

/** The hover sentence for any resident chip: who it is, from which revision, and the pin. */
export function residentChipTitle(mark: ResidentChipMark): string {
  const pinned = mark.pin ? ", pinned to the top of its column" : "";
  return `Resident ${mark.name} (revision ${mark.revision})${pinned}.`;
}

/** A running resident's sentence: the chip's, plus whether its profile has moved on since launch. */
export function residentMarkTitle(mark: ResidentSessionMark): string {
  const changed = mark.changedTo !== null
    ? ` Its profile has changed since launch (now revision ${mark.changedTo}).`
    : "";
  return `${residentChipTitle(mark)}${changed}`;
}
