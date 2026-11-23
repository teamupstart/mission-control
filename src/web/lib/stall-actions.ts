import { useRef, useState } from "react";
import type { InboxMessageKind } from "@shared/inbox.ts";
import type { Stall, StallFacts, StallKind } from "@shared/stall.ts";
import { api, type ActionResult } from "./api.ts";

/**
 * What a stall's fixes share, wherever a stall is drawn: the inbox's Stuck row (`StuckCard`) and
 * Idle's Stalled card (`StalledTileFacts`). The rule labels, the parked-run rules that decide a
 * run's one remedy and say its missing step, and the hook that runs a fix and reports its outcome.
 *
 * Its own module so neither surface owns the other's behavior: either card can be reworked or
 * removed without the other depending on its file, and a fix cannot come to mean two things.
 */

/** The rule that fired, as a Stuck row's label and a Stalled card's tag name it. */
export const STUCK_RULE_LABELS: Record<StallKind, string> = {
  "silent-working": "Silent while working",
  "unfinished-work": "Idle with work open",
  "workflow-parked": "Workflow run parked",
  escalated: "Foreman escalation unanswered",
};

/** What a completed action reports under the card, by the action that ran. */
const DONE: Record<string, string> = {
  nudge: "Nudge sent.",
  continue: "Asked it to continue.",
  push: "Told it to push.",
  stop: "Interrupted.",
  "mark-done": "Task marked done.",
  resubmit: "Resubmitted the run.",
  message: "Message sent.",
};

/**
 * A refused action's line under the card. A resubmission of an unchanged repository is refused
 * until someone confirms it, and that confirmation lives on the run's own page, so the line
 * says where to go rather than asking for a control the card does not have.
 */
function refusalText(result: ActionResult & { code?: string }): string {
  const error = result.error ?? "The action failed.";
  return result.code === "workflow_unchanged_repository" ? `${error}. Open run to confirm it there.` : error;
}

/**
 * Running a stall's fixes, for the inbox's Stuck row and Idle's Stalled card alike: one request
 * at a time per card, its outcome reported under the card, and nothing about an earlier stall
 * shown against a later one.
 *
 * The card keeps its identity when the rule or the facts change, so feedback about an action
 * taken on the earlier stall is cleared when this one is a different stall, and the controls are
 * released for it.
 */
export function useStallActions(sessionId: string, stall: Stall): {
  busy: string | null;
  error: string | null;
  done: string | null;
  /** A click handler that runs `go`, reports its outcome and calls `after` on success. */
  run: (
    action: string,
    go: () => Promise<ActionResult>,
    after?: () => void,
    describe?: (result: ActionResult) => string,
  ) => () => void;
  /** A click handler that sends one of the fixed messages (Nudge, Continue, Tell it to push). */
  fixed: (kind: InboxMessageKind) => () => void;
} {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
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
    // turned into one here, so a request that throws can never leave the card's controls disabled.
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
  const fixed = (kind: InboxMessageKind) => run(kind, () => api.sendInboxMessage(sessionId, kind));
  return { busy, error, done, run, fixed };
}

export type ParkedFacts = Extract<StallFacts, { kind: "workflow-parked" }>;

/**
 * The step a parked run is missing, as a phrase: the Stuck row prints it after "Missing step:",
 * and the Stalled card under its Missing label.
 */
export function parkedMissingStep(facts: ParkedFacts): string {
  // A run an orchestrator started reviews one exact result, so only that source can submit
  // again (`WorkflowManager.resubmit` refuses it). Said plainly, so the card does not promise
  // that the session's next turn or a resubmission from here would move it.
  if (parkedStep(facts) === "source") {
    return `the ${facts.externalSource} that started ${facts.workflowName} must submit again. Neither a resubmission from here nor the session's next turn moves this run.`;
  }
  if (facts.status === "waiting_for_new_head") {
    const unpushed = facts.unpushedCommits === 1 ? "1 commit" : `${facts.unpushedCommits} commits`;
    return facts.unpushedCommits > 0
      ? `a pushed head. ${unpushed} on this branch have not been pushed.`
      : `a pushed head on this branch for ${facts.workflowName}.`;
  }
  return facts.resubmittable
    ? `a resubmission to reopen ${facts.workflowName} round ${facts.round}.`
    : `the session's next turn, which reopens ${facts.workflowName} round ${facts.round}.`;
}

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
