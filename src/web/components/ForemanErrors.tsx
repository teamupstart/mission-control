import { useState } from "react";
import { FOREMAN_HEALTH_LABELS } from "@shared/foreman-health.ts";
import type { ForemanHealthIssue, ForemanHealthStatus } from "@shared/foreman-health.ts";
import { relativeTime } from "../lib/format.ts";
import { Tooltip } from "./Tooltip.tsx";

export function ForemanErrors({ health, running, enabled, onOpenModels }: {
  health: ForemanHealthStatus;
  running: boolean;
  enabled: boolean;
  onOpenModels: () => void;
}): React.JSX.Element {
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
      <p className="foreman-errors-hint">Repeated errors update these groups without repeated alerts.</p>
      {health.issues.map((issue, index) => index === 0 ? (
        <Issue key={issue.id} issue={issue} onOpenModels={onOpenModels} />
      ) : (
        <details className="foreman-error-group" key={issue.id}>
          <Tooltip label="Expand or collapse this error's details">
            <summary>{FOREMAN_HEALTH_LABELS[issue.operation]} error · {issue.count} {issue.count === 1 ? "occurrence" : "occurrences"}</summary>
          </Tooltip>
          <Issue issue={issue} onOpenModels={onOpenModels} />
        </details>
      ))}
      {health.truncated && <p className="foreman-errors-hint">Only the most recent error groups are retained.</p>}
    </section>
  );
}

function Issue({ issue, onOpenModels }: { issue: ForemanHealthIssue; onOpenModels: () => void }): React.JSX.Element {
  const [copy, setCopy] = useState<{ error: string; ok: boolean } | null>(null);
  async function copyError(): Promise<void> {
    try {
      await navigator.clipboard.writeText([
        `Foreman ${FOREMAN_HEALTH_LABELS[issue.operation]}`,
        [issue.runner, issue.model].filter(Boolean).join(" · "),
        issue.error,
      ].filter(Boolean).join("\n"));
      setCopy({ error: issue.error, ok: true });
    } catch { setCopy({ error: issue.error, ok: false }); }
  }
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
          <button type="button" className="btn btn-ghost" onClick={() => void copyError()}>Copy error</button>
        </Tooltip>
      </div>
      {copy?.error === issue.error && <p className="foreman-errors-hint" role="status">
        {copy.ok ? "Error copied" : "Could not copy. Select the error text to copy it."}
      </p>}
    </article>
  );
}
