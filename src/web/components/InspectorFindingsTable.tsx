import { Fragment, useState } from "react";
import type { InspectorComment, InspectorCommentStatus, InspectorSeverity } from "@shared/types.ts";
import { findingPublication, refusalTimes } from "@shared/inspector-findings.ts";
import type { PipelineStatus } from "../workflows/pipeline-bits.tsx";
import { Tooltip } from "./Tooltip.tsx";

/**
 * GitHub Inspector's findings on one pull request, shared by every view that lists them. Callers
 * own the caption and the empty state.
 */

export function inspectorFindingSeverityStatus(severity: InspectorSeverity): PipelineStatus {
  return severity === "blocker" || severity === "major"
    ? { tone: "failed", label: severity }
    : { tone: "waiting", label: severity };
}

export function inspectorFindingStatusStatus(status: InspectorCommentStatus): PipelineStatus {
  if (status === "resolved") return { tone: "passed", label: status };
  return status === "posting"
    ? { tone: "waiting", label: status }
    : { tone: "failed", label: status };
}

export function inspectorFindingLocation(finding: InspectorComment): string {
  if (!finding.path) return "general";
  return finding.line ? `${finding.path}:${finding.line}` : finding.path;
}

/** Shown for a row created before finding bodies were persisted. */
const LEGACY_FINDING_SENTENCE =
  "Legacy finding: detail was not persisted by the GitHub Inspector version that created this row.";

export function inspectorFindingBody(finding: InspectorComment): string {
  return finding.body ?? LEGACY_FINDING_SENTENCE;
}

export const UNKNOWN_POSTED_TOOLTIP = "Recorded before Mission Control tracked posting";

export interface InspectorFindingPostedCell {
  label: string;
  /** The GitHub comment the label links to, or null for plain text. */
  href: string | null;
  tooltip: string | null;
  /** A second line under the label: how often GitHub refused a draft. Null for none. */
  note: string | null;
}

/** GitHub's reason a draft was refused, as its tooltip and its detail row both say it. */
export function inspectorFindingRefusalReason(finding: InspectorComment): string | null {
  const publication = findingPublication(finding);
  if (publication.refusals === 0) return null;
  return publication.reason ?? "GitHub gave no reason";
}

/**
 * A posted finding without a captured link still reads "Posted": the Inspector records the link
 * on a later pass.
 */
export function inspectorFindingPostedCell(finding: InspectorComment): InspectorFindingPostedCell {
  const publication = findingPublication(finding);
  const refusal = inspectorFindingRefusalReason(finding);
  const reasonTip = refusal ? `GitHub's reason: ${refusal}` : null;
  const note = refusal ? `GitHub refused it ${refusalTimes(publication.refusals)}` : null;
  // A draft posted earlier links to that version, refused or not: it is still where it lives.
  const earlier = (base: string): InspectorFindingPostedCell => ({
    label: `${base} (posted earlier)`,
    href: publication.url,
    tooltip: [
      reasonTip,
      publication.url
        ? "Not posted again. Open the earlier version on GitHub"
        : "Not posted again. An earlier version was posted on GitHub",
    ].filter((part): part is string => part !== null).join(". "),
    note,
  });
  switch (publication.state) {
    case "posted":
      return publication.url
        ? { label: "Posted", href: publication.url, tooltip: "Open this finding on GitHub", note: null }
        : {
          label: "Posted",
          href: null,
          tooltip: "Posted on GitHub. The link is recorded on GitHub Inspector's next pass",
          note: null,
        };
    case "not-posted":
      if (publication.earlierPost) return earlier("Not posted");
      return { label: "Not posted", href: null, tooltip: reasonTip, note };
    case "refused":
      // No longer offered. It stays unresolved, so its Status still reads drafted.
      if (publication.earlierPost) return earlier("Refused");
      return { label: "Refused", href: null, tooltip: reasonTip, note };
    case "posting":
      return { label: "Posting", href: null, tooltip: null, note: null };
    case "unknown":
      return { label: "Unknown", href: null, tooltip: UNKNOWN_POSTED_TOOLTIP, note: null };
    default: {
      const exhaustive: never = publication.state;
      return exhaustive;
    }
  }
}

function PostedCell({ finding }: { finding: InspectorComment }): React.JSX.Element {
  const cell = inspectorFindingPostedCell(finding);
  let label: React.JSX.Element;
  if (cell.href) {
    label = (
      <Tooltip label={cell.tooltip ?? "Open on GitHub"}>
        <a href={cell.href} target="_blank" rel="noreferrer">{cell.label}</a>
      </Tooltip>
    );
  } else {
    label = cell.tooltip
      ? <Tooltip label={cell.tooltip}><span>{cell.label}</span></Tooltip>
      : <span>{cell.label}</span>;
  }
  if (!cell.note) return label;
  return (
    <>
      {label}
      <span className="inspector-finding-refusals">{cell.note}</span>
    </>
  );
}

const COLUMNS = ["Severity", "Finding", "Where", "Round", "Status", "Posted", "Detail"] as const;

function when(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

export function InspectorFindingsTable({
  findings,
  caption,
}: {
  findings: readonly InspectorComment[];
  /** The screen-reader caption, which says whose findings these are. */
  caption: string;
}): React.JSX.Element {
  const [openFinding, setOpenFinding] = useState<string | null>(null);
  return (
    <div className="wf-run-table wf-run-ledger">
      <table>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {COLUMNS.map((column) => <th key={column}>{column}</th>)}
          </tr>
        </thead>
        <tbody>
          {findings.map((finding) => {
            const severity = inspectorFindingSeverityStatus(finding.severity);
            const status = inspectorFindingStatusStatus(finding.status);
            const open = openFinding === finding.id;
            // An unresolved finding's body is never behind a disclosure.
            const unresolved = finding.status !== "resolved";
            const refusal = inspectorFindingRefusalReason(finding);
            return (
              <Fragment key={finding.id}>
                <tr className={`wf-run-ledger-row wf-run-finding-row is-${finding.severity}`}>
                  <td>
                    <span className={`workflow-chip workflow-${severity.tone}`}>
                      {severity.label}
                    </span>
                  </td>
                  <td>{finding.title}</td>
                  <td><code>{inspectorFindingLocation(finding)}</code></td>
                  <td>{finding.round}</td>
                  <td>
                    <span className={`workflow-chip workflow-${status.tone}`}>
                      {status.label}
                    </span>
                  </td>
                  <td><PostedCell finding={finding} /></td>
                  <td>
                    <Tooltip label={open
                      ? "Hide this finding's fingerprint and its timestamps"
                      : "Show the fingerprint the gate tracks this finding by, and when it moved"}>
                      <button
                        className="btn btn-ghost wf-run-ledger-toggle"
                        aria-expanded={open}
                        aria-controls={`wf-run-finding-${finding.id}`}
                        onClick={() => setOpenFinding(open ? null : finding.id)}
                      >
                        {open ? "Hide finding" : "Show finding"}
                      </button>
                    </Tooltip>
                  </td>
                </tr>
                {unresolved && (
                  <tr className="wf-run-ledger-alert">
                    <td colSpan={COLUMNS.length}>
                      <p className="wf-run-sentence">{inspectorFindingBody(finding)}</p>
                    </td>
                  </tr>
                )}
                {open && (
                  <tr className="wf-run-ledger-detail" id={`wf-run-finding-${finding.id}`}>
                    <td colSpan={COLUMNS.length}>
                      {!unresolved && <p>{inspectorFindingBody(finding)}</p>}
                      <dl className="wf-run-facts-list">
                        <div><dt>Fingerprint</dt><dd><code>{finding.fingerprint}</code></dd></div>
                        {refusal !== null && (
                          <div><dt>Why GitHub refused it</dt><dd>{refusal}</dd></div>
                        )}
                        <div><dt>Recorded</dt><dd>{when(finding.createdAt)}</dd></div>
                        <div><dt>Last change</dt><dd>{when(finding.updatedAt)}</dd></div>
                      </dl>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
