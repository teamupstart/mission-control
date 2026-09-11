import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  WORKFLOW_CHECK_CLEANUP_UNRESOLVED_PHASE,
  WORKFLOW_GATE_DETAIL_KEY,
  WORKFLOW_GATE_OWNED_STATUSES,
  WORKFLOW_INSPECTOR_ENTRY_PHASE,
  WORKFLOW_INSPECTOR_GATE_PHASES,
  WORKFLOW_RUN_PHASES,
  WORKFLOW_RUN_PHASE_MAX,
  WORKFLOW_RUN_PHASE_STATUSES,
  blockedPhaseClause,
  blockedPhaseClauseGaps,
  decodeWorkflowRunLifecycle,
  withInspectorGate,
  workflowCheckCleanupBlock,
  workflowInspectorGate,
  workflowRoundLimitBudget,
  workflowRoundLimitParkedPhase,
  workflowRunLifecycleViolation,
  workflowRunPhaseRecognized,
  type WorkflowRunLifecycleRecord,
  type WorkflowRunPhase,
} from "../src/shared/workflow-lifecycle.ts";
import {
  WORKFLOW_GATE_WAIT_REASONS,
  WORKFLOW_RUN_SPENT_PHASES,
  WORKFLOW_RUN_STATUSES,
  WORKFLOW_UNCHANGED_REPOSITORY_PHASE,
  type WorkflowInspectorGateState,
  type WorkflowJson,
} from "../src/shared/workflow.ts";

// What is at stake: a run states its lifecycle in three columns that vary independently, and
// three subsystems act on them. Every combination these tests admit is one the daemon can be
// in; every combination they refuse is one no reader could recover from. A decoder that
// answered two ways for one row, or a rule that let a stranded run be written, is the whole
// defect this file pins.

const gate: WorkflowInspectorGateState = {
  prKey: "owner/repo#7",
  prUrl: "https://github.com/owner/repo/pull/7",
  targetHeadSha: "head-a",
  failedHeadSha: null,
  enteredAt: 10,
  lastObservedAt: null,
  observedHeadSha: null,
  reviewPosture: null,
  waitReason: "awaiting_fresh_observation",
  findingFingerprints: ["finding-1"],
};

const asJson = (value: unknown): WorkflowJson => value as WorkflowJson;

const recordOf = (run: { status: string; currentPhase: string; gateState: WorkflowJson | null }) => ({
  status: run.status as WorkflowRunLifecycleRecord["status"],
  phase: run.currentPhase,
  gateState: run.gateState,
});

function record(
  status: WorkflowRunLifecycleRecord["status"],
  phase: string,
  gateState: WorkflowJson | null = null,
): WorkflowRunLifecycleRecord {
  return { status, phase, gateState };
}

/**
 * The representative payload each declared phase persists.
 *
 * The STATUSES are deliberately not here: they are the contract, so they live in
 * `WORKFLOW_RUN_PHASE_STATUSES` beside the registry and are read from it below. A copy in
 * this file would be a second source of truth for the very thing the validator enforces, and
 * the two would drift in exactly the direction that hides a bug - the test agreeing with
 * itself while the daemon does something else.
 *
 * EXHAUSTIVE by type: `Record<WorkflowRunPhase, ...>` means adding a phase to the registry
 * without deciding what its state looks like is a compile error here. That is the property
 * the first version of this table lacked - it listed seventeen hand-picked records, so a
 * registered phase like `delivery_blocked` or `session_action_blocked` could be declared
 * executable and never once be exercised.
 */
const VALID_STATES: Record<WorkflowRunPhase, { detail: WorkflowJson | null; kind: string }> = {
  // ---- driving states, where the attempts carry the run and no phase detail is kept -------
  activating: { detail: null, kind: "none" },
  capturing: { detail: null, kind: "none" },
  evidence_readiness_capture: { detail: null, kind: "none" },
  persona_review: { detail: null, kind: "none" },

  // ---- the two payloads an engine path acts on -------------------------------------------
  check_cleanup_unresolved: {
    detail: asJson({ nodeId: "check-1", attempts: 2, error: "lease unresolved" }),
    kind: "check_cleanup",
  },
  round_limit: {
    detail: asJson({ maxRepairRounds: 5, parkedPhase: "pr_handoff" }),
    kind: "round_limit",
  },
  inspector_round_limit: {
    detail: asJson({ maxRepairRounds: 5 }),
    kind: "round_limit",
  },

  // ---- the GitHub Inspector gate: sticky context, so no phase detail of its own -----------
  inspector_adapter_error: { detail: asJson(gate), kind: "none" },
  inspector_awaiting_fresh_observation: { detail: asJson(gate), kind: "none" },
  inspector_disabled: { detail: asJson(gate), kind: "none" },
  inspector_findings: { detail: asJson(gate), kind: "none" },
  inspector_head_mismatch: { detail: asJson(gate), kind: "none" },
  inspector_missing_pr: { detail: asJson(gate), kind: "none" },
  inspector_pr_closed: { detail: asJson(gate), kind: "none" },
  inspector_pr_switch_refused: { detail: asJson(gate), kind: "none" },
  inspector_review: { detail: asJson(gate), kind: "none" },
  inspector_review_backoff: { detail: asJson(gate), kind: "none" },
  inspector_review_error: { detail: asJson(gate), kind: "none" },
  inspector_unadopted_pr: { detail: asJson(gate), kind: "none" },
  inspector_working_tree_not_pushed: { detail: asJson(gate), kind: "none" },
  pr_handoff: { detail: asJson(gate), kind: "none" },

  // ---- phases that record a note about themselves and nothing acts on --------------------
  binding_archived: { detail: asJson({ reason: "binding_archived" }), kind: "opaque" },
  capture_error: { detail: asJson({ error: "capture failed" }), kind: "opaque" },
  capture_interrupted: { detail: asJson({ error: "interrupted" }), kind: "opaque" },
  complete: { detail: asJson({ outcome: "pass", label: "Approved" }), kind: "opaque" },
  conversation_changed: { detail: asJson({ reason: "conversation_changed" }), kind: "opaque" },
  delivery_blocked: { detail: asJson({ deliveryId: "d", reason: "consent" }), kind: "opaque" },
  delivery_prepare_error: { detail: asJson({ submissionId: "s", error: "e" }), kind: "opaque" },
  delivery_recovery_error: { detail: asJson({ deliveryId: "d", error: "e" }), kind: "opaque" },
  delivery_refused: { detail: asJson({ deliveryId: "d", reason: "refused" }), kind: "opaque" },
  delivery_uncertain: { detail: asJson({ deliveryId: "d", reason: "restart" }), kind: "opaque" },
  evidence_readiness: {
    detail: asJson({ submissionId: "s", gapCodes: ["no_tests"] }),
    kind: "opaque",
  },
  external_artifact_mismatch: {
    detail: asJson({ expectedHeadSha: "a", headSha: "b", headMatches: false }),
    kind: "opaque",
  },
  failed_outcome: { detail: asJson({ outcome: "fail", label: "Rejected" }), kind: "opaque" },
  image_evidence_capture: { detail: asJson({ error: "e", code: "image_changed" }), kind: "opaque" },
  // The payload `check_cleanup_unresolved` writes, under the phase that means the OPPOSITE.
  infrastructure_error: {
    detail: asJson({ nodeId: "n", attempts: 3, error: "provider call failed" }),
    kind: "opaque",
  },
  inspector_gate_context_invalid: { detail: asJson({ error: "no snapshot" }), kind: "opaque" },
  invalid_version: { detail: asJson({ error: "invalid" }), kind: "opaque" },
  missing_workflow_version: { detail: asJson({ error: "missing" }), kind: "opaque" },
  persona_feedback: {
    detail: asJson({ outcome: "fail", requestedChanges: [] }),
    kind: "opaque",
  },
  pr_handoff_prepare_error: { detail: asJson({ submissionId: "s", error: "e" }), kind: "opaque" },
  reattached_resubmit_required: {
    detail: asJson({ priorNoteKey: "a", noteKey: "b" }),
    kind: "opaque",
  },
  session_action: {
    detail: asJson({ nodeId: "n", attemptId: "a", deliveryId: "d", action: "Open PR" }),
    kind: "opaque",
  },
  session_action_blocked: {
    detail: asJson({ nodeId: "n", attemptId: "a", code: "refused", detail: "x" }),
    kind: "opaque",
  },
  session_action_capture: {
    detail: asJson({ nodeId: "n", attemptId: "a", submissionId: "s" }),
    kind: "opaque",
  },
  session_action_parallel_unsupported: { detail: asJson({ error: "parallel" }), kind: "opaque" },
  session_disappeared: { detail: asJson({ reason: "session_disappeared" }), kind: "opaque" },
  stale_capture: { detail: asJson({ error: "stale" }), kind: "opaque" },
  preflight_refinement_exhausted: {
    detail: asJson({ submissionId: "s1", round: 1, refinements: 2 }),
    kind: "opaque",
  },
  unchanged_evidence: {
    detail: asJson({ evidenceFingerprint: "fp", unchangedRefusals: 1 }),
    kind: "opaque",
  },
  unchanged_evidence_exhausted: {
    detail: asJson({ evidenceFingerprint: "fp", unchangedRefusals: 3 }),
    kind: "opaque",
  },
  unchanged_repository: {
    detail: asJson({ round: 2, evidenceFingerprint: "fp" }),
    kind: "opaque",
  },
};

test("every registered lifecycle state decodes to exactly one variant", () => {
  let checked = 0;
  for (const phase of WORKFLOW_RUN_PHASES) {
    const expected = VALID_STATES[phase];
    // Read from the shared contract, never from a local copy of it.
    for (const status of WORKFLOW_RUN_PHASE_STATUSES[phase]) {
      const input = record(status, phase, expected.detail);
      const lifecycle = decodeWorkflowRunLifecycle(input);
      assert.equal(
        lifecycle.detail.kind,
        expected.kind,
        `${status}/${phase} decoded as ${lifecycle.detail.kind}`,
      );
      assert.equal(lifecycle.phaseRecognized, true, `${phase} is not registered`);
      assert.equal(
        workflowRunLifecycleViolation(input),
        null,
        `${status}/${phase} was refused as a valid state`,
      );
      // `executable` is exactly its three documented conditions, asserted as a conjunction
      // rather than as an outcome: a recognised phase, a detail this build declared, and a
      // run that has not finished. Restating it here is what would catch the flag drifting
      // to depend on fewer of them, which is the defect this whole boundary was repaired for.
      assert.equal(
        lifecycle.executable,
        lifecycle.phaseRecognized
          && expected.kind !== "opaque"
          && !(["completed", "cancelled", "failed"] as string[]).includes(status),
        `${status}/${phase} executability`,
      );
      checked += 1;
    }
  }
  // The registry and the table are the same set, and every phase was actually exercised.
  assert.equal(Object.keys(VALID_STATES).length, new Set(WORKFLOW_RUN_PHASES).size);
  assert.equal(Object.keys(WORKFLOW_RUN_PHASE_STATUSES).length, new Set(WORKFLOW_RUN_PHASES).size);
  assert.ok(checked > WORKFLOW_RUN_PHASES.length, "some phases carry more than one status");
});

test("a bare gate and a legacy round-limit shape are still exactly one state each", () => {
  // The two shapes the exhaustive table above cannot express, because they are alternates for
  // a phase rather than its ordinary form.
  assert.equal(
    decodeWorkflowRunLifecycle(record("blocked", "round_limit", asJson({ maxRepairRounds: 5 }))).detail.kind,
    "round_limit",
  );
  const legacyBareGate = record("blocked", "round_limit", asJson(gate));
  assert.equal(decodeWorkflowRunLifecycle(legacyBareGate).detail.kind, "none");
  assert.deepEqual(workflowInspectorGate(legacyBareGate), gate);
  assert.equal(workflowRunLifecycleViolation(legacyBareGate), null);
});

test("the same three keys are a withheld retry or an exhausted node, by phase alone", () => {
  const detail = asJson({ nodeId: "check-1", attempts: 3, error: "lease unresolved" });
  // `infrastructure_error` writes this exact payload. Reading the payload first would arm the
  // cleanup resume over a node that has already spent every attempt it had.
  assert.equal(
    workflowCheckCleanupBlock(record("blocked", "infrastructure_error", detail)),
    null,
  );
  assert.deepEqual(
    workflowCheckCleanupBlock(record("blocked", WORKFLOW_CHECK_CLEANUP_UNRESOLVED_PHASE, detail)),
    { nodeId: "check-1", attempts: 3, error: "lease unresolved" },
  );
});

test("a round-limit block keeps the gate the run was reviewing under", () => {
  const detail = withInspectorGate({ maxRepairRounds: 5, parkedPhase: "pr_handoff" }, gate);
  const blocked = record("blocked", "round_limit", detail);
  // Both facts survive one block. Before the gate rode along, whichever writer got there
  // last erased the other's: the budget lost the pull request, or the gate lost the budget.
  assert.deepEqual(workflowRoundLimitBudget(blocked), {
    maxRepairRounds: 5,
    parkedPhase: "pr_handoff",
  });
  assert.deepEqual(workflowInspectorGate(blocked), gate);
  assert.equal(workflowRoundLimitParkedPhase(blocked), "pr_handoff");
  // A record written before the block carried the budget is the bare gate, and still reads.
  assert.deepEqual(workflowInspectorGate(record("blocked", "round_limit", asJson(gate))), gate);
  assert.equal(workflowRoundLimitBudget(record("blocked", "round_limit", asJson(gate))), null);
  // A bare gate records no budget, so it is not a round-limit DETAIL at all - and the block
  // is still legal, because the gate is the thing a grant revives it through.
  assert.equal(
    decodeWorkflowRunLifecycle(record("blocked", "round_limit", asJson(gate))).detail.kind,
    "none",
  );
  assert.equal(workflowRunLifecycleViolation(record("blocked", "round_limit", asJson(gate))), null);
});

test("a parked phase never restores a run into the block it is leaving", () => {
  for (const spent of WORKFLOW_RUN_SPENT_PHASES) {
    assert.equal(
      workflowRoundLimitParkedPhase(
        record("blocked", "round_limit", asJson({ maxRepairRounds: 3, parkedPhase: spent })),
      ),
      null,
      spent,
    );
  }
});

test("an unknown phase is inspectable and never executable, whatever its detail", () => {
  // The legacy-safety boundary is keyed on the PHASE, not only on the payload. A row from a
  // newer daemon, or a phase this build has dropped, is a lifecycle state whose meaning is
  // unknown - and a null detail does not make it knowable. Every executable path is keyed on
  // the phase, so "no detail to misread" is not the same as "safe to act on".
  for (const detail of [null, asJson({ maxRepairRounds: 5 }), asJson(gate)]) {
    const unknown = record("running", "a_phase_from_a_newer_daemon", detail);
    const lifecycle = decodeWorkflowRunLifecycle(unknown);
    assert.equal(lifecycle.phaseRecognized, false);
    assert.equal(lifecycle.executable, false, `detail ${JSON.stringify(detail)} read as executable`);
    // Inspectable: the status, the phase and the stored payload all survive the decode, and a
    // gate the run genuinely holds is still nameable.
    assert.equal(lifecycle.status, "running");
    assert.equal(lifecycle.phase, "a_phase_from_a_newer_daemon");
    assert.equal(workflowCheckCleanupBlock(unknown), null);
    assert.equal(workflowRoundLimitBudget(unknown), null);
  }
  assert.deepEqual(
    workflowInspectorGate(record("running", "a_phase_from_a_newer_daemon", asJson(gate))),
    gate,
    "an unknown phase must still be able to say which pull request it was reviewing",
  );
  // Storable, because refusing it would make a legacy run unreadable rather than safe.
  assert.equal(workflowRunLifecycleViolation(record("blocked", "a_reason_code_nothing_maps")), null);
});

test("every phase the daemon acts on is registered, and the registry is the only key", () => {
  // A phase missing here is not a cosmetic gap: it makes a legitimate run non-executable and
  // silently stops the path that resumes it. These are the phases with executable meaning.
  for (const phase of [
    WORKFLOW_CHECK_CLEANUP_UNRESOLVED_PHASE,
    WORKFLOW_UNCHANGED_REPOSITORY_PHASE,
    ...WORKFLOW_RUN_SPENT_PHASES,
    ...WORKFLOW_INSPECTOR_GATE_PHASES,
    ...Object.values(WORKFLOW_INSPECTOR_ENTRY_PHASE),
  ]) {
    assert.ok(workflowRunPhaseRecognized(phase), `${phase} is not in the phase registry`);
  }
  // No status is a way around it: an unknown phase is unrecognised under every one of them.
  for (const status of WORKFLOW_RUN_STATUSES) {
    assert.equal(
      decodeWorkflowRunLifecycle(record(status, "not_a_declared_phase")).executable,
      false,
      status,
    );
  }
  assert.ok(WORKFLOW_RUN_PHASES.length > WORKFLOW_INSPECTOR_GATE_PHASES.length);
});

test("an unrecognised payload stays readable and is never handed to an executable path", () => {
  const legacy = asJson({ someOlderDaemonWrote: "a shape this build never declared" });
  const lifecycle = decodeWorkflowRunLifecycle(record("blocked", "delivery_refused", legacy));
  assert.equal(lifecycle.detail.kind, "opaque");
  assert.equal(lifecycle.executable, false);
  assert.deepEqual(
    lifecycle.detail.kind === "opaque" ? lifecycle.detail.detail : null,
    legacy,
    "the raw record remains inspectable",
  );
  assert.equal(workflowInspectorGate(record("blocked", "delivery_refused", legacy)), null);
  assert.equal(workflowCheckCleanupBlock(record("blocked", "delivery_refused", legacy)), null);
  assert.equal(workflowRoundLimitBudget(record("blocked", "delivery_refused", legacy)), null);
});

test("a finished run is never executable, whatever it still carries", () => {
  for (const status of ["completed", "cancelled", "failed"] as const) {
    const lifecycle = decodeWorkflowRunLifecycle(record(status, "complete", asJson(gate)));
    assert.equal(lifecycle.executable, false, status);
    // Readable, because a finished GitHub Inspector review's result IS its gate.
    assert.deepEqual(workflowInspectorGate(record(status, "complete", asJson(gate))), gate);
  }
});

test("contradictory lifecycle combinations are refused before persistence", () => {
  const invalid: Array<[WorkflowRunLifecycleRecord, string]> = [
    // A status only the GitHub Inspector poller un-parks, with nothing for it to read.
    [record("waiting_for_new_head", "inspector_findings"), "requires its state"],
    // Caught by the detail contract first, which is the more precise complaint: the gate
    // phases record no detail of their own at all.
    [
      record("waiting_for_inspector", "inspector_review", asJson({ error: "x" })),
      "inspector_review records no detail of its own, but carries error",
    ],
    // A phase recording something it has no business knowing - previously accepted, because
    // the decoder called any unrecognised object `opaque` and no rule looked further.
    [
      record("blocked", "delivery_refused", asJson({ deliveryId: "d", nodeId: "n" })),
      "delivery_refused records deliveryId, reason, not nodeId",
    ],
    [
      record("blocked", "capture_error", asJson({ deliveryId: "d" })),
      "capture_error records error, code, not deliveryId",
    ],
    // A phase whose only detail is what a delivery leaves behind, carrying something else.
    [
      record("waiting_for_session", "pr_handoff", asJson({ submissionId: "s" })),
      "pr_handoff records deliveryId, reason, transcriptAnchor, resolvedByOperator, not submissionId",
    ],
    // The gate cannot re-enter a phase it does not know, so it must not park in one.
    // Caught by the phase's own declared status contract, which fires before the gate rules.
    [record("waiting_for_pr", "delivery_refused", asJson(gate)), "is persisted as blocked"],
    // The reviewer's example: a registered phase under a status it is never written with.
    // Recognised phase, cleanly decoding payload, and previously no rule mentioned it.
    [
      record("completed", "delivery_refused", asJson({ deliveryId: "d" })),
      "delivery_refused is persisted as blocked, not completed",
    ],
    // The same hole in the other direction: a driving phase on a run that is not driving.
    [record("blocked", "persona_review"), "persona_review is persisted as running"],
    [record("running", "capturing"), "capturing is persisted as capturing, not running"],
    [
      record("waiting_for_session", "evidence_readiness", asJson({ submissionId: "s" })),
      "evidence_readiness is persisted as waiting_for_evidence_readiness",
    ],
    // NOTE: an unrecognised `inspector_`-prefixed phase is deliberately NOT in this table. It
    // is an unknown phase like any other, and a later test proves it is treated as one.
    // A spent-budget block that recorded neither the budget nor the gate cannot be granted out of.
    [record("blocked", "round_limit", asJson({ error: "out" })), "round_limit records maxRepairRounds, parkedPhase, not error"],
    [record("blocked", "round_limit"), "must record the budget"],
    [record("waiting_for_session", "round_limit", asJson({ maxRepairRounds: 2 })), "is persisted as blocked"],
    // A cleanup block with nothing to resume, and one whose status says it is not blocked.
    [
      record("blocked", WORKFLOW_CHECK_CLEANUP_UNRESOLVED_PHASE, asJson({ error: "x" })),
      "must name the node and attempt",
    ],
    [
      record("running", WORKFLOW_CHECK_CLEANUP_UNRESOLVED_PHASE, asJson({
        nodeId: "n",
        attempts: 1,
        error: "x",
      })),
      "is persisted as blocked",
    ],
    // The action wait is its own vocabulary and must not borrow another phase's.
    [record("waiting_for_action", "persona_feedback"), "is persisted as waiting_for_session"],
    // A finished run must not advertise work to resume.
    [record("cancelled", "round_limit", asJson({ maxRepairRounds: 2 })), "is persisted as blocked"],
    [
      record("completed", WORKFLOW_CHECK_CLEANUP_UNRESOLVED_PHASE, asJson({
        nodeId: "n",
        attempts: 1,
        error: "x",
      })),
      "is persisted as blocked",
    ],
    // A phase is a code, not a blob.
    [record("blocked", ""), "must not be empty"],
    [record("blocked", "x".repeat(WORKFLOW_RUN_PHASE_MAX + 1)), "must not exceed"],
  ];
  for (const [input, fragment] of invalid) {
    const violation = workflowRunLifecycleViolation(input);
    assert.ok(
      violation?.includes(fragment),
      `${input.status}/${input.phase.slice(0, 40)} reported ${violation}`,
    );
  }
});

test("the GitHub Inspector gate entry phase is a closed lookup, not an interpolation", () => {
  // The interpolation this replaced produced `inspector_inspector_disabled` for one reason,
  // and both routes back into a blocked gate test for `inspector_disabled` exactly.
  assert.equal(WORKFLOW_INSPECTOR_ENTRY_PHASE.inspector_disabled, "inspector_disabled");
  // Total and inside the registry: every reason names a phase, and every one of those phases
  // is one the gate can re-enter.
  for (const reason of WORKFLOW_GATE_WAIT_REASONS) {
    const phase = WORKFLOW_INSPECTOR_ENTRY_PHASE[reason];
    assert.ok(
      (WORKFLOW_INSPECTOR_GATE_PHASES as readonly string[]).includes(phase),
      `${reason} names an unregistered phase ${phase}`,
    );
  }
  // Every gate-owned status has at least one phase it may legitimately park in.
  for (const status of WORKFLOW_GATE_OWNED_STATUSES) {
    const parkable = WORKFLOW_INSPECTOR_GATE_PHASES.filter((phase) =>
      workflowRunLifecycleViolation(record(status, phase, asJson(gate))) === null);
    assert.ok(parkable.length > 0, status);
  }
});

test("the sticky gate rides beside a phase detail without becoming it", () => {
  const detail = withInspectorGate({ round: 3, evidenceFingerprint: "fp" }, gate);
  const parked = record("waiting_for_session", "unchanged_repository", detail);
  assert.deepEqual(workflowInspectorGate(parked), gate);
  assert.equal(
    (detail as { [key: string]: WorkflowJson }).round,
    3,
    "the phase's own detail is untouched",
  );
  // No gate to keep means no reserved key, so an ordinary detail keeps its exact shape.
  const plain = withInspectorGate({ round: 3 }, null);
  assert.deepEqual(plain, { round: 3 });
  assert.equal((plain as { [key: string]: WorkflowJson })[WORKFLOW_GATE_DETAIL_KEY], undefined);

  // And NOTHING to keep beside the gate stays the BARE gate rather than an envelope around
  // it. This is the case the compare-and-set statements depend on: `{ gate: {...} }` where the
  // bare gate belongs would stop every gate transition from matching, silently.
  const only = withInspectorGate({}, gate);
  assert.deepEqual(only, gate as unknown as WorkflowJson);
  assert.equal((only as { [key: string]: WorkflowJson })[WORKFLOW_GATE_DETAIL_KEY], undefined);
  assert.deepEqual(
    decodeWorkflowRunLifecycle({
      status: "waiting_for_session",
      phase: "pr_handoff",
      gateState: only,
    }).detailKeys,
    [],
    "a gate with nothing beside it records no phase detail",
  );
});

// ---------------------------------------------------------------------------
// The two defects the model above exists to close, through the real store.
// ---------------------------------------------------------------------------

const home = mkdtempSync(join(tmpdir(), "mission-workflow-lifecycle-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

/**
 * A run stranded in the phase the gate's old string interpolation invented, written into the
 * database BEFORE the daemon opens it - which is the only way to prove the migration ran.
 *
 * `inspector_${waitReason}` produced `inspector_inspector_disabled` when the reason was itself
 * `inspector_disabled`, and both routes back into a blocked gate test for `inspector_disabled`
 * exactly. Re-enabling GitHub Inspector never re-evaluated the run and Recheck refused it, so
 * nothing on the machine would ever have looked at this row again.
 */
const STRANDED_GATE: WorkflowInspectorGateState = { ...gate, waitReason: "inspector_disabled" };
{
  const raw = new DatabaseSync(join(home, "harness.db"));
  raw.exec(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id                    TEXT PRIMARY KEY,
      binding_id            TEXT NOT NULL,
      workflow_version_id   TEXT NOT NULL,
      status                TEXT NOT NULL,
      current_phase         TEXT NOT NULL,
      max_repair_rounds     INTEGER NOT NULL,
      trigger_source        TEXT NOT NULL,
      trigger_key           TEXT NOT NULL,
      inspector_pr_key      TEXT,
      inspector_head_sha    TEXT,
      gate_state_json       TEXT,
      started_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL,
      completed_at          INTEGER
    );
  `);
  raw.prepare(
    `INSERT INTO workflow_runs (
       id, binding_id, workflow_version_id, status, current_phase, max_repair_rounds,
       trigger_source, trigger_key, gate_state_json, started_at, updated_at
     ) VALUES ('stranded', 'binding', 'version', 'blocked', 'inspector_inspector_disabled', 3,
               'manual', 'trigger-stranded', ?, 1, 1)`,
  ).run(JSON.stringify(STRANDED_GATE));
  raw.close();
}

const { openDb } = await import("../src/server/db.ts");
const { WorkflowStore, clearWorkflowTables } = await import("../src/server/workflows/store.ts");
const db = openDb();
const store = new WorkflowStore(db);
// Read HERE, and the position is load-bearing: immediately after the daemon's own open has
// migrated the seeded row, and before the manager and registry modules below are imported.
// Importing those two BEFORE this read leaves `workflow_runs` empty, so the capture must come
// first for this test to be measuring the migration at all rather than an empty table.
const migratedStrandedRun = store.getRun("stranded");

const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const { Registry } = await import("../src/server/registry.ts");

function seedRun(id: string, status: string, phase: string, gateState: unknown): void {
  db.prepare(
    `INSERT INTO workflow_runs (
       id, binding_id, workflow_version_id, status, current_phase, max_repair_rounds,
       trigger_source, trigger_key, gate_state_json, started_at, updated_at
     ) VALUES (?, 'binding', 'version', ?, ?, 3, 'manual', ?, ?, 1, 1)`,
  ).run(id, status, phase, `trigger-${id}`, gateState === null ? null : JSON.stringify(gateState));
}

test("a run that spends its budget while gated keeps the pull request it was gated on", () => {
  clearWorkflowTables(db);
  // The reachable case: a `pr_handoff` run parked for the session, whose operator clicks
  // Resubmit after the budget is gone. `blockForRoundLimit` used to overwrite the column with
  // the budget alone, and the pull request, entry time and finding fingerprints went with it -
  // unrecoverably, because nothing else on the run records them.
  seedRun("spent", "waiting_for_session", "pr_handoff", gate);
  const blocked = store.blockForRoundLimit(store.getRun("spent")!, 50);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.currentPhase, "round_limit");
  const lifecycle = {
    status: blocked.status,
    phase: blocked.currentPhase,
    gateState: blocked.gateState,
  };
  assert.deepEqual(workflowInspectorGate(lifecycle), gate, "the gate did not survive the block");
  assert.deepEqual(workflowRoundLimitBudget(lifecycle), {
    maxRepairRounds: 3,
    parkedPhase: "pr_handoff",
  });
});

test("the store refuses a lifecycle triple no reader could recover from", () => {
  clearWorkflowTables(db);
  seedRun("guarded", "running", "persona_review", null);
  // Stranding: a status only the GitHub Inspector poller un-parks, with no gate to poll.
  assert.throws(
    () => store.setRunState("guarded", "waiting_for_new_head", "inspector_findings", null),
    /requires its state/,
  );
  // Arming the cleanup resume over a payload that is not a cleanup block.
  assert.throws(
    () => store.setRunState("guarded", "blocked", WORKFLOW_CHECK_CLEANUP_UNRESOLVED_PHASE, {
      error: "not a node",
    }),
    /must name the node and attempt/,
  );
  // The interpolated phase that stranded every gate entered while GitHub Inspector was off.
  // Through the COMPATIBILITY door, because `setRunState` no longer accepts a phase this
  // build does not declare - that is now a compile error, which is the stronger guarantee, and
  // the reason no runtime rule refuses an unrecognised `inspector_` phase any more.
  assert.equal(store.getRun("guarded")?.currentPhase, "persona_review", "a refusal wrote nothing");
});

test("runs stranded in the phase an interpolation invented are migrated back", () => {
  const migrated = migratedStrandedRun!;
  assert.ok(migrated, "the legacy row did not survive the upgrade at all");
  assert.equal(
    migrated.currentPhase,
    "inspector_disabled",
    "the run is still parked where neither the gate poller nor Recheck will look",
  );
  assert.equal(migrated.status, "blocked", "a disabled gate is genuinely blocked");
  assert.equal(
    workflowRunLifecycleViolation({
      status: migrated.status,
      phase: migrated.currentPhase,
      gateState: migrated.gateState,
    }),
    null,
  );
});

test("a legacy record stays queryable through every introspection path, byte for byte", () => {
  clearWorkflowTables(db);
  // A row from a build this one does not share: a phase nothing here declares, carrying a
  // detail shape nothing here declares either. It must survive being stored and read back
  // WITHOUT modification, because a legacy run that cannot be read is a legacy run that
  // cannot be diagnosed - and a decoder that quietly normalised it would destroy the only
  // record of what the older daemon actually did.
  const legacyDetail = {
    someOlderDaemonWrote: "a shape this build never declared",
    nested: { round: 4, fingerprints: ["a", "b"] },
    count: 0,
  };
  // The summary projection inner-joins the binding, so the row needs one to be reachable.
  db.prepare(
    `INSERT INTO workflow_bindings (
       id, workflow_version_id, note_key, session_id, trigger_mode, delivery_mode, state,
       max_repair_rounds, created_at, updated_at
     ) VALUES ('binding', 'version', 'note', 'session', 'manual', 'preview', 'active', 3, 1, 1)`,
  ).run();
  seedRun("legacy", "blocked", "a_phase_from_another_build", legacyDetail);

  // Every read path the daemon and the dashboard use.
  const read = store.getRun("legacy")!;
  assert.equal(read.currentPhase, "a_phase_from_another_build", "getRun rewrote the phase");
  assert.deepEqual(read.gateState, legacyDetail, "getRun lost or changed the stored detail");
  assert.equal(
    JSON.stringify(read.gateState),
    JSON.stringify(legacyDetail),
    "the detail did not round-trip byte for byte",
  );

  const listed = store.listRuns().find((run) => run.id === "legacy");
  assert.ok(listed, "listRuns dropped the legacy row");
  assert.equal(listed.currentPhase, "a_phase_from_another_build");
  assert.deepEqual(listed.gateState, legacyDetail);

  // The projection the Runs page reads. It must NAME the unknown phase rather than blank it.
  const summary = store.runSummary("legacy");
  assert.ok(summary, "runSummary dropped the legacy row");
  assert.equal(summary.phase, "a_phase_from_another_build");
  assert.equal(summary.status, "blocked");

  // Writing an unknown phase is ALLOWED and lossless: refusing it would make a legacy run
  // unreadable rather than safe, which is the opposite of the guarantee.
  const rewritten = store.setRunStateCarryingPhase(
    "legacy",
    "blocked",
    "another_unknown_phase",
    legacyDetail,
    60,
  );
  assert.equal(rewritten.currentPhase, "another_unknown_phase");
  assert.deepEqual(rewritten.gateState, legacyDetail);

  // Inspectable, and still not executable - the two halves of the guarantee together.
  const lifecycle = decodeWorkflowRunLifecycle({
    status: rewritten.status,
    phase: rewritten.currentPhase,
    gateState: rewritten.gateState,
  });
  assert.equal(lifecycle.phaseRecognized, false);
  assert.equal(lifecycle.executable, false);
  assert.deepEqual(
    lifecycle.detail.kind === "opaque" ? lifecycle.detail.detail : null,
    legacyDetail,
    "the decode did not carry the raw record through for inspection",
  );
});

test("the store refuses a registered phase under a status it is never written with", () => {
  clearWorkflowTables(db);
  seedRun("mismatch", "running", "persona_review", null);
  // The reviewer's example. Every part of this looked fine to the old validator: the phase is
  // registered, the payload decodes cleanly as `opaque`, and no special rule mentioned either
  // - so a finished run parked on a delivery refusal was persistable. It is a contradiction
  // because `delivery_refused` means a packet the session never took, which a completed run
  // cannot be waiting on.
  assert.throws(
    () => store.setRunState("mismatch", "completed", "delivery_refused", { deliveryId: "d" }),
    /delivery_refused is persisted as blocked, not completed/,
  );
  // The same hole in the other direction: a driving phase on a run that is not driving.
  assert.throws(
    () => store.setRunState("mismatch", "blocked", "persona_review"),
    /persona_review is persisted as running/,
  );
  assert.throws(
    () => store.setRunState("mismatch", "waiting_for_session", "evidence_readiness", {
      submissionId: "s",
    }),
    /evidence_readiness is persisted as waiting_for_evidence_readiness/,
  );
  assert.equal(store.getRun("mismatch")?.currentPhase, "persona_review", "a refusal wrote nothing");
  assert.equal(store.getRun("mismatch")?.status, "running");
  // And every status the contract DOES declare for a phase is accepted, so the rule bounds
  // the writers rather than merely narrowing them.
  for (const status of WORKFLOW_RUN_PHASE_STATUSES.unchanged_repository) {
    const moved = store.setRunState("mismatch", status, "unchanged_repository", { round: 1 });
    assert.equal(moved.status, status);
    assert.equal(moved.currentPhase, "unchanged_repository");
  }
});

test("the GitHub Inspector gate leaves a legacy unknown-phase run exactly as persisted", async () => {
  clearWorkflowTables(db);
  // A row a newer daemon left: a live gate, a gate-owned status, and a phase this build does
  // not declare. The decoder calls it non-executable, and the gate is an execution path - so
  // it must not advance or REWRITE the record. Before the guard, the fresh-observation path
  // substituted a recognised phase for the unknown one and wrote it back, destroying the only
  // evidence of what the older daemon was doing.
  seedRun("legacy-gated", "waiting_for_inspector", "inspector_from_a_newer_daemon", gate);
  const before = store.getRun("legacy-gated")!;
  assert.equal(
    decodeWorkflowRunLifecycle({
      status: before.status,
      phase: before.currentPhase,
      gateState: before.gateState,
    }).executable,
    false,
    "the record must decode as non-executable for this test to mean anything",
  );
  const manager = new WorkflowManager(new Registry(), store);
  await (manager as unknown as {
    evaluateInspectorGate(id: string, observation: null): Promise<void>;
  }).evaluateInspectorGate("legacy-gated", null);
  const after = store.getRun("legacy-gated")!;
  assert.equal(after.currentPhase, "inspector_from_a_newer_daemon", "the gate rewrote the phase");
  assert.equal(after.status, "waiting_for_inspector");
  assert.deepEqual(after.gateState, before.gateState, "the gate rewrote the stored state");
  assert.equal(after.updatedAt, before.updatedAt, "the gate touched the row");
});

test("the store refuses a registered phase carrying detail it has no business recording", () => {
  clearWorkflowTables(db);
  seedRun("detail", "running", "persona_review", null);
  // Previously accepted: the phase is registered, the status is right, and the decoder
  // classified the payload as `opaque` because it recognised nothing in it - so no rule
  // looked further and a delivery refusal could be stored naming a check node.
  assert.throws(
    () => store.setRunState("detail", "blocked", "delivery_refused", {
      deliveryId: "d",
      nodeId: "n",
    }),
    /delivery_refused records deliveryId, reason, not nodeId/,
  );
  assert.throws(
    () => store.setRunState("detail", "blocked", "capture_error", { deliveryId: "d" }),
    /capture_error records error, code, not deliveryId/,
  );
  // A gate-only phase may not grow a phase detail.
  assert.throws(
    () => store.setRunState("detail", "waiting_for_inspector", "inspector_review", {
      error: "x",
    }),
    /inspector_review records no detail of its own, but carries error/,
  );
  assert.equal(store.getRun("detail")?.currentPhase, "persona_review", "a refusal wrote nothing");
  // A writer that fills fewer of the phase's optional fields than another is NOT a
  // contradiction, which is why the contract bounds the key set rather than requiring keys.
  assert.equal(
    store.setRunState("detail", "blocked", "infrastructure_error", { nodeId: "n" }).currentPhase,
    "infrastructure_error",
  );
});

test("the carry-forward door is held to the same detail contract as the naming writer", () => {
  clearWorkflowTables(db);
  seedRun("carry", "running", "persona_review", null);
  // No door is exempt. This one once skipped the detail half, on the argument that a payload
  // it merely carried was not its to justify - which made "every registered phase" untrue and
  // excused exactly the payloads that had landed somewhere they did not belong.
  assert.throws(
    () => store.setRunStateCarryingPhase("carry", "waiting_for_action", "session_action", {
      nodeId: "n",
      attemptId: "a",
      code: "refused",
      detail: "the note from the phase this run was in a moment ago",
    }),
    /session_action records .*not code, detail/,
  );
  // The status half applies here too, as it always did.
  assert.throws(
    () => store.setRunStateCarryingPhase("carry", "completed", "delivery_refused", {
      deliveryId: "d",
    }),
    /delivery_refused is persisted as blocked, not completed/,
  );
  // What the door still relaxes is the PHASE SPELLING, and only that: a free-form cancel
  // reason and a phase from a newer daemon must stay storable, or a legacy run becomes
  // unreadable rather than safe.
  const legacy = store.setRunStateCarryingPhase("carry", "blocked", "a_phase_from_elsewhere", {
    anything: "at all",
  });
  assert.equal(legacy.currentPhase, "a_phase_from_elsewhere");
  assert.equal(store.getRun("carry")?.currentPhase, "a_phase_from_elsewhere");
});

test("a delivery that moves the phase carries the gate, and leaves the old note behind", () => {
  clearWorkflowTables(db);
  // The fix at the source. A delivery does not author a lifecycle state - it confirms a packet
  // and leaves the run where that packet put it. While the phase stands still its note is
  // still its own; when the phase MOVES, the note belongs to the phase being left, and only
  // the sticky gate rides across.
  seedRun("moved", "blocked", "delivery_uncertain", withInspectorGate({ deliveryId: "d" }, gate));
  const before = store.getRun("moved")!;
  assert.deepEqual(workflowInspectorGate(recordOf(before)), gate);

  const carried = (store as unknown as {
    deliveryCarriedDetail(run: typeof before, phase: string, own: WorkflowJson | null): WorkflowJson | null;
  }).deliveryCarriedDetail(before, "evidence_readiness", null);
  assert.deepEqual(
    carried,
    gate as unknown as WorkflowJson,
    "a phase change must carry the gate alone, not the note it is leaving",
  );
  // And the result satisfies the destination phase's contract, which is the point: the old
  // note would not have.
  assert.equal(
    workflowRunLifecycleViolation({
      status: "waiting_for_evidence_readiness",
      phase: "evidence_readiness",
      gateState: carried,
    }),
    null,
  );

  // Standing still, the note is still this phase's own and is carried verbatim.
  const held = (store as unknown as {
    deliveryCarriedDetail(run: typeof before, phase: string, own: WorkflowJson | null): WorkflowJson | null;
  }).deliveryCarriedDetail(before, "delivery_uncertain", null);
  assert.deepEqual(held, before.gateState);

  // AND the branch where the delivery has a detail of its own. Returning that bare would drop
  // the gate for exactly the reason the round-limit block used to: a payload with something of
  // its own to say overwriting the one thing that was never the phase's to hold.
  const own = (store as unknown as {
    deliveryCarriedDetail(
      run: typeof before,
      phase: string,
      own: { [key: string]: WorkflowJson } | null,
    ): WorkflowJson | null;
  }).deliveryCarriedDetail(before, "persona_feedback", {
    deliveryId: "d",
    transcriptAnchor: 42,
  });
  assert.deepEqual(
    workflowInspectorGate({
      status: "waiting_for_session",
      phase: "persona_feedback",
      gateState: own,
    }),
    gate,
    "a delivery recording its own detail must not drop the gate",
  );
  assert.equal((own as { [key: string]: WorkflowJson }).deliveryId, "d", "and keeps its own detail");
  // The result is still a legal persona_feedback record: the reserved gate key is never
  // counted as phase detail.
  assert.equal(
    workflowRunLifecycleViolation({
      status: "waiting_for_session",
      phase: "persona_feedback",
      gateState: own,
    }),
    null,
  );
});

test("a valid gate cannot smuggle foreign keys past the detail contract", () => {
  clearWorkflowTables(db);
  seedRun("smuggle", "running", "persona_review", null);
  // The hole this closes, and it is worth naming precisely because it looked closed. The gate
  // schema is NON-STRICT: handed a valid gate plus `error`, it parses and returns only the
  // gate. Reading the parse, the record looked like a bare gate carrying no phase detail. But
  // `setRunState` persists `JSON.stringify(gateState)` - the object it was HANDED - so `error`
  // reached SQLite on a phase whose contract permits no detail of its own. The decoder now
  // derives the phase's own keys from the raw object minus the keys the gate consumed.
  const gateWithStray = { ...gate, error: "x" } as unknown as WorkflowJson;
  assert.throws(
    () => store.setRunState("smuggle", "waiting_for_inspector", "inspector_review", gateWithStray),
    /inspector_review records no detail of its own, but carries error/,
  );
  // Through the compatibility door too - no writer is exempt.
  assert.throws(
    () => store.setRunStateCarryingPhase(
      "smuggle",
      "waiting_for_inspector",
      "inspector_review",
      gateWithStray,
    ),
    /inspector_review records no detail of its own, but carries error/,
  );
  assert.equal(store.getRun("smuggle")?.currentPhase, "persona_review", "a refusal wrote nothing");

  // The decode itself reports the stray rather than discarding it, which is what the
  // validator reads and what a diagnostic surface needs to see.
  const decoded = decodeWorkflowRunLifecycle({
    status: "waiting_for_inspector",
    phase: "inspector_review",
    gateState: gateWithStray,
  });
  assert.deepEqual(decoded.detailKeys, ["error"], "the stray key was dropped from the decode");
  assert.deepEqual(decoded.gate, gate, "and the gate is still read out of the same payload");

  // The honest bare gate is unaffected: it still records no detail and still persists.
  const clean = store.setRunState(
    "smuggle",
    "waiting_for_inspector",
    "inspector_review",
    asJson(gate),
  );
  assert.equal(clean.currentPhase, "inspector_review");
  assert.deepEqual(
    decodeWorkflowRunLifecycle(recordOf(clean)).detailKeys,
    [],
    "a bare gate must still read as no phase detail",
  );
});

test("an unknown inspector_ phase is an unknown phase like any other", () => {
  clearWorkflowTables(db);
  // A rule once refused any `inspector_`-prefixed phase outside the gate registry. Because
  // every REGISTERED inspector phase is in that registry by construction, the rule could only
  // ever fire on an UNRECOGNISED one - making a foreign `inspector_` phase uniquely
  // un-carryable while `a_phase_from_a_newer_daemon` sailed through, in direct contradiction
  // of the contract this model states. The two must be indistinguishable.
  for (const phase of ["a_phase_from_a_newer_daemon", "inspector_from_a_newer_daemon"]) {
    assert.equal(workflowRunPhaseRecognized(phase), false, phase);
    assert.equal(
      workflowRunLifecycleViolation({ status: "waiting_for_session", phase, gateState: null }),
      null,
      `${phase} was refused where its twin was not`,
    );
  }

  // Through the real store, which is where it bit: an unrelated delivery carrying the run's
  // existing phase forward must not throw merely because that phase starts with `inspector_`.
  seedRun("foreign", "waiting_for_session", "persona_feedback", null);
  const carried = store.setRunStateCarryingPhase(
    "foreign",
    "waiting_for_session",
    "inspector_from_a_newer_daemon",
    { deliveryId: "d" },
  );
  assert.equal(carried.currentPhase, "inspector_from_a_newer_daemon");

  // And it is still non-executable, so nothing acts on it - the protection that actually
  // matters, and the one the removed rule was not providing.
  const lifecycle = decodeWorkflowRunLifecycle(recordOf(carried));
  assert.equal(lifecycle.phaseRecognized, false);
  assert.equal(lifecycle.executable, false);

  // The doubled name the interpolation once minted is refused by the TYPE system now, which is
  // earlier and more complete than the string rule was:
  //   store.setRunState(id, "blocked", "inspector_inspector_disabled", ...)
  //     -> TS2345: not assignable to parameter of type WorkflowRunPhase
  assert.equal(workflowRunPhaseRecognized("inspector_inspector_disabled"), false);
});

/*
 * The vocabulary guard: no phase a run can block in may render as its own identifier.
 *
 * This is not a style rule. `blockedPhaseClause` falls back to `phase.replaceAll("_", " ")`
 * for a code nobody mapped, and that fallback is silent and plausible-looking - so the DEFAULT
 * for a phase added to the registry above is to ship unnamed and print
 * "preflight refinement exhausted" at an operator in the Line strip, the Review drawer, the
 * Runs rail and the notification that fires the moment the run blocks. Twelve of the
 * twenty-seven blocked-capable phases were in exactly that state, including the one a real
 * No-Mistakes run stopped on.
 *
 * The assertion is over `blockedPhaseClauseGaps` rather than spelled here, so the rule has one
 * definition and the failure can say what to do about it. Adding a phase to
 * `WORKFLOW_RUN_PHASES` with `blocked` among its statuses is what makes this fail; writing the
 * clause is what makes it pass.
 */
test("every blocked-capable phase has a clause that beats the fallback", () => {
  const gaps = blockedPhaseClauseGaps();
  assert.deepEqual(
    gaps,
    [],
    gaps.map((gap) => `${gap.phase} ${gap.problem}`).join("\n"),
  );

  // Both halves of the rule are live, demonstrated on the registry itself rather than asserted
  // about the helper in the abstract. `delivery_refused` is the one the weaker guard missed:
  // it HAD a key for a release, whose value was character-for-character the fallback.
  assert.equal(blockedPhaseClause("delivery_refused"), "pane refused the write");
  assert.notEqual(blockedPhaseClause("delivery_refused"), "delivery refused");

  // Every blocked-capable phase is covered, and the count is stated so that deleting a phase
  // from the registry cannot quietly shrink what this test walks.
  const blockedCapable = WORKFLOW_RUN_PHASES
    .filter((phase) => WORKFLOW_RUN_PHASE_STATUSES[phase].includes("blocked"));
  assert.equal(blockedCapable.length, 27);

  // One-directional, and deliberately so. The map also serves the triage column's PARKED rows,
  // which are `waiting_for_session`, so it legitimately holds keys that are not blocked-capable.
  // A guard asserting the converse would demand those entries be deleted and put the phase code
  // back on the rows they exist for.
  assert.equal(blockedPhaseClause("reattached_resubmit_required"), "reattached");
  assert.equal(
    WORKFLOW_RUN_PHASE_STATUSES.reattached_resubmit_required.includes("blocked"),
    false,
  );

  // And the contract every other surface leans on: an unmapped code still degrades to readable
  // text rather than to `undefined`. `alerts.ts` and `run-actions.ts` read the same function
  // now, so this is the one spelling of the fallback rather than two that must agree.
  assert.equal(blockedPhaseClause("some_future_reason"), "some future reason");
});

/*
 * The goal-provenance verdict, which is a different question from every lifecycle triple
 * above: not "is this run in a state a reader can act on" but "is the ask it froze the kind of
 * thing a review can be judged against at all".
 *
 * It lives beside the lifecycle rules because it shares their invariant. A run that exists
 * without a verdict would falsify the only claim this instrument makes - that every run
 * created from here on says what kind of ask it froze - so the verdict is written by the same
 * transaction that inserts the run, at BOTH insert sites. The second one is not an edge case:
 * `claimForemanCompletion` is the Foreman completion path, and it produced four of the ten
 * machine-authored goals the investigation behind this measured.
 */

const PROVENANCE_BINDING = {
  workflowVersionId: "provenance-version",
  noteKey: "provenance-note",
  sessionId: "provenance-session",
  sessionAgent: "claude" as const,
  sessionName: "provenance",
  sessionCwd: process.cwd(),
  sessionRepoRoot: process.cwd(),
  triggerMode: "manual" as const,
  deliveryMode: "preview" as const,
  maxRepairRounds: 3,
};

/** The repair packet's opening line - the payload shape the classifier recognises by prefix. */
const MACHINE_ASK =
  "Workflow review failed. This is a repair round; address the review packet below."
  + "\n\nOriginal user goal:\nMake the diff link stop spinning";

const HUMAN_ASK = "Make the diff link stop showing a busy spinner after the diff loads";

const provenanceIntent = (rawGoal: string) => ({
  rawGoal,
  refinedGoal: null,
  sourceNoteKey: PROVENANCE_BINDING.noteKey,
  decisions: [],
  frozenAt: 1,
});

const classifiedEvents = (runId: string) =>
  store.listEvents(runId).filter((event) => event.kind === "run_intent_classified");

/** Every run row's stored verdict column, read raw so an absent one is visible as absent. */
const storedVerdict = (runId: string): string | null => {
  const row = db.prepare(
    `SELECT intent_provenance_json FROM workflow_runs WHERE id = ?`,
  ).get(runId) as { intent_provenance_json: string | null } | undefined;
  return row?.intent_provenance_json ?? null;
};

function provenanceBinding(id: string) {
  return store.insertBinding({ ...PROVENANCE_BINDING, id, now: 1 });
}

test("a run created by the manual path says what kind of ask it froze", () => {
  clearWorkflowTables(db);
  const binding = provenanceBinding("provenance-manual-binding");
  const created = store.createInitialSubmission(
    {
      id: "provenance-manual-run",
      binding,
      triggerSource: "manual",
      triggerKey: "provenance-manual-trigger",
      now: 5,
      intent: provenanceIntent(MACHINE_ASK),
    },
    {
      id: "provenance-manual-submission",
      triggerSource: "manual",
      triggerKey: "provenance-manual-trigger",
      context: {},
      evidence: {},
      now: 5,
    },
  );
  assert.equal(created.run.intentProvenance?.verdict, "automation");
  assert.deepEqual(created.run.intentProvenance?.signals, ["automation"]);
  assert.equal(created.run.intentProvenance?.classifiedAt, 5);
  assert.match(created.run.intentProvenance?.reason ?? "", /Mission Control types itself/);
  assert.ok(storedVerdict("provenance-manual-run"), "the verdict reached the column");

  // Announced once, at the freeze. Not on every submission, and not again on a retry: the
  // event id is derived from the run, so `appendEvent` answers a replay with the row it has.
  assert.equal(classifiedEvents("provenance-manual-run").length, 1);
  const payload = classifiedEvents("provenance-manual-run")[0]!.payload as {
    verdict: string;
    signals: string[];
  };
  assert.deepEqual(
    { verdict: payload.verdict, signals: payload.signals },
    { verdict: "automation", signals: ["automation"] },
  );

  const retried = store.createInitialSubmission(
    {
      id: "provenance-manual-run",
      binding,
      triggerSource: "manual",
      triggerKey: "provenance-manual-trigger",
      now: 6,
      intent: provenanceIntent(MACHINE_ASK),
    },
    {
      id: "provenance-manual-submission",
      triggerSource: "manual",
      triggerKey: "provenance-manual-trigger",
      context: {},
      evidence: {},
      now: 6,
    },
  );
  assert.equal(retried.idempotent, true);
  assert.equal(classifiedEvents("provenance-manual-run").length, 1, "a retry announced twice");
});

test("a run created by the Foreman completion path says it too", () => {
  clearWorkflowTables(db);
  const binding = provenanceBinding("provenance-foreman-binding");
  // `retireGuard: false` is the sibling-repository claim: the completion boundary was already
  // spent by the first repository's claim, so this one rides the same proof. It reaches the
  // same INSERT as an ordinary drain claim without a queue guard to arm first.
  const claimed = store.claimForemanCompletion({
    binding,
    completionKind: "drain",
    marker: "provenance-marker",
    expectedWorkCycle: null,
    summary: "",
    evidenceFingerprint: "provenance-fingerprint",
    expectedIntent: null,
    runId: "provenance-foreman-run",
    submissionId: "provenance-foreman-submission",
    retireGuard: false,
    intent: provenanceIntent(MACHINE_ASK),
    now: 7,
  });
  assert.equal(claimed.created, true);
  assert.equal(claimed.run.intentProvenance?.verdict, "automation");
  assert.ok(storedVerdict("provenance-foreman-run"), "the second insert site classifies too");
  assert.equal(classifiedEvents("provenance-foreman-run").length, 1);
});

test("a healthy ask is classified and says nothing about it", () => {
  clearWorkflowTables(db);
  const binding = provenanceBinding("provenance-healthy-binding");
  const created = store.createInitialSubmission(
    {
      id: "provenance-healthy-run",
      binding,
      triggerSource: "manual",
      triggerKey: "provenance-healthy-trigger",
      now: 8,
      intent: provenanceIntent(HUMAN_ASK),
    },
    {
      id: "provenance-healthy-submission",
      triggerSource: "manual",
      triggerKey: "provenance-healthy-trigger",
      context: {},
      evidence: {},
      now: 8,
    },
  );
  assert.equal(created.run.intentProvenance?.verdict, "objective");
  assert.deepEqual(created.run.intentProvenance?.signals, []);
  // Stored, because "measured and healthy" is a fact worth having. Silent, because an event
  // on every healthy run would bury the ones that mean something.
  assert.ok(storedVerdict("provenance-healthy-run"));
  assert.equal(classifiedEvents("provenance-healthy-run").length, 0);
});

test("the verdict and the run commit together, or neither exists", () => {
  clearWorkflowTables(db);
  const binding = provenanceBinding("provenance-atomic-binding");
  // A submission id already taken. The run row and its event are written first, so a throw
  // here is exactly the crash-in-between this has to survive.
  store.createInitialSubmission(
    {
      id: "provenance-first-run",
      binding,
      triggerSource: "manual",
      triggerKey: "provenance-first-trigger",
      now: 9,
      intent: provenanceIntent(HUMAN_ASK),
    },
    {
      id: "provenance-shared-submission",
      triggerSource: "manual",
      triggerKey: "provenance-first-trigger",
      context: {},
      evidence: {},
      now: 9,
    },
  );
  assert.throws(() => store.createInitialSubmission(
    {
      id: "provenance-rolled-back-run",
      binding,
      triggerSource: "manual",
      triggerKey: "provenance-second-trigger",
      now: 10,
      intent: provenanceIntent(MACHINE_ASK),
    },
    {
      id: "provenance-shared-submission",
      triggerSource: "manual",
      triggerKey: "provenance-second-trigger",
      context: {},
      evidence: {},
      now: 10,
    },
  ));
  assert.equal(store.getRun("provenance-rolled-back-run"), null);
  assert.equal(storedVerdict("provenance-rolled-back-run"), null);
  assert.equal(classifiedEvents("provenance-rolled-back-run").length, 0);

  // And the standing invariant behind all of this: no row in the table has a NULL verdict
  // unless nothing this build wrote created it.
  const unclassified = db.prepare(
    `SELECT COUNT(*) AS count FROM workflow_runs WHERE intent_provenance_json IS NULL`,
  ).get() as { count: number };
  assert.equal(Number(unclassified.count), 0, "a run created here must never lack a verdict");
});

test("a run frozen before the verdict existed is not classified after the fact", () => {
  clearWorkflowTables(db);
  // Exactly what a daemon upgrade leaves behind: the column exists and this row predates it.
  seedRun("provenance-legacy", "waiting_for_session", "pr_handoff", null);
  assert.equal(storedVerdict("provenance-legacy"), null);
  assert.equal(
    store.getRun("provenance-legacy")?.intentProvenance ?? null,
    null,
    "reading a legacy run must not invent a verdict for a freeze nobody measured",
  );
  assert.equal(classifiedEvents("provenance-legacy").length, 0);
});

/**
 * A damaged verdict column costs the operator the badge, and nothing else.
 *
 * `readRunIntentProvenance` is the one tolerant read on this row besides the intent pair, and
 * the reason is stated where it lives: every other JSON column throws through
 * `parseNullableJson`, which `getRun` turns into a NULL run, so one bad byte in a diagnostic
 * column would take the whole run out of every listing. Paying that for a badge would be
 * absurd - the operator would lose the run in order to be told something about it.
 *
 * That tolerance is only worth having if it is contained, which is what this pins: the run is
 * still there, its identity, lifecycle and frozen ask are still readable, and the verdict alone
 * degrades to the same "not classified" a legacy row already means. The legacy test above
 * covers an ABSENT column; this covers a present one this build cannot read, which is the state
 * a partial restore or a newer daemon's payload actually produces.
 */
test("a verdict this build cannot read costs the badge and never the run", () => {
  clearWorkflowTables(db);
  const binding = provenanceBinding("provenance-corrupt-binding");
  store.createInitialSubmission(
    {
      id: "provenance-corrupt-run",
      binding,
      triggerSource: "manual",
      triggerKey: "provenance-corrupt-trigger",
      now: 11,
      intent: provenanceIntent(HUMAN_ASK),
    },
    {
      id: "provenance-corrupt-submission",
      triggerSource: "manual",
      triggerKey: "provenance-corrupt-trigger",
      context: {},
      evidence: {},
      now: 11,
    },
  );
  const healthy = store.getRun("provenance-corrupt-run");
  assert.equal(healthy?.intentProvenance?.verdict, "objective", "the fixture starts classified");

  const damaged = [
    // A truncated write: not JSON at all.
    { label: "invalid JSON", payload: '{"verdict":"objective",' },
    // Parses, and says something this build has no meaning for - a newer daemon's vocabulary.
    { label: "unknown verdict", payload: JSON.stringify({
      verdict: "suspicious", signals: [], reason: "from a newer build", classifiedAt: 11,
    }) },
    // Parses, uses only known words, and CONTRADICTS itself: the verdict is not the
    // highest-precedence signal beside it. The schema refuses this rather than picking a half.
    { label: "verdict disagreeing with its signals", payload: JSON.stringify({
      verdict: "objective", signals: ["automation"], reason: "both and neither", classifiedAt: 11,
    }) },
    // Structurally wrong where the column is meant to be an object.
    { label: "an array", payload: "[]" },
  ];

  for (const { label, payload } of damaged) {
    db.prepare(`UPDATE workflow_runs SET intent_provenance_json = ? WHERE id = ?`)
      .run(payload, "provenance-corrupt-run");
    const run = store.getRun("provenance-corrupt-run");
    assert.ok(run, `${label} must not erase the run`);
    assert.equal(run.intentProvenance ?? null, null, `${label} must read as unclassified`);
    // Contained: everything else on the row still reads, so the run stays operable rather than
    // becoming a second kind of damaged that nobody can act on.
    assert.equal(run.id, "provenance-corrupt-run");
    assert.equal(run.status, "capturing", `${label} must not disturb the lifecycle`);
    assert.equal(run.currentPhase, "capturing");
    assert.equal(run.intentState, "frozen", `${label} must not touch the frozen ask`);
    assert.equal(run.intent?.rawGoal, HUMAN_ASK);
    // And it is still reachable the way a listing reaches it, not just by id - which is the
    // failure mode being ruled out, since a throwing read is what removes a run from those.
    assert.equal(
      store.listRuns().some((row) => row.id === "provenance-corrupt-run"),
      true,
      `${label} must leave the run in the fleet listing`,
    );
    assert.equal(store.activeRunForBinding(binding.id)?.id, "provenance-corrupt-run");
  }

  // The damage is the column's alone: a well-formed verdict written back reads again, so
  // nothing about the tolerance is sticky.
  db.prepare(`UPDATE workflow_runs SET intent_provenance_json = ? WHERE id = ?`).run(
    JSON.stringify({
      verdict: "automation",
      signals: ["automation"],
      reason: "restored by hand",
      classifiedAt: 12,
    }),
    "provenance-corrupt-run",
  );
  assert.equal(store.getRun("provenance-corrupt-run")?.intentProvenance?.verdict, "automation");
});
