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

/**
 * True while the agent is (or is presumed to be) actively driving its own work,
 * so it will answer a parked no-mistakes gate itself rather than waiting on you.
 * A hook-instrumented session is active in `starting`/`working`; an
 * uninstrumented session only ever reports `working` while alive, so we treat it
 * as active crew too (same "can't prove it's waiting" stance as reportBucket).
 */
export function agentActive(s: Session): boolean {
  return s.state === "starting" || s.state === "working";
}

/** True while a no-mistakes run is parked at a gate, awaiting the agent's decision. */
function gatePending(s: Session): boolean {
  return Boolean(s.nomistakes && (s.nomistakes.awaitingAgent || s.nomistakes.gateStep));
}

/**
 * Two sessions are driving the *same* no-mistakes run. Keyed on the run itself
 * (its branch), not on cwd+branch: several terminals share one checkout on one
 * branch yet each may be driving a different run (or none), so a shared cwd is
 * not proof of a shared run. The registry attributes a run only to the sessions
 * that actually launched or own it, so both carrying a summary on the same
 * branch is the precise "same run" signal.
 */
function sameRun(a: Session, b: Session): boolean {
  return Boolean(a.nomistakes && b.nomistakes && a.nomistakes.branch === b.nomistakes.branch);
}

/**
 * True when a no-mistakes run parked on `s` *needs you* - i.e. waiting on a human
 * decision, not on the agent.
 *
 * `axi` is the agent-facing interface: a parked gate reports `awaiting_agent`
 * because it's waiting for the agent's `axi respond`, which the `/no-mistakes`
 * skill issues autonomously while the session works. Surfacing every parked gate
 * as "needs you" nags you for decisions the skill self-resolves.
 *
 * One run can be driven by more than one session - the launcher plus a dispatched
 * crewmate checked out on its branch - so it's still being driven as long as ANY
 * session carrying that same run (see sameRun) is active; the agent behind that
 * one will answer the gate. Only once they've all stopped does it need you. Pass
 * `fleet` (all live sessions) for that cross-session check; it defaults to `s`
 * alone, which reduces to "parked and this agent has stopped".
 */
export function gateParked(s: Session, fleet: Session[] = [s]): boolean {
  if (!gatePending(s)) return false;
  if (agentActive(s)) return false; // this agent is driving its own gate
  for (const o of fleet) {
    if (o.state !== "exited" && sameRun(o, s) && agentActive(o)) return false; // a sibling is driving it
  }
  return true;
}

/**
 * Which report section a session belongs to. Mirrors the card's badge precedence:
 * a pending review or a parked gate always means "needs you", regardless of the
 * agent's own reported state; an uninstrumented ("running") session counts as
 * active crew rather than idle, since we can't prove it's waiting. `fleet` lets a
 * parked gate defer to a same-run session that's still driving it (see gateParked).
 */
export function reportBucket(s: Session, fleet: Session[] = [s]): ReportBucket {
  if (s.state === "exited") return "exited";
  if (s.pendingReviews > 0) return "needs-you";
  if (gateParked(s, fleet)) return "needs-you";
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
export function needsYouReason(s: Session, fleet: Session[] = [s]): string | null {
  if (s.pendingReviews > 0) return s.pendingReviews > 1 ? `${s.pendingReviews} to review` : "to review";
  if (s.state === "awaiting_input") return "needs input";
  if (s.state === "awaiting_review") return "needs review";
  if (gateParked(s, fleet)) return `gate parked at ${s.nomistakes?.gateStep ?? "a gate"}`;
  return null;
}
