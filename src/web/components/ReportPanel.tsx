import { useEffect, useMemo, useState } from "react";
import type { Session, Task, TaskSummary } from "@shared/types.ts";
import {
  RECENT_TASKS_CAP,
  finishedTasks,
  needsYouReason,
  queuedTasks,
  reportBucket,
} from "@shared/session.ts";
import { api } from "../lib/api.ts";
import { shortenCwd } from "../lib/format.ts";

/**
 * The fleet report (`/bearings`): who needs you, who's working, what's idle, the
 * backlog, and recent outcomes - assembled from the same live snapshot the grid
 * uses (so it never flickers or lags), with the SAME bucketing the server uses
 * for its markdown digest.
 */
export function ReportPanel({
  sessions,
  tasks,
  onClose,
  onOpenReviews,
}: {
  sessions: Session[];
  tasks: Task[];
  onClose: () => void;
  onOpenReviews: (sessionId: string) => void;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const [marking, setMarking] = useState<string | null>(null);
  const [outcome, setOutcome] = useState("");
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);

  // Close on Escape, consistent with the dispatch modal (App.tsx suppresses the
  // grid's global keys while this panel is open, so it must handle Escape itself).
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const { needsYou, working, idle } = useMemo(() => {
    const nY: Session[] = [];
    const wk: Session[] = [];
    const id: Session[] = [];
    for (const s of sessions) {
      const b = reportBucket(s, sessions);
      if (b === "needs-you") nY.push(s);
      else if (b === "working") wk.push(s);
      else if (b === "idle") id.push(s);
    }
    return { needsYou: nY, working: wk, idle: id };
  }, [sessions]);

  const backlog = useMemo(() => queuedTasks(tasks), [tasks]);
  const recent = useMemo(() => finishedTasks(tasks).slice(0, RECENT_TASKS_CAP), [tasks]);
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  // gitInfo can't read a linked-worktree's .git, so a dispatched agent's
  // session has gitBranch === null; fall back to the task's branch (matching the
  // server's markdown digest, so the panel and the copied text agree).
  const branchOf = (s: Session): string | null =>
    s.gitBranch ?? (s.task ? taskById.get(s.task.id)?.branch ?? null : null);

  async function copyMarkdown(): Promise<void> {
    try {
      const text = await (await fetch("/api/report.md")).text();
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked - the JSON report is still on /api/report */
    }
  }

  async function markDone(taskId: string): Promise<void> {
    const o = outcome.trim();
    if (!o) return;
    await api.completeTask(taskId, o);
    setMarking(null);
    setOutcome("");
  }

  async function cancel(taskId: string): Promise<void> {
    await api.cancelTask(taskId);
    setConfirmCancel(null);
  }

  async function reclaim(taskId: string): Promise<void> {
    await api.reclaimTask(taskId);
    setConfirmCancel(null);
  }

  // Abort an active agent and reclaim its worktree. Two-click confirm so a stray
  // click can't take one down. Terminal tasks that still hold a tree are reclaimed
  // from Recent outcomes instead (single surface), so this is active tasks only.
  function cancelControl(task: TaskSummary): React.JSX.Element | null {
    if (task.status !== "running" && task.status !== "dispatching") {
      return null;
    }
    if (confirmCancel !== task.id) {
      return (
        <button className="btn btn-danger-ghost" onClick={() => setConfirmCancel(task.id)}>
          Cancel
        </button>
      );
    }
    return (
      <span className="report-cancel">
        <button className="btn btn-danger" onClick={() => void cancel(task.id)}>
          Confirm cancel
        </button>
        <button className="btn btn-ghost" onClick={() => setConfirmCancel(null)}>
          ✕
        </button>
      </span>
    );
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <aside className="report-panel" role="dialog" aria-label="Fleet report" onClick={(e) => e.stopPropagation()}>
        <header className="report-head">
          <h2>Fleet bearings</h2>
          <button className="btn btn-ghost" onClick={() => void copyMarkdown()}>
            {copied ? "Copied ✓" : "Copy as markdown"}
          </button>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="report-body">
          <Section title="Needs you" tone="attention" count={needsYou.length} empty="Nothing blocked on you.">
            {needsYou.map((s) => (
              <SessionRow key={s.id} s={s} branch={branchOf(s)} reason={needsYouReason(s, sessions) ?? "needs you"}>
                {s.pendingReviews > 0 && (
                  <button className="btn" onClick={() => onOpenReviews(s.id)}>
                    Review
                  </button>
                )}
                {s.task && cancelControl(s.task)}
                <button className="btn" onClick={() => void api.focus(s.id)}>
                  Focus
                </button>
              </SessionRow>
            ))}
          </Section>

          <Section title="Working" tone="working" count={working.length} empty="No agents running.">
            {working.map((s) => (
              <SessionRow key={s.id} s={s} branch={branchOf(s)} reason={s.activity ?? ""}>
                {s.task && (s.task.status === "running" || s.task.status === "dispatching") ? (
                  marking === s.task.id ? (
                    <span className="report-mark">
                      <input
                        className="field-input"
                        autoFocus
                        placeholder="outcome, e.g. opened PR #123"
                        value={outcome}
                        onChange={(e) => setOutcome(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void markDone(s.task!.id);
                          if (e.key === "Escape") setMarking(null);
                        }}
                      />
                      <button className="btn btn-send" onClick={() => void markDone(s.task!.id)}>
                        Save
                      </button>
                    </span>
                  ) : (
                    <button
                      className="btn"
                      title="Record an outcome. The worktree + agent stay until you Clean up."
                      onClick={() => setMarking(s.task!.id)}
                    >
                      Mark done…
                    </button>
                  )
                ) : null}
                {s.task && cancelControl(s.task)}
                <button className="btn" onClick={() => void api.focus(s.id)}>
                  Focus
                </button>
              </SessionRow>
            ))}
          </Section>

          <Section title="Idle" tone="idle" count={idle.length} empty="Nothing sitting idle.">
            {idle.map((s) => (
              <SessionRow key={s.id} s={s} branch={branchOf(s)} reason="">
                <button className="btn" onClick={() => void api.focus(s.id)}>
                  Focus
                </button>
              </SessionRow>
            ))}
          </Section>

          <Section title="Backlog" tone="neutral" count={backlog.length} empty="Backlog is empty.">
            {backlog.map((t) => (
              <div className="report-row" key={t.id}>
                <div className="report-row-main">
                  <span className="report-name">{t.title}</span>
                  <span className="task-kind">{t.kind}</span>
                  <span className="report-sub mono">{shortenCwd(t.repoRoot)}</span>
                </div>
                <div className="report-row-actions">
                  <button className="btn btn-send" onClick={() => void api.dispatchQueued(t.id)}>
                    Dispatch
                  </button>
                  <button className="btn btn-danger-ghost" onClick={() => void api.deleteTask(t.id)}>
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </Section>

          <Section title="Recent outcomes" tone="neutral" count={recent.length} empty="No finished tasks yet.">
            {recent.map((t) => (
              <div className="report-row" key={t.id}>
                <div className="report-row-main">
                  <span className="report-name">{t.title}</span>
                  <span className={`report-status status-${t.status}`}>{t.status}</span>
                  {t.outcome &&
                    (t.outcomeUrl ? (
                      <a className="task-outcome" href={t.outcomeUrl} target="_blank" rel="noreferrer">
                        {t.outcome}
                      </a>
                    ) : (
                      <span className="report-sub">{t.outcome}</span>
                    ))}
                  {!t.outcome && t.error && <span className="report-sub dim">{t.error}</span>}
                </div>
                {/* A cleanly-failed task (torn down, no worktree) can be retried in
                    place - it re-provisions from scratch. */}
                {t.status === "failed" && !t.worktreePath && (
                  <div className="report-row-actions">
                    <button className="btn btn-send" onClick={() => void api.dispatchQueued(t.id)}>
                      Retry
                    </button>
                  </div>
                )}
                {/* A terminal task that still holds a worktree - a done task
                    awaiting reclaim, or a failed-but-alive dispatch whose agent may
                    still be running - is freed here (keeping its status + outcome). */}
                {t.worktreePath && (
                  <div className="report-row-actions">
                    {confirmCancel === t.id ? (
                      <span className="report-cancel">
                        <span className="report-sub">reclaim worktree &amp; stop agent?</span>
                        <button className="btn btn-danger" onClick={() => void reclaim(t.id)}>
                          Clean up
                        </button>
                        <button className="btn btn-ghost" onClick={() => setConfirmCancel(null)}>
                          ✕
                        </button>
                      </span>
                    ) : (
                      <button className="btn btn-danger-ghost" onClick={() => setConfirmCancel(t.id)}>
                        Clean up
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </Section>
        </div>
      </aside>
    </div>
  );
}

function Section({
  title,
  tone,
  count,
  empty,
  children,
}: {
  title: string;
  tone: string;
  count: number;
  empty: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="report-section">
      <h3 className={`report-section-title tone-${tone}`}>
        {title} <span className="report-count">{count}</span>
      </h3>
      {count === 0 ? <p className="report-empty">{empty}</p> : children}
    </section>
  );
}

function SessionRow({
  s,
  branch,
  reason,
  children,
}: {
  s: Session;
  branch: string | null;
  reason: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  const label = s.task?.title || s.name;
  return (
    <div className="report-row">
      <div className="report-row-main">
        <span className={`agent-dot agent-${s.agent}`} aria-hidden />
        <span className="report-name" title={label}>
          {label}
        </span>
        {s.task && <span className="task-kind">{s.task.kind}</span>}
        {branch && <span className="report-sub mono branch">{branch}</span>}
        {reason && <span className="report-sub">{reason}</span>}
      </div>
      <div className="report-row-actions">{children}</div>
    </div>
  );
}
