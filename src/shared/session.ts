// Shared session-bucketing logic, used by BOTH the server's roundup report
// (src/server/report.ts) and the client's report panel (src/web) so the two can
// never disagree about who "needs you". Keep this in sync conceptually with the
// card's `stateDisplay` in src/web/lib/format.ts (same attention precedence).

import type { Session, Task } from "./types.ts";

export type ReportBucket = "needs-you" | "working" | "idle" | "exited";

// ---- task list projections (shared by server report + web panel, single source) ----

/** How many finished tasks the report surfaces. */
export const RECENT_TASKS_CAP = 20;

/** Backlog: tasks not yet dispatched, oldest first. */
export function backlogTasks(tasks: Task[]): Task[] {
  return tasks.filter((t) => t.status === "backlog").sort((a, b) => a.createdAt - b.createdAt);
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
 * as an active agent too (same "can't prove it's waiting" stance as reportBucket).
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
 * agent checked out on its branch - so it's still being driven as long as ANY
 * session carrying that same run (see sameRun) is active; the agent behind that
 * one will answer the gate. Only once they've all stopped does it need you. Pass
 * `sessions` (all live sessions) for that cross-session check; it defaults to `s`
 * alone, which reduces to "parked and this agent has stopped".
 */
export function gateParked(s: Session, sessions: Session[] = [s]): boolean {
  if (!gatePending(s)) return false;
  if (agentActive(s)) return false; // this agent is driving its own gate
  for (const o of sessions) {
    if (o.state !== "exited" && sameRun(o, s) && agentActive(o)) return false; // a sibling is driving it
  }
  return true;
}

/**
 * True while a no-mistakes run this session owns is actively *executing a step*.
 *
 * The agent can background the `axi run`/`axi respond` that drives the run and
 * end its turn. That reports `idle`, which is a true statement about the agent -
 * it isn't thinking or calling tools - but the run keeps going, and its
 * completion re-invokes the agent. So the session is committed to that work and
 * will resume on its own, with no human in the loop: not idle in the only sense
 * the dashboard's idle bucket means ("free, could take work").
 *
 * Executing excludes parked (see gatePending): `status` stays "running" while a
 * run sits at a gate, but a parked run is *waiting* on a decision, not working.
 * Whether that wait needs you is gateParked's call, and conflating the two here
 * would let a gate parked under a presumed-driving agent masquerade as confirmed
 * work.
 *
 * This clears the same bar as hook instrumentation rather than lowering it (see
 * reportBucket). The registry only attributes a run to a session whose *own*
 * agent process has a live `no-mistakes` descendant driving it (see
 * discovery/nomistakes-launch.ts), so this is a live process re-confirmed every
 * poll - stronger evidence than a hook, and it self-expires: when the driver
 * dies or the run ends, `status` stops reporting running and the session drops
 * back to idle on the next poll. Nothing can get stuck "working" forever.
 */
export function runInFlight(s: Session): boolean {
  return s.nomistakes?.status === "running" && !gatePending(s);
}

/**
 * Which report section a session belongs to:
 *  - needs-you: prompting you - a pending review, a parked gate that needs you,
 *    or the agent explicitly awaiting your input/review.
 *  - working: an agent we can *confirm* is running. That takes hook
 *    instrumentation (starting/working) or a live no-mistakes run the agent
 *    backgrounded (runInFlight); an uninstrumented session with neither reports
 *    no live state, so we don't claim it's busy.
 *  - idle: open but not prompting you and not confirmed running - instrumented
 *    sessions the agent has parked at idle, plus uninstrumented sessions with no
 *    run in flight behind them.
 *
 * `sessions` lets a parked gate defer to a same-run session that's still driving it
 * (see gateParked).
 */
export function reportBucket(s: Session, sessions: Session[] = [s]): ReportBucket {
  if (s.state === "exited") return "exited";
  if (s.pendingReviews > 0) return "needs-you";
  // A menu on the screen is DIRECT evidence the session has stopped and cannot move
  // until someone answers - and unlike the state checks below, it needs no hooks to see.
  // That gap is the whole reason this is here: an uninstrumented session parked on a
  // permission prompt has `state: "idle"` forever, so it reported as idle while being
  // the single most blocked thing on the board. Read off the pane every poll and cleared
  // the moment the menu closes, so nothing can get stuck here.
  if (s.paneDialog) return "needs-you";
  if (gateParked(s, sessions)) return "needs-you";
  if (s.instrumented) {
    if (s.state === "awaiting_input" || s.state === "awaiting_review") return "needs-you";
    if (s.state === "starting" || s.state === "working") return "working";
  }
  // Ranks below every state the hook stream can confirm, so a genuine "needs
  // input" still wins over a run churning in the background. A gate that needs
  // YOU already returned above, so this only claims the run is self-driving.
  if (runInFlight(s)) return "working";
  return "idle"; // instrumented-idle, or uninstrumented (open, not confirmed busy)
}

/** A one-line reason a session needs you, or null when it doesn't. */
export function needsYouReason(s: Session, sessions: Session[] = [s]): string | null {
  if (s.pendingReviews > 0) return s.pendingReviews > 1 ? `${s.pendingReviews} to review` : "to review";
  // Ahead of `awaiting_input`, which is the same fact reported more vaguely: when we can
  // see the menu we can say how many ways out of it there are, and the count is what tells
  // a permission prompt (2-3 rows) from a question worth opening the card for.
  if (s.paneDialog) return `${s.paneDialog.options.length} options to pick from`;
  if (s.state === "awaiting_input") return "needs input";
  if (s.state === "awaiting_review") return "needs review";
  if (gateParked(s, sessions)) return `gate parked at ${s.nomistakes?.gateStep ?? "a gate"}`;
  return null;
}
