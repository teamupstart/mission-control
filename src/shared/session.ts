// Shared session-bucketing logic, used by BOTH the server's roundup report
// (src/server/report.ts) and the client's report panel (src/web) so the two can
// never disagree about who "needs you". Keep this in sync conceptually with the
// card's `stateDisplay` in src/web/lib/format.ts (same attention precedence).

import type { PaneDialog, Session, Task } from "./types.ts";
import { byPriorityThenAge } from "./task.ts";
import { canInterrupt, capabilitiesFor } from "./harness-capabilities.ts";
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
    session.state !== "stopping" &&
    capabilitiesFor(session.agent).permissionModes?.liveControl.kind === "cycle" &&
    canWriteTo(session)
  );
}

/**
 * Whether Ctrl+C can stop what this session is doing right now.
 *
 * Two facts, and both are needed. The harness/runtime pair must have a mechanism
 * (`canInterrupt`), and there must be a turn to stop: interrupting an idle agent is a key
 * that does nothing, and the honest presentation of that is a disabled control saying so
 * rather than a live one that appears to have failed.
 *
 * `canCycleMode`'s job, for the other live control - the ONE gate the keydown handler, the
 * board overview's in-place arm and the ActionBar button share, so a tile, a card and the
 * bar can never disagree about when the stop is offered.
 *
 * Reads the RAW lifecycle state through `agentActive` rather than its confidence, which is
 * deliberate: a session whose state was never confirmed presents as running and is presumed
 * to be working, and refusing to interrupt exactly the sessions we know least about would
 * strand the case the gesture exists for. An interrupt aimed at a driver that has already
 * finished is a no-op both drivers document tolerating.
 */
export function canInterruptSession(session: Session): boolean {
  return agentActive(session) && canInterrupt(session.agent, session.runtime);
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
 * The activity line when it describes something happening RIGHT NOW, or null.
 *
 * `activity` is written on every lifecycle event, not only the busy ones, so the field
 * outlives the work it described: once a session settles it holds a status label -
 * `"idle"`, `"ended (logout)"` - that the state badge beside it already carries, and a
 * surface that animates it would be animating a session that is not moving. `instrumented`
 * is the freshness half of the same problem: when a terminal session's hooks lapse past
 * the overlay TTL the passive poller refreshes `state` from the transcript and leaves
 * `activity` at its stale overlay value, so only a current push channel makes the label
 * worth drawing as live.
 *
 * Established by the board tile's ticker and now shared with the conversation's
 * in-progress row, because the two would otherwise carry a copy each of a rule whose
 * every conjunct is load-bearing and none of which is obvious from the field name.
 */
export function liveActivity(s: Session): string | null {
  if (!s.instrumented || !agentActive(s)) return null;
  return s.activity ?? null;
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
  return s.state === "exited" || s.state === "stopping" ? null : s.paneDialog;
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

/** Rotate a 32-bit word left, the primitive SHA-1 uses in every round. */
function rotateLeft(word: number, bits: number): number {
  return ((word << bits) | (word >>> (32 - bits))) >>> 0;
}

/**
 * SHA-1 as a browser-safe pure function.
 *
 * This is not a security boundary. It preserves the compact marker already persisted on
 * Foreman notes while letting the browser verify that a note and an open dialog name the
 * same ask. Using Web Crypto would make the check asynchronous, and keeping Node's
 * `createHash` in the server would leave the two sides with separate marker algorithms.
 */
export function sha1Hex(input: string): string {
  const source = new TextEncoder().encode(input);
  const paddedLength = Math.ceil((source.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(source);
  bytes[source.length] = 0x80;

  const view = new DataView(bytes.buffer);
  const bitLength = source.length * 8;
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const words = new Uint32Array(80);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) words[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 80; i += 1) {
      words[i] = rotateLeft(words[i - 3]! ^ words[i - 8]! ^ words[i - 14]! ^ words[i - 16]!, 1);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i += 1) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const next = (rotateLeft(a, 5) + f + e + k + words[i]!) >>> 0;
      e = d;
      d = c;
      c = rotateLeft(b, 30);
      b = a;
      a = next;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  return [h0, h1, h2, h3, h4].map((word) => word.toString(16).padStart(8, "0")).join("");
}

/**
 * The stable marker for the ask represented by a pane or driver dialog.
 *
 * Shared by the daemon that writes the note and the browser that decides whether the
 * note is optional context for the open form. The SHA-1 prefix is an existing persisted
 * shape, so changing it would strand live notes and make Foreman judge the same ask twice.
 *
 * Digested rather than carried whole because a marker is only ever compared for equality,
 * and `dialogIdentity` is a JSON blob of every row's number and label.
 *
 * Three callers now have to arrive at the SAME string from different ends. `classifyPending`
 * mints it when Foreman first faces the ask; the answer routes rebuild it to find the note
 * pinned on an ask a human has just answered themselves (`retireNoteAnsweredByYou`); and the
 * dashboard rebuilds it again to decide whether the open form already owns this note. A
 * second spelling would silently retire nothing - the note would still be there, and the miss
 * would look like the original bug.
 */
export function dialogMarker(dialog: PaneDialog): string {
  return `dialog:${sha1Hex(dialogIdentity(dialog)).slice(0, 12)}`;
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
  // Accepted shutdown is unavailable, not idle. Keeping it in the working bucket prevents
  // Foreman from selecting a driver the supervisor has already closed to new sends while
  // its final event stream drains into the ordinary eviction path.
  if (s.state === "stopping") return "working";
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
