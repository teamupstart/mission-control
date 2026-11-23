import { useState } from "react";
import { FOREMAN_HEALTH_LABELS } from "@shared/foreman-health.ts";
import type { ForemanHealthIssue, ForemanHealthStatus } from "@shared/foreman-health.ts";
import { useCopyFeedback } from "../lib/clipboard.ts";
import { relativeTime } from "../lib/format.ts";
import { Tooltip } from "./Tooltip.tsx";

/**
 * Acknowledge the occurrences on screen. Resolves to a sentence explaining why some were not
 * hidden, or null once the daemon has hidden them all. A dismissed group returns on its next
 * occurrence.
 */
export type DismissForemanErrors = (issues: ForemanHealthIssue[]) => Promise<string | null>;

export function ForemanErrors({ health, running, enabled, onOpenModels, onDismiss }: {
  health: ForemanHealthStatus;
  running: boolean;
  enabled: boolean;
  onOpenModels: () => void;
  onDismiss: DismissForemanErrors;
}): React.JSX.Element {
  const [dismissing, setDismissing] = useState(false);
  const [dismissError, setDismissError] = useState<string | null>(null);
  async function dismiss(issues: ForemanHealthIssue[]): Promise<void> {
    setDismissing(true);
    setDismissError(null);
    const failure = await onDismiss(issues);
    setDismissing(false);
    if (failure !== null) setDismissError(failure);
  }
  return (
    <section className="foreman-errors" aria-label="Foreman errors">
      <div className="foreman-errors-head">
        <strong>⚠ Foreman needs attention</strong>
        <span>{health.issues.length} {health.issues.length === 1 ? "issue" : "issues"}</span>
      </div>
      <p className="foreman-errors-state">
        {running ? "Worker running" : "Worker not running"}
        {enabled ? ". Foreman has reported errors." : ". Foreman is disabled."}
        {!health.current && " Showing the last worker report; current error status is unavailable."}
      </p>
      <p className="foreman-errors-hint">Repeated errors update these groups without repeated alerts. A dismissed error returns if it happens again.</p>
      {health.issues.length > 1 && (
        <div className="foreman-error-actions">
          <Tooltip label="Hide every error below until it happens again">
            <button type="button" className="btn btn-ghost" disabled={dismissing}
              onClick={() => void dismiss(health.issues)}>Dismiss all</button>
          </Tooltip>
        </div>
      )}
      {dismissError && <p className="foreman-errors-hint" role="alert">{dismissError}</p>}
      {health.issues.map((issue, index) => index === 0 ? (
        <Issue key={issue.id} issue={issue} onOpenModels={onOpenModels}
          dismissing={dismissing} onDismiss={() => void dismiss([issue])} />
      ) : (
        <details className="foreman-error-group" key={issue.id}>
          <Tooltip label="Expand or collapse this error's details">
            <summary>{FOREMAN_HEALTH_LABELS[issue.operation]} error · {issue.count} {issue.count === 1 ? "occurrence" : "occurrences"}</summary>
          </Tooltip>
          <Issue issue={issue} onOpenModels={onOpenModels}
            dismissing={dismissing} onDismiss={() => void dismiss([issue])} />
        </details>
      ))}
      {health.truncated && <p className="foreman-errors-hint">Only the most recent error groups are retained.</p>}
    </section>
  );
}

/** The clipboard text for one group: activity, provider and model, then the diagnostic. */
export function foremanErrorCopyText(issue: ForemanHealthIssue): string {
  return [
    `Foreman ${FOREMAN_HEALTH_LABELS[issue.operation]}`,
    [issue.runner, issue.model].filter(Boolean).join(" · "),
    issue.error,
  ].filter(Boolean).join("\n");
}

function Issue({ issue, onOpenModels, dismissing, onDismiss }: {
  issue: ForemanHealthIssue;
  onOpenModels: () => void;
  dismissing: boolean;
  onDismiss: () => void;
}): React.JSX.Element {
  const copy = useCopyFeedback({ resetOn: issue.error });
  return (
    <article className="foreman-error-issue">
      <strong>{FOREMAN_HEALTH_LABELS[issue.operation]} error</strong>
      {issue.runner && <p className="foreman-error-model">{issue.runner} · <code>{issue.model}</code></p>}
      <div className="foreman-error-received">
        <span>Error received</span>
        <pre>{issue.error}</pre>
      </div>
      <div className="foreman-error-counts">
        <span>{issue.count.toLocaleString()} {issue.count === 1 ? "occurrence" : "occurrences"}</span>
        {issue.sessions.length > 0 && (
          <span>Seen in {issue.sessions.length}{issue.sessionsTruncated ? "+" : ""} {issue.sessions.length === 1 ? "session" : "sessions"}</span>
        )}
      </div>
      <p className="foreman-errors-hint">
        <Tooltip label={`First seen at ${new Date(issue.firstSeenAt).toLocaleString()}`}>
          <span>First seen {relativeTime(issue.firstSeenAt)}</span>
        </Tooltip>
        {" · "}
        <Tooltip label={`Last seen at ${new Date(issue.lastSeenAt).toLocaleString()}`}>
          <span>Last seen {relativeTime(issue.lastSeenAt)}</span>
        </Tooltip>
      </p>
      {issue.sessions.length > 0 && (
        <details className="foreman-error-sessions">
          <Tooltip label="Expand or collapse the sessions where this error was seen">
            <summary>Show affected sessions</summary>
          </Tooltip>
          <ul>{issue.sessions.map((session) => <li key={session.id}>{session.name || session.id}</li>)}</ul>
          {issue.sessionsTruncated && <p className="foreman-errors-hint">Showing the first {issue.sessions.length} session names.</p>}
        </details>
      )}
      <div className="foreman-error-actions">
        {issue.runner && <Tooltip label="Choose the provider and model for each Foreman activity">
          <button type="button" className="btn btn-ghost" onClick={onOpenModels}>Open model settings</button>
        </Tooltip>}
        <Tooltip label="Copy this error and its provider and model to the clipboard">
          <button type="button" className="btn btn-ghost"
            onClick={() => void copy.copy(() => foremanErrorCopyText(issue))}>Copy error</button>
        </Tooltip>
        <Tooltip label="Hide this error until it happens again">
          <button type="button" className="btn btn-ghost" disabled={dismissing} onClick={onDismiss}>Dismiss</button>
        </Tooltip>
      </div>
      {(copy.copied || copy.error !== null) && <p className="foreman-errors-hint" role="status">
        {copy.copied ? "Error copied" : "Could not copy. Select the error text to copy it."}
      </p>}
    </article>
  );
}
