import { useState } from "react";
import type { MissionSchedule } from "@shared/schedules.ts";
import { scheduleIsRunnable } from "@shared/schedules.ts";
import {
  archiveSchedule,
  runScheduleNow,
  setScheduleEnabled,
} from "../../lib/api.ts";
import {
  SCHEDULE_HEALTH_REASON_LABELS,
  cadenceLabel,
  delayIsLate,
  formatDelay,
  formatInstantLong,
  missedPolicyLabel,
  occurrenceStatusView,
  overlapPolicyLabel,
  shortRepo,
} from "../../lib/schedules.ts";
import { Tooltip } from "../Tooltip.tsx";

/**
 * The catalog's right half: everything about the selected schedule, and every operator
 * mutation it offers.
 *
 * The daemon owns every decision shown here - health, the next instant, the policy
 * outcomes - and this reads them. What it adds is the action surface: Pause/Resume, Run
 * now, Archive, and the routes into Preview, Edit and History. Each mutation disables its
 * control while it is in flight (no duplicate clicks) and surfaces a structured error
 * rather than a blank failure. Run now is explicit that it FILES A BACKLOG TASK - it never
 * dispatches or types into a pane; Foreman remains the only autonomous path to execution.
 */
export function ScheduleDetail({
  schedule,
  onEdit,
  onPreview,
  onHistory,
  onArchived,
}: {
  schedule: MissionSchedule;
  onEdit: () => void;
  onPreview: () => void;
  onHistory: () => void;
  /** Archive committed; the catalog should select a neighbour. */
  onArchived: () => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState<null | "enable" | "run" | "archive">(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);

  const runnable = scheduleIsRunnable(schedule);
  const template = schedule.template;
  const last = schedule.lastOccurrence;

  async function toggleEnabled(): Promise<void> {
    setBusy("enable");
    setMessage(null);
    const result = await setScheduleEnabled(schedule.id, !schedule.enabled);
    setBusy(null);
    if (!result.ok) setMessage({ tone: "error", text: result.error ?? "The request failed." });
  }

  async function runNow(): Promise<void> {
    setBusy("run");
    setMessage(null);
    const result = await runScheduleNow(schedule.id);
    setBusy(null);
    if (!result.ok) {
      setMessage({ tone: "error", text: result.error ?? "The request failed." });
      return;
    }
    const status = result.occurrence?.status ?? null;
    const view = occurrenceStatusView(status);
    setMessage({
      tone: "ok",
      text:
        status === "created"
          ? "Filed a backlog task. Foreman may dispatch it once its gates pass."
          : `Recorded a manual occurrence: ${view.label.toLowerCase()}.`,
    });
  }

  async function archive(): Promise<void> {
    setBusy("archive");
    setMessage(null);
    const result = await archiveSchedule(schedule.id);
    setBusy(null);
    setConfirmArchive(false);
    if (!result.ok) {
      setMessage({ tone: "error", text: result.error ?? "The request failed." });
      return;
    }
    onArchived();
  }

  return (
    <div className="rm-detail">
      <div className="rm-panel-head">
        <div className="rm-detail-title">
          <span className="rm-row-icon" aria-hidden>
            ◷
          </span>
          <div>
            <h3>{schedule.name}</h3>
            <p className="rm-dim">
              {shortRepo(template?.repoRoot)} · revision {schedule.revision}
            </p>
          </div>
        </div>
        <div className="rm-detail-actions">
          <Tooltip
            label={
              schedule.enabled
                ? "Pause this mission; future occurrences stop, history is kept"
                : "Resume this mission from the next instant, not the one it was parked on"
            }
          >
            <button className="btn" onClick={toggleEnabled} disabled={busy !== null}>
              {schedule.enabled ? "Pause" : "Resume"}
            </button>
          </Tooltip>
          <Tooltip
            label={
              runnable
                ? "Edit this mission; saving creates a new immutable revision"
                : "This mission was written by a newer build and cannot be edited safely"
            }
          >
            <button className="btn" onClick={onEdit} disabled={busy !== null || !runnable}>
              Edit
            </button>
          </Tooltip>
        </div>
      </div>

      <div className="rm-detail-body">
        {schedule.unreadable && (
          <p className="rm-banner rm-banner-attention" role="alert">
            This schedule was written by a newer build and cannot be run as read:{" "}
            {schedule.unreadable.reason}
          </p>
        )}
        {schedule.health === "attention" && schedule.healthReasons.length > 0 && (
          <ul className="rm-attention-reasons">
            {schedule.healthReasons.map((reason) => (
              <li key={reason}>{SCHEDULE_HEALTH_REASON_LABELS[reason] ?? reason}</li>
            ))}
          </ul>
        )}

        <div className="rm-next-run">
          <span className="rm-eyebrow">Next occurrence</span>
          <div className="rm-next-time">
            {schedule.nextRunAt != null
              ? formatInstantLong(schedule.nextRunAt, schedule.timezone)
              : schedule.enabled
                ? "No next occurrence is scheduled"
                : "Paused · no occurrence is scheduled"}
          </div>
          <p className="rm-dim">
            Will create a normal backlog task. Foreman may dispatch it only after the
            existing live-mode, allowlist, dependency and capacity checks pass.
          </p>
        </div>

        <dl className="rm-kv">
          {template && (
            <>
              <dt>Task title</dt>
              <dd>
                <strong>{template.title}</strong>
              </dd>
            </>
          )}
          <dt>Cadence</dt>
          <dd>{cadenceLabel(schedule.expression)}</dd>
          <dt>Exact cron</dt>
          <dd className="rm-mono">{schedule.expression}</dd>
          <dt>Time zone</dt>
          <dd>{schedule.timezone} · DST aware</dd>
          <dt>Next (UTC)</dt>
          <dd className="rm-mono">
            {schedule.nextRunAt != null ? new Date(schedule.nextRunAt).toISOString() : "-"}
          </dd>
          <dt>Execution mode</dt>
          <dd>{schedule.executionMode ?? "Unreadable by this build"}</dd>
          {template && (
            <>
              <dt>Task intent</dt>
              <dd>{template.intent}</dd>
              <dt>Repository</dt>
              <dd className="rm-mono">{template.repoRoot}</dd>
              <dt>Task defaults</dt>
              <dd>
                {template.agent} · {template.kind}
                {template.priority ? ` · ${template.priority}` : ""}
                {template.model ? ` · ${template.model}` : " · model follows harness default"}
              </dd>
            </>
          )}
          <dt>Overlap</dt>
          <dd>{overlapPolicyLabel(schedule.overlapPolicy)}</dd>
          <dt>Missed runs</dt>
          <dd>{missedPolicyLabel(schedule.missedPolicy)}</dd>
        </dl>

        <div className="rm-guarantee">
          <span className="rm-guarantee-mark" aria-hidden>
            ☾
          </span>
          <div>
            <strong>Durable local catch-up · best effort</strong>
            No work runs while this laptop is asleep or powered off; overdue instants are
            accounted for exactly once when Mission Control resumes, and the run is created
            late by the actual delay. It is not promised to run at the original wall-clock
            instant.
          </div>
        </div>

        {last && (
          <div className="rm-last-run">
            <span className="rm-eyebrow">Most recent occurrence</span>
            <span>
              <span className={`rm-badge-inline rm-badge-${occurrenceStatusView(last.status).tone}`}>
                {occurrenceStatusView(last.status).label}
              </span>{" "}
              ·{" "}
              <span className={delayIsLate(last.delayMs) ? "rm-late" : ""}>
                {formatDelay(last.delayMs)}
              </span>{" "}
              {last.taskId ? "· task filed" : ""}
            </span>
          </div>
        )}

        {message && (
          <p
            className={message.tone === "error" ? "rm-error" : "rm-note-ok"}
            role={message.tone === "error" ? "alert" : "status"}
          >
            {message.text}
          </p>
        )}

        <div className="rm-detail-foot">
          <Tooltip label="Enumerate the next occurrences and simulate standby, without writing anything">
            <button className="btn" onClick={onPreview} disabled={busy !== null || !runnable}>
              Preview
            </button>
          </Tooltip>
          <Tooltip label="Open this mission's paginated run history">
            <button className="btn" onClick={onHistory} disabled={busy !== null}>
              History
            </button>
          </Tooltip>
          <span className="rm-spacer" />
          {confirmArchive ? (
            <>
              <span className="rm-dim rm-small">Archive keeps history. Sure?</span>
              <Tooltip label="Keep editing - do not archive">
                <button className="btn" onClick={() => setConfirmArchive(false)} disabled={busy !== null}>
                  Cancel
                </button>
              </Tooltip>
              <Tooltip label="Retire this mission; its generated tasks and history are preserved">
                <button className="btn btn-danger" onClick={() => void archive()} disabled={busy !== null}>
                  {busy === "archive" ? "Archiving…" : "Archive"}
                </button>
              </Tooltip>
            </>
          ) : (
            <Tooltip label="Retire this mission from the catalog; history is kept">
              <button className="btn" onClick={() => setConfirmArchive(true)} disabled={busy !== null}>
                Archive
              </button>
            </Tooltip>
          )}
          <Tooltip label="Files this mission's work now as a backlog task - it does not run an agent. Works while paused.">
            <button
              className="btn btn-primary"
              onClick={() => void runNow()}
              disabled={busy !== null || !runnable}
            >
              {busy === "run" ? "Filing…" : "Run now"}
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
