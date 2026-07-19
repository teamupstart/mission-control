// The alert engine: turn session state transitions into notifications. Pure and
// unit-tested - callers just deliver what this produces. Reuses the shared
// bucketing so "who needs you" matches the report exactly.
//
// Lives in shared/ because away mode made the daemon a consumer too: the stall
// detector runs server-side (sessionEqual excludes lastActivity from the SSE
// change comparison, so the client cannot see a session go quiet), and the away
// buffer folds these same alerts into the return digest.
//
// DETECTION IS UNCONDITIONAL. This engine used to take an `afk` flag and emit the
// informational kinds only when it was set, which is backwards: it made away mode
// *louder* than being at the desk. Detection now always reports everything that
// happened, and DELIVERY decides what is worth interrupting for (see
// deliverable/bufferable below). That inversion is the whole point of away mode.

import type { Session, Task } from "./types.ts";
import { gateParked, reportBucket } from "./session.ts";
import { wrapupAskCopy } from "./queue.ts";
import type { Stall } from "./stall.ts";

export type AlertKind =
  | "needs-input"
  | "review"
  | "gate"
  | "task-done"
  | "task-failed"
  | "idle"
  | "stuck"
  | "foreman";
export type AlertSeverity = "attention" | "info";

export interface Alert {
  /** Stable per (kind, subject) so a repeat replaces its toast via the Notification tag. */
  id: string;
  kind: AlertKind;
  title: string;
  body: string;
  sessionId: string | null;
  severity: AlertSeverity;
}

export interface AlertScope {
  sessions: Session[];
  tasks: Task[];
  /**
   * Currently-stalled sessions, from the daemon's stall detector. Optional because
   * nothing but the daemon can COMPUTE it - the elapsed-time signal never reaches
   * the client, which fetches the result instead (see useStalls) - so a scope built
   * before that read lands simply carries no stalls and emits no `stuck` alerts.
   */
  stalls?: Stall[];
}

/**
 * Whether an alert is worth interrupting a human for, even mid-coffee.
 *
 * Attention alerts mean something is BLOCKED on you and will not proceed until you
 * act; info alerts are things that happened and can wait for the digest. Away mode
 * delivers the former and buffers the latter.
 */
export function deliverable(a: Alert): boolean {
  return a.severity === "attention";
}

/** The complement: what accumulates into the return digest rather than notifying. */
export function bufferable(a: Alert): boolean {
  return !deliverable(a);
}

function sessionLabel(s: Session): string {
  return s.task?.title || s.name || "a session";
}

/**
 * The baseline `next` should be diffed against, given that stalls arrive on their
 * own channel and may land after the one the rest of the scope came in on.
 *
 * An absent `stalls` means NOT READ YET, which is not the same as read-and-empty -
 * and the difference decides whether a stall is news. Without this, the dashboard
 * would re-announce every already-stuck session on page load whenever the SSE
 * snapshot won its race against the stalls fetch (and stay quiet when it lost),
 * making a "looks stuck" notification a coin flip on every refresh. Absent stalls
 * are therefore adopted into the baseline rather than read as N new stalls, which is
 * exactly what the snapshot does for every other alert kind.
 */
export function withKnownStalls(prev: AlertScope, next: AlertScope): AlertScope {
  if (prev.stalls !== undefined || next.stalls === undefined) return prev;
  return { ...prev, stalls: next.stalls };
}

/** Stalls keyed for edge-triggering, so a stall that persists doesn't re-alert. */
function stallKeys(scope: AlertScope): Set<string> {
  return new Set((scope.stalls ?? []).map((x) => `${x.sessionId}:${x.kind}`));
}

/**
 * The alert one stall implies, whether or not it is new.
 *
 * Split out because the away watcher re-derives it every tick to refresh the wording
 * already sitting in the buffer (see refreshAlerts): a stall alerts ONCE, so without
 * a second reading the digest would describe it in the words it had when the
 * threshold tripped. Deriving both from here means the refreshed line and the alert
 * that announced it can never diverge.
 */
export function stuckAlert(st: Stall, sessions: Session[]): Alert {
  const s = sessions.find((x) => x.id === st.sessionId);
  return {
    id: `stuck:${st.sessionId}:${st.kind}`,
    kind: "stuck",
    title: `${s ? sessionLabel(s) : "a session"} looks stuck`,
    body: st.reason,
    sessionId: st.sessionId,
    severity: "attention",
  };
}

/**
 * The NEW alerts implied by the transition prev -> next. Each attention cause is
 * detected from session FIELDS directly (not the coarse bucket or a reason string),
 * edge-triggered per cause - so a review landing on a session that's already
 * awaiting input still alerts, and the alert kind can't drift from wording changes.
 */
export function detectAlerts(prev: AlertScope, next: AlertScope): Alert[] {
  const alerts: Alert[] = [];
  const prevSessions = new Map(prev.sessions.map((s) => [s.id, s]));

  for (const s of next.sessions) {
    const before = prevSessions.get(s.id);
    const label = sessionLabel(s);

    // needs-input: the agent is blocked on you (awaiting input or a review decision).
    const blocked = (st: Session["state"]) => st === "awaiting_input" || st === "awaiting_review";
    if (blocked(s.state) && !(before && blocked(before.state))) {
      alerts.push({
        id: `input:${s.id}`,
        kind: "needs-input",
        title: `${label} needs you`,
        body: s.state === "awaiting_review" ? "needs review" : "needs input",
        sessionId: s.id,
        severity: "attention",
      });
    }

    // review: a review item landed (pending count rose from zero).
    if (s.pendingReviews > 0 && (before?.pendingReviews ?? 0) === 0) {
      alerts.push({
        id: `review:${s.id}`,
        kind: "review",
        title: `${label} needs review`,
        body: s.pendingReviews > 1 ? `${s.pendingReviews} to review` : "to review",
        sessionId: s.id,
        severity: "attention",
      });
    }

    // gate: a no-mistakes run parked awaiting a decision.
    if (gateParked(s) && !(before && gateParked(before))) {
      alerts.push({
        id: `gate:${s.id}`,
        kind: "gate",
        title: `${label} - gate parked`,
        body: `gate parked at ${s.nomistakes?.gateStep ?? "a gate"}`,
        sessionId: s.id,
        severity: "attention",
      });
    }

    // foreman: the auto-responder handed a decision back to you (a design fork or
    // a risky ask it declined to answer). Edge-triggered on the note flipping to
    // escalated, so it fires once when Foreman escalates.
    if (s.note?.disposition === "escalated" && before?.note?.disposition !== "escalated") {
      alerts.push({
        id: `foreman:${s.id}`,
        kind: "foreman",
        title: `${label} - Foreman needs your call`,
        body: s.note.lastAction ?? "a decision was escalated to you",
        sessionId: s.id,
        severity: "attention",
      });
    }

    // queue: an item Foreman was driving needs you (it escalated), or the batch
    // drained and it's asking whether to ship. Read from the ITEM state rather
    // than overloading the note to get this for free: the note is triage's record
    // for a prompt episode, and a queue write there would skew its tallies.
    const esc = s.queue?.escalatedCount ?? 0;
    if (esc > (before?.queue?.escalatedCount ?? 0)) {
      alerts.push({
        id: `queue:${s.id}`,
        kind: "foreman",
        title: `${label} - Foreman is stuck on a queued item`,
        body: "an item couldn't be finished and needs you",
        sessionId: s.id,
        severity: "attention",
      });
    }
    // Which trigger raised this decides the wording, and the answer is the row itself:
    // the `prompted` trigger fires only on a checkout with NO queued work, so a
    // zero-item row is a wrap-up about a prompt, not about a batch. `wrapupAskCopy` is
    // the same call the Ship it? card makes, so the toast and the card it points at
    // cannot describe the same ask two different ways.
    if (s.queue?.wrapupAskedAt && !before?.queue?.wrapupAskedAt) {
      alerts.push({
        id: `wrapup:${s.id}`,
        kind: "foreman",
        title: `${label} - ${wrapupAskCopy(s.queue.totalCount > 0).alert}`,
        body: "ship it? Foreman is waiting on you",
        sessionId: s.id,
        severity: "attention",
      });
    }

    // idle: finished a burst of work and is now waiting. Informational - it means
    // something FINISHED, which is digest material rather than an interruption.
    if (before && reportBucket(s) === "idle" && reportBucket(before) === "working") {
      alerts.push({
        id: `idle:${s.id}`,
        kind: "idle",
        title: `${label} went idle`,
        // `activity` is the last hook one-liner, which on a Stop is literally
        // "idle" - so using it unconditionally yields "X went idle - idle", which
        // adds nothing and reads as noise in the digest (and, fed to the digest
        // model, as though nothing happened at all).
        body: s.activity && s.activity !== "idle" ? s.activity : "",
        sessionId: s.id,
        severity: "info",
      });
    }
  }

  // stuck: the stall detector newly flagged this session. Edge-triggered on
  // (session, kind) so a stall that persists across polls alerts once, not every
  // tick - and a session whose stall CHANGES kind (went quiet, then escalated)
  // legitimately alerts again, because that is new information.
  const before = stallKeys(prev);
  for (const st of next.stalls ?? []) {
    if (before.has(`${st.sessionId}:${st.kind}`)) continue;
    alerts.push(stuckAlert(st, next.sessions));
  }

  const prevTasks = new Map(prev.tasks.map((t) => [t.id, t]));
  for (const t of next.tasks) {
    const beforeTask = prevTasks.get(t.id);
    if (t.status === "failed" && beforeTask?.status !== "failed") {
      alerts.push({
        id: `failed:${t.id}`,
        kind: "task-failed",
        title: `Task failed: ${t.title}`,
        body: t.error ?? "dispatch failed",
        sessionId: t.sessionId,
        severity: "attention",
      });
    } else if (t.status === "done" && beforeTask?.status !== "done") {
      alerts.push({
        id: `done:${t.id}`,
        kind: "task-done",
        title: `Task done: ${t.title}`,
        body: t.outcome ?? "completed",
        sessionId: t.sessionId,
        severity: "info",
      });
    }
  }

  return alerts;
}

/** Compact one-line summary of several alerts, for the reconnect catch-up toast. */
export function summarizeAlerts(alerts: Alert[]): string {
  const titles = alerts.map((a) => a.title);
  const shown = titles.slice(0, 3).join(" · ");
  return titles.length > 3 ? `${shown} · +${titles.length - 3} more` : shown;
}

/** The most urgent severity in a batch - an "attention" alert must not be masked. */
export function batchSeverity(alerts: Alert[]): AlertSeverity {
  return alerts.some((a) => a.severity === "attention") ? "attention" : "info";
}

/** Whether anything is worth reporting, so a quiet digest can be skipped. */
export function hasReportable(scope: AlertScope): boolean {
  for (const s of scope.sessions) if (reportBucket(s) !== "exited") return true;
  return scope.tasks.some((t) => t.status === "backlog");
}

/** Compact scope digest, e.g. "2 need you · 3 working · 1 idle · 1 in backlog". */
export function digestLine(scope: AlertScope): string {
  let needsYou = 0;
  let working = 0;
  let idle = 0;
  for (const s of scope.sessions) {
    const b = reportBucket(s);
    if (b === "needs-you") needsYou++;
    else if (b === "working") working++;
    else if (b === "idle") idle++;
  }
  const backlog = scope.tasks.filter((t) => t.status === "backlog").length;
  const parts = [`${needsYou} need you`, `${working} working`, `${idle} idle`];
  if (backlog > 0) parts.push(`${backlog} in backlog`);
  const stuck = (scope.stalls ?? []).length;
  if (stuck > 0) parts.push(`${stuck} stuck`);
  return parts.join(" · ");
}
