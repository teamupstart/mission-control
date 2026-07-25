// Shared session-bucketing logic, used by BOTH the server's roundup report
// (src/server/report.ts) and the client's report panel (src/web) so the two can
// never disagree about who "needs you". Keep this in sync conceptually with the
// card's `stateDisplay` in src/web/lib/format.ts (same attention precedence).

import type { PaneDialog, Session, Task } from "./types.ts";
import { byPriorityThenAge } from "./task.ts";
import { capabilitiesFor } from "./harness-capabilities.ts";
import { canWriteTo } from "./pane.ts";

/**
 * Whether Shift+Tab can cycle this session's permission mode: a live session whose harness
 * exposes that cycle as its live control, with a pane to inject the keystroke into. The ONE
 * gate the shortcut (App's keydown and the CommandBar keycap) and the ActionBar button share,
 * so a board tile, a card and the bar can never disagree about when the cycle is offered - a
 * menu-driven permission control (`liveControl.kind !== "cycle"`) must never be sent a
 * keystroke its TUI reads as something else.
 */
export function canCycleMode(session: Session): boolean {
  return (
    session.state !== "exited" &&
    capabilitiesFor(session.agent).permissionModes?.liveControl.kind === "cycle" &&
    canWriteTo(session)
  );
}

export type ReportBucket = "needs-you" | "working" | "idle" | "exited";

// ---- task list projections (shared by server report + web panel, single source) ----

/** How many finished tasks the report surfaces. */
export const RECENT_TASKS_CAP = 20;

/**
 * Backlog: tasks not yet dispatched, most urgent first and oldest first within a
 * priority. An untriaged backlog is still oldest-first, because unset priority sorts
 * as one rank - see `byPriorityThenAge`.
 */
export function backlogTasks(tasks: Task[]): Task[] {
  return tasks.filter((t) => t.status === "backlog").sort(byPriorityThenAge);
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
 * This intentionally reads the raw lifecycle state rather than its confidence: a
 * confirmed hook or transcript reading may report `starting`/`working`, while the
 * unconfirmed discovery default also presumes `working` rather than claiming a human
 * must answer a gate.
 */
export function agentActive(s: Session): boolean {
  return s.state === "starting" || s.state === "working";
}

/**
 * The menu this session is parked on and can still be answered, or null.
 *
 * `paneDialog` outlives the pane it was read from: a session that vanishes is marked
 * `exited` field-by-field, so the last menu we saw rides along for the whole exit-linger
 * window. Every reader wants the same thing from that - nothing - so they ask here rather
 * than reading the field, which is what kept the buckets honest while the card still
 * offered buttons aimed at a dead pane.
 */
export function activePaneDialog(s: Session): PaneDialog | null {
  return s.state === "exited" ? null : s.paneDialog;
}

/**
 * What makes two reads of the pane the SAME question: the prompt and the rows offered.
 *
 * The dialog is re-parsed from the screen every poll, so object identity says nothing and
 * every consumer needs this same notion - the card to decide whether a failure message is
 * still about the menu it was raised on, the alerter to decide whether a menu is news.
 * `highlighted` is excluded on purpose: a cursor moving in the terminal is the same
 * question being read again, not a new one to re-announce. So is a row's `checked`, for a
 * reason of its own that this function must not undo - see `PaneOption.checked`.
 */
export function dialogIdentity(dialog: PaneDialog): string {
  return JSON.stringify([dialog.prompt ?? "", dialog.options.map((o) => [o.number, o.label])]);
}

/**
 * How a menu describes itself in one line. The count is what tells a permission prompt
 * (2-3 rows) from a question worth opening the card for. Shared so the wording lives in
 * one place while each caller keeps its own view of how a menu RANKS against other
 * reasons - which is not the same question, and the two disagree (see `needsYouReason`).
 */
export function paneDialogReason(dialog: PaneDialog): string {
  return `${dialog.options.length} options to pick from`;
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
export function gateParked(s: Session, sessions: readonly Session[] = [s]): boolean {
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
 *  - working: an agent we can *confirm* is running. That takes a fresh lifecycle
 *    reading (from hooks or an explicit transcript marker) or a live no-mistakes run
 *    the agent backgrounded (runInFlight); a session with neither reports no live
 *    state, so we don't claim it's busy.
 *  - idle: open but not prompting you and not confirmed running - sessions whose
 *    lifecycle source reports idle, plus sessions with no fresh state and no run in
 *    flight behind them.
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
  //
  // This also widens Foreman's `tickTargets` (src/server/foreman/queue-machine.ts), which
  // selects on this bucket, to sessions parked on a dialog it has not been told about by a
  // hook. That is deliberate: answering routine prompts is Foreman's job, a visible menu is
  // exactly the case it exists for, and `decideQueueTick` still escalates on `!hooksSeen`.
  if (activePaneDialog(s)) return "needs-you";
  if (gateParked(s, sessions)) return "needs-you";
  if (s.stateConfirmed) {
    if (s.state === "awaiting_input" || s.state === "awaiting_review") return "needs-you";
    if (s.state === "starting" || s.state === "working") return "working";
  }
  // Ranks below every state the hook stream can confirm, so a genuine "needs
  // input" still wins over a run churning in the background. A gate that needs
  // YOU already returned above, so this only claims the run is self-driving.
  if (runInFlight(s)) return "working";
  return "idle"; // confirmed idle, or open without confirmed busy evidence
}

/** A one-line reason a session needs you, or null when it doesn't. */
export function needsYouReason(s: Session, sessions: Session[] = [s]): string | null {
  if (s.pendingReviews > 0) return s.pendingReviews > 1 ? `${s.pendingReviews} to review` : "to review";
  // Ahead of `awaiting_input`, which is the same fact reported more vaguely: when we can
  // see the menu we can say how many ways out of it there are. Below `pendingReviews`
  // though - this ranks reasons for someone TRIAGING a board, where a review is the more
  // specific ask. An alerter announcing a menu the moment it opens ranks them the other
  // way round and so words itself from `paneDialogReason` directly.
  const dialog = activePaneDialog(s);
  if (dialog) return paneDialogReason(dialog);
  if (s.state === "awaiting_input") return "needs input";
  if (s.state === "awaiting_review") return "needs review";
  if (gateParked(s, sessions)) return `gate parked at ${s.nomistakes?.gateStep ?? "a gate"}`;
  return null;
}
