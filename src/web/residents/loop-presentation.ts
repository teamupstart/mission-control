import { residentAwakeAt, residentSleepingUntil, residentWakeOpeningLabel } from "@shared/resident-schedule.ts";
import type { ResidentLoopStatus, ResidentRunSummary } from "@shared/residents.ts";
import { reportBucket } from "@shared/session.ts";
import type { Session } from "@shared/types.ts";
import type { ResidentControlAction } from "./api.ts";
import type { ResidentSessionMark } from "./marker.ts";

export type ResidentLoopDetails = ResidentLoopStatus & Partial<Pick<ResidentRunSummary, "compaction" | "settings">>;

export const RESIDENT_LOOP_CONTROLS_LABEL = "Resident controls";

/** The same status text feeds the card and the fleet filter. */
export function residentLoopPresentation(loop: ResidentLoopDetails, session: Session | null | undefined, now: number, activeHours: boolean) {
  const held = loop.loopState !== "paused" && session != null && reportBucket(session) === "needs-you";
  // A wake can be held until the next window while the resident is still awake in this one.
  const waiting = !held && loop.loopState === "waiting";
  const heldUntil = waiting ? residentSleepingUntil(loop.settings?.schedule, loop.nextWakeAt, now, activeHours) : null;
  const asleep = waiting && !residentAwakeAt(loop.settings?.schedule, now, activeHours);
  const wakesAt = heldUntil ?? (asleep ? loop.nextWakeAt : null);
  const remaining = loop.nextWakeAt === null ? null : Math.max(0, Math.ceil((loop.nextWakeAt - now) / 1000));
  const label = held ? "waiting on you" : asleep ? "asleep" : loop.loopState;
  const iteration = `iteration ${loop.iteration}`;
  const next = held || remaining === null ? null
    : wakesAt !== null ? `wakes ${residentWakeOpeningLabel(wakesAt, now)}`
      : `next in ${remaining < 60 ? `${remaining}s` : `${Math.ceil(remaining / 60)}m`}`;
  const queued = loop.runRequestedAt === null ? null : "run queued";
  const reasons = [loop.pauseReason, loop.wakeReason].filter((reason): reason is string => !!reason);
  const compaction = loop.compaction && [
    { label: "Compaction before wakes", status: loop.compaction.betweenIterations ? "active" : "unavailable" },
    { label: "Native backstop", status: loop.compaction.nativeBackstop ? "active" : "unavailable" },
  ];
  return {
    tone: asleep ? "asleep" : loop.loopState,
    label, iteration, next, queued, reasons, compaction,
    summary: [label, iteration, next, queued, ...reasons].filter(Boolean).join(" · "),
    compactionSummary: compaction?.map(({ label, status }) => `${label}: ${status}.`).join(" "),
  };
}

export function residentLoopSearchFields(loop: ResidentLoopDetails, session: Session | null, now: number, activeHours: boolean): string[] {
  const { summary, compactionSummary } = residentLoopPresentation(loop, session, now, activeHours);
  return compactionSummary ? [summary, compactionSummary] : [summary];
}

export function residentLoopActions(mark: ResidentSessionMark): { label: string; action: ResidentControlAction }[] {
  if (!mark.loop) return [];
  const actions: { label: string; action: ResidentControlAction }[] = [
    mark.loop.loopState === "paused" ? { label: "Resume", action: "resume" } : { label: "Pause", action: "pause" },
    mark.loop.runRequestedAt === null ? { label: "Run now", action: "run-now" } : { label: "Cancel queued run", action: "cancel-run-now" },
  ];
  if (mark.changedTo !== null) actions.push({ label: "Restart on new profile", action: "restart" });
  return actions;
}
