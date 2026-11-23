import { useState } from "react";
import { reportEntryStatus, reportToRead, type ReportItem } from "@shared/reports.ts";
import { InboxActionButton } from "./AgentName.tsx";
import { ConversationTimestamp } from "./ConversationTimestamp.tsx";
import { PlanView } from "./PlanView.tsx";
import { Tooltip } from "./Tooltip.tsx";

/**
 * An agent report in its session's conversation, where it was posted (`inbox` flag). The session
 * is a report's permanent home: every version of every report has an entry here, read or not,
 * replaced or not, and the entry outlives the report's place in the inbox.
 *
 * It says it is a report, gives the title (the `toggle` action, which discloses the body), the
 * version when it replaced an earlier one, and how the report stands: waiting to be read, replaced,
 * or how it was cleared (read, replied to, or followed up). While it is waiting to be read it
 * offers `mark-read`. A report with an attached document offers `open-report`, which reads the
 * copy stored when it was posted and never marks it read. Every control is drawn through
 * `InboxActionButton`, and
 * `test/inbox-actions.test.ts` scans this file for a control drawn any other way. The body is
 * open while this report is the one open on screen (App's `openReportId`), the same one the inbox
 * reads, so opening it here opens it there too.
 */
export function ReportEntryCard({
  report,
  open,
  onToggle,
  onMarkRead,
  onOpenDocument,
}: {
  report: ReportItem;
  open: boolean;
  onToggle: () => void;
  /** Mark it read. Resolves to why the daemon refused, or null. */
  onMarkRead: () => Promise<string | null>;
  /** Open the attached document's stored copy in the reader. */
  onOpenDocument: () => void;
}): React.JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const name = report.author.name;
  const waiting = reportToRead(report);
  const bodyId = `report-entry-body-${report.id}`;
  const status = reportEntryStatus(report);
  return (
    <div
      className={`report-entry${waiting ? " is-waiting" : ""}`}
      role="note"
      aria-label={`Report: ${report.title}`}
      data-report-id={report.id}
    >
      <div className="review-answer-head">
        <span className="review-answer-who report-entry-tag">Report</span>
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
        <ConversationTimestamp at={report.createdAt} className="turn-time" />
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
            <div className="agent-report-document">
              <p className="inbox-line">Attached: {report.document.name}</p>
              <div className="agent-report-actions">
                <InboxActionButton
                  action="open-report"
                  name={name}
                  className="btn"
                  tooltip="Read the attached document from the copy stored when this report was posted. It does not mark the report read"
                  onClick={onOpenDocument}
                />
              </div>
            </div>
          )}
        </div>
      )}
      <div className="review-asked-foot">
        <span className="report-entry-status">{status}</span>
        {report.version > 1 && (
          <span className="report-entry-version">Version {report.version}, replacing an earlier report</span>
        )}
        <span className="dim">{report.id}</span>
        {waiting && (
          <>
            <span className="inbox-spacer" />
            <InboxActionButton
              action="mark-read"
              name={name}
              className="btn btn-ghost"
              tooltip="Mark this report read. It leaves the inbox and the to read figure, and stays here"
              onClick={() => {
                setError(null);
                void onMarkRead().then(setError);
              }}
            />
          </>
        )}
      </div>
      {error && <p className="inbox-line inbox-error" role="alert">{error}</p>}
    </div>
  );
}
