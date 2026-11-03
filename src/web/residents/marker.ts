import type { CSSProperties } from "react";
import {
  residentMarker,
  type ResidentMarker,
  type ResidentLoopStatus,
  type ResidentMarkerColorId,
  type ResidentProfile,
  type ResidentRunSummary,
} from "@shared/residents.ts";
import type { Session, Task } from "@shared/types.ts";

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
  loop?: ResidentLoopStatus & Pick<ResidentRunSummary, "compaction">;
  runId: string;
  /** The task the run launched, so a control can name it - Restart's completion prompt does. */
  taskId: string;
  profileId: string;
  /** Null when the run launched without a Persona. */
  personaName: string | null;
  /**
   * The profile's current revision when it is newer than the pinned one, else null. Read only to
   * say "profile changed since launch"; nothing the run draws or does follows it.
   */
  changedTo: number | null;
  /** The pinned revision's Control other sessions: whether this run asks for session control. */
  controlOtherSessions: boolean;
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

/**
 * Where a replaced session's replacement stands: `live` once its run and session both exist,
 * `starting` while the run is launching or its session has not appeared, `stopped` when a
 * replacement was reserved but no live run of it remains, and `not-started` when Restart ended
 * this run but its launch failed before reserving any replacement at all.
 */
export type ResidentReplacementState = "live" | "starting" | "stopped" | "not-started";

/**
 * A session whose resident run was replaced through Restart on new profile. The run has ended,
 * so the session has no `ResidentSessionMark`, but its task is still open: completing it is the
 * operator's call, and this is what the Console offers it from - for as long as the task stays
 * open, whatever happens to the replacement meanwhile.
 */
export interface ResidentReplacement {
  /** The replacement run's pinned name while it is live, else the replaced session's own. */
  name: string;
  /** The revision the replacement pinned; null when Restart reserved no replacement. */
  revision: number | null;
  /** The replacement's marker colour while its run is live; null otherwise. */
  colorId: ResidentMarkerColorId | null;
  state: ResidentReplacementState;
  /** The replacement's session, set only when `state` is `live`. */
  sessionId: string | null;
}

/**
 * Join each still-open session to the Restart that ended its run. Read from the task's durable
 * `residentRestart` record, not from the replacement's live run, because that run can end or
 * fail while the replaced task is still waiting to be completed.
 */
export function residentReplacementsBySession(
  sessions: readonly Session[],
  tasks: readonly Task[],
  runs: readonly ResidentRunSummary[],
): ReadonlyMap<string, ResidentReplacement> {
  const out = new Map<string, ResidentReplacement>();
  const restarted = new Map(tasks.filter((task) => task.status === "running" && task.residentRestart)
    .map((task) => [task.id, task.residentRestart!]));
  if (restarted.size === 0) return out;
  for (const session of sessions) {
    const restart = session.task?.status === "running" ? restarted.get(session.task.id) : undefined;
    if (!restart) continue;
    const replacementTaskId = restart.replacementTaskId;
    const run = replacementTaskId ? runs.find((candidate) => candidate.taskId === replacementTaskId) : undefined;
    const replacementSession = run ? sessions.find((candidate) => candidate.task?.id === replacementTaskId) : undefined;
    out.set(session.id, {
      name: run?.settings.identity.name ?? session.name,
      revision: restart.revision,
      colorId: run ? residentMarker(run.settings).colorId : null,
      state: replacementTaskId === null ? "not-started" : !run ? "stopped" : replacementSession ? "live" : "starting",
      sessionId: replacementSession?.id ?? null,
    });
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
    taskId: run.taskId,
    loop: run,
    profileId: run.profileId,
    name: run.settings.identity.name,
    personaName: run.personaName,
    ...marker,
    revision: run.profileRevision,
    changedTo: profile && profile.revision > run.profileRevision ? profile.revision : null,
    controlOtherSessions: run.settings.authority.controlOtherSessions,
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
