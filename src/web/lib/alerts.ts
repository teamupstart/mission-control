// The alert engine: turn fleet state transitions into notifications. Pure and
// unit-tested - the hook (useNotifier) just delivers what this produces. Reuses
// the shared bucketing so "who needs you" matches the report exactly.

import type { Session, Task } from "@shared/types.ts";
import { gateParked, reportBucket } from "@shared/session.ts";

export type AlertKind =
  | "needs-input"
  | "review"
  | "gate"
  | "task-done"
  | "task-failed"
  | "idle"
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

export interface AlertSettings {
  notifications: boolean;
  sound: boolean;
  /** Away mode: alert on everything (idle, task-done) and send periodic digests. */
  afk: boolean;
  digestMinutes: number;
}

export interface Fleet {
  sessions: Session[];
  tasks: Task[];
}

function sessionLabel(s: Session): string {
  return s.task?.title || s.name || "a session";
}

/**
 * The NEW alerts implied by the transition prev -> next. Each attention cause is
 * detected from session FIELDS directly (not the coarse bucket or a reason string),
 * edge-triggered per cause - so a review landing on a session that's already
 * awaiting input still alerts, and the alert kind can't drift from wording changes.
 * In AFK mode it also reports sessions going idle and tasks finishing.
 */
export function detectAlerts(prev: Fleet, next: Fleet, settings: AlertSettings): Alert[] {
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
    if (s.queue?.wrapupAskedAt && !before?.queue?.wrapupAskedAt) {
      alerts.push({
        id: `wrapup:${s.id}`,
        kind: "foreman",
        title: `${label} - the work queue drained`,
        body: "ship it? Foreman is waiting on you",
        sessionId: s.id,
        severity: "attention",
      });
    }

    // idle (AFK): finished a burst of work and is now waiting.
    if (
      settings.afk &&
      before &&
      reportBucket(s) === "idle" &&
      reportBucket(before) === "working"
    ) {
      alerts.push({
        id: `idle:${s.id}`,
        kind: "idle",
        title: `${label} went idle`,
        body: s.activity ?? "idle",
        sessionId: s.id,
        severity: "info",
      });
    }
  }

  const prevTasks = new Map(prev.tasks.map((t) => [t.id, t]));
  for (const t of next.tasks) {
    const before = prevTasks.get(t.id);
    if (t.status === "failed" && before?.status !== "failed") {
      alerts.push({
        id: `failed:${t.id}`,
        kind: "task-failed",
        title: `Task failed: ${t.title}`,
        body: t.error ?? "dispatch failed",
        sessionId: t.sessionId,
        severity: "attention",
      });
    } else if (settings.afk && t.status === "done" && before?.status !== "done") {
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

/** Whether the fleet has anything worth reporting, so a quiet digest can be skipped. */
export function hasReportable(fleet: Fleet): boolean {
  for (const s of fleet.sessions) if (reportBucket(s) !== "exited") return true;
  return fleet.tasks.some((t) => t.status === "backlog");
}

/** Compact fleet digest, e.g. "2 need you · 3 working · 1 idle · 1 in backlog". */
export function digestLine(fleet: Fleet): string {
  let needsYou = 0;
  let working = 0;
  let idle = 0;
  for (const s of fleet.sessions) {
    const b = reportBucket(s);
    if (b === "needs-you") needsYou++;
    else if (b === "working") working++;
    else if (b === "idle") idle++;
  }
  const backlog = fleet.tasks.filter((t) => t.status === "backlog").length;
  const parts = [`${needsYou} need you`, `${working} working`, `${idle} idle`];
  if (backlog > 0) parts.push(`${backlog} in backlog`);
  return parts.join(" · ");
}
