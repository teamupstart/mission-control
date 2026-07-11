// The alert engine: turn fleet state transitions into notifications. Pure and
// unit-tested - the hook (useNotifier) just delivers what this produces. Reuses
// the shared bucketing so "who needs you" matches the report exactly.

import type { Session, Task } from "@shared/types.ts";
import { needsYouReason, reportBucket } from "@shared/session.ts";

export type AlertKind = "needs-input" | "review" | "gate" | "task-done" | "task-failed" | "idle";
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

function kindFromReason(reason: string): AlertKind {
  // Check gate first - "gate parked at review" contains both words.
  if (/gate/i.test(reason)) return "gate";
  if (/review/i.test(reason)) return "review";
  return "needs-input";
}

/**
 * The NEW alerts implied by the transition prev -> next. Fires on the edge into an
 * attention state (not every tick a session sits there), so a waiting session
 * alerts once. In AFK mode it also reports sessions going idle and tasks finishing.
 */
export function detectAlerts(prev: Fleet, next: Fleet, settings: AlertSettings): Alert[] {
  const alerts: Alert[] = [];
  const prevSessions = new Map(prev.sessions.map((s) => [s.id, s]));

  for (const s of next.sessions) {
    const before = prevSessions.get(s.id);
    const beforeBucket = before ? reportBucket(before) : "exited";
    const nowBucket = reportBucket(s);

    if (nowBucket === "needs-you" && beforeBucket !== "needs-you") {
      const reason = needsYouReason(s) ?? "needs you";
      alerts.push({
        id: `needs:${s.id}`,
        kind: kindFromReason(reason),
        title: `${sessionLabel(s)} needs you`,
        body: reason,
        sessionId: s.id,
        severity: "attention",
      });
    } else if (settings.afk && nowBucket === "idle" && beforeBucket === "working") {
      alerts.push({
        id: `idle:${s.id}`,
        kind: "idle",
        title: `${sessionLabel(s)} went idle`,
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

/** The most urgent severity in a batch - an "attention" alert must not be masked. */
export function batchSeverity(alerts: Alert[]): AlertSeverity {
  return alerts.some((a) => a.severity === "attention") ? "attention" : "info";
}

/** Whether the fleet has anything worth reporting, so a quiet digest can be skipped. */
export function hasReportable(fleet: Fleet): boolean {
  for (const s of fleet.sessions) if (reportBucket(s) !== "exited") return true;
  return fleet.tasks.some((t) => t.status === "queued");
}

/** Compact fleet digest, e.g. "2 need you · 3 working · 1 idle · 1 queued". */
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
  const queued = fleet.tasks.filter((t) => t.status === "queued").length;
  const parts = [`${needsYou} need you`, `${working} working`, `${idle} idle`];
  if (queued > 0) parts.push(`${queued} queued`);
  return parts.join(" · ");
}
