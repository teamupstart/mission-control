import { Fragment } from "react";
import { canMessage } from "@shared/pane.ts";
import type { Stall } from "@shared/stall.ts";
import type { Session } from "@shared/types.ts";
import { stalledFactRows } from "../lib/stalled.ts";
import { api } from "../lib/api.ts";
import { Tooltip } from "./Tooltip.tsx";
import { InboxActionButton } from "./AgentName.tsx";
import { parkedStep, STUCK_RULE_LABELS, useStallActions } from "../lib/stall-actions.ts";

type StalledFactsProps = {
  session: Session;
  stall: Stall;
  onMessage?: () => void;
  onOpenQueue?: () => void;
  /** Open the session's Complete dialog. Absent where nothing can host it, and Mark done is not drawn. */
  onComplete?: () => void;
  onOpenRun?: (runId: string) => void;
  /** Hide this stall until its facts change; absent where nothing can record a dismissal. */
  onDismiss?: () => void;
};

/**
 * A Stalled card's fact sheet and fixes (`idle-stalled`): what is open, what the session last did
 * and what Foreman made of it, then the step that moves it, in place.
 *
 * This is what replaced the inbox's Stuck row for an idle stall. That row said a session was
 * stuck and little else; the card already says which session, which repository and which branch,
 * so this adds only what the stall rule observed and the session's own last words on it.
 *
 * The fixes are the Stuck row's, from the same `INBOX_ACTIONS` entries and the same
 * `useStallActions`, so a fix cannot come to mean two things. Mark done goes through `onComplete`
 * here and on the Stuck row, so a stalled session completes like any other. Only the two idle kinds
 * reach here.
 * Clicks stop at this panel: the tile's own click opens the session, and a fix pressed on a card
 * must not also drill into it.
 */
export function StalledTileFacts({
  session,
  stall,
  onOpenRun,
  onMessage,
  onOpenQueue,
  onComplete,
  onDismiss,
}: StalledFactsProps): React.JSX.Element | null {
  const { busy, error, done, run, fixed } = useStallActions(session.id, stall);
  const facts = stall.facts ?? null;
  const name = session.name || "this session";
  const messageable = canMessage(session) && session.state !== "exited";
  const disabled = busy !== null;
  const runId = stall.kind === "workflow-parked"
    ? (facts?.kind === "workflow-parked" ? facts.runId : stall.workflowRunId)
    : undefined;
  const showMessage = !facts
    || (facts.kind === "unfinished-work" && facts.task)
    || (facts.kind === "workflow-parked" && parkedStep(facts) === "new-head");
  const rows = stalledFactRows(session, stall);

  return (
    <div
      className="stalled-facts"
      role="group"
      aria-label={`Why ${name} stalled`}
      onClick={(event) => event.stopPropagation()}
    >
      <dl>
        {rows.map((row) => (
          <Fragment key={row.label}>
            <dt>{row.label}</dt>
            <dd className={row.tone ? `is-${row.tone}` : undefined}>{row.value}{row.detail && <span className="stalled-task-status"> · {row.detail}</span>}</dd>
          </Fragment>
        ))}
      </dl>
      <div className="stalled-actions">
        {stall.kind === "unfinished-work" && messageable && (
          <InboxActionButton
            action="nudge"
            name={name}
            className="btn btn-primary"
            tooltip="Ask what it is doing and whether anything is blocking it"
            disabled={disabled}
            onClick={fixed("nudge")}
          />
        )}
        {showMessage && messageable && onMessage && (
          <Tooltip label="Open the session and focus its message box">
            <button type="button" className="btn btn-ghost" onClick={onMessage}>Message…</button>
          </Tooltip>
        )}
        {facts?.kind === "unfinished-work" && facts.queueOpen > 0 && onOpenQueue && (
          <Tooltip label="Open this session's work queue">
            <button type="button" className="btn btn-ghost" onClick={onOpenQueue}>Open queue</button>
          </Tooltip>
        )}
        {facts?.kind === "unfinished-work" && facts.task && onComplete && (
          <InboxActionButton
            action="mark-done"
            name={name}
            tooltip="Open the Complete dialog: the work is finished and nothing more is owed. It marks the task done, closes the session, and offers a retro when one is worth running"
            disabled={disabled}
            onClick={onComplete}
          />
        )}
        {facts?.kind === "workflow-parked" && parkedStep(facts) === "resubmit" && (
          <InboxActionButton
            action="resubmit"
            name={name}
            className="btn btn-primary"
            tooltip="Open the run's next repair round from the session's current work"
            disabled={disabled}
            onClick={run("resubmit", () => api.resubmitWorkflowRun(facts.runId))}
          />
        )}
        {facts?.kind === "workflow-parked" && parkedStep(facts) === "push" && messageable && (
          <InboxActionButton
            action="push"
            name={name}
            className="btn btn-primary"
            tooltip="Tell it to push: the review waits for a pushed head on this branch"
            disabled={disabled}
            onClick={fixed("push")}
          />
        )}
        {facts?.kind === "workflow-parked" && parkedStep(facts) === "next-turn" && messageable && (
          <InboxActionButton
            action="continue"
            name={name}
            className="btn btn-primary"
            tooltip="Ask it to take its next turn on the parked run"
            disabled={disabled}
            onClick={fixed("continue")}
          />
        )}
        {runId && onOpenRun && (
          <InboxActionButton
            action="open-run"
            name={name}
            tooltip="Open this workflow run on the Runs page"
            onClick={() => onOpenRun(runId)}
          />
        )}
        {onDismiss && (
          <InboxActionButton
            action="dismiss"
            name={name}
            tooltip="Return this card to the rest of Idle without resolving it. It comes back if the session stalls on something new"
            ariaLabel={`Dismiss ${name} from Stalled`}
            onClick={onDismiss}
          />
        )}
      </div>
      {error && <p className="stalled-feedback is-error" role="alert">{error}</p>}
      {done && !error && <p className="stalled-feedback" role="status">{done}</p>}
    </div>
  );
}

/**
 * The same fact sheet and fixes as a band in the session detail, for the Console layout and the
 * Board's drill-in (`idle-stalled`). The rail row shows only the first fact, and an idle stall the
 * Stalled section draws is no longer an inbox row, so without this an operator who works in the
 * Console would see the mark with no way to act on it or dismiss it.
 */
export function StalledBand(props: StalledFactsProps): React.JSX.Element {
  return (
    <section className="stalled-band" aria-label="Session stalled">
      <div className="stalled-band-top">
        <span className="stalled-band-flag">Stalled</span>
        <span className="stalled-band-rule">{STUCK_RULE_LABELS[props.stall.kind]}</span>
      </div>
      <StalledTileFacts {...props} />
    </section>
  );
}
