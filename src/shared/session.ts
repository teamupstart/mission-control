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
 * True while the agent is (or is presumed to be) actively driving its own work.
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
  return JSON.stringify([
    dialog.prompt ?? "",
    dialog.options.map((o) => [o.number, o.label]),
    ...(dialog.source === "driver" ? [dialog.requestId ?? ""] : []),
  ]);
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

/**
 * True when a session is genuinely parked and its work has settled.
 *
 * Shared rather than Foreman-owned because the daemon asks the identical question: the
 * Workflow resumption observer only picks a parked repair round back up once the agent it
 * typed the packet into has actually stopped, and two spellings of "settled" would mean the
 * Foreman and the daemon disagreeing about whether an agent is still typing.
 *
 * The gate is `state === "idle"`, and that is enough on its own because `state` is
 * only ever `idle` from a REAL source - a fresh hook overlay, or the transcript-
 * derived passive state. The base rebuild default is `working`, so nothing sets
 * `idle` without evidence: an `idle` here is always a claim someone made, never an
 * absence of data. (This is the distinction `reportBucket` can't make, where `idle`
 * is also its catch-all for an uninstrumented session - so don't be tempted to gate
 * this on the bucket instead.)
 *
 * We used to also require `instrumented` (a fresh hook within 30 min). That was
 * redundant while hooks were the only source of `idle`, and became WRONG once the
 * transcript became a second source: it gated out exactly the hook-free idle this
 * predicate now exists to honour, stranding the queue of any session whose hooks
 * lapsed or whose daemon had just restarted. `instrumented` stays a real field for
 * the UI badge and `reportBucket`; it is simply not what settled-idle turns on.
 *
 * The `settleMs` age absorbs hook reordering (hooks are independent HTTP posts, so
 * a PostToolUse can land after a Stop and briefly un-idle the session) and covers
 * the pause between turns of a multi-turn flow. It stays a PARAMETER: the Foreman's
 * window is its own config (`FOREMAN_QUEUE_SETTLE_MS`) and every other caller passes
 * whatever its own subsystem decided, so nothing here has to know about either.
 */
export function settledIdle(s: Session, now: number, settleMs: number): boolean {
  if (s.state !== "idle") return false;
  const since = s.lastActivity ?? s.firstSeen;
  return now - since >= settleMs;
}

/**
 * Which report section a session belongs to:
 *  - needs-you: prompting you through a pending review, visible menu, or explicit
 *    awaiting-input/review state.
 *  - working: an agent we can *confirm* is running. That takes a fresh lifecycle
 *    reading from hooks or an explicit transcript marker; a session without one
 *    reports no live state, so we don't claim it is busy.
 *  - idle: open but not prompting you and not confirmed running - sessions whose
 *    lifecycle source reports idle, plus sessions with no fresh state.
 */
export function reportBucket(s: Session, _sessions: Session[] = [s]): ReportBucket {
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
  if (s.stateConfirmed) {
    if (s.state === "awaiting_input" || s.state === "awaiting_review") return "needs-you";
    if (s.state === "starting" || s.state === "working") return "working";
  }
  return "idle"; // confirmed idle, or open without confirmed busy evidence
}

/** A one-line reason a session needs you, or null when it doesn't. */
export function needsYouReason(s: Session, _sessions: Session[] = [s]): string | null {
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
  return null;
}
