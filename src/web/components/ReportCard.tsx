import { reportUpdatedNote, type ReportItem } from "@shared/reports.ts";
import { relativeTime } from "../lib/format.ts";
import { InboxActionButton } from "./AgentName.tsx";
import { PlanView } from "./PlanView.tsx";
import { Tooltip } from "./Tooltip.tsx";

/**
 * One agent report in the inbox (`inbox` flag).
 *
 * Collapsed to its title, its author's name and its age, so a section of several reads as a
 * list of headings. Opening it shows the body, the link, and Mark read. Every control is drawn
 * from its `INBOX_ACTIONS` entry through `InboxActionButton`: the title is the `toggle` action,
 * which only discloses the body and is never spoken, and Mark read is `mark-read`, whose spoken
 * form a later voice layer shows beside it. `test/inbox-actions.test.ts` scans this file for a
 * control drawn any other way.
 *
 * Which report is open is the dashboard's (`openReportId` in App), never this card's: a voice
 * command binds to the report that is open on screen, so there is one answer to "which one".
 * Opening a report does NOT mark it read; only Mark read does, here.
 */
export function ReportCard({
  report,
  open,
  onToggle,
  onMarkRead,
  error = null,
  now,
}: {
  report: ReportItem;
  open: boolean;
  onToggle: () => void;
  onMarkRead: () => void;
  /** Why the last Mark read was refused, drawn beneath the card until it is tried again. */
  error?: string | null;
  /** Injectable so a render test can own the clock. */
  now?: number;
}): React.JSX.Element {
  const name = report.author.name;
  const updated = reportUpdatedNote(report.version);
  const bodyId = `report-body-${report.id}`;
  return (
    <article className={`agent-report-card${open ? " is-open" : ""}`} aria-label={`Report: ${report.title}`}>
      <div className="agent-report-head">
        <InboxActionButton
          action="toggle"
          name={name}
          label={report.title}
          className="agent-report-toggle"
          tooltip={open ? "Hide this report" : "Show this report. Opening it does not mark it read"}
          ariaExpanded={open}
          ariaControls={open ? bodyId : undefined}
          onClick={onToggle}
        />
        <span className="agent-report-meta">
          <strong>{name}</strong>
          <span className="dim"> · {relativeTime(report.createdAt, now)}</span>
          {updated && <span className="dim"> · {updated}</span>}
        </span>
      </div>
      {open && (
        <div className="agent-report-body" id={bodyId}>
          <PlanView markdown={report.body} />
          {report.url && (
            <p className="agent-report-link">
              <Tooltip label="Open the link the agent attached, in your browser">
                <a href={report.url} target="_blank" rel="noreferrer noopener">{report.url}</a>
              </Tooltip>
            </p>
          )}
          {report.document && (
            <p className="inbox-line">Attached: {report.document.name}</p>
          )}
          <div className="agent-report-actions">
            <InboxActionButton
              action="mark-read"
              name={name}
              className="btn btn-primary"
              tooltip="Mark this report read. It leaves the inbox and the to read figure, and stays in its session"
              cardOpen
              onClick={onMarkRead}
            />
          </div>
        </div>
      )}
      {error && <p className="inbox-line inbox-error" role="alert">{error}</p>}
    </article>
  );
}
