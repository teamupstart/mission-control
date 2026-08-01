/**
 * What is at stake: the durable half of session action execution - the tuples that reach
 * operators' rows, the row-boundary invariants that keep a half-written action from reading
 * as something else, the adapter registry that decides what this build may promise, and the
 * one transaction that turns a finished action turn into a child evidence segment.
 *
 * These are the rules a restart depends on. A receipt whose source attempt belongs to a
 * different submission would let a node activated on one evidence snapshot advance a graph
 * running on another; two live packets for one attempt would type the same instruction twice;
 * an action attempt with no snapshot is a row nothing can deliver, recover or explain.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionActionSnapshot, WorkflowJson } from "../src/shared/workflow.ts";
import {
  SESSION_ACTION_BLOCK_CODES,
  SESSION_ACTION_COMPLETION_CAPABILITIES,
  SESSION_ACTION_WAIT_REASONS,
  WORKFLOW_DELIVERY_KINDS,
  WORKFLOW_NODE_ATTEMPT_STATES,
  WORKFLOW_RUN_STATUSES,
} from "../src/shared/workflow.ts";

const home = mkdtempSync(join(tmpdir(), "mission-session-action-durability-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { WorkflowStore, WorkflowRowError, clearWorkflowTables, parseWorkflowSubmissionRow,
  parseWorkflowNodeAttemptRow, parseWorkflowDeliveryRow } =
  await import("../src/server/workflows/store.ts");
const { SESSION_ACTION_ADAPTERS, sessionActionAdapter, sessionActionCapabilities } =
  await import("../src/server/workflows/session-action-adapters.ts");

const db = openDb();
const store = new WorkflowStore(db, [], [], []);
after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => clearWorkflowTables(db));

// ---- append-only tuples ------------------------------------------------------------------

test("every durable tuple this phase touches is APPENDED, never reordered", () => {
  // A tuple's ORDER is not decoration here: these strings are already written into rows on
  // operators' machines. Renaming or reordering one does not migrate a run, it makes it
  // unreadable - and reading an unknown value tolerantly would be worse, because a delivered
  // packet would come back as a different kind of packet.
  assert.deepEqual([...WORKFLOW_NODE_ATTEMPT_STATES], [
    "queued", "running", "retry_wait", "completed", "error", "cancelled", "waiting",
  ]);
  assert.deepEqual([...WORKFLOW_DELIVERY_KINDS], [
    "persona_feedback",
    "inspector_feedback",
    "pr_handoff",
    "unchanged_evidence_nudge",
    "session_action",
  ]);
  assert.deepEqual([...WORKFLOW_RUN_STATUSES], [
    "capturing", "running", "waiting_for_session", "waiting_for_pr", "waiting_for_inspector",
    "waiting_for_new_head", "blocked", "completed", "cancelled", "failed", "waiting_for_action",
  ]);
  // `waiting` is none of the other six, and each exclusion is load-bearing.
  assert.equal(WORKFLOW_NODE_ATTEMPT_STATES.includes("waiting"), true);
  assert.equal(
    ["queued", "running", "completed"].some((state) => state === "waiting"),
    false,
  );
});

// ---- the completion adapter registry ------------------------------------------------------

test("the registry answers for every completion kind, and pull_request is UNAVAILABLE", () => {
  const capabilities = sessionActionCapabilities();
  assert.deepEqual(capabilities.map((item) => item.kind), ["session_turn", "pull_request"]);

  const turn = sessionActionAdapter("session_turn");
  assert.equal(turn.available, true);
  assert.equal(turn.validateSnapshot({} as SessionActionSnapshot), null);

  const pr = sessionActionAdapter("pull_request");
  assert.equal(pr.available, false);
  assert.ok(pr.unavailableReason, "an unavailable adapter must say why, in a sentence");
  // A registered REFUSAL, not an absent entry and not a placeholder that returns success.
  // Succeeding here would complete a `pull_request` action on the generic turn boundary
  // alone, claiming PR provenance nobody checked.
  const decision = pr.decide({
    snapshot: {} as SessionActionSnapshot,
    session: {} as never,
    anchorTranscriptBytes: null,
    deliveredAt: 1,
    pickedUpAt: 2,
    settledAt: 3,
    now: 4,
  });
  assert.equal(decision.kind, "blocked");
  if (decision.kind !== "blocked") return;
  assert.equal(decision.code, "adapter_unavailable");
  assert.ok(SESSION_ACTION_BLOCK_CODES.includes(decision.code));
});

test("the shared capability table and the server registry are one answer, not two", () => {
  // The browser reads the shared table and the daemon executes the registry. If they could
  // disagree, a surface would offer a proof the runtime refuses - a workflow an operator can
  // author and never run.
  for (const capability of sessionActionCapabilities()) {
    assert.deepEqual(capability, {
      kind: SESSION_ACTION_COMPLETION_CAPABILITIES[capability.kind].kind,
      available: SESSION_ACTION_COMPLETION_CAPABILITIES[capability.kind].available,
      label: SESSION_ACTION_COMPLETION_CAPABILITIES[capability.kind].label,
      unavailableReason: SESSION_ACTION_COMPLETION_CAPABILITIES[capability.kind].unavailableReason,
    });
    assert.equal(SESSION_ACTION_ADAPTERS[capability.kind].kind, capability.kind);
  }
});

test("a session_turn action completes on the turn boundary and constrains nothing more", () => {
  const decision = sessionActionAdapter("session_turn").decide({
    snapshot: {} as SessionActionSnapshot,
    session: {} as never,
    anchorTranscriptBytes: 10,
    deliveredAt: 1,
    pickedUpAt: 2,
    settledAt: 3,
    now: 4,
  });
  assert.deepEqual(decision, { kind: "complete", continuationExpectation: { kind: "none" } });
  // An action may legitimately change only remote or conversation state, so an unchanged
  // checkout is a real outcome rather than a failed expectation.
  assert.equal(
    sessionActionAdapter("session_turn").validateCapture({ kind: "none" }, {} as never),
    null,
  );
});

// ---- row boundaries ------------------------------------------------------------------------

const submissionRow = (patch: Record<string, unknown> = {}) => ({
  id: "s1",
  run_id: "r1",
  round: 1,
  segment: 0,
  parent_submission_id: null,
  continuation_node_id: null,
  continuation_node_attempt_id: null,
  mode: "full_workflow",
  trigger_source: "manual",
  trigger_key: "manual:1",
  evidence_fingerprint: "f1",
  context_json: "{}",
  evidence_json: "{}",
  pr_head_sha: null,
  status: "running",
  created_at: 1,
  updated_at: 1,
  completed_at: null,
  ...patch,
});

test("continuation provenance is all-or-nothing with a nonzero segment", () => {
  // A child with no parent reads as an ordinary repair round; a segment-zero row carrying a
  // parent claims a continuation that never happened. Both are refused at the row, which is
  // the last place the difference is still cheap to see.
  assert.throws(
    () => parseWorkflowSubmissionRow(submissionRow({ segment: 1 })),
    WorkflowRowError,
  );
  assert.throws(
    () => parseWorkflowSubmissionRow(submissionRow({ parent_submission_id: "s0" })),
    WorkflowRowError,
  );
  const child = parseWorkflowSubmissionRow(submissionRow({
    segment: 1,
    parent_submission_id: "s0",
    continuation_node_id: "act",
    continuation_node_attempt_id: "a0",
  }));
  assert.equal(child.segment, 1);
  assert.equal(child.parentSubmissionId, "s0");
});

const attemptRow = (patch: Record<string, unknown> = {}) => ({
  id: "a1",
  submission_id: "s1",
  node_id: "act",
  attempt: 1,
  state: "waiting",
  persona_snapshot_json: null,
  session_action_snapshot_json: JSON.stringify({
    sourceSessionActionId: "sa1",
    sourceRevision: 1,
    name: "Tidy",
    description: "",
    promptMarkdown: "# Tidy\n",
    requiredSkillId: null,
    completion: { kind: "session_turn" },
  }),
  runner_id: null,
  model_id: null,
  verdict_json: null,
  output_json: null,
  retry_at: null,
  input_fingerprint: "f1:act",
  error: null,
  created_at: 1,
  updated_at: 1,
  started_at: null,
  finished_at: null,
  ...patch,
});

test("an attempt executes one KIND of thing, and a waiting one must carry its action", () => {
  const waiting = parseWorkflowNodeAttemptRow(attemptRow());
  assert.equal(waiting.state, "waiting");
  assert.equal(waiting.sessionAction?.promptMarkdown, "# Tidy\n");
  assert.equal(waiting.persona, null);

  // Both snapshots would make every reader that asks "reviewer or action?" answer twice.
  assert.throws(
    () => parseWorkflowNodeAttemptRow(attemptRow({
      persona_snapshot_json: JSON.stringify({
        sourcePersonaId: "p1",
        sourceRevision: 1,
        name: "Judge",
        description: "",
        guidanceMarkdown: "# Judge",
        runner: null,
        model: null,
      }),
    })),
    WorkflowRowError,
  );
  // A waiting attempt with nothing to deliver is a run parked on a row nothing can explain.
  assert.throws(
    () => parseWorkflowNodeAttemptRow(attemptRow({ session_action_snapshot_json: null })),
    WorkflowRowError,
  );
  // A malformed completion kind fails the ROW rather than degrading to `session_turn`, which
  // would complete a historical action under a weaker proof contract than it was published
  // with.
  assert.throws(
    () => parseWorkflowNodeAttemptRow(attemptRow({
      session_action_snapshot_json: JSON.stringify({
        sourceSessionActionId: "sa1",
        sourceRevision: 1,
        name: "Tidy",
        description: "",
        promptMarkdown: "# Tidy\n",
        requiredSkillId: null,
        completion: { kind: "webhook" },
      }),
    })),
    WorkflowRowError,
  );
});

const deliveryRow = (patch: Record<string, unknown> = {}) => ({
  id: "d1",
  run_id: "r1",
  submission_id: "s1",
  kind: "session_action",
  node_attempt_id: "a1",
  session_id: "sess",
  note_key: "note",
  payload: "packet",
  payload_sha256: "sha",
  state: "prepared",
  error: null,
  created_at: 1,
  updated_at: 1,
  delivered_at: null,
  payload_pruned_at: null,
  ...patch,
});

test("only a session_action delivery names an attempt, and it must name one", () => {
  assert.equal(parseWorkflowDeliveryRow(deliveryRow()).nodeAttemptId, "a1");
  // Orphaned from its attempt, two action nodes in one submission become one packet.
  assert.throws(
    () => parseWorkflowDeliveryRow(deliveryRow({ node_attempt_id: null })),
    WorkflowRowError,
  );
  // A legacy kind that acquired an attempt would make recovery treat a pr_handoff as a graph
  // node's action.
  assert.throws(
    () => parseWorkflowDeliveryRow(deliveryRow({ kind: "pr_handoff" })),
    WorkflowRowError,
  );
  // Every historical row: null attempt, still readable, still recoverable.
  assert.equal(
    parseWorkflowDeliveryRow(deliveryRow({ kind: "pr_handoff", node_attempt_id: null })).nodeAttemptId,
    null,
  );
});

// ---- the continuation transaction ----------------------------------------------------------

/** A run with one submission, one waiting action attempt, and its delivered packet. */
function seedWaitingAction(now = 100): {
  runId: string;
  submissionId: string;
  attemptId: string;
} {
  const runId = "r1";
  const submissionId = "s1";
  // A binding, because every run in production has one and `runSummary` joins through it.
  db.prepare(
    `INSERT INTO workflow_bindings (id, workflow_version_id, note_key, session_id, session_agent,
       session_name, session_cwd, session_repo_root, trigger_mode, delivery_mode, state,
       max_repair_rounds, created_at, updated_at)
     VALUES ('b1', 'v1', 'note', 'sess', 'claude', 'sess', '/repo', '/repo', 'manual', 'live',
             'active', 5, ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO workflow_runs (id, binding_id, workflow_version_id, status, current_phase,
       max_repair_rounds, trigger_source, trigger_key, started_at, updated_at)
     VALUES (?, 'b1', 'v1', 'running', 'persona_review', 5, 'manual', 'manual:r1', ?, ?)`,
  ).run(runId, now, now);
  db.prepare(
    `INSERT INTO workflow_submissions (id, run_id, round, segment, mode, trigger_source,
       trigger_key, evidence_fingerprint, context_json, evidence_json, status, created_at,
       updated_at)
     VALUES (?, ?, 1, 0, 'full_workflow', 'manual', 'manual:r1:1', 'f1', '{}', '{}', 'running', ?, ?)`,
  ).run(submissionId, runId, now, now);
  const attempt = store.insertAttempt({
    id: "a1",
    submissionId,
    nodeId: "act",
    attempt: 1,
    state: "waiting",
    persona: null,
    sessionAction: {
      sourceSessionActionId: "sa1",
      sourceRevision: 1,
      name: "Tidy",
      description: "",
      promptMarkdown: "# Tidy\n",
      requiredSkillId: null,
      completion: { kind: "session_turn" },
    },
    sessionActionState: {
      wait: "preparing",
      deliveryId: null,
      anchor: null,
      pickedUpAt: null,
      settledAt: null,
      expectation: null,
      continuationSubmissionId: null,
      blocked: null,
    },
    inputFingerprint: "f1:act",
    now,
  });
  return { runId, submissionId, attemptId: attempt.id };
}

test("a reservation happens exactly once, however many times it is retried", () => {
  const { runId, submissionId, attemptId } = seedWaitingAction();
  const first = store.reserveSessionActionContinuation({
    attemptId,
    submissionId: "child-1",
    triggerKey: "session_action:a1:f1",
    now: 200,
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.idempotent, false);
  assert.equal(first.submission.round, 1);
  assert.equal(first.submission.segment, 1);
  assert.equal(first.submission.parentSubmissionId, submissionId);
  assert.equal(first.submission.continuationNodeAttemptId, attemptId);
  // The run moves into its own capture phase; the attempt records where its child went.
  assert.equal(store.getRun(runId)?.status, "capturing");
  assert.equal(store.getRun(runId)?.currentPhase, "session_action_capture");
  assert.equal(
    store.sessionActionState(store.getAttempt(attemptId)!)?.continuationSubmissionId,
    "child-1",
  );

  // A retry after a crash - a NEW submission id, the same attempt - resumes the reservation
  // rather than opening a rival branch of the run.
  const retry = store.reserveSessionActionContinuation({
    attemptId,
    submissionId: "child-2",
    triggerKey: "session_action:a1:f1",
    now: 300,
  });
  assert.equal(retry.ok, true);
  if (!retry.ok) return;
  assert.equal(retry.idempotent, true);
  assert.equal(retry.submission.id, "child-1");
  assert.equal(store.listSubmissions(runId).length, 2);
});

test("a superseded parent, a terminal run, and a settled attempt all refuse to continue", () => {
  const { runId, attemptId } = seedWaitingAction();
  // A newer segment means something else already moved this run on.
  db.prepare(
    `INSERT INTO workflow_submissions (id, run_id, round, segment, parent_submission_id,
       continuation_node_id, continuation_node_attempt_id, mode, trigger_source, trigger_key,
       evidence_fingerprint, context_json, evidence_json, status, created_at, updated_at)
     VALUES ('other', ?, 1, 1, 's1', 'act', ?, 'full_workflow', 'manual', 'other', 'f9', '{}',
             '{}', 'running', 150, 150)`,
  ).run(runId, attemptId);
  const superseded = store.reserveSessionActionContinuation({
    attemptId,
    submissionId: "child-x",
    triggerKey: "session_action:a1:new",
    now: 200,
  });
  assert.equal(superseded.ok, false);
  if (superseded.ok) return;
  assert.equal(superseded.reason, "parent_superseded");

  clearWorkflowTables(db);
  const second = seedWaitingAction();
  store.cancelRun(second.runId, "cancelled", 400);
  // Cancel closes the waiting attempt, so there is nothing left to continue.
  assert.equal(store.getAttempt(second.attemptId)?.state, "cancelled");
  const terminal = store.reserveSessionActionContinuation({
    attemptId: second.attemptId,
    submissionId: "child-y",
    triggerKey: "session_action:a1:terminal",
    now: 500,
  });
  assert.equal(terminal.ok, false);
  if (terminal.ok) return;
  assert.equal(terminal.reason, "attempt_not_waiting");
});

test("the completion transaction closes the attempt and seeds only the action's route", () => {
  const { runId, submissionId, attemptId } = seedWaitingAction();
  const reserved = store.reserveSessionActionContinuation({
    attemptId,
    submissionId: "child-1",
    triggerKey: "session_action:a1:f1",
    now: 200,
  });
  assert.equal(reserved.ok, true);
  const completed = store.completeSessionActionContinuation({
    attemptId,
    submissionId: "child-1",
    receipts: [{ edgeId: "e-act", payload: { outcome: "complete" } as WorkflowJson }],
    now: 300,
  });
  assert.ok(completed, "the completion transaction refused a legitimate continuation");
  assert.equal(completed.attempt.state, "completed");
  // The attempt stays in the PARENT submission: it ran against that evidence.
  assert.equal(completed.attempt.submissionId, submissionId);
  const receipts = store.listReceipts("child-1");
  assert.deepEqual(receipts.map((receipt) => receipt.edgeId), ["e-act"]);
  // The deliberate cross-submission link.
  assert.equal(receipts[0]!.sourceAttemptId, attemptId);

  // Replaying is a no-op rather than a second completion.
  assert.equal(
    store.completeSessionActionContinuation({
      attemptId,
      submissionId: "child-1",
      receipts: [{ edgeId: "e-act", payload: { outcome: "complete" } as WorkflowJson }],
      now: 400,
    }),
    null,
  );
  assert.equal(store.listReceipts("child-1").length, 1);
});

test("a receipt may cross submissions ONLY through the child's declared continuation attempt", () => {
  const { submissionId, attemptId } = seedWaitingAction();
  const reserved = store.reserveSessionActionContinuation({
    attemptId,
    submissionId: "child-1",
    triggerKey: "session_action:a1:f1",
    now: 200,
  });
  assert.equal(reserved.ok, true);
  // A DIFFERENT attempt of the parent submission has no business authorizing child work: it
  // was activated on evidence the child no longer holds.
  const stranger = store.insertAttempt({
    id: "a2",
    submissionId,
    nodeId: "judge",
    attempt: 1,
    state: "completed",
    persona: null,
    inputFingerprint: "f1:judge",
    now: 100,
  });
  assert.throws(
    () => store.addReceipt("child-1", "e-judge", stranger.id, { outcome: "pass" }, 300),
    /outside submission/,
  );
  // The declared continuation attempt is the one exception, and it is allowed.
  assert.equal(
    store.addReceipt("child-1", "e-act", attemptId, { outcome: "complete" }, 300),
    true,
  );
});

test("one action attempt owns at most one LIVE packet, and the database says so", () => {
  const { runId, submissionId, attemptId } = seedWaitingAction();
  const first = store.prepareDelivery({
    id: "d1",
    runId,
    submissionId,
    kind: "session_action",
    nodeAttemptId: attemptId,
    sessionId: "sess",
    noteKey: "note",
    payload: "packet",
    payloadSha256: "sha-1",
  }, 200);
  assert.equal(first.idempotent, false);

  // A DIFFERENT payload for the same attempt still resolves to the packet it already owns.
  // The generic `(submission, kind, payload sha)` identity would have let this through, and
  // two action nodes in one submission can legitimately render the same bytes.
  const again = store.prepareDelivery({
    id: "d2",
    runId,
    submissionId,
    kind: "session_action",
    nodeAttemptId: attemptId,
    sessionId: "sess",
    noteKey: "note",
    payload: "different packet",
    payloadSha256: "sha-2",
  }, 300);
  assert.equal(again.idempotent, true);
  assert.equal(again.delivery.id, "d1");
  assert.equal(store.listDeliveriesForAttempt(attemptId).length, 1);

  // And an attempt outside this submission is refused rather than linked.
  assert.throws(() => store.prepareDelivery({
    id: "d3",
    runId,
    submissionId,
    kind: "session_action",
    nodeAttemptId: "not-in-this-submission",
    sessionId: "sess",
    noteKey: "note",
    payload: "packet",
    payloadSha256: "sha-3",
  }, 400), /own submission/);
});

test("blocking an action is a run state, never a verdict or a spent repair round", () => {
  const { runId, attemptId } = seedWaitingAction();
  const blocked = store.blockSessionActionAttempt({
    attemptId,
    code: "required_skill_unavailable",
    detail: "Enable Skills first.",
    now: 200,
  });
  assert.ok(blocked);
  assert.equal(blocked.state, "error");
  // No verdict, so nothing downstream can read it as a review outcome.
  assert.equal(blocked.verdict, null);
  assert.equal(store.getRun(runId)?.status, "blocked");
  assert.equal(store.getRun(runId)?.currentPhase, "session_action_blocked");
  // The round is untouched: an action's failure never spends repair budget.
  assert.equal(store.runSummary(runId)?.round, 1);
  assert.deepEqual(store.listReceipts("s1"), []);
});

test("every wait reason is a WAIT, and every block code is closed", () => {
  // The two vocabularies are separate because they reach different readers: a wait is
  // something the runtime is still doing, a block is something a human has to resolve.
  assert.equal(SESSION_ACTION_WAIT_REASONS.length, 7);
  assert.equal(new Set(SESSION_ACTION_WAIT_REASONS).size, SESSION_ACTION_WAIT_REASONS.length);
  assert.equal(new Set(SESSION_ACTION_BLOCK_CODES).size, SESSION_ACTION_BLOCK_CODES.length);
  for (const reason of SESSION_ACTION_WAIT_REASONS) {
    assert.equal(
      (SESSION_ACTION_BLOCK_CODES as readonly string[]).includes(reason),
      false,
      `${reason} is both a wait and a block`,
    );
  }
});
