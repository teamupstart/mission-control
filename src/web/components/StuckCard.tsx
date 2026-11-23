import { useEffect, useRef, useState } from "react";
import { canMessage } from "@shared/pane.ts";
import { canInterruptSession } from "@shared/session.ts";
import type { InboxMessageKind } from "@shared/inbox.ts";
import type { Stall, StallFacts, StallKind } from "@shared/stall.ts";
import type { Session } from "@shared/types.ts";
import { api, type ActionResult } from "../lib/api.ts";
import { interruptReport, type InterruptOutcome } from "../lib/interrupting.ts";
import type { AgentNameView } from "../lib/agent-names.ts";
import { AgentName, InboxActionButton } from "./AgentName.tsx";
import { AgentDot } from "./session-bits.tsx";

/**
 * One Stuck row (`inbox` flag): a session the daemon's stall rules flagged, with the rule that
 * fired, why, and the fix in place.
 *
 * Every control is drawn from its `INBOX_ACTIONS` entry through `InboxActionButton`, and only
 * when its target exists: Mark done only with an open task, Resubmit only on a run that a
 * resubmission can move, Tell it to push only with commits the remote has not seen, Continue on
 * a parked run only when neither of those applies and the session's next turn is the step,
 * Interrupt
 * only on a session that can be interrupted, and the message controls only on a session that
 * can receive messages. There is no Cancel, on this card or any other inbox card.
 *
 * Nothing here removes the row. It leaves when the daemon stops reporting the stall, which is
 * when the session has moved, or when the operator dismisses it.
 */

/** The rule that fired, as the row's label names it. */
export const STUCK_RULE_LABELS: Record<StallKind, string> = {
  "silent-working": "Silent while working",
  "unfinished-work": "Idle with work open",
  "workflow-parked": "Workflow run parked",
  escalated: "Foreman escalation unanswered",
};

/** What a completed action reports under the row, by the action that ran. */
const DONE: Record<string, string> = {
  nudge: "Nudge sent.",
  continue: "Asked it to continue.",
  push: "Told it to push.",
  stop: "Interrupted.",
  "mark-done": "Task marked done.",
  resubmit: "Resubmitted the run.",
  message: "Message sent.",
};

const MARK_DONE_OUTCOME = "Marked done from the inbox";

/**
 * What a completed Interrupt reports, in the words the session's own Interrupt uses
 * (`interruptReport`): a turn that had already ended stopped nothing and kept the queue, and a
 * stop that dropped queued messages says how many.
 */
export function interruptDone(result: InterruptOutcome): string {
  return interruptReport(result).flash ?? "Interrupted.";
}

/**
 * A refused action's line under the row. A resubmission of an unchanged repository is refused
 * until someone confirms it, and that confirmation lives on the run's own page, so the line
 * says where to go rather than asking for a control this row does not have.
 */
function refusalText(result: ActionResult & { code?: string }): string {
  const error = result.error ?? "The action failed.";
  return result.code === "workflow_unchanged_repository" ? `${error}. Open run to confirm it there.` : error;
}

export function StuckCard({
  session,
  stall,
  context,
  subject,
  onOpenSession,
  onOpenRun,
  onDismiss,
  onReplyBox,
}: {
  session: Session;
  stall: Stall;
  context: string | null;
  /** The agent's display name, as the row's header and hints print it. */
  subject: AgentNameView;
  onOpenSession: (sessionId: string) => void;
  onOpenRun: (runId: string) => void;
  onDismiss: () => void;
  /**
   * Whether this row is drawing its message box (the escalation's reply box included), reported
   * as it appears and goes: the shared `onReplyBox` contract the transcript's reply box uses, so
   * the session keeps one compose box at a time.
   */
  onReplyBox?: (present: boolean) => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // The row keeps its id (`stuck:<session>`) when the rule or the facts change, so feedback
  // about an action taken on the earlier stall is cleared when this one is a different stall,
  // and the controls are released for it. The draft is kept: it is the operator's words, not a
  // report about an action.
  const identity = `${stall.kind}:${stall.fingerprint ?? stall.reason}`;
  const [shownFor, setShownFor] = useState(identity);
  if (shownFor !== identity) {
    setShownFor(identity);
    setError(null);
    setDone(null);
    setBusy(null);
  }
  // Read when a request settles, so a result can tell whether the stall it was sent for is
  // still the one on screen. `latest` numbers each request, so an older one settling late
  // never releases the controls a newer one is holding.
  const current = useRef(identity);
  current.current = identity;
  const latest = useRef(0);
  // Counts every edit to the message box. A send remembers the count it started at, and its
  // success clears the box only if nothing was typed since: a draft written while the send was
  // pending stays, even when it repeats the words that were sent.
  const draftEdits = useRef(0);
  const facts = stall.facts ?? null;
  const name = subject.name;
  const messageable = canMessage(session) && session.state !== "exited";
  // Reported without depending on the callback's identity, as `TranscriptPanel` does: present
  // while the box is drawn, retracted when it goes or the row unmounts.
  const notifyReplyBox = useRef(onReplyBox);
  notifyReplyBox.current = onReplyBox;
  useEffect(() => {
    if (!messageable) return;
    notifyReplyBox.current?.(true);
    return () => notifyReplyBox.current?.(false);
  }, [messageable]);

  const run = (
    action: string,
    go: () => Promise<ActionResult>,
    after?: () => void,
    describe?: (result: ActionResult) => string,
  ) => () => {
    const request = ++latest.current;
    const sentFor = identity;
    setBusy(action);
    setError(null);
    setDone(null);
    // `api` answers failures as `{ ok: false }` rather than rejecting, but a rejection is still
    // turned into one here, so a request that throws can never leave the row's controls disabled.
    const settled = Promise.resolve()
      .then(go)
      .catch((err: unknown): ActionResult => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    void settled.then((result) => {
      if (request === latest.current) setBusy(null);
      // A sent message has left the box whatever is on screen now, so the draft is cleared.
      if (result.ok) after?.();
      // A result about an earlier stall says nothing about this one: it is not shown.
      if (current.current !== sentFor || request !== latest.current) return;
      if (!result.ok) {
        setError(refusalText(result));
        return;
      }
      setDone(describe ? describe(result) : DONE[action] ?? null);
    });
  };
  const fixed = (kind: InboxMessageKind) => run(kind, () => api.sendInboxMessage(session.id, kind));
  const disabled = busy !== null;

  return (
    <section className="inbox-item inbox-stuck" aria-label={`${name} is stuck`}>
      <div className="inbox-head">
        <AgentDot agent={session.agent} />
        <AgentName view={subject} />
        <span className="inbox-meta">{STUCK_RULE_LABELS[stall.kind]}</span>
        {context && <span className="inbox-context">{context}</span>}
        <span className="inbox-spacer" />
        <InboxActionButton
          action="open-session"
          name={name}
          tooltip="Focus this session on the fleet"
          onClick={() => onOpenSession(session.id)}
        />
        <InboxActionButton
          action="dismiss"
          name={name}
          tooltip="Remove this from the inbox without resolving it. It stays dismissed until it reports something new"
          ariaLabel={`Dismiss ${name} from the inbox`}
          onClick={onDismiss}
        />
      </div>
      <p className="inbox-line inbox-stuck-reason">{stall.reason}</p>
      {facts && <p className="inbox-line">{stuckDetail(facts)}</p>}
      <div className="inbox-actions">
        {facts?.kind === "silent-working" && messageable && (
          <InboxActionButton
            action="nudge"
            name={name}
            className="btn btn-primary"
            tooltip="Ask it for a one-line status and what, if anything, is blocking it"
            disabled={disabled}
            onClick={fixed("nudge")}
          />
        )}
        {facts?.kind === "silent-working" && canInterruptSession(session) && (
          <InboxActionButton
            action="stop"
            name={name}
            tooltip="Stop the turn it is in. Messages queued behind it are dropped"
            disabled={disabled}
            onClick={run("stop", () => api.interrupt(session.id), undefined, interruptDone)}
          />
        )}
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
        {facts?.kind === "workflow-parked" && facts.resubmittable && (
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
          // Nothing a click on the run can move, and nothing to push: the missing step is the
          // session's own next turn (a self-resuming round, or new work to commit), so the row
          // asks it to continue.
          <InboxActionButton
            action="continue"
            name={name}
            className="btn btn-primary"
            tooltip="Ask it to take its next turn on the parked run"
            disabled={disabled}
            onClick={fixed("continue")}
          />
        )}
        {facts?.kind === "workflow-parked" && (
          <InboxActionButton
            action="open-run"
            name={name}
            tooltip="Open this workflow run on the Runs page"
            onClick={() => onOpenRun(facts.runId)}
          />
        )}
      </div>
      {messageable && (
        <div className="inbox-message">
          <textarea
            className="inbox-message-input"
            rows={2}
            value={draft}
            aria-label={facts?.kind === "escalated" ? `Reply to ${name}` : `Message ${name}`}
            placeholder={facts?.kind === "escalated" ? "Reply to what Foreman escalated" : `Message ${name}`}
            onChange={(event) => {
              draftEdits.current += 1;
              setDraft(event.target.value);
            }}
          />
          <InboxActionButton
            action="message"
            name={name}
            label={facts?.kind === "escalated" ? "Reply" : undefined}
            tooltip="Send this to the agent as your message"
            disabled={disabled || draft.trim() === ""}
            onClick={() => {
              const text = draft.trim();
              if (!text) return;
              const editsAtSend = draftEdits.current;
              run("message", () => api.sendText(session.id, text, true), () => {
                if (draftEdits.current === editsAtSend) setDraft("");
              })();
            }}
          />
        </div>
      )}
      {error && (
        <p className="inbox-line inbox-error" role="alert">
          {error}
        </p>
      )}
      {done && !error && (
        <p className="inbox-line" role="status">
          {done}
        </p>
      )}
    </section>
  );
}

/** The one line that says what is open or missing, from the rule's facts. */
export function stuckDetail(facts: StallFacts): string {
  switch (facts.kind) {
    case "silent-working":
      return facts.activity
        ? `Last activity: ${facts.activity}`
        : "It has reported no activity since it went quiet.";
    case "unfinished-work": {
      const queue = facts.queueOpen === 1 ? "1 open queue item" : `${facts.queueOpen} open queue items`;
      if (facts.task) {
        return facts.queueOpen > 0
          ? `Open: the task "${facts.task.title}" and ${queue}.`
          : `Open: the task "${facts.task.title}".`;
      }
      return `Open: ${queue}. A queue's items are handled in the session.`;
    }
    case "workflow-parked": {
      // A run an orchestrator started reviews one exact result, so only that source can submit
      // again (`WorkflowManager.resubmit` refuses it). Said plainly, so the row does not promise
      // that the session's next turn or a resubmission from here would move it.
      if (parkedStep(facts) === "source") {
        return `Missing step: the ${facts.externalSource} that started ${facts.workflowName} must submit again. Neither a resubmission from here nor the session's next turn moves this run.`;
      }
      if (facts.status === "waiting_for_new_head") {
        const unpushed = facts.unpushedCommits === 1 ? "1 commit" : `${facts.unpushedCommits} commits`;
        return facts.unpushedCommits > 0
          ? `Missing step: a pushed head. ${unpushed} on this branch have not been pushed.`
          : `Missing step: a pushed head on this branch for ${facts.workflowName}.`;
      }
      return facts.resubmittable
        ? `Missing step: a resubmission to reopen ${facts.workflowName} round ${facts.round}.`
        : `Missing step: the session's next turn, which reopens ${facts.workflowName} round ${facts.round}.`;
    }
    case "escalated":
      return facts.text ? `Foreman escalated: ${facts.text}` : "Foreman escalated a decision to you.";
  }
}

type ParkedFacts = Extract<StallFacts, { kind: "workflow-parked" }>;

/**
 * Whose step a parked run is waiting on, which decides the one remedy its row offers.
 *
 * - `resubmit`: a manual or Preview round that Resubmit reopens.
 * - `push`: a run waiting for a pushed head, with commits the remote has not seen. Only this
 *   status is moved by a push; a run waiting for the session is not, whatever is unpushed.
 * - `source`: a run an orchestrator started, waiting for the session. Only that source can
 *   submit it again, so nothing on the row moves it.
 * - `next-turn`: everything else, which the session's own next turn moves.
 */
export function parkedStep(facts: ParkedFacts): "resubmit" | "push" | "source" | "next-turn" {
  if (facts.resubmittable) return "resubmit";
  if (facts.status === "waiting_for_new_head") return facts.unpushedCommits > 0 ? "push" : "next-turn";
  if (facts.externalSource !== null) return "source";
  return "next-turn";
}
