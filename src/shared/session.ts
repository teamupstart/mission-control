// Shared session-bucketing logic, used by BOTH the server's fleet report
// (src/server/report.ts) and the client's report panel (src/web) so the two can
// never disagree about who "needs you". Keep this in sync conceptually with the
// card's `stateDisplay` in src/web/lib/format.ts (same attention precedence).

import type { Session, Task } from "./types.ts";

export type ReportBucket = "needs-you" | "working" | "idle" | "exited";

// ---- task list projections (shared by server report + web panel, single source) ----

/** How many finished tasks the report surfaces. */
export const RECENT_TASKS_CAP = 20;

/** Backlog: queued tasks, oldest first. */
export function queuedTasks(tasks: Task[]): Task[] {
  return tasks.filter((t) => t.status === "queued").sort((a, b) => a.createdAt - b.createdAt);
}

/** Finished tasks (done/failed/cancelled), newest first. Caller slices to RECENT_TASKS_CAP. */
export function finishedTasks(tasks: Task[]): Task[] {
  return tasks
    .filter((t) => t.status === "done" || t.status === "failed" || t.status === "cancelled")
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** True when a no-mistakes run is parked waiting on a decision for this session. */
export function gateParked(s: Session): boolean {
  return Boolean(s.nomistakes && (s.nomistakes.awaitingAgent || s.nomistakes.gateStep));
}

/**
 * Which report section a session belongs to. Mirrors the card's badge precedence:
 * a pending review or a parked gate always means "needs you", regardless of the
 * agent's own reported state; an uninstrumented ("running") session counts as
 * active crew rather than idle, since we can't prove it's waiting.
 */
export function reportBucket(s: Session): ReportBucket {
  if (s.state === "exited") return "exited";
  if (s.pendingReviews > 0) return "needs-you";
  if (gateParked(s)) return "needs-you";
  if (!s.instrumented) return "working";
  switch (s.state) {
    case "awaiting_input":
    case "awaiting_review":
      return "needs-you";
    case "idle":
      return "idle";
    default:
      return "working"; // starting / working
  }
}

/** A one-line reason a session needs you, or null when it doesn't. */
export function needsYouReason(s: Session): string | null {
  if (s.pendingReviews > 0) return s.pendingReviews > 1 ? `${s.pendingReviews} to review` : "to review";
  if (s.state === "awaiting_input") return "needs input";
  if (s.state === "awaiting_review") return "needs review";
  if (gateParked(s)) return `gate parked at ${s.nomistakes?.gateStep ?? "a gate"}`;
  return null;
}
