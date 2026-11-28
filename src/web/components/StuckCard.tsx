import { InboxVoiceFoot } from "./InboxVoiceFoot.tsx";
import { VoiceAnswersContext } from "../lib/voice-open-cards.ts";
import { VoiceRosterContext } from "../lib/voice-roster.ts";
import { useContext, useEffect, useRef, useState } from "react";
import { canMessage } from "@shared/pane.ts";
import { canInterruptSession } from "@shared/session.ts";
import type { Stall, StallFacts } from "@shared/stall.ts";
import type { Session } from "@shared/types.ts";
import { api } from "../lib/api.ts";
import { parkedMissingStep, parkedStep, STUCK_RULE_LABELS, useStallActions } from "../lib/stall-actions.ts";
import { interruptReport, type InterruptOutcome } from "../lib/interrupting.ts";
import type { AgentNameView } from "../lib/agent-names.ts";
import { AgentNameWithCallSign, InboxActionButton } from "./AgentName.tsx";
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

/**
 * What a completed Interrupt reports, in the words the session's own Interrupt uses
 * (`interruptReport`): a turn that had already ended stopped nothing and kept the queue, and a
 * stop that dropped queued messages says how many.
 */
export function interruptDone(result: InterruptOutcome): string {
  return interruptReport(result).flash ?? "Interrupted.";
}

export function StuckCard({
  session,
  stall,
  context,
  subject,
  title = subject,
  onOpenSession,
  onOpenRun,
  onComplete,
  onDismiss,
  onReplyBox,
}: {
  session: Session;
  stall: Stall;
  context: string | null;
  /** The agent's name as its spoken hints say it: the call sign, where one names it. */
  subject: AgentNameView;
  /**
   * The name the row's header prints, when it differs from `subject`: the title with the call
   * sign beside it (`agentNamePairView`). Defaults to `subject`. The row's accessible names (its
   * label, Dismiss and message box) follow this visible title; only spoken hints use `subject`.
   */
  title?: AgentNameView;
  onOpenSession: (sessionId: string) => void;
  onOpenRun: (runId: string) => void;
  /** Absent where nothing can host the Complete dialog, and Mark done is not drawn. */
  onComplete?: (sessionId: string) => void;
  onDismiss: () => void;
  /**
   * Whether this row is drawing its message box (the escalation's reply box included), reported
   * as it appears and goes: the shared `onReplyBox` contract the transcript's reply box uses, so
   * the session keeps one compose box at a time.
   */
  onReplyBox?: (present: boolean) => void;
}): React.JSX.Element {
  const { busy, error, done, run, fixed } = useStallActions(session.id, stall);
  // The draft is kept across a change of stall: it is the operator's words, not a report about
  // an action.
  const [draft, setDraft] = useState("");
  // Counts every edit to the message box. A send remembers the count it started at, and its
  // success clears the box only if nothing was typed since: a draft written while the send was
  // pending stays, even when it repeats the words that were sent.
  const draftEdits = useRef(0);
  const facts = stall.facts ?? null;
  const name = title.name;
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

  const disabled = busy !== null;
  const voice = !!useContext(VoiceAnswersContext);
  const speaker = useContext(VoiceRosterContext).find(r => r.sessionId === session.id);
  const sendMessage = (text: string) => {
    if (!text.trim()) return;
    const editsAtSend = draftEdits.current;
    run("message", () => api.sendText(session.id, text.trim(), true), () => {
      if (text === draft && draftEdits.current === editsAtSend) setDraft("");
    })();
  };

  return (
    <section data-voice-kind={voice ? "stuck" : undefined} data-voice-id={session.id} data-voice-session={session.id} data-voice-key={speaker?.key} className="inbox-item inbox-stuck" aria-label={`${name} is stuck`}>
      <div className="inbox-head">
        <AgentDot agent={session.agent} />
        <AgentNameWithCallSign view={title} />
        <span className="inbox-meta">{STUCK_RULE_LABELS[stall.kind]}</span>
        {context && <span className="inbox-context">{context}</span>}
        <span className="inbox-spacer" />
        <InboxActionButton
          action="open-session"
          name={subject}
          tooltip="Focus this session on the fleet"
          onClick={() => onOpenSession(session.id)}
        />
        <InboxActionButton
          action="dismiss"
          name={subject}
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
            name={subject}
            className="btn btn-primary"
            tooltip="Ask it for a one-line status and what, if anything, is blocking it"
            disabled={disabled}
            onClick={fixed("nudge")}
          />
        )}
        {facts?.kind === "silent-working" && canInterruptSession(session) && (
          <InboxActionButton
            action="stop"
            name={subject}
            tooltip="Stop the turn it is in. Messages queued behind it are dropped"
            disabled={disabled}
            onClick={run("stop", () => api.interrupt(session.id), undefined, interruptDone)}
          />
        )}
        {facts?.kind === "unfinished-work" && messageable && (
          <InboxActionButton
            action="continue"
            name={subject}
            className="btn btn-primary"
            tooltip="Ask it to pick the open work up where it stopped"
            disabled={disabled}
            onClick={fixed("continue")}
          />
        )}
        {facts?.kind === "unfinished-work" && facts.task && onComplete && (
          <InboxActionButton
            action="mark-done"
            name={subject}
            tooltip="Open the Complete dialog: the work is finished and nothing more is owed. It marks the task done, closes the session, and offers a retro when one is worth running"
            disabled={disabled}
            onClick={() => onComplete(session.id)}
          />
        )}
        {facts?.kind === "workflow-parked" && facts.resubmittable && (
          <InboxActionButton
            action="resubmit"
            name={subject}
            className="btn btn-primary"
            tooltip="Open the run's next repair round from the session's current work"
            disabled={disabled}
            onClick={run("resubmit", () => api.resubmitWorkflowRun(facts.runId))}
          />
        )}
        {facts?.kind === "workflow-parked" && parkedStep(facts) === "push" && messageable && (
          <InboxActionButton
            action="push"
            name={subject}
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
            name={subject}
            className="btn btn-primary"
            tooltip="Ask it to take its next turn on the parked run"
            disabled={disabled}
            onClick={fixed("continue")}
          />
        )}
        {facts?.kind === "workflow-parked" && (
          <InboxActionButton
            action="open-run"
            name={subject}
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
            name={subject}
            label={facts?.kind === "escalated" ? "Reply" : undefined}
            tooltip="Send this to the agent as your message"
            disabled={disabled || draft.trim() === ""}
            onDictate={sendMessage}
            dictateDisabled={disabled}
            onClick={() => sendMessage(draft)}
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
      {voice && <InboxVoiceFoot name={speaker} />}
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
    case "workflow-parked":
      return `Missing step: ${parkedMissingStep(facts)}`;
    case "escalated":
      return facts.text ? `Foreman escalated: ${facts.text}` : "Foreman escalated a decision to you.";
  }
}
