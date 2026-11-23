import { Fragment } from "react";
import { canMessage } from "@shared/pane.ts";
import type { Stall } from "@shared/stall.ts";
import type { Session } from "@shared/types.ts";
import { api } from "../lib/api.ts";
import { InboxActionButton } from "./AgentName.tsx";
import { parkedMissingStep, parkedStep, useStallActions } from "../lib/stall-actions.ts";

/** What a task completed from a Stalled card records as its outcome. */
const MARK_DONE_OUTCOME = "Marked done from the Stalled section";

/**
 * A Stalled card's fact sheet and fixes (`idle-stalled`): what is open, what the session last did
 * and what Foreman made of it, then the step that moves it, in place.
 *
 * This is what replaced the inbox's Stuck row for an idle stall. That row said a session was
 * stuck and little else; the card already says which session, which repository and which branch,
 * so this adds only what the stall rule observed and the session's own last words on it.
 *
 * The fixes are the Stuck row's, from the same `INBOX_ACTIONS` entries and the same
 * `useStallActions`, so a fix cannot come to mean two things. Only the two idle kinds reach here.
 * Clicks stop at this panel: the tile's own click opens the session, and a fix pressed on a card
 * must not also drill into it.
 */
export function StalledTileFacts({
  session,
  stall,
  onOpenRun,
  onDismiss,
}: {
  session: Session;
  stall: Stall;
  onOpenRun?: (runId: string) => void;
  /** Hide this stall until its facts change; absent where nothing can record a dismissal. */
  onDismiss?: () => void;
}): React.JSX.Element | null {
  const { busy, error, done, run, fixed } = useStallActions(session.id, stall);
  const facts = stall.facts ?? null;
  const name = session.name || "this session";
  const messageable = canMessage(session) && session.state !== "exited";
  const disabled = busy !== null;
  const note = session.note?.brief || session.note?.lastAction || null;

  const rows: { label: string; value: string; tone?: "muted" | "warn" }[] = [];
  if (facts?.kind === "unfinished-work") {
    if (facts.task) rows.push({ label: "Task", value: facts.task.title });
    if (facts.queueOpen > 0) {
      rows.push({ label: "Queue", value: facts.queueOpen === 1 ? "1 open item" : `${facts.queueOpen} open items` });
    }
  } else if (facts?.kind === "workflow-parked") {
    rows.push({
      label: "Waiting",
      value: facts.status === "waiting_for_new_head"
        ? `${facts.workflowName} round ${facts.round} waits for a pushed head`
        : `${facts.workflowName} round ${facts.round} never reopened`,
    });
    rows.push({ label: "Missing", value: parkedMissingStep(facts), tone: "warn" });
  } else {
    // A stall from a daemon that predates facts: its sentence is all there is to say.
    rows.push({ label: "Why", value: stall.reason });
  }
  rows.push({ label: "Last", value: session.activity ?? "No activity reported", tone: "muted" });
  if (note) rows.push({ label: "Foreman", value: note });

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
            <dd className={row.tone ? `is-${row.tone}` : undefined}>{row.value}</dd>
          </Fragment>
        ))}
      </dl>
      <div className="stalled-actions">
        {facts?.kind === "unfinished-work" && messageable && (
          <InboxActionButton
            action="continue"
            name={name}
            className="btn btn-primary"
            tooltip="Ask it to pick the open work up where it stopped"
            disabled={disabled}
            onClick={fixed("continue")}
          />
        )}
        {facts?.kind === "unfinished-work" && facts.task && (
          <InboxActionButton
            action="mark-done"
            name={name}
            tooltip="Complete this session's task: the work is finished and nothing more is owed"
            disabled={disabled}
            onClick={run("mark-done", () => api.completeTask(facts.task!.id, MARK_DONE_OUTCOME))}
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
        {facts?.kind === "workflow-parked" && onOpenRun && (
          <InboxActionButton
            action="open-run"
            name={name}
            tooltip="Open this workflow run on the Runs page"
            onClick={() => onOpenRun(facts.runId)}
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
