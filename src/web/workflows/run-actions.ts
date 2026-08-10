import type {
  WorkflowBindingState,
  WorkflowDelivery,
  WorkflowRunDetail,
} from "@shared/workflow.ts";
import {
  WORKFLOW_LIMITS,
  manualWorkflowTriggerRequestId,
  workflowRunGaveUp,
  workflowRunIsOpen,
} from "@shared/workflow.ts";
// One-directional: this module reads `run-model`'s derivations at runtime, and `run-model` takes
// only a TYPE from here, so there is no cycle to resolve at load.
import {
  blockedPhaseClause,
  gateWaitSentence,
  orderedSubmissions,
} from "./run-model.ts";
import type { WorkflowConfirmRequest } from "./WorkflowConfirmModal.tsx";

/**
 * How many rounds the run-detail grant hands over at once.
 *
 * Two rather than one, because one buys a single attempt and a round-limited run has just
 * demonstrated that a single attempt was not enough - an operator who has to click through
 * a confirmation for every retry learns to raise the binding instead, which is the setting
 * that governs every FUTURE run rather than this stuck one.
 */
const GRANT_ROUNDS = 2;

export type RunActionId = string;
export type WorkflowDeliveryResolution =
  | "mark_delivered"
  | "discard_and_new_round";

export type WorkflowConfirmDescriptor = Omit<WorkflowConfirmRequest, "onConfirm">;

export interface RunActionDescriptor {
  id: RunActionId;
  label: string;
  tooltip: string;
  disabled: boolean;
}

export interface CopyFeedbackAction extends RunActionDescriptor {
  kind: "copy-feedback";
}

export type GateAction =
  | (RunActionDescriptor & { kind: "prepare-pr" })
  | (RunActionDescriptor & { kind: "recheck-inspector" })
  | (RunActionDescriptor & {
      kind: "open-pr";
      /**
       * NON-nullable, and that is the type doing the work rather than a comment.
       *
       * `inspectorGateActions` pushes this arm only when there is a pull request to open, so
       * the compiler now rejects a reintroduction of the destination-less entry - a better
       * guard than a test, because it fails at the point somebody writes it.
       */
      href: string;
    });

export interface DeliveryAction extends RunActionDescriptor {
  kind: "resolve-delivery";
  deliveryId: WorkflowDelivery["id"];
  resolution: WorkflowDeliveryResolution;
  confirm: WorkflowConfirmDescriptor;
}

export function copyFeedbackAction(
  detail: WorkflowRunDetail,
  copied = false,
): CopyFeedbackAction {
  const available = detail.deliveries.some((delivery) => delivery.payload.length > 0)
    || detail.attempts.some((attempt) => attempt.verdict);
  return {
    id: "copy-feedback",
    kind: "copy-feedback",
    label: copied ? "Copied" : "Copy feedback",
    tooltip: available
      ? "Copy every reviewer verdict to the clipboard"
      : detail.deliveries.some((delivery) => delivery.payloadPrunedAt != null)
        ? "Raw delivery feedback was pruned and no Persona verdict remains"
        : "No workflow feedback has been recorded yet",
    disabled: !available,
  };
}

/**
 * The Inspector gate's complete action vocabulary.
 *
 * Filtering lives here so the Runs page and the session detail cannot disagree about whether
 * a run's own immutable completion policy offers a PR handoff.
 */
export function inspectorGateActions(detail: WorkflowRunDetail): GateAction[] {
  const gate = detail.inspectorGate;
  const actions: GateAction[] = [];
  if (
    gate
    && detail.run.status === "waiting_for_pr"
    && (gate.state.waitReason === "missing_pr"
      || gate.state.waitReason === "unadopted_pr")
    && detail.version?.completionPolicy.kind === "inspector"
    && detail.version.completionPolicy.missingPrAction === "offer_prepare_pr"
  ) {
    actions.push({
      id: "prepare-pr",
      kind: "prepare-pr",
      label: "Prepare PR in session",
      tooltip: "Send the session an explicit commit, push, and PR handoff packet",
      disabled: false,
    });
  }
  if (gate && gate.state.waitReason !== null) {
    actions.push({
      id: "recheck-inspector",
      kind: "recheck-inspector",
      label: "Recheck Inspector",
      tooltip: "Evaluate the gate again from Inspector's current durable ledger",
      disabled: false,
    });
  }
  /*
   * Only when there is a pull request to open.
   *
   * Pushed unconditionally, this rendered a permanently disabled `Open PR` on every run with no
   * adopted pull request - both on runs with no pull-request concept at all and, more often, on
   * an `inspector`-policy run parked in `waiting_for_pr`, which is parked precisely BECAUSE no
   * pull request is adopted yet. So the condition is the URL and NOT the completion policy:
   * policy alone leaves the destination-less button standing on exactly the runs this is meant
   * to clear, while requiring the URL covers both cases at once.
   *
   * Nothing is lost by its absence. A `waiting_for_pr` run's gate section already says no pull
   * request is adopted and offers `Prepare PR in session`, so a greyed-out header button only
   * repeated a fact the page states properly a few sections down.
   */
  const href = gate?.state.prUrl ?? null;
  if (href !== null) {
    actions.push({
      id: "open-pr",
      kind: "open-pr",
      label: "Open PR",
      tooltip: "Open this run's adopted pull request in a new tab",
      disabled: false,
      href,
    });
  }
  return actions;
}

/**
 * Recovery copy and guards for an uncertain delivery.
 *
 * `sessionBound` must be `detail.binding.sessionId !== null`. A rendered session is not proof
 * that the delivery's own binding still points at a live conversation.
 */
export function deliveryResolutionActions(
  delivery: WorkflowDelivery,
  sessionBound: boolean,
): DeliveryAction[] {
  return [
    {
      id: `delivery:${delivery.id}:mark_delivered`,
      kind: "resolve-delivery",
      deliveryId: delivery.id,
      resolution: "mark_delivered",
      label: "Mark delivered",
      tooltip: "Confirm the exact packet already reached the inspected pane",
      disabled: false,
      confirm: {
        title: "Mark this packet delivered",
        body: "Confirm you inspected the session's pane and this exact repair prompt is in it."
          + " Marking it delivered ends the recovery.",
        confirmLabel: "Mark delivered",
        confirmHint: "Records the packet as delivered without sending it again",
      },
    },
    {
      id: `delivery:${delivery.id}:discard_and_new_round`,
      kind: "resolve-delivery",
      deliveryId: delivery.id,
      resolution: "discard_and_new_round",
      label: "Discard and send new round",
      tooltip: sessionBound
        ? "Discard this ambiguous packet and create a replacement repair round"
        : "The bound session is gone, so no replacement round can be prepared",
      disabled: !sessionBound,
      confirm: {
        title: "Discard and send a new repair round",
        body: "The pane may already hold this packet. Discarding it prepares a fresh repair"
          + " round, which the session could receive twice.",
        confirmLabel: "Discard and send new round",
        confirmHint: "Discards the ambiguous packet and prepares a new repair round",
        danger: true,
        requirePhrase: "DISCARD AND SEND A NEW REPAIR ROUND",
      },
    },
  ];
}

/**
 * Whether this run can take a resubmission, and why not when it cannot.
 *
 * `refusal` carries the reason so a disabled control can say it; `null` means the header's own
 * per-button copy applies, because a live resubmission invites two different things - fresh
 * evidence or the snapshot already taken - and that wording belongs beside the buttons.
 */
export interface ResubmitAvailability {
  /** A blocked run resumes the round it stalled in; a waiting run opens the next one. */
  resuming: boolean;
  refusal: string | null;
}

/**
 * Whether the header may offer a resubmission.
 *
 * `blocked` belongs here because `manager.resubmit` has always accepted it while the header
 * offered the control to `waiting_for_session` alone. That left a run blocked on a fault which
 * has since cleared - `check_cleanup_unresolved` once its pooled worktree came back - showing
 * nothing but Cancel run, with the one call that revives it a route away and unreachable.
 *
 * The refusals mirror `manager.resubmit`'s own, in its order, so the control never promises a
 * call the server will reject. An Inspector-only repair is excluded rather than disabled: it
 * owns Restart full workflow, and two competing recoveries side by side is how an operator
 * picks the wrong one.
 */
export function resubmitAvailability(
  detail: WorkflowRunDetail,
  liveInspectorRepair: boolean,
): ResubmitAvailability | null {
  const { status } = detail.run;
  if (status !== "waiting_for_session" && status !== "blocked") return null;
  const resuming = status === "blocked";
  if (resuming && liveInspectorRepair) return null;
  if (detail.binding.state !== "active") {
    return { resuming, refusal: "The bound session is gone, so no further round can be prepared" };
  }
  if (detail.externalSource) {
    return { resuming, refusal: "An externally sourced run cannot take a manual round" };
  }
  if (detail.summary.round > detail.summary.maxRepairRounds) {
    return { resuming, refusal: "This run has used every repair round its binding allows" };
  }
  return { resuming, refusal: null };
}

/** Takes anything that carries a tooltip, so the derived next move reads it too. */
export function runActionTooltip(
  descriptor: { tooltip: string },
  pending: boolean,
): string {
  return pending ? "This action is already running" : descriptor.tooltip;
}

/**
 * The request id an unchanged resubmission must replay, read off the run itself.
 *
 * DERIVED, not remembered. The id belongs to the submission the daemon refused, and that
 * submission is on run detail carrying the very key it was filed under - so the answer is a
 * property of the run rather than of the component that happened to make the failing request.
 * A `useRef` holding it looked equivalent and was not: after a reload the ref is empty, and the
 * only place that showed was the round counter. The header went on offering to review "this
 * snapshot" while the daemon, finding no prior submission, opened a fresh repair round and spent
 * one of the binding's on evidence it had already been told was identical.
 *
 * The guards mirror `manager.resubmit`'s revive path exactly, and they have to, because both
 * outcomes either side of it are silent:
 *
 *  - Inside the window, replaying revives the failed submission IN THE SAME ROUND.
 *  - Past the nudge limit the phase is `unchanged_evidence_exhausted`, the revive guard no longer
 *    matches, and the daemon answers "already applied" with the old failed row - so a replay
 *    there is a click that does nothing, and `null` (a fresh id) is the one that runs.
 *
 * `null` is therefore a correct answer and not a failure: the caller mints a fresh id, which is
 * always accepted. Every narrowing below degrades that way, including the trigger key being a
 * shape this build does not recognise.
 */
export function refusedUnchangedRequestId(detail: WorkflowRunDetail): string | null {
  if (
    detail.run.status !== "waiting_for_session"
    || detail.run.currentPhase !== "unchanged_evidence"
  ) return null;
  const refused = orderedSubmissions(detail).at(-1);
  // The refusal marks the submission it opened `failed` and leaves it newest, so anything else
  // here means the run has moved on and this is not the round being repaired.
  if (!refused || refused.status !== "failed" || refused.triggerSource !== "manual") return null;
  return manualWorkflowTriggerRequestId(detail.binding.id, refused.triggerKey);
}

/**
 * The ONE move a run's own state actually takes, or `null`.
 *
 * The detail-level sibling of `runRemedy` (`run-model.ts`), and a separate function rather than
 * a widening of it: `runRemedy` answers from a fleet-wide SUMMARY under a stricter contract, so
 * it has to punt exactly the states only run detail can decide - the gate actions, the targeted
 * retry, the unchanged-evidence recovery. This one reads detail and resolves them. They stay
 * siblings that agree on vocabulary: ONE `RunActionId` per intent, never one per surface
 * (`run-model.ts`).
 *
 * It is POST-ONLY, and that is load-bearing. Every descriptor is a mutation the shared action
 * store can dispatch, which keeps that dispatch total over the type with no kind the render
 * site special-cases. Navigation is deliberately not modelled - which is why
 * `blocked`/`inspector_disabled` resolves to NO move rather than to a "Turn Inspector on"
 * primary: Inspector settings open through a callback prop, so a `path` would have nothing to
 * point at, and the Inspector gate section further down the same page already renders
 * `Open Inspector settings`. If a navigation primary is ever genuinely needed it is a separate
 * union modelled on `GateAction`, which already mixes an `href` arm with two POST kinds - not a
 * widening of this one.
 */
export interface RunNextMove {
  /**
   * Stable, and doubles as the `RunActionId` the action store keys pending state and request
   * ids by. `prepare-pr` and `recheck-inspector` deliberately reuse their `GateAction` ids, so
   * the same intent dispatched from the ladder and from here is one in-flight request rather
   * than two.
   */
  id: RunActionId;
  kind:
    | "resubmit"
    | "resubmit-unchanged"
    | "prepare-pr"
    | "recheck-inspector"
    | "retry"
    | "grant-rounds"
    | "run-again";
  label: string;
  tooltip: string;
  /**
   * The POST path, its id already interpolated.
   *
   * A FULL path rather than an action name, because `run-again` is keyed by the BINDING and
   * every other arm by the run. One descriptor that can only spell one route would have made
   * the terminal arm a second derivation.
   */
  path: string;
  /** Everything the route needs beyond `requestId`. Empty for most arms. */
  body: Record<string, string | boolean | number>;
  /** `null` fires immediately; a move that spends a round warns first. */
  confirm: WorkflowConfirmDescriptor | null;
}

/**
 * Why a stopped run has no move, as prose for the person reading the page.
 *
 * Two fields rather than one string because the sentence does two different jobs, and the
 * reviewed mockup draws that distinction typographically: `cause` is the fact, emphasised, and
 * `consequence` names where the decision that settles it actually lives. That closing move is
 * `runRemedy`'s own - "the row still says why; it just does not pretend one button settles it".
 */
export interface RunNoMoveReason {
  cause: string;
  consequence: string;
}

/**
 * The blocked phases whose recovery is a DECISION rather than a resubmission.
 *
 * A DENYLIST, deliberately. `currentPhase` is a free string that new `setRunState` callers add
 * to without this module hearing about it, so an unrecognised block has to degrade to the
 * recovery `resubmitAvailability` has already proved the daemon accepts. Degrading the other
 * way - an allowlist, so a phase nobody enumerated silently loses its move - would recreate the
 * dead end this whole derivation exists to remove.
 *
 * `session_disappeared` and `round_limit` are absent on purpose: `resubmitAvailability` already
 * refuses both on their own terms, and its refusal is the better sentence.
 */
const DECISION_BLOCKED_PHASES: ReadonlySet<string> = new Set([
  // The findings list and the gate section own these three.
  "inspector_findings",
  "inspector_pr_closed",
  "inspector_disabled",
  // The deliveries section owns these: two mutually exclusive resolutions, and choosing needs
  // the operator's eyes on the session's pane rather than a button up in the header.
  "delivery_uncertain",
  "delivery_refused",
  "delivery_blocked",
]);

/** The two phases the manager writes when it refuses an unchanged evidence snapshot. */
const UNCHANGED_EVIDENCE_PHASES: ReadonlySet<string> = new Set([
  "unchanged_evidence",
  "unchanged_evidence_exhausted",
]);

const runPath = (detail: WorkflowRunDetail, action: string): string =>
  `/api/workflow-runs/${encodeURIComponent(detail.run.id)}/${action}`;

/**
 * Whether the newest submission is an Inspector-only repair.
 *
 * Derived here rather than taken as a parameter for the same reason `preview` is: the run page
 * computes the identical predicate for its own scrubber, and two callers who could disagree
 * about it is how a live recovery gets withdrawn by a view choice.
 */
function liveInspectorRepair(detail: WorkflowRunDetail): boolean {
  return orderedSubmissions(detail).at(-1)?.mode === "inspector_only";
}

/**
 * The one thing a FINISHED run can still do: review the same session again.
 *
 * This closed the page's largest dead end. A `completed`, `cancelled` or `failed` run used to
 * render six controls and not one of them ran anything - a review that had finished was the end
 * of the road, with no path back to reviewing that session from anywhere in the product.
 *
 * It needs no new route, and the daemon proves it rather than this comment: `activeRunForBinding`
 * defines "open" by SQL exclusion of exactly the three terminal statuses, so the `run_active`
 * refusal stops firing the moment the prior run finishes; nothing in the completion path writes
 * `workflow_bindings.state`, so the binding is still `active`; and the only per-submission guard
 * is the `requestId`-derived trigger key, which is idempotency rather than exclusivity.
 *
 * Two asymmetries live here and nowhere else in this function, both deliberate:
 *
 *  - It is keyed by `detail.binding.id`, not by the run. A run is a thing that happened; only
 *    the binding can start another one.
 *  - Its success lands the reader on a DIFFERENT run, so the caller routes rather than reloads.
 */
function runAgainMove(detail: WorkflowRunDetail, preview: boolean): RunNextMove | null {
  /*
   * The manager's refusals, in `prepareSubmit`'s own order. Where either holds, the move is
   * `null` and `runNoMoveReason` turns it into the sentence - never a disabled button.
   *
   * The one refusal not mirrored here is `run_active`, and it cannot be: run detail carries no
   * sibling runs, so a page reading an OLDER terminal run of a binding that has since started
   * another has no way to know. That is the one path to a 409, it needs two runs of one binding
   * to reach, and the daemon's own sentence is what the page then shows.
   */
  if (detail.binding.state !== "active") return null;
  if (detail.externalSource) return null;

  /*
   * WHICH version runs again, and why the copy has to be careful about it.
   *
   * The submit route runs the version the BINDING points at now, which is not necessarily the
   * one this run used - rebinding the same session to a newer published version leaves this
   * finished run pinned to the old one. The number of the new one is not on the wire (the
   * binding carries a version id, and `detail.version` is the RUN's version), so where they
   * disagree the confirm says so instead of naming a version that would not run. A button that
   * spends model tokens must not name the wrong workflow version while doing it.
   */
  const rebound = detail.binding.workflowVersionId !== detail.run.workflowVersionId;
  const session = detail.binding.sessionName;
  const version = `${detail.summary.workflowName} v${detail.summary.workflowVersion}`;
  const body = rebound
    ? `${session} is bound to a different published version than the ${version} this run used,`
      + " so the new run uses the bound one. It reads that session's current diff and"
      + " transcript, starts a NEW run and spends model tokens; this finished run stays in"
      + " history."
    : `This reads ${session}'s current diff and transcript, then runs every reviewer in`
      + ` ${version} against that fresh evidence. It starts a NEW run and spends model tokens;`
      + " this finished run stays in history.";
  return {
    id: "run-again",
    kind: "run-again",
    label: preview ? "Preview this review again" : "Run this review again",
    tooltip: "Capture fresh evidence from the session and start a new run of this workflow",
    path: `/api/workflow-bindings/${encodeURIComponent(detail.binding.id)}/submit`,
    body: {},
    // Confirmed, because it spends model tokens and creates a run. NOT phrase-gated: the
    // phrase exists for the two actions that abandon work, and this one only adds.
    confirm: {
      title: preview ? "Preview this review again" : "Run this review again",
      body,
      confirmLabel: preview ? "Preview again" : "Run again",
      confirmHint: "Starts a new run against the same session",
    },
  };
}

export function runNextMove(detail: WorkflowRunDetail): RunNextMove | null {
  const { status, currentPhase } = detail.run;
  const preview = detail.binding.deliveryMode !== "live";

  // Terminal. The one arm that STARTS a run rather than advancing one, and an arm on this same
  // function rather than a second derivation or a bespoke button.
  if (!workflowRunIsOpen(status)) return runAgainMove(detail, preview);

  // In flight. The pipeline strip below is already saying what is happening, and a run that is
  // moving does not need a button telling you to wait.
  if (status === "capturing" || status === "running" || status === "waiting_for_action") {
    return null;
  }

  // The three gate waits. `inspectorGateActions` already mirrors the manager's guards for both
  // arms, so scoping to these statuses is what keeps a gate action from preempting a blocked
  // run's own recovery - `manager.recheckInspector` accepts any non-terminal run with a gate,
  // which would otherwise make `Check again` the answer to an Inspector findings block.
  if (
    status === "waiting_for_pr"
    || status === "waiting_for_inspector"
    || status === "waiting_for_new_head"
  ) {
    const gateActions = inspectorGateActions(detail);
    const prepare = gateActions.find((action) => action.kind === "prepare-pr");
    if (prepare) {
      return {
        id: prepare.id,
        kind: "prepare-pr",
        label: "Ask the session to open a PR",
        tooltip: prepare.tooltip,
        path: runPath(detail, "prepare-pr"),
        body: {},
        confirm: null,
      };
    }
    const recheck = gateActions.find((action) => action.kind === "recheck-inspector");
    if (recheck) {
      return {
        id: recheck.id,
        kind: "recheck-inspector",
        label: "Check again",
        tooltip: recheck.tooltip,
        path: runPath(detail, "recheck-inspector"),
        body: {},
        confirm: null,
      };
    }
    return null;
  }

  /*
   * The provider call failed rather than the review, and it comes BEFORE the resubmission
   * family: retrying the exhausted call resumes the round the run already paid for, while a
   * resubmission would open a new one.
   *
   * Gated on an errored attempt existing, because `manager.retry` refuses without one - a
   * button that always answers 409 is worse than no button. The attempt id is deliberately not
   * sent, exactly as `runRemedy` omits it: the daemon then picks the newest errored attempt on
   * the live submission itself, which is the one this page would have chosen anyway and cannot
   * go stale across a round boundary.
   */
  if (
    status === "blocked"
    && currentPhase === "infrastructure_error"
    && detail.attempts.some((attempt) => attempt.state === "error")
  ) {
    return {
      id: "retry",
      kind: "retry",
      label: "Retry the failed call",
      tooltip: "The provider call failed rather than the review - try it again",
      path: runPath(detail, "retry"),
      body: {},
      confirm: null,
    };
  }

  /*
   * A run that spent its repair budget, which is the one block that never clears itself.
   *
   * It comes BEFORE the resubmission family because it is the reason that family refuses:
   * `resubmitAvailability` turns `round > maxRepairRounds` into a refusal sentence, and for
   * a round-limited run that sentence used to be the end of the page - a paragraph pointing
   * at a binding edit that cannot reach this run's snapshot. The grant moves the number the
   * refusal actually reads, so the very next render offers the resume move on its own.
   *
   * This is also the only move here that changes what a pull request is waiting for, so the
   * confirmation says so: while the run is spent, Shipping reports a permanent block.
   */
  const spent = workflowRunGaveUp({
    status,
    phase: currentPhase,
    round: detail.summary.round,
    maxRepairRounds: detail.summary.maxRepairRounds,
  });
  /*
   * Offered only where it REVIVES something, which is two different conditions.
   *
   * An Inspector-only gate run is revived by the grant itself: the daemon restores
   * `waiting_for_new_head` so the gate re-enters, and that works whoever started the run.
   * Externally sourced runs are included for exactly this arm - an ensemble handoff binds
   * a published version and its binding stays active, so its gate DOES hold the Shipping
   * veto and can go spent. Withholding the button there would leave the Merge queue telling
   * an operator to open a run that offers nothing.
   *
   * Every other spent run is revived by the resume move instead, so it inherits that move's
   * preconditions: a manual round is what it will go on to take, and `resubmitAvailability`
   * refuses one for a gone session or an external source. Granting rounds there would raise
   * a number nothing goes on to spend - a button that succeeds and changes nothing.
   */
  const gateRepair = liveInspectorRepair(detail);
  if (
    spent
    && detail.binding.state === "active"
    && (gateRepair || !detail.externalSource)
    // And only while there is headroom to grant. `grantRepairRounds` clamps the sum at the
    // same ceiling and REFUSES a grant that would not move the number, so a run already at
    // the maximum would otherwise render a button whose only possible answer is a 409.
    && detail.summary.maxRepairRounds < WORKFLOW_LIMITS.repairRoundsMax
  ) {
    // The number the daemon will actually add, not the number we asked for. The clamp bites
    // within `GRANT_ROUNDS` of the ceiling, and a button that promises two and delivers one
    // is a small lie told at the exact moment an operator is counting rounds.
    const rounds = Math.min(
      detail.summary.maxRepairRounds + GRANT_ROUNDS,
      WORKFLOW_LIMITS.repairRoundsMax,
    ) - detail.summary.maxRepairRounds;
    return {
      id: "grant-rounds",
      kind: "grant-rounds",
      label: rounds === 1 ? "Grant one more round" : `Grant ${rounds} more rounds`,
      tooltip: "Raise this run's repair budget so the review can continue",
      path: runPath(detail, "grant-rounds"),
      body: { rounds },
      confirm: {
        title: rounds === 1 ? "Grant one more repair round" : `Grant ${rounds} more repair rounds`,
        body: "This run used every repair round its budget allowed, so it stopped and will"
          + " not restart on its own - and while it is stopped its pull request cannot merge."
          + ` Granting ${rounds === 1 ? "one" : rounds} more lets the review carry on from`
          + " where it left off.",
        confirmLabel: "Grant the rounds",
        confirmHint: "Raises this run's budget only",
        danger: false,
      },
    };
  }

  // Everything below is a resubmission, so the manager's own refusals decide first. Where it
  // refuses, the move is `null` and `runNoMoveReason` turns the refusal into the sentence.
  const availability = resubmitAvailability(detail, liveInspectorRepair(detail));
  if (!availability || availability.refusal !== null) return null;

  /*
   * The unchanged-evidence recovery, offered only once the refusal has actually happened.
   *
   * It is not a co-equal twin of the fresh resubmission beforehand: it exists solely to answer
   * `workflow_unchanged_evidence`, and the manager persists that refusal as a run phase, so the
   * affordance is durable across a remount rather than held in component state.
   */
  if (UNCHANGED_EVIDENCE_PHASES.has(currentPhase)) {
    return {
      id: "resubmit-unchanged",
      kind: "resubmit-unchanged",
      label: preview ? "Preview unchanged" : "Review this snapshot anyway",
      tooltip: "Run the review again against the evidence snapshot already taken",
      path: runPath(detail, "resubmit"),
      body: { resubmitUnchanged: true },
      confirm: {
        title: preview ? "Preview unchanged evidence" : "Submit unchanged evidence",
        body: "This runs every reviewer again against the snapshot already taken, so"
          + " nothing about the work under review has changed since the last round.",
        confirmLabel: preview ? "Preview unchanged" : "Submit unchanged",
        confirmHint: "Starts a new round against the existing evidence snapshot",
      },
    };
  }

  const resumable = status === "waiting_for_session"
    || !DECISION_BLOCKED_PHASES.has(currentPhase);
  if (!resumable) return null;
  return {
    id: "resubmit",
    kind: "resubmit",
    label: preview ? "Preview fresh evidence" : "Resume review",
    tooltip: availability.resuming
      ? "Re-read the session's current diff and resume this run where it stalled"
      : "Re-read the session's current diff and run the review again",
    path: runPath(detail, "resubmit"),
    body: {},
    confirm: null,
  };
}

/**
 * The phases whose own sentence beats anything composed from a clause.
 *
 * `blockedPhaseClause` is three or four words for a 240px triage column; this page has a whole
 * paragraph's width and a reader who has arrived here specifically to find out what happened.
 * So the mapped phases get real prose, and `blockedPhaseClause` stays the FALLBACK for a phase
 * code nobody wrote an entry for - which is the job it already does for unmapped codes.
 */
const NO_MOVE_SENTENCES: Record<string, RunNoMoveReason> = {
  session_disappeared: {
    cause: "The session this run was reviewing is gone,",
    consequence: "so it cannot take another round. Cancelling clears it from your queue; its"
      + " evidence and verdicts stay in history.",
  },
  /*
   * Reached only when something ELSE also refuses - an inactive binding, an external
   * source - because a run that is merely out of rounds now gets the grant as its move.
   *
   * Neither sentence sends the reader to the binding any more, and that is a correction
   * rather than a rewording: a run snapshots `maxRepairRounds` when its row is inserted and
   * every guard compares against that snapshot, so raising the binding's budget changes
   * what the NEXT run may spend and cannot reach this one. The old copy named the one
   * remedy guaranteed not to work.
   */
  round_limit: {
    cause: "This run has used every repair round it was given,",
    consequence: "and the rest of its state means nothing here can open another one."
      + " Cancelling clears the run, keeps its history, and releases the merge block its"
      + " gate holds on the pull request.",
  },
  inspector_round_limit: {
    cause: "This run has used every Inspector round it was given,",
    consequence: "and the rest of its state means nothing here can open another one."
      + " Cancelling clears the run, keeps its history, and releases the merge block its"
      + " gate holds on the pull request.",
  },
  inspector_findings: {
    cause: "Inspector left findings that have to be resolved.",
    consequence: "Fix them in the session and push - they are listed under Inspector final gate"
      + " below, and no button up here can settle them.",
  },
  inspector_pr_closed: {
    cause: "The adopted pull request was closed or switched.",
    consequence: "Reopen it or adopt the replacement; Inspector final gate below carries the"
      + " pull request this run was pinned to.",
  },
  inspector_disabled: {
    cause: "Inspector is switched off, so the gate cannot be evaluated.",
    consequence: "Turn it back on from Open Inspector settings, in Inspector final gate below.",
  },
  delivery_uncertain: {
    cause: "A repair packet may or may not have reached the session.",
    consequence: "Confirm or discard it in Deliveries below - the choice needs your eyes on the"
      + " pane, so no button up here can settle it.",
  },
  delivery_refused: {
    cause: "The session refused this run's repair packet.",
    consequence: "Retry or resolve it in Deliveries below, which carries the packet and the"
      + " refusal.",
  },
  delivery_blocked: {
    cause: "This run's repair packet cannot be delivered.",
    consequence: "Deliveries below carries the packet and why it is held.",
  },
};

/**
 * Why a finished run cannot be run again, per binding state.
 *
 * Exhaustive over the union minus `active` rather than one lumped sentence, because the three
 * are three different situations and only one of them is "the session is gone". A fourth binding
 * state fails to compile here, which is the point of spelling the type out.
 *
 * `resubmitAvailability` lumps all three into "the bound session is gone" for an OPEN run, and
 * that stays its wording: there the move being refused is another round of a run in progress,
 * and Cancel run is the sentence's companion. Here the run is over and there is nothing to
 * cancel, so the sentence's job is to name what would make another run possible.
 */
const NO_RERUN_SENTENCES: Record<Exclude<WorkflowBindingState, "active">, RunNoMoveReason> = {
  orphaned: {
    cause: "The session this review ran against is gone,",
    consequence: "so it cannot be run again from here. Its evidence and verdicts stay in"
      + " history.",
  },
  paused: {
    cause: "This review's binding is paused,",
    consequence: "so it cannot be run again from here. Reattaching the workflow to the session"
      + " is what starts another run.",
  },
  archived: {
    cause: "This review's binding was archived,",
    consequence: "so it cannot be run again from here. Binding the workflow to a session again"
      + " is what starts another run.",
  },
};

/**
 * The sentence a run with no move puts in front of the reader, or `null`.
 *
 * Never a disabled button standing in for an explanation, and never a sentence competing with a
 * move: this returns `null` whenever `runNextMove` returns a descriptor, so the invariant holds
 * structurally rather than by the render site remembering it.
 */
export function runNoMoveReason(detail: WorkflowRunDetail): RunNoMoveReason | null {
  if (runNextMove(detail) !== null) return null;
  const { status, currentPhase } = detail.run;

  /*
   * A finished run explains itself only when it cannot be RUN AGAIN.
   *
   * With an active binding it always can, so this is unreachable for the healthy case: the guard
   * above has already returned `null` because `runAgainMove` produced the primary. What is left
   * is the finished run whose binding has since gone, and it earns a sentence for the same
   * reason a blocked one does - the reader is looking for the button the plan promised and it is
   * not there.
   */
  if (!workflowRunIsOpen(status)) {
    if (detail.externalSource) {
      return {
        cause: "An external orchestrator started this run,",
        consequence: "so starting another one is its call rather than this page's. Its"
          + " provenance is named just below.",
      };
    }
    return detail.binding.state === "active"
      ? null
      : NO_RERUN_SENTENCES[detail.binding.state];
  }

  // A moving run is explained by the strip below it, not by a paragraph telling you to wait.
  if (
    status === "capturing"
    || status === "running"
    || status === "waiting_for_action"
  ) return null;

  const mapped = NO_MOVE_SENTENCES[currentPhase];
  if (mapped) return mapped;

  // An Inspector-only repair withholds the resubmission on purpose rather than by refusal: it
  // owns `Restart full workflow`, and two competing recoveries side by side is how an operator
  // picks the wrong one. That control is in the danger group, so the sentence names it.
  if (liveInspectorRepair(detail)) {
    return {
      cause: "This round is an Inspector-only repair,",
      consequence: status === "waiting_for_new_head"
        ? "so it resumes on the next pushed head. Restart full workflow reruns every reviewer"
          + " from freshly captured evidence instead."
        : "so a fresh reviewer round is not offered here. Restart full workflow reruns every"
          + " reviewer from freshly captured evidence.",
    };
  }

  /*
   * The refusal copy `resubmitAvailability` already produces, promoted from a dead control's
   * tooltip to the page's own prose. Kept verbatim as the cause so one fact has one wording,
   * and paired with the move that IS available - Cancel run, in the danger group beside it.
   *
   * Reached only by the refusals whose phase has no mapped sentence above: a paused or archived
   * binding, an external source, and a run out of rounds that never reached `round_limit`.
   */
  const refusal = resubmitAvailability(detail, false)?.refusal;
  if (refusal) {
    return {
      cause: `${refusal}.`,
      consequence: "Cancelling clears it from your queue; its evidence and verdicts stay in"
        + " history.",
    };
  }

  if (
    status === "waiting_for_pr"
    || status === "waiting_for_inspector"
    || status === "waiting_for_new_head"
  ) {
    return {
      cause: gateWaitSentence(detail.inspectorGate?.state.waitReason ?? null),
      consequence: "Inspector final gate below carries the heads and the review round.",
    };
  }

  return {
    cause: `This run is blocked - ${blockedPhaseClause(currentPhase)}.`,
    consequence: "Nothing up here settles it; the sections below carry what happened.",
  };
}
