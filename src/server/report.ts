import type { FleetReport, ReportItem, Session, Task } from "@shared/types.ts";
import {
  RECENT_TASKS_CAP,
  backlogTasks,
  finishedTasks,
  needsYouReason,
  reportBucket,
} from "@shared/session.ts";

/**
 * Project the live registry snapshot into a fleet report - the `/bearings`
 * analog. Pure over its input (pass `now` for deterministic tests). Buckets
 * sessions with the SAME shared logic the UI uses, joins each to its dispatched
 * task for intent + branch, and folds tasks into a backlog + recent-outcomes list.
 */
export function buildReport(
  snap: { sessions: Session[]; tasks: Task[] },
  now: number = Date.now(),
): FleetReport {
  const taskById = new Map(snap.tasks.map((t) => [t.id, t]));

  const toItem = (s: Session, reason = ""): ReportItem => {
    const task = s.task ? taskById.get(s.task.id) : undefined;
    return {
      sessionId: s.id,
      name: s.name,
      kind: s.task?.kind ?? null,
      branch: s.gitBranch ?? task?.branch ?? null,
      activity: s.activity,
      reason,
      taskTitle: s.task?.title ?? null,
      outcome: s.task?.outcome ?? null,
      outcomeUrl: s.task?.outcomeUrl ?? null,
    };
  };

  const needsYou: ReportItem[] = [];
  const working: ReportItem[] = [];
  const idle: ReportItem[] = [];
  let exited = 0;

  for (const s of snap.sessions) {
    const bucket = reportBucket(s, snap.sessions);
    if (bucket === "exited") {
      exited++;
      continue;
    }
    if (bucket === "needs-you") needsYou.push(toItem(s, needsYouReason(s, snap.sessions) ?? "needs you"));
    else if (bucket === "idle") idle.push(toItem(s));
    else working.push(toItem(s));
  }

  const backlog = backlogTasks(snap.tasks);
  const finished = finishedTasks(snap.tasks);
  const recent = finished.slice(0, RECENT_TASKS_CAP);

  return {
    generatedAt: now,
    counts: {
      sessions: snap.sessions.length - exited,
      working: working.length,
      idle: idle.length,
      needsYou: needsYou.length,
      exited,
      backlog: backlog.length,
    },
    needsYou,
    working,
    idle,
    backlog,
    recent,
    recentTruncated: finished.length > recent.length,
  };
}

/** Render a report as a compact, copy-pasteable markdown digest ("current bearings"). */
export function renderReportMarkdown(r: FleetReport): string {
  const stamp = new Date(r.generatedAt).toISOString().slice(0, 16).replace("T", " ");
  const lines: string[] = [`# Fleet bearings - ${stamp}`];

  const branch = (b: string | null) => (b ? `  [${b}]` : "");
  const kind = (k: ReportItem["kind"]) => (k ? ` (${k})` : "");
  const named = (i: ReportItem) => (i.taskTitle ? `"${i.taskTitle}"` : i.name);

  lines.push("", `Needs you (${r.needsYou.length})`);
  for (const i of r.needsYou) lines.push(`- ${named(i)}${kind(i.kind)} - ${i.reason}${branch(i.branch)}`);

  lines.push("", `Working (${r.working.length})`);
  for (const i of r.working) {
    const act = i.activity ? ` - ${i.activity}` : "";
    lines.push(`- ${named(i)}${kind(i.kind)}${act}${branch(i.branch)}`);
  }

  lines.push("", `Idle (${r.idle.length})`);
  for (const i of r.idle) lines.push(`- ${named(i)}${kind(i.kind)}${branch(i.branch)}`);

  lines.push("", `Backlog (${r.backlog.length})`);
  for (const t of r.backlog) lines.push(`- "${t.title}" (${t.kind}) - ${t.repoRoot}`);

  lines.push("", `Recent outcomes (${r.recent.length}${r.recentTruncated ? "+" : ""})`);
  for (const t of r.recent) {
    const tail = t.outcome ? ` - ${t.outcome}` : t.error ? ` - ${t.error}` : "";
    lines.push(`- "${t.title}" ${t.status}${tail}`);
  }
  if (r.recentTruncated) lines.push(`  (older outcomes omitted)`);

  return lines.join("\n") + "\n";
}
