import { useState } from "react";
import type { MissionSchedule } from "@shared/schedules.ts";
import { scheduleIsRunnable } from "@shared/schedules.ts";
import { archiveSchedule, runScheduleNow, setScheduleEnabled } from "../../lib/api.ts";
import {
  SCHEDULE_HEALTH_REASON_LABELS,
  cadenceSentence,
  completionPolicyLabel,
  executionModeLabel,
  formatInstantLong,
  missedPolicyLabel,
  occurrenceStatusView,
  overlapPolicyLabel,
  scheduleHealthLabel,
  scheduleHealthTone,
} from "../../lib/schedules.ts";
import { RepositoryName } from "../RepositoryName.tsx";
import { Tooltip } from "../Tooltip.tsx";
import { ScheduleSpine } from "./ScheduleSpine.tsx";

/**
 * Everything about the selected mission, arranged around its time axis.
 *
 * The order is the argument. WHAT this mission does (its name, its cadence as a sentence,
 * and the task every run files) comes first because that is what an operator came to read;
 * WHEN it has run and will run is the spine below it; and the exact stored configuration -
 * the cron string, the zone, the policies, the machine-readable instants - sits in a
 * disclosure, because it is an audit view rather than a headline. It used to be eleven
 * `dt`/`dd` pairs at one weight, where the agent instructions carried exactly as much
 * emphasis as a UTC restatement of a value printed 200px above them.
 *
 * The daemon still owns every judgement shown here - health, the next instant, the policy
 * outcomes - and this reads them. What it adds is the action surface: Pause/Resume, Run now,
 * Archive and the route into Edit. Each mutation disables its control while it is in flight
 * and surfaces a structured error rather than a blank failure. Run now is explicit that it
 * FILES A BACKLOG TASK - it never dispatches or types into a pane; Foreman remains the only
 * autonomous path to execution.
 */
export function ScheduleDetail({
  schedule,
  initialOccurrenceId,
  initialScheduledFor,
  onEdit,
  onArchived,
  onOpenTask,
  resolveTaskLink,
}: {
  schedule: MissionSchedule;
  initialOccurrenceId?: string | null;
  initialScheduledFor?: number | null;
  onEdit: () => void;
  /** Archive committed; the catalog should select a neighbour. */
  onArchived: () => void;
  /** Open a generated task from the spine's history half. */
  onOpenTask?: (taskId: string) => void;
  resolveTaskLink?: (taskId: string) => { openable: boolean; blockedReason: string | null };
}): React.JSX.Element {
  const [busy, setBusy] = useState<null | "enable" | "run" | "archive">(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);

  const runnable = scheduleIsRunnable(schedule);
  const template = schedule.template;

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
      <div className="rm-detail-id">
        <span className="rm-row-icon" aria-hidden>
          ◷
        </span>
        <div className="rm-detail-name">
          <h3>{schedule.name}</h3>
          <p className="rm-detail-cadence">
            {cadenceSentence(schedule.expression, schedule.timezone)}
          </p>
          <div className="rm-detail-chips">
            <RepositoryName path={template?.repoRoot} className="rm-chip" />
            {template && (
              <span className="rm-chip">{template.agent ?? "agent follows kind"}</span>
            )}
            {template && <span className="rm-chip">{template.kind}</span>}
            {template?.model && <span className="rm-chip">{template.model}</span>}
            <span className="rm-chip">revision {schedule.revision}</span>
          </div>
        </div>
        <div className="rm-detail-actions">
          <span className={`rm-pill rm-pill-${scheduleHealthTone(schedule.health)}`}>
            {scheduleHealthLabel(schedule.health)}
          </span>
          {/* Pause stays available even for an unreadable schedule (an operator must always
              be able to stop one), but Resume is disabled when !runnable: resuming would set
              the durable enabled flag on a config this build cannot run, and a later
              compatible build would then start it without anyone re-enabling it. */}
          <Tooltip
            label={
              schedule.enabled
                ? "Pause this mission; future occurrences stop, history is kept"
                : runnable
                  ? "Resume this mission from the next instant, not the one it was parked on"
                  : "This mission was written by a newer build and cannot be resumed until opened in a compatible build"
            }
          >
            <button
              className="btn"
              onClick={toggleEnabled}
              disabled={busy !== null || (!schedule.enabled && !runnable)}
            >
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

        {template && (
          <div className="rm-brief">
            <span className="rm-eyebrow">Each run files this task</span>
            <strong className="rm-brief-title">{template.title}</strong>
            <p className="rm-brief-intent">{template.intent}</p>
          </div>
        )}

        <details className="rm-config">
          <Tooltip label="Show the exact stored configuration this mission runs on">
            <summary>
              Configuration
              <span className="rm-dim"> - cron, time zone, policies and task defaults</span>
            </summary>
          </Tooltip>
          <dl className="rm-kv">
            <dt>Cron expression</dt>
            <dd className="rm-mono">{schedule.expression}</dd>
            <dt>Time zone</dt>
            <dd>{schedule.timezone} · DST aware</dd>
            <dt>Next occurrence</dt>
            <dd>
              {/* The exact instant rides `dateTime`, so the audit value stays in the document
                  without a second UTC restatement competing with the sentence beside it. */}
              {schedule.nextRunAt != null ? (
                <time dateTime={new Date(schedule.nextRunAt).toISOString()}>
                  {formatInstantLong(schedule.nextRunAt, schedule.timezone)}
                </time>
              ) : schedule.enabled ? (
                "None is scheduled"
              ) : (
                "Paused · none is scheduled"
              )}
            </dd>
            <dt>Execution mode</dt>
            <dd>
              {executionModeLabel(schedule.executionMode)}
              {schedule.executionMode && (
                <span className="rm-dim rm-mono"> {schedule.executionMode}</span>
              )}
            </dd>
            <dt>Overlap</dt>
            <dd>{overlapPolicyLabel(schedule.overlapPolicy)}</dd>
            <dt>Missed runs</dt>
            <dd>{missedPolicyLabel(schedule.missedPolicy)}</dd>
            <dt>Completion</dt>
            <dd>{completionPolicyLabel(schedule.completionPolicy)}</dd>
            {template && (
              <>
                <dt>Repository</dt>
                <dd className="rm-mono">
                  <RepositoryName path={template.repoRoot} />
                </dd>
                <dt>Task defaults</dt>
                <dd>
                  {template.agent ?? "agent follows kind"} · {template.kind}
                  {template.priority ? ` · ${template.priority}` : ""}
                  {template.model ? ` · ${template.model}` : " · model follows harness default"}
                </dd>
              </>
            )}
          </dl>
        </details>

        <ScheduleSpine
          key={schedule.id}
          scheduleId={schedule.id}
          schedule={schedule}
          initialOccurrenceId={initialOccurrenceId}
          initialScheduledFor={initialScheduledFor}
          onOpenTask={onOpenTask}
          resolveTaskLink={resolveTaskLink}
        />

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

        {message && (
          <p
            className={message.tone === "error" ? "rm-error" : "rm-note-ok"}
            role={message.tone === "error" ? "alert" : "status"}
          >
            {message.text}
          </p>
        )}

        <div className="rm-detail-foot">
          {confirmArchive ? (
            <>
              <span className="rm-dim rm-small">Archive keeps history. Sure?</span>
              <Tooltip label="Keep this mission in the catalog - do not archive">
                <button
                  className="btn"
                  onClick={() => setConfirmArchive(false)}
                  disabled={busy !== null}
                >
                  Cancel
                </button>
              </Tooltip>
              <Tooltip label="Retire this mission; its generated tasks and history are preserved">
                <button
                  className="btn btn-danger"
                  onClick={() => void archive()}
                  disabled={busy !== null}
                >
                  {busy === "archive" ? "Archiving…" : "Archive"}
                </button>
              </Tooltip>
            </>
          ) : (
            <Tooltip label="Retire this mission from the catalog; history is kept">
              <button
                className="btn"
                onClick={() => setConfirmArchive(true)}
                disabled={busy !== null}
              >
                Archive
              </button>
            </Tooltip>
          )}
          <span className="rm-spacer" />
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
