import { useMemo, useState } from "react";
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

  const { needsYou, working, idle } = useMemo(() => {
    const nY: Session[] = [];
    const wk: Session[] = [];
    const id: Session[] = [];
    for (const s of sessions) {
      const b = reportBucket(s);
      if (b === "needs-you") nY.push(s);
      else if (b === "working") wk.push(s);
      else if (b === "idle") id.push(s);
    }
    return { needsYou: nY, working: wk, idle: id };
  }, [sessions]);

  const backlog = useMemo(() => queuedTasks(tasks), [tasks]);
  const recent = useMemo(() => finishedTasks(tasks).slice(0, RECENT_TASKS_CAP), [tasks]);

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

  async function cancel(taskId: string, removeWorktree: boolean): Promise<void> {
    await api.cancelTask(taskId, removeWorktree);
    setConfirmCancel(null);
  }

  // Stop a live crewmate. Two-step: the second row lets you keep or reclaim its
  // isolated worktree (reclaiming returns a treehouse lease / removes the tree).
  function cancelControl(task: TaskSummary): React.JSX.Element | null {
    if (task.status !== "running" && task.status !== "dispatching") return null;
    if (confirmCancel !== task.id) {
      return (
        <button className="btn btn-danger-ghost" onClick={() => setConfirmCancel(task.id)}>
          Cancel
        </button>
      );
    }
    return (
      <span className="report-cancel">
        <span className="report-sub">stop &amp;</span>
        <button className="btn" onClick={() => void cancel(task.id, false)}>
          keep tree
        </button>
        <button className="btn btn-danger" onClick={() => void cancel(task.id, true)}>
          remove tree
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
              <SessionRow key={s.id} s={s} reason={needsYouReason(s) ?? "needs you"}>
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

          <Section title="Working" tone="working" count={working.length} empty="No crew running.">
            {working.map((s) => (
              <SessionRow key={s.id} s={s} reason={s.activity ?? ""}>
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
                    <button className="btn" onClick={() => setMarking(s.task!.id)}>
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
              <SessionRow key={s.id} s={s} reason="">
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
  reason,
  children,
}: {
  s: Session;
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
        {s.gitBranch && <span className="report-sub mono branch">{s.gitBranch}</span>}
        {reason && <span className="report-sub">{reason}</span>}
      </div>
      <div className="report-row-actions">{children}</div>
    </div>
  );
}
