import type {
  WorkflowBindingState,
  WorkflowDelivery,
  WorkflowRunDetail,
} from "@shared/workflow.ts";
import {
  workflowRunIsOpen,
} from "@shared/workflow.ts";
import { blockedPhaseClause } from "@shared/workflow-lifecycle.ts";
// One-directional: this module reads `run-model`'s derivations at runtime, and `run-model` takes
// only a TYPE from here, so there is no cycle to resolve at load.
import {
  cancelGateSentence,
  cancelReleasesGate,
  gateWaitSentence,
  inspectorGateSentence,
  orderedSubmissions,
  spentInspectorGateCondition,
} from "./run-model.ts";
import type { WorkflowConfirmRequest } from "./WorkflowConfirmModal.tsx";

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
  if (detail.summary.recovery?.operations.includes("prepare-pr")) {
    actions.push({
      id: "prepare-pr",
      kind: "prepare-pr",
      label: "Prepare PR in session",
      tooltip: "Send the session an explicit commit, push, and PR handoff packet",
      disabled: false,
    });
  }
  if (detail.summary.recovery?.operations.includes("recheck-inspector")) {
    actions.push({
      id: "recheck-inspector",
      kind: "recheck-inspector",
      label: "Recheck GitHub Inspector",
      tooltip: "Evaluate the gate again from GitHub Inspector's current durable ledger",
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
  /**
   * Whether the run has STOPPED, so a resubmission is what restarts it.
   *
   * It used to be documented as "a blocked run resumes the round it stalled in", and that was
   * never true of the daemon. `manager.resubmit` opens `latest.round + 1` for a blocked run
   * and a waiting one identically, and the two differ only in whether anything would have
   * happened without the click. The old reading leaked into the button's own copy and told
   * operators a round was being resumed while a fresh one was being spent.
   */
  resuming: boolean;
  refusal: string | null;
}

/** Read the daemon's resubmission explanation without interpreting lifecycle fields. */
export function resubmitAvailability(
  detail: WorkflowRunDetail,
  _liveInspectorRepair: boolean,
): ResubmitAvailability | null {
  return detail.summary.recovery?.resubmit ?? null;
}

/** Takes anything that carries a tooltip, so the derived next move reads it too. */
export function runActionTooltip(
  descriptor: { tooltip: string },
  pending: boolean,
): string {
  return pending ? "This action is already running" : descriptor.tooltip;
}

/**
 * The tooltip a next move carries while the run's posture is `auto` (`runPosture`).
 *
 * The move stays clickable - overriding is legitimate - but its ordinary tooltip describes a
 * click the page is recommending, and under an `auto` posture that is exactly the reading
 * being corrected. The resubmission family gets the cost spelled out because that is the
 * click the confusion produced: it interrupts a session mid-repair and spends the round the
 * observer was about to open for free.
 */
export function overriddenNextMoveTooltip(move: RunNextMove): string {
  switch (move.kind) {
    case "resubmit":
    case "resubmit-unchanged":
      return "Not required - this review resumes on its own. Starting a round now interrupts"
        + " the session's repair and spends one.";
    default:
      return `Not required - this run advances on its own. ${move.tooltip}`;
  }
}

/** The daemon supplies the exact idempotency key for a refused snapshot replay. */
export function refusedUnchangedRequestId(detail: WorkflowRunDetail): string | null {
  return detail.summary.recovery?.resubmit?.requestId ?? null;
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

/** Render the confirmed new-run operation the daemon offered. */
function runAgainMove(detail: WorkflowRunDetail, preview: boolean): RunNextMove | null {
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
      captureEvidence: true,
    },
  };
}

export function runNextMove(detail: WorkflowRunDetail): RunNextMove | null {
  const recovery = detail.summary.recovery;
  const primary = recovery?.primary;
  if (!recovery || !primary || !recovery.operations.includes(primary)) return null;
  const preview = detail.binding.deliveryMode !== "live";
  if (primary === "run-again") return runAgainMove(detail, preview);
  if (primary === "prepare-pr" || primary === "recheck-inspector") {
    const gateActions = inspectorGateActions(detail);
    const prepare = gateActions.find((action) => action.kind === "prepare-pr");
    if (primary === "prepare-pr" && prepare) {
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
    if (primary === "recheck-inspector" && recheck) {
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

  if (primary === "retry") {
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

  if (primary === "grant-rounds") {
    const rounds = recovery.grantRounds;
    const spentCondition = spentInspectorGateCondition(detail);
    const adoptCleanHead = spentCondition?.kind === "clean_exact_head";
    const label = adoptCleanHead
      ? "Adopt clean Inspector head"
      : rounds === 1 ? "Grant one more round" : `Grant ${rounds} more rounds`;
    return {
      id: "grant-rounds",
      kind: "grant-rounds",
      label,
      tooltip: adoptCleanHead
        ? "Resume the audited Inspector-only path so the daemon can revalidate and adopt this exact head"
        : "Raise this run's repair budget so the review can continue",
      path: runPath(detail, "grant-rounds"),
      body: { rounds },
      confirm: {
        title: adoptCleanHead
          ? "Adopt the clean Inspector head"
          : rounds === 1 ? "Grant one more repair round" : `Grant ${rounds} more repair rounds`,
        body: adoptCleanHead
          ? `Current Inspector reports ${shortHead(spentCondition.headSha)} as the exact open head, reviewed live with no open findings. This grants ${rounds === 1 ? "one repair round" : `${rounds} repair rounds`} through the existing audited path; the browser does not pass the gate. The daemon revalidates the head, creates the immutable Inspector-only submission, and only then may complete the workflow.`
          : "This run used every repair round its budget allowed, so it stopped and will"
            + " not restart on its own - and while it is stopped its pull request cannot merge."
            + ` Granting ${rounds === 1 ? "one" : rounds} more lets the review carry on from`
            + " where it left off.",
        confirmLabel: adoptCleanHead ? "Adopt clean head" : "Grant the rounds",
        confirmHint: adoptCleanHead
          ? "Raises this run's budget and reuses the audited Inspector evaluator"
          : "Raises this run's budget only",
        danger: false,
      },
    };
  }

  // Everything below is a resubmission, so the manager's own refusals decide first. Where it
  // refuses, the move is `null` and `runNoMoveReason` turns the refusal into the sentence.
  const availability = recovery.resubmit;
  if (!availability || availability.refusal !== null) return null;

  /*
   * The unchanged-evidence recovery, offered only once the refusal has actually happened.
   *
   * It is not a co-equal twin of the fresh resubmission beforehand: it exists solely to answer
   * `workflow_unchanged_evidence`, and the manager persists that refusal as a run phase, so the
   * affordance is durable across a remount rather than held in component state.
   */
  if (primary === "resubmit-unchanged") {
    const latestSubmissionId = orderedSubmissions(detail).at(-1)?.id ?? null;
    const reusedImageCount = latestSubmissionId
      ? detail.evidenceImages?.find((group) => group.submissionId === latestSubmissionId)?.images.length ?? 0
      : 0;
    /*
     * The pre-capture refusal reads differently because it refused a different thing.
     *
     * `unchanged_evidence` refused a snapshot that had already been taken, so its sentence is
     * about reusing that snapshot and the images frozen into it. `unchanged_repository`
     * refused before any of that existed: nothing was captured, nothing was frozen, and no
     * round was spent. Telling that operator about reused images would describe a submission
     * they do not have, so this arm states what the daemon actually compared - the tree - and
     * what proceeding will cost.
     */
    const repositoryOnly = availability.unchanged === "repository";
    if (repositoryOnly) {
      return {
        id: "resubmit-unchanged",
        kind: "resubmit-unchanged",
        label: preview ? "Preview unchanged" : "Review it anyway",
        tooltip: "Review the same commit and working tree the last round already reviewed",
        path: runPath(detail, "resubmit"),
        body: { resubmitUnchanged: true },
        confirm: {
          title: preview ? "Preview unchanged work" : "Review unchanged work",
          body: `The repository has not changed since round ${detail.summary.round} - same`
            + " commit, same working tree, no new evidence registered. Reviewing it again runs"
            + " every reviewer from the top against identical code, which will usually return"
            + " the same verdicts, and it spends one repair round."
            + " Do it when the transcript itself is the evidence, such as a manual"
            + " verification you have just carried out.",
          confirmLabel: preview ? "Preview unchanged" : "Review it anyway",
          confirmHint: "Spends one repair round on work that has not moved",
        },
      };
    }
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
          + " nothing about the work under review has changed since the last round."
          + ` It reuses exactly ${reusedImageCount} image${reusedImageCount === 1 ? "" : "s"};`
          + " no new image evidence can be added to this replay.",
        confirmLabel: preview ? "Preview unchanged" : "Submit unchanged",
        confirmHint: "Starts a new round against the existing evidence snapshot",
      },
    };
  }

  if (primary !== "resubmit") {
    const _unsupported: never = primary;
    return null;
  }
  const nextRound = detail.summary.round + 1;
  return {
    // One action-store intent per repair round. A fresh capture that is refused as unchanged
    // must retain its request id for the exact replay, but once that replay runs the NEXT fresh
    // capture cannot reuse the old id and be answered with the previous submission.
    id: `resubmit:${nextRound}`,
    kind: "resubmit",
    /*
     * It opens the NEXT round. It does not resume the one that stopped, and saying so was a
     * promise the server never made: `manager.resubmit` computes `latest.round + 1` for a
     * blocked run and a waiting one alike, and the graph re-runs from Session with an empty
     * attempt slate, so every reviewer that passed last round runs again.
     *
     * The old copy - "resume this run where it stalled" - read as though the stopped round
     * picked up where it left off, which made the round it actually spends look like a bug
     * rather than the documented cost. The action id one line above always knew the number.
     */
    label: preview ? "Preview fresh evidence" : `Start repair round ${nextRound}`,
    tooltip: "Re-read the session's current diff and run every reviewer again from the top",
    path: runPath(detail, "resubmit"),
    body: {},
    confirm: {
      title: preview ? "Preview fresh evidence" : `Start repair round ${nextRound}`,
      body: "This re-reads the bound session, takes a fresh immutable evidence submission,"
        + " and runs every reviewer again from the top - including the ones that passed."
        + (availability.resuming
          ? " The run is stopped, so this is what restarts it, and it spends one repair round."
          : " It spends one repair round.")
        + " If the repository has not moved since the last round, it will say so instead of"
        + " spending one.",
      confirmLabel: preview ? "Preview fresh evidence" : `Start round ${nextRound}`,
      confirmHint: "Captures the session again with this image evidence packet",
      captureEvidence: true,
    },
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
      + " Cancelling clears the run and keeps its history.",
  },
  inspector_round_limit: {
    cause: "This run has used every GitHub Inspector round it was given,",
    consequence: "and the rest of its state means nothing here can open another one."
      + " Cancelling clears the run and keeps its history.",
  },
  inspector_findings: {
    cause: "GitHub Inspector left findings that have to be resolved.",
    consequence: "Fix them in the session and push - they are listed in the run record's"
      + " Completion tab, and no button up here can settle them.",
  },
  inspector_pr_closed: {
    cause: "The adopted pull request was closed or switched.",
    consequence: "Reopen it or adopt the replacement; the run record's Completion tab carries"
      + " the pull request this run was pinned to.",
  },
  inspector_disabled: {
    cause: "GitHub Inspector is switched off, so the gate cannot be evaluated.",
    consequence: "Turn it back on from Open GitHub Inspector settings, in the run record's Completion tab.",
  },
  delivery_uncertain: {
    cause: "A repair packet may or may not have reached the session.",
    consequence: "Confirm or discard it in the run record's Deliveries tab - the choice needs"
      + " your eyes on the pane, so no button up here can settle it.",
  },
  delivery_refused: {
    cause: "The session refused this run's repair packet.",
    consequence: "Retry or resolve it in the run record's Deliveries tab, which carries the"
      + " packet and the refusal.",
  },
  delivery_blocked: {
    cause: "This run's repair packet cannot be delivered.",
    consequence: "The run record's Deliveries tab carries the packet and why it is held.",
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
  if (!detail.summary.recovery || (!detail.summary.recovery.phaseKnown && workflowRunIsOpen(detail.run.status))) {
    return {
      cause: detail.summary.recovery ? "This daemon does not recognize the run's phase." : "Recovery actions are unavailable.",
      consequence: "Inspect the run record for details. Refresh after updating the daemon to obtain its recovery actions.",
    };
  }
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

  const spentCondition = spentInspectorGateCondition(detail);
  if (spentCondition) {
    const release = cancelReleasesGate(detail.summary);
    return {
      cause: inspectorGateSentence(detail),
      consequence: "This run cannot receive the audited grant from its current state."
        + " Cancelling keeps its audit history"
        + (release === null ? "." : `.${cancelGateSentence(release)}`),
    };
  }

  const mapped = NO_MOVE_SENTENCES[currentPhase];
  if (mapped) {
    /*
     * The merge-block clause is EARNED, not assumed - and the same predicate the two cancel
     * confirmations use earns it.
     *
     * `round_limit` is the generic round-exhaustion phase, shared by every workflow type. A
     * version whose completion policy is not `inspector` never populates gate state at all,
     * and a spent run reaching this sentence has already failed some other test - an
     * orphaned binding, the repair ceiling - which is exactly when `mergeGate` stops walking
     * it. Appending "cancelling releases the merge block" to a static string told those runs
     * something plainly false about a pull request they do not hold. Conditional here, and
     * naming the number rather than "the pull request", because a sentence that cannot say
     * WHICH one is a sentence that does not know there is one.
     */
    const release = cancelReleasesGate(detail.summary);
    return release === null
      ? mapped
      : { ...mapped, consequence: mapped.consequence + cancelGateSentence(release) };
  }

  // An Inspector-only repair withholds the resubmission on purpose rather than by refusal: it
  // owns `Restart full workflow`, and two competing recoveries side by side is how an operator
  // picks the wrong one. That control is in the danger group, so the sentence names it.
  if (liveInspectorRepair(detail)) {
    return {
      cause: "This round is a GitHub Inspector-only repair,",
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
      consequence: "The run record's Completion tab carries the heads and the review round.",
    };
  }

  return {
    cause: `This run is blocked - ${blockedPhaseClause(currentPhase)}.`,
    consequence: "Nothing up here settles it; the run record carries what happened.",
  };
}

/** The short full object id used in a confirmation without importing presentation JSX. */
function shortHead(head: string): string {
  return head.length > 12 ? head.slice(0, 12) : head;
}
