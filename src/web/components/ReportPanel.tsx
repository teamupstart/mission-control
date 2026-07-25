import { useMemo, useState } from "react";
import type { BacklogPlan, Session, Task, TaskSummary } from "@shared/types.ts";
import {
  RECENT_TASKS_CAP,
  backlogTasks,
  finishedTasks,
  needsYouReason,
  reportBucket,
} from "@shared/session.ts";
import { backlogIndex, declaredBlockers, deadBlockersFor } from "@shared/backlog.ts";
import { api } from "../lib/api.ts";
import { shortenCwd } from "../lib/format.ts";
import { formatChord, useKeybindings } from "../lib/keybindings.ts";
import {
  AgentDot,
  DeadBlockerButton,
  LabelChips,
  PriorityChip,
  ScheduleOriginChip,
  ScheduleSwitch,
} from "./session-bits.tsx";
import { Overlay, OVERLAY_IDS } from "./Overlay.tsx";
import { Tooltip } from "./Tooltip.tsx";

function BacklogReportRow({
  task,
  tasks,
  deadBlockers,
  onEditTask,
  onOpenSchedule,
  scheduleNameById,
}: {
  task: Task;
  tasks: Task[];
  /** Cancelled/failed tasks blocking this row, directly or up its chain. */
  deadBlockers: Task[];
  onEditTask: (taskId: string) => void;
  onOpenSchedule?: (scheduleId: string, occurrenceId?: string) => void;
  scheduleNameById?: ReadonlyMap<string, string>;
}): React.JSX.Element {
  const [toggleBusy, setToggleBusy] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [deadBlockerOpen, setDeadBlockerOpen] = useState(false);
  const blockers = declaredBlockers(task, tasks);

  async function setEnabled(enabled: boolean): Promise<void> {
    if (toggleBusy) return;
    setToggleBusy(true);
    setToggleError(null);
    const result = await api.updateTask(task.id, { enabled });
    if (!result.ok) setToggleError(result.error ?? "Could not change the schedule setting");
    setToggleBusy(false);
  }

  // Resolve a dead prerequisite - the two halves of unblocking this row. The target is
  // the DEAD task, never `task`: fixing it releases every dependent, not just this one.
  async function resolveDead(run: (id: string) => Promise<{ ok: boolean; error?: string }>, id: string): Promise<void> {
    if (toggleBusy) return;
    setToggleBusy(true);
    setToggleError(null);
    const result = await run(id);
    if (!result.ok) setToggleError(result.error ?? "Could not resolve the blocking task");
    setToggleBusy(false);
  }

  return (
    <div
      className={`report-row${task.enabled ? "" : " is-disabled"}${
        deadBlockerOpen ? " is-deadblock-open" : ""
      }`}
    >
      <div className="report-row-main report-row-stack">
        <span className="report-line">
          <Tooltip label="Open this task for editing">
            <button className="report-name report-name-btn" onClick={() => onEditTask(task.id)}>
              {task.title}
            </button>
          </Tooltip>
          <PriorityChip priority={task.priority} />
          <span className="task-kind">{task.kind}</span>
          <ScheduleSwitch
            enabled={task.enabled}
            taskTitle={task.title}
            busy={toggleBusy}
            onChange={(enabled) => void setEnabled(enabled)}
          />
          {/* Same resolve affordance the board card carries, for the same dead-prerequisite
              case - so the fix is reachable from whichever backlog surface you are reading. */}
          <DeadBlockerButton
            deadBlockers={deadBlockers}
            busy={toggleBusy}
            onOpenChange={setDeadBlockerOpen}
            onReschedule={(id) => void resolveDead((deadId) => api.rescheduleTask(deadId), id)}
            onComplete={(id) =>
              void resolveDead(
                (deadId) =>
                  api.completeTask(
                    deadId,
                    "Marked done from a blocked dependent - its work is already in place.",
                    undefined,
                    true,
                    true,
                  ),
                id,
              )
            }
          />
        </span>
        <span className="report-line report-line-sub">
          <LabelChips labels={task.labels} max={3} />
          <span className="report-sub mono">{shortenCwd(task.repoRoot)}</span>
          <ScheduleOriginChip
            task={task}
            scheduleNames={scheduleNameById}
            onOpen={onOpenSchedule}
          />
        </span>
        {blockers.length > 0 && (
          <span className="report-line report-line-sub">
            Waiting for{" "}
            {blockers
              .map((blocker) =>
                blocker.state === "disabled" ? `${blocker.title} (disabled)` : blocker.title,
              )
              .join(", ")}
          </span>
        )}
        {toggleError && (
          <span className="report-line report-line-sub report-task-error" role="alert">
            {toggleError}
          </span>
        )}
      </div>
      <div className="report-row-actions">
        <Tooltip
          label={
            blockers.length > 0
              ? "Dependencies must complete first"
              : "Launch an agent on this task now"
          }
        >
          <button
            className="btn btn-send"
            onClick={() => void api.dispatchBacklog(task.id, true)}
            disabled={blockers.length > 0}
          >
            {blockers.length > 0 ? "Waiting" : "Dispatch"}
          </button>
        </Tooltip>
        <Tooltip label="Delete this task from the backlog">
          <button className="btn btn-danger-ghost" onClick={() => void api.deleteTask(task.id)}>
            Delete
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

/**
 * The Sitrep panel (`/api/report`): who needs you, who's working, what's idle, the
 * backlog, and recent outcomes - assembled from the same live snapshot the grid
 * uses (so it never flickers or lags), with the SAME bucketing the server uses
 * for its markdown digest.
 *
 * The action id + endpoint still say "roundup"/"report": the id keys persisted
 * keybindings, so renaming it would orphan anyone's saved override.
 */
export function ReportPanel({
  sessions,
  tasks,
  backlogPlan,
  onClose,
  onOpenReviews,
  onEditTask,
  onOpenSchedule,
  scheduleNameById,
}: {
  sessions: Session[];
  tasks: Task[];
  /**
   * Foreman's reading of the backlog, or null when it has none. Threaded in for the same
   * reason the board column takes it: without the plan's inferred edges this panel can
   * only see operator-DECLARED dependencies, so a card stranded behind a cancelled task
   * Foreman inferred would show nothing to act on. See `deadBlockersFor`.
   */
  backlogPlan: BacklogPlan | null;
  onClose: () => void;
  onOpenReviews: (sessionId: string) => void;
  /** Close this panel and reopen the dispatch modal over a backlog task. */
  onEditTask: (taskId: string) => void;
  /** Close this panel and open the Scheduled Catalog from a generated task's provenance. */
  onOpenSchedule?: (scheduleId: string, occurrenceId?: string) => void;
  /** Live schedule names by id, for provenance copy on backlog and recent rows. */
  scheduleNameById?: ReadonlyMap<string, string>;
}): React.JSX.Element {
  const { bindings } = useKeybindings();
  const [copied, setCopied] = useState(false);
  const [marking, setMarking] = useState<string | null>(null);
  const [outcome, setOutcome] = useState("");
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);

  // Escape is handled by the Overlay this panel renders into, NOT by App - App
  // suppresses the grid's global keys while any overlay is up, so the overlay layer
  // has to close itself. That invariant is unchanged; it just lives in one place now.

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

  const backlog = useMemo(() => backlogTasks(tasks), [tasks]);
  const recent = useMemo(() => finishedTasks(tasks).slice(0, RECENT_TASKS_CAP), [tasks]);
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  // Built once for the whole Backlog section rather than per row, the way the board
  // column does it - the dependency walk is linear off this shared index.
  const backlogDepIndex = useMemo(() => backlogIndex(tasks, backlogPlan), [tasks, backlogPlan]);

  // gitBranch is null when the checkout's .git or HEAD can't be read; fall back to
  // the task's branch (matching the server's markdown digest, so the panel and the
  // copied text agree).
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
        <Tooltip label="Abort this agent and reclaim its worktree - asks for a confirming click first">
          <button className="btn btn-danger-ghost" onClick={() => setConfirmCancel(task.id)}>
            Cancel
          </button>
        </Tooltip>
      );
    }
    return (
      <span className="report-cancel">
        <Tooltip label="Abort this agent now and reclaim its worktree">
          <button className="btn btn-danger" onClick={() => void cancel(task.id)}>
            Confirm cancel
          </button>
        </Tooltip>
        <Tooltip label="Leave this agent running">
          <button className="btn btn-ghost" onClick={() => setConfirmCancel(null)}>
            ✕
          </button>
        </Tooltip>
      </span>
    );
  }

  return (
    <Overlay
      id={OVERLAY_IDS.sitrep}
      onClose={onClose}
      as="aside"
      className="report-panel"
      role="dialog"
      ariaLabel="Sitrep"
    >
      <header className="report-head">
        <h2>Sitrep</h2>
        {/* The topbar button that opens this is a bare glyph, so the shortcut
            is spelled out here instead - where you can read it while the panel
            is up, and act on it next time. */}
        <kbd aria-hidden>{formatChord(bindings.roundup)}</kbd>
        <Tooltip label="Copy this whole sitrep to the clipboard as markdown">
          <button className="btn btn-ghost report-copy" onClick={() => void copyMarkdown()}>
            {copied ? "Copied ✓" : "Copy as markdown"}
          </button>
        </Tooltip>
        <Tooltip label="Close the sitrep (Escape)">
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </Tooltip>
      </header>

      <div className="report-body">
        <Section title="Needs you" tone="attention" count={needsYou.length} empty="Nothing blocked on you.">
          {needsYou.map((s) => (
            <SessionRow key={s.id} s={s} branch={branchOf(s)} reason={needsYouReason(s, sessions) ?? "needs you"}>
              {s.pendingReviews > 0 && (
                <Tooltip label="Open this session's pending reviews">
                  <button className="btn" onClick={() => onOpenReviews(s.id)}>
                    Review
                  </button>
                </Tooltip>
              )}
              {s.task && cancelControl(s.task)}
              <Tooltip label="Bring this session's terminal pane to the front">
                <button className="btn" onClick={() => void api.focus(s.id)}>
                  Focus
                </button>
              </Tooltip>
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
                    <Tooltip label="Record this outcome and mark the task done (Enter)">
                      <button className="btn btn-send" onClick={() => void markDone(s.task!.id)}>
                        Save
                      </button>
                    </Tooltip>
                  </span>
                ) : (
                  <Tooltip label="Record an outcome. The worktree + agent stay until you Clean up.">
                    <button className="btn" onClick={() => setMarking(s.task!.id)}>
                      Mark done…
                    </button>
                  </Tooltip>
                )
              ) : null}
              {s.task && cancelControl(s.task)}
              <Tooltip label="Bring this session's terminal pane to the front">
                <button className="btn" onClick={() => void api.focus(s.id)}>
                  Focus
                </button>
              </Tooltip>
            </SessionRow>
          ))}
        </Section>

        <Section title="Idle" tone="idle" count={idle.length} empty="Nothing sitting idle.">
          {idle.map((s) => (
            <SessionRow key={s.id} s={s} branch={branchOf(s)} reason="">
              <Tooltip label="Bring this session's terminal pane to the front">
                <button className="btn" onClick={() => void api.focus(s.id)}>
                  Focus
                </button>
              </Tooltip>
            </SessionRow>
          ))}
        </Section>

        <Section title="Backlog" tone="neutral" count={backlog.length} empty="Backlog is empty.">
          {backlog.map((task) => (
            <BacklogReportRow
              key={task.id}
              task={task}
              tasks={tasks}
              deadBlockers={deadBlockersFor(task, backlogDepIndex)}
              onEditTask={onEditTask}
              onOpenSchedule={onOpenSchedule}
              scheduleNameById={scheduleNameById}
            />
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
                    <Tooltip label={`Outcome: ${t.outcome} - open on GitHub`}>
                      <a className="task-outcome" href={t.outcomeUrl} target="_blank" rel="noreferrer">
                        {t.outcome}
                      </a>
                    </Tooltip>
                  ) : (
                    <span className="report-sub">{t.outcome}</span>
                  ))}
                {!t.outcome && t.error && <span className="report-sub dim">{t.error}</span>}
                {/* A finished scheduled task keeps its provenance so its run history is
                    still one click away after it has left the backlog. */}
                <ScheduleOriginChip
                  task={t}
                  scheduleNames={scheduleNameById}
                  onOpen={onOpenSchedule}
                />
              </div>
              {/* A cleanly-failed task (torn down, no worktree) can be retried in
                  place - it re-provisions from scratch. */}
              {t.status === "failed" && !t.worktreePath && (
                <div className="report-row-actions">
                  <Tooltip label="Dispatch this failed task again from scratch">
                    <button
                      className="btn btn-send"
                      onClick={() => void api.dispatchBacklog(t.id, true)}
                    >
                      Retry
                    </button>
                  </Tooltip>
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
                      <Tooltip label="Reclaim this task's worktree and stop any agent still holding it">
                        <button className="btn btn-danger" onClick={() => void reclaim(t.id)}>
                          Clean up
                        </button>
                      </Tooltip>
                      <Tooltip label="Keep the worktree">
                        <button className="btn btn-ghost" onClick={() => setConfirmCancel(null)}>
                          ✕
                        </button>
                      </Tooltip>
                    </span>
                  ) : (
                    <Tooltip label="Reclaim this task's worktree - asks for a confirming click first">
                      <button className="btn btn-danger-ghost" onClick={() => setConfirmCancel(t.id)}>
                        Clean up
                      </button>
                    </Tooltip>
                  )}
                </div>
              )}
            </div>
          ))}
        </Section>
      </div>
    </Overlay>
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
        <AgentDot agent={s.agent} />
        <Tooltip label={label}>
          <span className="report-name">{label}</span>
        </Tooltip>
        {s.task && <span className="task-kind">{s.task.kind}</span>}
        {branch && <span className="report-sub mono branch">{branch}</span>}
        {reason && <span className="report-sub">{reason}</span>}
      </div>
      <div className="report-row-actions">{children}</div>
    </div>
  );
}
