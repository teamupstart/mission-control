import { useState } from "react";
import { reportUpdatedNote, type ReplyTarget, type ReportItem } from "@shared/reports.ts";
import type { ReportPublishState } from "../lib/sessionReports.ts";
import { relativeTime } from "../lib/format.ts";
import { InboxActionButton } from "./AgentName.tsx";
import { useReportDraft } from "../lib/reportDrafts.ts";
import { PlanView } from "./PlanView.tsx";
import { Tooltip } from "./Tooltip.tsx";

/**
 * One agent report in the inbox (`inbox` flag).
 *
 * Collapsed to its title, its author's name and its age, so a section of several reads as a
 * list of headings. Opening it shows the body, the link, the answer the report's agent can take
 * now, and Mark read. Every control is drawn from its `INBOX_ACTIONS` entry through
 * `InboxActionButton`: the title is the `toggle` action, which only discloses the body and is
 * never spoken; Mark read is `mark-read`; the reply box sends with `reply`; and a report whose
 * agent is gone offers `follow-up`, drawn as Start a follow-up task, or as Retry once a follow-up
 * task was created and its dispatch failed. A report with an attached document offers
 * `open-report`, which reads the copy stored when it was posted, and `publish-scout`, which saves
 * that document to the scout archive on this press and never otherwise; once published the card
 * says so and offers `open-archive`. `test/inbox-actions.test.ts` scans this file for a control
 * drawn any other way.
 *
 * What the card offers follows `target` (`replyTarget`): a reply box while the agent can take a
 * message; a line saying a resident is not running, with where to launch it, as text; a line
 * saying a running session cannot take a message; Start a follow-up task for a standard session
 * that has ended; or a line saying no follow-up can be
 * started when the report stored no repository. A completed session is never resumed.
 *
 * Which report is open is the dashboard's (`openReportId` in App), never this card's: a voice
 * command binds to the report that is open on screen, so there is one answer to "which one".
 * Opening a report does NOT mark it read; Mark read, a reply, or a dispatched follow-up does.
 * Neither Open report nor Publish as scout marks it read either.
 */
/** No request in flight and no refusal: what a card shows before its first press. */
const IDLE_PUBLISH: ReportPublishState = { busy: false, refusal: null };

export function ReportCard({
  report,
  open,
  target,
  onToggle,
  onMarkRead,
  onReply,
  onFollowUp,
  onOpenDocument,
  onPublish,
  publishState = IDLE_PUBLISH,
  onOpenArchive,
  error = null,
  now,
}: {
  report: ReportItem;
  open: boolean;
  /** Where a reply can go now. */
  target: ReplyTarget;
  onToggle: () => void;
  onMarkRead: () => void;
  /** Send the operator's reply. Resolves to why it was refused, or null. */
  onReply: (text: string) => Promise<string | null>;
  /** Start, or retry, the follow-up task. Resolves to why it failed, or null. */
  onFollowUp: (text: string) => Promise<string | null>;
  /** Open the attached document's stored copy in the reader. */
  onOpenDocument: () => void;
  /** Publish the attached document as a scout archive. Its outcome comes back in `publishState`. */
  onPublish: () => void;
  /**
   * Publish as scout's state for this report, kept by the dashboard so a refusal or an in-flight
   * request survives the card being collapsed or the inbox being closed.
   */
  publishState?: ReportPublishState;
  /** Go to the published archive on the Scouts page. */
  onOpenArchive: () => void;
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
            <ReportDocumentControls
              report={report}
              onOpenDocument={onOpenDocument}
              onPublish={onPublish}
              publishState={publishState}
              onOpenArchive={onOpenArchive}
            />
          )}
          <ReportAnswer report={report} target={target} onReply={onReply} onFollowUp={onFollowUp} />
          <div className="agent-report-actions">
            {/* A report opened from its notification may already be read; there is nothing to mark. */}
            {report.readAt === null ? (
              <InboxActionButton
                action="mark-read"
                name={name}
                className="btn btn-ghost"
                tooltip="Mark this report read. It leaves the inbox and the to read figure, and stays in its session"
                cardOpen
                onClick={onMarkRead}
              />
            ) : (
              <span className="dim">Read</span>
            )}
          </div>
        </div>
      )}
      {error && <p className="inbox-line inbox-error" role="alert">{error}</p>}
    </article>
  );
}

/**
 * How the operator answers this report, by where its agent is now. A follow-up task created by
 * an earlier press whose dispatch failed outranks everything else: its Retry dispatches that same
 * task, so the box that would file a second one is not offered.
 */
function ReportAnswer({
  report,
  target,
  onReply,
  onFollowUp,
}: {
  report: ReportItem;
  target: ReplyTarget;
  onReply: (text: string) => Promise<string | null>;
  onFollowUp: (text: string) => Promise<string | null>;
}): React.JSX.Element {
  const name = report.author.name;
  // Held by chain outside React state (`lib/reportDrafts.ts`): a replacement report keeps the
  // words, and a keystroke re-renders this card alone.
  const [draft, onDraft] = useReportDraft(report.rootId);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // The dashboard clears the draft once a send is accepted; a refusal leaves it in the box.
  const run = (send: (text: string) => Promise<string | null>, text: string) => {
    setBusy(true);
    setFailure(null);
    void send(text).then((error) => {
      setBusy(false);
      setFailure(error);
    });
  };
  const failureLine = failure && <p className="inbox-line inbox-error" role="alert">{failure}</p>;

  if (report.followUpTaskId !== null && report.readAt === null) {
    return (
      <div className="agent-report-answer">
        <p className="inbox-line">Follow-up task created but not started.</p>
        {failureLine}
        <div className="agent-report-actions">
          <InboxActionButton
            action="follow-up"
            name={name}
            label="Retry"
            className="btn btn-primary"
            tooltip="Dispatch the follow-up task this report already started. It is never filed twice; if that task was deleted, you are asked for instructions for a new one"
            disabled={busy}
            cardOpen
            onClick={() => run(onFollowUp, "")}
          />
        </div>
      </div>
    );
  }

  switch (target.kind) {
    case "resident-not-running":
      return (
        <div className="agent-report-answer">
          <p className="inbox-line"><strong>{name} isn't running.</strong></p>
          <p className="inbox-line dim">To reply, launch it again from the Residents drawer.</p>
        </div>
      );
    case "unreachable":
      return (
        <div className="agent-report-answer">
          <p className="inbox-line dim">
            {name}'s session is still running but cannot take a message from here. It is not ended,
            so no follow-up task is offered either.
          </p>
        </div>
      );
    case "gone-no-repository":
      return (
        <div className="agent-report-answer">
          <p className="inbox-line dim">
            This session has ended, and its report recorded no repository, so a follow-up task
            cannot be started from here.
          </p>
        </div>
      );
    case "live":
    case "gone": {
      const live = target.kind === "live";
      const label = live ? `Reply to ${name}` : "Instructions for the follow-up task";
      return (
        <div className="agent-report-answer">
          {!live && (
            <p className="inbox-line dim">
              This session has ended and is never resumed. A follow-up task starts a new session
              with this report as its context.
            </p>
          )}
          <textarea
            className="agent-report-reply"
            aria-label={label}
            placeholder={live ? `Reply to ${name}. The message names and restates this report` : "What the follow-up task should do"}
            rows={3}
            value={draft}
            disabled={busy}
            onChange={(event) => onDraft(event.target.value)}
          />
          {failureLine}
          <div className="agent-report-actions">
            {live ? (
              <InboxActionButton
                action="reply"
                name={name}
                className="btn btn-primary"
                tooltip="Send this reply to the agent as your message. It marks the report read"
                disabled={busy || !draft.trim()}
                cardOpen
                onClick={() => run(onReply, draft)}
              />
            ) : (
              <InboxActionButton
                action="follow-up"
                name={name}
                className="btn btn-primary"
                tooltip="Dispatch a new task in this report's repository with your words and the report as context. It marks the report read once the task is dispatched"
                disabled={busy || !draft.trim()}
                cardOpen
                onClick={() => run(onFollowUp, draft)}
              />
            )}
          </div>
        </div>
      );
    }
  }
}

/**
 * A report's attached document: Open report, then Publish as scout, which becomes "Published"
 * and Open archive once the archive holds it. A page the archive's checker refused lists every
 * problem it named, and nothing was published.
 */
function ReportDocumentControls({
  report,
  onOpenDocument,
  onPublish,
  publishState,
  onOpenArchive,
}: {
  report: ReportItem;
  onOpenDocument: () => void;
  onPublish: () => void;
  publishState: ReportPublishState;
  onOpenArchive: () => void;
}): React.JSX.Element {
  const name = report.author.name;
  const { busy, refusal } = publishState;
  const published = report.publishedArchiveKey !== null;
  return (
    <div className="agent-report-document">
      <p className="inbox-line">Attached: {report.document!.name}</p>
      <div className="agent-report-actions">
        <InboxActionButton
          action="open-report"
          name={name}
          className="btn"
          tooltip="Read the attached document from the copy stored when this report was posted. It does not mark the report read"
          cardOpen
          onClick={onOpenDocument}
        />
        {published ? (
          <>
            <span className="agent-report-published" role="status">Published</span>
            <InboxActionButton
              action="open-archive"
              name={name}
              className="btn btn-ghost"
              tooltip="Open this report's archive on the Scouts page"
              onClick={onOpenArchive}
            />
          </>
        ) : (
          <InboxActionButton
            action="publish-scout"
            name={name}
            className="btn btn-ghost"
            tooltip="Save the attached document to the scout archive. Nothing is archived until you press this, and it does not mark the report read"
            disabled={busy}
            cardOpen
            onClick={onPublish}
          />
        )}
      </div>
      {refusal && !published && (
        <div className="inbox-line inbox-error" role="alert">
          <p>{refusal.failed
            // Mission Control's own failure, whose cause only the server knows: a write, a read of
            // the stored copy or the library, or a restart. Its own words lead, never a guess.
            ? refusal.problems.length > 1
              ? "Not published, and nothing is wrong with the document:"
              : `Not published, and nothing is wrong with the document: ${refusal.error}`
            : refusal.problems.length > 1 ? "Not published. The archive refused this document:" : `Not published. ${refusal.error}`}</p>
          {refusal.problems.length > 1 && (
            <ul>
              {refusal.problems.map((problem) => <li key={problem}>{problem}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
