import type { MissionReport, ReportItem, Session, Task } from "@shared/types.ts";
import {
  RECENT_TASKS_CAP,
  backlogTasks,
  finishedTasks,
  needsYouReason,
  reportBucket,
} from "@shared/session.ts";
import {
  pipelineCommissionAttentionEntries,
  type PipelineCommission,
  type PipelineRun,
} from "@shared/pipeline.ts";

/**
 * Project the live registry snapshot into a roundup report - the `/bearings`
 * analog. Pure over its input (pass `now` for deterministic tests). Buckets
 * sessions with the SAME shared logic the UI uses, joins each to its dispatched
 * task for intent + branch, and folds tasks into a backlog + recent-outcomes list.
 */
export function buildReport(
  snap: { sessions: Session[]; tasks: Task[]; pipelineCommissions?: PipelineCommission[]; pipelineRuns?: PipelineRun[] },
  now: number = Date.now(),
): MissionReport {
  const taskById = new Map(snap.tasks.map((t) => [t.id, t]));
  const pipelineAttentionEntries = pipelineCommissionAttentionEntries({
    commissions: snap.pipelineCommissions,
    tasks: snap.tasks,
    runs: snap.pipelineRuns,
    sessions: snap.sessions,
  });
  const pipelineAttentionByTask = new Map(pipelineAttentionEntries.flatMap(({ commission, attention }) =>
    attention ? [[commission.taskId, { commission, attention }] as const] : []));
  const pipelineAttentionByCommission = new Map(pipelineAttentionEntries.map((entry) =>
    [entry.commission.id, entry.attention] as const));

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
  const representedCommissions = new Set<string>();

  for (const s of snap.sessions) {
    const bucket = reportBucket(s, snap.sessions);
    if (bucket === "exited") {
      exited++;
      continue;
    }
    const pipeline = s.task ? pipelineAttentionByTask.get(s.task.id) : null;
    if (pipeline) {
      representedCommissions.add(pipeline.commission.id);
      needsYou.push(toItem(s, `${pipeline.attention.title}: ${pipeline.attention.detail}`));
    } else if (bucket === "needs-you") needsYou.push(toItem(s, needsYouReason(s, snap.sessions) ?? "needs you"));
    else if (bucket === "idle") idle.push(toItem(s));
    else working.push(toItem(s));
  }

  for (const commission of snap.pipelineCommissions ?? []) {
    if (representedCommissions.has(commission.id)) continue;
    const task = taskById.get(commission.taskId) ?? null;
    const attention = pipelineAttentionByCommission.get(commission.id) ?? null;
    if (!attention) continue;
    needsYou.push({
      sessionId: `pipeline:${commission.id}`,
      name: commission.handoff?.planSlug ?? `Pipeline commission ${commission.id.slice(0, 8)}`,
      kind: "pipeline",
      branch: commission.authoringBranch,
      activity: null,
      reason: `${attention.title}: ${attention.detail}`,
      taskTitle: task?.title ?? null,
      outcome: task?.outcome ?? null,
      outcomeUrl: task?.outcomeUrl ?? null,
    });
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
export function renderReportMarkdown(r: MissionReport): string {
  const stamp = new Date(r.generatedAt).toISOString().slice(0, 16).replace("T", " ");
  const lines: string[] = [`# Mission bearings - ${stamp}`];

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

  // Priority leads the line because the list is already sorted by it - the digest reads
  // top-down as a triage order, and a reader who pastes it elsewhere keeps that order.
  // Both marks are omitted entirely when unset, so an untriaged backlog reads as before.
  lines.push("", `Backlog (${r.backlog.length})`);
  for (const t of r.backlog) {
    const prio = t.priority ? `[${t.priority}] ` : "";
    const labels = t.labels.length > 0 ? ` {${t.labels.join(", ")}}` : "";
    // Rides in the kind group rather than as a mark of its own: a digest pasted
    // elsewhere is read as a list of what is queued, and a parked item that looks
    // identical to a live one is the one line in it that is not true.
    const kind = t.enabled ? t.kind : `${t.kind}, disabled`;
    lines.push(`- ${prio}"${t.title}" (${kind})${labels} - ${t.repoRoot}`);
  }

  lines.push("", `Recent outcomes (${r.recent.length}${r.recentTruncated ? "+" : ""})`);
  for (const t of r.recent) {
    const tail = t.outcome ? ` - ${t.outcome}` : t.error ? ` - ${t.error}` : "";
    lines.push(`- "${t.title}" ${t.status}${tail}`);
  }
  if (r.recentTruncated) lines.push(`  (older outcomes omitted)`);

  return lines.join("\n") + "\n";
}
