/**
 * What is at stake: the run page must offer the ONE thing a run needs, and never a disabled
 * button standing in for an explanation.
 *
 * The header used to assemble its own controls inline, so "which control does this state get"
 * was answerable only by rendering markup and reading it back. `runNextMove` makes it a pure
 * function over run detail, and this file is the table: every run state, the move it resolves,
 * and - where it resolves nothing - the sentence that says why and names where the decision
 * lives.
 *
 * Two invariants here are load-bearing beyond any single row.
 *
 * `RunNextMove` is POST-ONLY. Every value it can hold is dispatchable through the shared action
 * store with no kind the render site special-cases, which is why `inspector_disabled` is a
 * no-move state rather than a "Turn Inspector on" primary: Inspector settings open through a
 * callback prop, so a `path` would have nothing to point at. The path assertion below is the
 * guard that fails if a navigation descriptor slips in.
 *
 * And a move and a reason are mutually exclusive. A header showing both would be a primary next
 * to an excuse for not having one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  WorkflowBindingState,
  WorkflowGateWaitReason,
  WorkflowInspectorGateDetail,
  WorkflowRunDetail,
  WorkflowRunStatus,
  WorkflowVersion,
} from "../src/shared/workflow.ts";
import { WORKFLOW_RUN_STATUSES } from "../src/shared/workflow.ts";
import {
  manualWorkflowTriggerKey,
  manualWorkflowTriggerRequestId,
} from "../src/shared/workflow.ts";
import {
  inspectorGateActions,
  refusedUnchangedRequestId,
  runNextMove,
  runNoMoveReason,
} from "../src/web/workflows/run-actions.ts";

interface Shape {
  status: WorkflowRunStatus;
  phase?: string;
  /** `preview` is derived from the binding inside the function, so this drives the binding. */
  live?: boolean;
  bindingState?: WorkflowBindingState;
  round?: number;
  maxRepairRounds?: number;
  externalSource?: boolean;
  /** `manager.retry` refuses without an errored attempt, so the move is gated on one. */
  erroredAttempt?: boolean;
  /** The newest submission's mode. An Inspector-only repair withholds the resubmission. */
  inspectorOnly?: boolean;
  /** The newest submission's own status and idempotency key, for the replay derivation. */
  submissionStatus?: string;
  /**
   * The version the BINDING points at now, when it is no longer the one this run used.
   *
   * Rebinding the same session to a newer published version leaves a finished run pinned to
   * the old one, and the rerun submits the bound one - so the confirm has to say which.
   */
  boundVersionId?: string;
  triggerSource?: string;
  triggerKey?: string;
  gate?: { waitReason: WorkflowGateWaitReason | null; prUrl?: string | null } | null;
  policy?: "none" | "inspector";
  missingPrAction?: "offer_prepare_pr" | "wait";
}

function detailFor(shape: Shape): WorkflowRunDetail {
  const {
    status,
    phase = "persona_review",
    live = false,
    bindingState = "active",
    round = 2,
    maxRepairRounds = 5,
    externalSource = false,
    erroredAttempt = false,
    inspectorOnly = false,
    gate = null,
    policy = "none",
    missingPrAction = "offer_prepare_pr",
    submissionStatus = "running",
    triggerSource = "manual",
    triggerKey = manualWorkflowTriggerKey("binding", "request-1"),
    boundVersionId = "version",
  } = shape;
  const inspectorGate: WorkflowInspectorGateDetail | null = gate
    ? {
        state: {
          prKey: gate.prUrl ? "owner/repo#7" : null,
          prUrl: gate.prUrl ?? null,
          targetHeadSha: "head",
          failedHeadSha: null,
          enteredAt: 8,
          lastObservedAt: null,
          observedHeadSha: null,
          reviewPosture: null,
          waitReason: gate.waitReason,
          findingFingerprints: [],
        },
        inspector: { enabled: true, mode: "live", posture: null },
        inspection: null,
        findings: [],
      }
    : null;
  return {
    summary: {
      id: "run",
      status,
      phase,
      round,
      maxRepairRounds,
      workflowName: "Release review",
      workflowVersion: 2,
    },
    binding: {
      id: "binding",
      workflowVersionId: boundVersionId,
      deliveryMode: live ? "live" : "preview",
      state: bindingState,
      sessionId: bindingState === "active" ? "session" : null,
      sessionName: "Fix the diff link",
    },
    version: {
      completionPolicy: policy === "inspector"
        ? { kind: "inspector", onFindings: "restart_workflow", missingPrAction }
        : { kind: "none" },
    } as WorkflowVersion,
    run: { id: "run", status, currentPhase: phase, workflowVersionId: "version" },
    submissions: [{
      id: "submission",
      round,
      segment: 0,
      mode: inspectorOnly ? "inspector_only" : "full_workflow",
      status: submissionStatus,
      triggerSource,
      triggerKey,
      createdAt: 1,
    }],
    attempts: erroredAttempt
      ? [{ id: "attempt", state: "error", submissionId: "submission" }]
      : [],
    deliveries: [],
    events: [],
    externalSource: externalSource ? { kind: "ensemble", id: "ens" } : null,
    inspectorGate,
  } as unknown as WorkflowRunDetail;
}

/** The move's kind and its label, or `null` - the whole answer in one comparable value. */
const moveOf = (shape: Shape): { kind: string; label: string } | null => {
  const move = runNextMove(detailFor(shape));
  return move ? { kind: move.kind, label: move.label } : null;
};

test("a run in flight is explained by its own progress, not by a button", () => {
  for (const status of ["capturing", "running", "waiting_for_action"] as const) {
    assert.equal(moveOf({ status }), null, `${status} must offer no move`);
    assert.equal(
      runNoMoveReason(detailFor({ status })),
      null,
      `${status} must not explain itself in prose either`,
    );
  }
});

/**
 * The plan's largest functional gap: a finished run that could not be run again.
 *
 * Every terminal status reaches the same arm, and it is the one move keyed by the BINDING rather
 * than the run - a run is a thing that happened, and only the binding can start another. The path
 * assertion is the regression guard against copying the resubmission's shape: a
 * `/api/workflow-runs/{id}/resubmit` here would be sent at a route that refuses a terminal run,
 * and both spellings look equally plausible in a diff.
 */
test("every terminal status offers the rerun, keyed by the binding rather than the run", () => {
  for (const status of ["completed", "cancelled", "failed"] as const) {
    const detail = detailFor({ status, live: true });
    const move = runNextMove(detail);
    assert.ok(move, `${status} must offer a move`);
    assert.equal(move.kind, "run-again");
    assert.equal(move.label, "Run this review again");
    assert.equal(move.path, "/api/workflow-bindings/binding/submit");
    assert.doesNotMatch(move.path, /\/api\/workflow-runs\//, `${status} sent a run-keyed path`);
    assert.deepEqual(move.body, {});
    // Confirmed, because it captures fresh evidence and spends model tokens. NOT phrase-gated:
    // the typed phrase exists for the two actions that abandon work, and this one only adds.
    assert.ok(move.confirm, `${status} must confirm before spending tokens`);
    assert.equal(move.confirm.requirePhrase, undefined);
    assert.match(move.confirm.body, /spends model tokens/);
    assert.match(move.confirm.body, /starts a NEW run/i);
    // Named in the reader's terms: which workflow, which version, which session.
    assert.match(move.confirm.body, /Release review v2/);
    assert.match(move.confirm.body, /Fix the diff link/);
    // A move and a sentence never sit together, terminal runs included.
    assert.equal(runNoMoveReason(detail), null, `${status} must not also explain itself`);
  }
});

/** A bound preview must never invite an operator to a live submission, here as anywhere. */
test("a finished preview offers to preview again, not to run", () => {
  assert.deepEqual(
    moveOf({ status: "completed" }),
    { kind: "run-again", label: "Preview this review again" },
  );
});

/**
 * WHICH version the rerun would actually run.
 *
 * The submit route runs the version the binding points at NOW. Rebinding the same session to a
 * newer published version leaves this finished run pinned to the old one, so naming this run's
 * `v2` in the confirm would be a promise the route does not keep - and this is a button that
 * spends model tokens while making it.
 */
test("a rebound session's rerun says the bound version is not this run's", () => {
  const move = runNextMove(detailFor({ status: "completed", boundVersionId: "version-9" }));
  assert.match(
    move?.confirm?.body ?? "",
    /bound to a different published version than the Release review v2 this run used/,
  );
  assert.match(move?.confirm?.body ?? "", /the new run uses the bound one/);
});

/**
 * A finished run whose binding has gone is the one terminal state with no move, so it takes the
 * same treatment every other no-move state does: a sentence naming what would make another run
 * possible. Three states, three sentences, because "paused" and "the session is gone" are not
 * the same situation and a reader who is told the wrong one goes looking in the wrong place.
 */
test("a finished run whose binding has gone says so rather than offering a dead rerun", () => {
  const rows: [WorkflowBindingState, RegExp][] = [
    ["orphaned", /^The session this review ran against is gone,$/],
    ["paused", /^This review's binding is paused,$/],
    ["archived", /^This review's binding was archived,$/],
  ];
  for (const [bindingState, cause] of rows) {
    const detail = detailFor({ status: "completed", bindingState });
    assert.equal(runNextMove(detail), null, `a ${bindingState} binding must offer no rerun`);
    const reason = runNoMoveReason(detail);
    assert.match(reason?.cause ?? "", cause, `a ${bindingState} binding must say why`);
    assert.match(reason?.consequence ?? "", /cannot be run again from here/);
  }
});

/** The orchestrator that filed the run owns the next one, and the page says so. */
test("an externally sourced finished run leaves the next one to its orchestrator", () => {
  const detail = detailFor({ status: "failed", externalSource: true });
  assert.equal(runNextMove(detail), null);
  assert.equal(
    runNoMoveReason(detail)?.cause,
    "An external orchestrator started this run,",
  );
});

test("a waiting run resumes the review, in the binding's own voice", () => {
  assert.deepEqual(
    moveOf({ status: "waiting_for_session", live: true }),
    { kind: "resubmit", label: "Resume review" },
  );
  // Preview mode is the label's own branch and not a caller's choice: a bound preview must
  // never invite an operator to a live submission.
  assert.deepEqual(
    moveOf({ status: "waiting_for_session" }),
    { kind: "resubmit", label: "Preview fresh evidence" },
  );
});

/**
 * The unchanged-evidence recovery, and why it is not a co-equal twin.
 *
 * It answers exactly one refusal - `workflow_unchanged_evidence` - and the manager persists that
 * refusal as a run PHASE, so the affordance is durable across a remount rather than held in
 * component state. Offered before the refusal it is a second submission button nobody needs;
 * offered after it, it is the only move that gets the run going again.
 */
test("both unchanged-evidence phases offer the snapshot resubmission and nothing else", () => {
  assert.deepEqual(
    moveOf({ status: "waiting_for_session", phase: "unchanged_evidence", live: true }),
    { kind: "resubmit-unchanged", label: "Review this snapshot anyway" },
  );
  assert.deepEqual(
    moveOf({ status: "waiting_for_session", phase: "unchanged_evidence" }),
    { kind: "resubmit-unchanged", label: "Preview unchanged" },
  );
  assert.deepEqual(
    moveOf({ status: "blocked", phase: "unchanged_evidence_exhausted", live: true }),
    { kind: "resubmit-unchanged", label: "Review this snapshot anyway" },
  );
  assert.deepEqual(
    moveOf({ status: "blocked", phase: "unchanged_evidence_exhausted" }),
    { kind: "resubmit-unchanged", label: "Preview unchanged" },
  );
});

/**
 * The replayed request id comes off the RUN, so it cannot go missing with the component.
 *
 * This is the regression guard for the defect that made a `useRef` the wrong home for it. The ref
 * was empty after any reload, and nothing on screen said so: the header went on offering to review
 * "this snapshot" while the daemon, finding no prior submission, opened a fresh repair round and
 * spent one of the binding's on evidence it had already been told was identical. Reading the id
 * off the refused submission's own trigger key makes the answer a property of the run, which a
 * remount cannot take away.
 */
test("the refused request id is derived from the run, not remembered by the page", () => {
  assert.equal(
    refusedUnchangedRequestId(detailFor({
      status: "waiting_for_session",
      phase: "unchanged_evidence",
      submissionStatus: "failed",
      triggerKey: manualWorkflowTriggerKey("binding", "request-42"),
    })),
    "request-42",
  );
});

/**
 * `null` is a correct answer, not a failure: the caller mints a fresh id, which the daemon always
 * accepts. Every narrowing has to degrade that way, because the alternative is a request the
 * daemon answers "already applied" to - a click that silently does nothing.
 */
test("the replay is withheld wherever the daemon would not revive the submission", () => {
  const cases: [string, Shape][] = [
    // Past the nudge limit the revive guard no longer matches the phase, so a replay would be
    // answered with the old failed row and nothing would run.
    ["exhausted", {
      status: "blocked",
      phase: "unchanged_evidence_exhausted",
      submissionStatus: "failed",
    }],
    // No refusal has happened, so there is nothing to revive.
    ["no refusal", { status: "waiting_for_session", submissionStatus: "running" }],
    // The run moved on: the newest submission is not the refused one.
    ["submission not failed", {
      status: "waiting_for_session",
      phase: "unchanged_evidence",
      submissionStatus: "running",
    }],
    // An automatically triggered submission cannot be revived by a manual replay at all - no
    // request id could reconstruct its key.
    ["automatic trigger", {
      status: "waiting_for_session",
      phase: "unchanged_evidence",
      submissionStatus: "failed",
      triggerSource: "foreman",
      triggerKey: "foreman:binding:whatever",
    }],
    // A namespaced sibling under the same prefix. Replaying its request id against `resubmit`
    // would compose a key that matches a different submission, or none.
    ["restart-full key", {
      status: "waiting_for_session",
      phase: "unchanged_evidence",
      submissionStatus: "failed",
      triggerKey: "manual:binding:restart-full:request-9",
    }],
    // A key shape this build does not recognise degrades to a fresh id rather than to a guess.
    ["unrecognised key", {
      status: "waiting_for_session",
      phase: "unchanged_evidence",
      submissionStatus: "failed",
      triggerKey: "something-else-entirely",
    }],
  ];
  for (const [name, shape] of cases) {
    assert.equal(refusedUnchangedRequestId(detailFor(shape)), null, `${name} must not replay`);
  }
});

/** The composer and the reader are one contract, so a round trip is the honest assertion. */
test("a manual trigger key round-trips, and its namespaced siblings do not", () => {
  const key = manualWorkflowTriggerKey("binding-7", "abc-123");
  assert.equal(key, "manual:binding-7:abc-123");
  assert.equal(manualWorkflowTriggerRequestId("binding-7", key), "abc-123");
  // A different binding's key is not this binding's, even though the shape matches.
  assert.equal(manualWorkflowTriggerRequestId("binding-8", key), null);
  for (const sibling of [
    "manual:binding-7:restart-full:abc-123",
    "manual:binding-7:delivery-resolution:abc-123",
    "manual:binding-7:",
    "inspector-head:run:sha",
  ]) {
    assert.equal(
      manualWorkflowTriggerRequestId("binding-7", sibling),
      null,
      `${sibling} is not a manual submission request id`,
    );
  }
});

test("the gate waits resolve to the handoff first, then to a recheck", () => {
  assert.deepEqual(
    moveOf({
      status: "waiting_for_pr",
      policy: "inspector",
      gate: { waitReason: "missing_pr" },
    }),
    { kind: "prepare-pr", label: "Ask the session to open a PR" },
  );
  // Same state, but the version's own policy declines to offer the handoff: the gate can still
  // be re-evaluated, so that is the move.
  assert.deepEqual(
    moveOf({
      status: "waiting_for_pr",
      policy: "inspector",
      missingPrAction: "wait",
      gate: { waitReason: "missing_pr" },
    }),
    { kind: "recheck-inspector", label: "Check again" },
  );
  for (const status of ["waiting_for_inspector", "waiting_for_new_head"] as const) {
    assert.deepEqual(
      moveOf({ status, policy: "inspector", gate: { waitReason: "review_pending" } }),
      { kind: "recheck-inspector", label: "Check again" },
      `${status} must offer the recheck`,
    );
  }
});

/**
 * A gate action must not answer a blocked run.
 *
 * `manager.recheckInspector` accepts ANY non-terminal run that has a gate, so an unscoped
 * lookup would make `Check again` the primary for an Inspector findings block - a button that
 * re-reads a ledger nobody changed, in place of the sentence pointing at the findings.
 */
test("a blocked run's own recovery outranks the gate's recheck", () => {
  assert.deepEqual(
    moveOf({
      status: "blocked",
      phase: "infrastructure_error",
      erroredAttempt: true,
      gate: { waitReason: "review_pending" },
    }),
    { kind: "retry", label: "Retry the failed call" },
  );
  assert.equal(
    moveOf({
      status: "blocked",
      phase: "inspector_findings",
      policy: "inspector",
      gate: { waitReason: "findings" },
    }),
    null,
  );
});

/**
 * `manager.retry` refuses without an errored attempt, so the primary must not promise it - and
 * withholding it falls THROUGH to the resubmission rather than to nothing, because that is a call
 * the daemon does accept for a blocked run. A button that always answers 409 is worse than no
 * button; no button at all, where a working one exists, is worse than both.
 */
test("the provider retry needs a failed attempt, and falls through when there is none", () => {
  assert.deepEqual(
    moveOf({ status: "blocked", phase: "infrastructure_error", erroredAttempt: true }),
    { kind: "retry", label: "Retry the failed call" },
  );
  assert.deepEqual(
    moveOf({ status: "blocked", phase: "infrastructure_error" }),
    { kind: "resubmit", label: "Preview fresh evidence" },
  );
});

/**
 * A blocked phase nobody enumerated keeps its recovery.
 *
 * The no-move phases are a DENYLIST on purpose. `currentPhase` is a free string that new
 * `setRunState` callers add to without this module hearing about it, so an unrecognised block has
 * to degrade to the resubmission the daemon already accepts. Degrading the other way is how a
 * recoverable run becomes the dead end this whole derivation exists to remove.
 */
test("a blocked fault that a fresh capture can clear still offers the resubmission", () => {
  for (const phase of [
    "check_cleanup_unresolved",
    "capture_error",
    "capture_interrupted",
    "stale_capture",
    "delivery_prepare_error",
    "session_action_blocked",
    "inspector_gate_context_invalid",
    "external_artifact_mismatch",
    "a_phase_this_build_has_never_heard_of",
  ]) {
    assert.deepEqual(
      moveOf({ status: "blocked", phase, live: true }),
      { kind: "resubmit", label: "Resume review" },
      `blocked/${phase} must still offer a resubmission`,
    );
  }
});

test("a block whose recovery is a decision offers no move and names the owner", () => {
  const rows: [string, string][] = [
    ["inspector_findings", "they are listed under Inspector final gate below"],
    ["inspector_pr_closed", "Inspector final gate below carries the pull request"],
    ["inspector_disabled", "Turn it back on from Open Inspector settings, in Inspector final gate below."],
    ["delivery_uncertain", "Confirm or discard it in Deliveries below"],
    ["delivery_refused", "Retry or resolve it in Deliveries below"],
    ["delivery_blocked", "Deliveries below carries the packet and why it is held."],
  ];
  for (const [phase, owner] of rows) {
    const detail = detailFor({ status: "blocked", phase });
    assert.equal(moveOf({ status: "blocked", phase }), null, `blocked/${phase} must offer no move`);
    const reason = runNoMoveReason(detail);
    assert.ok(reason, `blocked/${phase} must say why`);
    assert.ok(
      reason.consequence.includes(owner),
      `blocked/${phase} must name where the decision lives, got: ${reason.consequence}`,
    );
  }
});

test("a session that is gone says so, and names cancelling", () => {
  const gone = runNoMoveReason(detailFor({
    status: "blocked",
    phase: "session_disappeared",
    bindingState: "orphaned",
  }));
  assert.equal(gone?.cause, "The session this run was reviewing is gone,");
  assert.match(gone?.consequence ?? "", /Cancelling clears it from your queue/);
});

/*
 * A run out of rounds used to be the page's one true dead end: no move, and a paragraph
 * naming the binding as the place to fix it. The paragraph was wrong - a run compares
 * against the `maxRepairRounds` it snapshotted at insert, which no binding edit rewrites -
 * and the dead end was the reason its pull request could never merge again. It is a move
 * now, and the move raises the number the refusal actually reads.
 */
test("a run out of rounds offers the grant rather than a dead end", () => {
  const detail = detailFor({ status: "blocked", phase: "round_limit", round: 6 });
  const move = runNextMove(detail);
  assert.equal(move?.kind, "grant-rounds");
  assert.match(move?.label ?? "", /Grant \d+ more rounds/);
  assert.match(move?.path ?? "", /\/grant-rounds$/);
  assert.equal(move?.body.rounds, 2);
  // The one move on this page that changes what a pull request is waiting for.
  assert.match(move?.confirm?.body ?? "", /pull request cannot merge/);
  assert.equal(runNoMoveReason(detail), null, "a move and a no-move sentence cannot both stand");
});

/*
 * The grant moves ONE number, and the whole design rests on that being enough: every way a
 * blocked run comes back refuses on `round > maxRepairRounds`, so a budget the run can
 * afford hands it straight back to the existing resume move with no second revival path.
 */
test("a granted budget hands the run back to the ordinary resume move", () => {
  const move = runNextMove(detailFor({
    status: "blocked",
    phase: "round_limit",
    round: 6,
    maxRepairRounds: 8,
  }));
  assert.notEqual(move, null, "a run inside its budget is not a dead end");
  assert.notEqual(move?.kind, "grant-rounds", "the grant outstayed the shortage it answers");
});

/*
 * The ceiling. `grantRepairRounds` clamps at `repairRoundsMax` and refuses a grant that
 * would not move the number, so offering the button at the maximum would render a control
 * whose only possible answer is a 409.
 */
test("a run already at the repair ceiling is not offered a grant it cannot take", () => {
  const move = runNextMove(detailFor({
    status: "blocked",
    phase: "round_limit",
    round: 21,
    maxRepairRounds: 20,
  }));
  assert.notEqual(move?.kind, "grant-rounds", "a button that can only answer 409");
});

/** The stale remedy, pinned as gone: it named the one fix guaranteed not to reach this run. */
test("no run-detail sentence sends the operator to the binding for a spent budget", () => {
  const spent = runNoMoveReason(detailFor({
    status: "blocked",
    phase: "round_limit",
    round: 6,
    bindingState: "orphaned",
  }));
  assert.ok(spent, "an unrevivable spent run must still say why");
  assert.doesNotMatch(spent.consequence, /change to the binding/);
});

/** The refusal copy `resubmitAvailability` writes, promoted from a tooltip into the page. */
test("an externally sourced run is refused in the manager's own words", () => {
  const detail = detailFor({ status: "waiting_for_session", externalSource: true });
  assert.equal(runNextMove(detail), null);
  assert.equal(
    runNoMoveReason(detail)?.cause,
    "An externally sourced run cannot take a manual round.",
  );
});

/**
 * An Inspector-only repair withholds the resubmission deliberately rather than by refusal, so
 * the sentence has to name the control that DOES apply - Restart full workflow, in the danger
 * group beside it. Two competing recoveries side by side is how an operator picks the wrong one.
 */
test("an Inspector-only repair names the restart instead of offering a round", () => {
  const detail = detailFor({
    status: "blocked",
    phase: "capture_error",
    inspectorOnly: true,
  });
  assert.equal(runNextMove(detail), null);
  assert.match(runNoMoveReason(detail)?.cause ?? "", /Inspector-only repair/);
  assert.match(runNoMoveReason(detail)?.consequence ?? "", /Restart full workflow/);
});

/**
 * `Open PR` earns its place when there is a pull request to open, and not otherwise.
 *
 * Three cases, because the distinction that matters is the URL and not the completion policy.
 * The middle one is what a policy-only gate gets wrong, and it is the common case: an
 * `inspector`-policy run sitting in `waiting_for_pr` is there precisely BECAUSE no pull request
 * is adopted yet. Absence is asserted, not `disabled === true`.
 */
test("Open PR is absent unless the gate carries a usable pull request URL", () => {
  const openPr = (shape: Shape): { href: string } | undefined => {
    const action = inspectorGateActions(detailFor(shape))
      .find((candidate) => candidate.kind === "open-pr");
    return action?.kind === "open-pr" ? { href: action.href } : undefined;
  };
  assert.equal(openPr({ status: "running", policy: "none" }), undefined);
  assert.equal(
    openPr({ status: "waiting_for_pr", policy: "inspector", gate: { waitReason: "missing_pr" } }),
    undefined,
  );
  assert.deepEqual(
    openPr({
      status: "waiting_for_inspector",
      policy: "inspector",
      gate: { waitReason: "review_pending", prUrl: "https://github.com/owner/repo/pull/7" },
    }),
    { href: "https://github.com/owner/repo/pull/7" },
  );
});

/**
 * The POST-only guard, over every state the union can reach.
 *
 * A navigation descriptor cannot be added without failing this: it would have no route to send,
 * so its `path` would be empty or fabricated. The same sweep pins the mutual exclusion of a move
 * and a sentence, and that every status in the append-only union is decided rather than thrown
 * on - a new status added upstream reaches this test before it reaches a reader.
 */
test("every move the table can produce is a sendable POST, and never sits beside a sentence", () => {
  const phases = [
    "persona_review",
    "unchanged_evidence",
    "unchanged_evidence_exhausted",
    "infrastructure_error",
    "check_cleanup_unresolved",
    "session_disappeared",
    "round_limit",
    "inspector_findings",
    "inspector_disabled",
    "delivery_uncertain",
  ];
  let moves = 0;
  for (const status of WORKFLOW_RUN_STATUSES) {
    for (const phase of phases) {
      for (const gate of [null, { waitReason: "review_pending" as const }]) {
        for (const live of [true, false]) {
          const detail = detailFor({
            status,
            phase,
            live,
            gate,
            policy: "inspector",
            erroredAttempt: true,
          });
          const move = runNextMove(detail);
          const reason = runNoMoveReason(detail);
          assert.ok(
            move === null || reason === null,
            `${status}/${phase} offered a move AND a reason`,
          );
          if (!move) continue;
          moves += 1;
          // Two route shapes and no third: every arm advances the RUN, except the rerun, which
          // asks the BINDING for a new one. Both are POSTs the action store can dispatch, and a
          // navigation descriptor would match neither.
          assert.match(
            move.path,
            move.kind === "run-again"
              ? /^\/api\/workflow-bindings\/binding\/submit$/
              : /^\/api\/workflow-runs\/run\/[a-z-]+$/,
            `${status}/${phase}`,
          );
          assert.ok(move.label.length > 0, `${status}/${phase} has an empty label`);
          assert.ok(move.tooltip.length > 0, `${status}/${phase} has an empty tooltip`);
          assert.ok(move.id.length > 0, `${status}/${phase} has an empty action id`);
        }
      }
    }
  }
  // The sweep has to actually reach moves, or it proves nothing about them.
  assert.ok(moves > 0, "the status sweep produced no moves at all");
});
