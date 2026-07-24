import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ENSEMBLE_LIMITS,
  ENSEMBLE_PLAN_VERSION,
  ensembleIsRunnable,
  type CompiledEnsemblePlan,
} from "../src/shared/ensemble.ts";

/**
 * What is at stake: this store is the durable memory of work that spends real money on an
 * operator's machine. Four failures it has to make impossible, all of them silent:
 *
 *  1. A create retry that launches a second group of N agents.
 *  2. A stale worker writing a status backwards over a decision an operator already made.
 *  3. A replayed capture or command producing a second artifact, a second stage attempt or
 *     a doubled audit trail after a restart.
 *  4. A row written by a NEWER build vanishing from the list instead of loading as one this
 *     build refuses to run - a run nobody can see is a run nobody can cancel.
 */

const home = mkdtempSync(join(tmpdir(), "mission-ensemble-store-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { EnsembleStore, EnsembleRowError, clearEnsembleTables } = await import(
  "../src/server/ensembles/store.ts"
);

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => clearEnsembleTables(db));

function plan(over: Partial<CompiledEnsemblePlan> = {}): CompiledEnsemblePlan {
  return {
    planVersion: ENSEMBLE_PLAN_VERSION,
    strategyKey: "best_of_n@1",
    budget: { maxMembers: 3, maxConcurrentMembers: 2, maxWaves: 1, maxStageAttempts: 2, deadlineMs: null },
    information: { kind: "isolated" },
    roles: [1, 2].map((ordinal) => ({
      key: `candidate-${ordinal}`,
      label: `Candidate ${ordinal}`,
      ordinal,
      wave: 1,
      agent: null,
      model: null,
      effort: null,
      approach: null,
      promptTemplate: "work alone",
      requiredArtifacts: ["commit" as const],
      input: { kind: "run_base" as const },
    })),
    stages: [
      {
        id: "stage-1",
        ordinal: 1,
        label: "Candidates",
        driverKind: "member",
        driverKey: "member_wave@1",
        dependsOn: [],
        barrier: { kind: "none" },
        maxAttempts: 1,
        wave: 1,
        roleKeys: ["candidate-1", "candidate-2"],
      },
    ],
    ...over,
  };
}

function insert(store: InstanceType<typeof EnsembleStore>, sourceKey = "manual:1", now = 100) {
  return store.createRun(
    {
      sourceKind: "manual",
      sourceKey,
      sourceId: null,
      strategyId: "best_of_n",
      strategyVersion: 1,
      strategyKey: "best_of_n@1",
      strategyLabel: "Best of N",
      title: "Try two approaches",
      intent: "Implement the feature",
      repoRoot: "/repo",
      baseBranch: null,
      baseSha: null,
      plan: plan(),
      strategyConfig: { members: [{}, {}] },
      status: "planning",
      members: [
        { roleKey: "candidate-1", roleLabel: "Candidate 1", ordinal: 1, wave: 1 },
        { roleKey: "candidate-2", roleLabel: "Candidate 2", ordinal: 2, wave: 1 },
      ],
    },
    now,
  );
}

// ---- creation ----

test("a run and its whole roster are created together", () => {
  const store = new EnsembleStore(db);
  const write = insert(store);
  assert.equal(write.created, true);
  assert.equal(write.members.length, 2);
  assert.deepEqual(
    write.members.map((member) => [member.roleKey, member.ordinal, member.status, member.taskId]),
    [
      ["candidate-1", 1, "pending", null],
      ["candidate-2", 2, "pending", null],
    ],
  );
  assert.equal(write.run.status, "planning");
  // No base until the launch runtime pins one, and the record says so rather than holding a
  // plausible HEAD nothing verified.
  assert.equal(write.run.baseSha, null);
});

test("a partial roster is impossible: a failing member insert takes the run with it", () => {
  const store = new EnsembleStore(db);
  assert.throws(() =>
    store.createRun(
      {
        sourceKind: "manual",
        sourceKey: "manual:bad",
        sourceId: null,
        strategyId: "best_of_n",
        strategyVersion: 1,
        strategyKey: "best_of_n@1",
        strategyLabel: "Best of N",
        title: "T",
        intent: "I",
        repoRoot: "/repo",
        baseBranch: null,
        baseSha: null,
        plan: plan(),
        strategyConfig: {},
        status: "planning",
        // Two members claiming ordinal 1. The UNIQUE index refuses the second, and the
        // transaction must take the first and the run with it.
        members: [
          { roleKey: "candidate-1", roleLabel: "C1", ordinal: 1, wave: 1 },
          { roleKey: "candidate-2", roleLabel: "C2", ordinal: 1, wave: 1 },
        ],
      },
      100,
    ),
  );
  assert.equal(store.runBySource("manual", "manual:bad"), null);
  assert.equal(store.listRuns().length, 0);
});

test("the same source key returns the run it already made, and never a second one", () => {
  const store = new EnsembleStore(db);
  const first = insert(store, "manual:same");
  const retry = insert(store, "manual:same", 500);
  assert.equal(retry.created, false);
  assert.equal(retry.run.id, first.run.id);
  assert.equal(retry.members.length, 2);
  assert.equal(store.listRuns().length, 1);
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS count FROM ensemble_members`).get() as { count: number }).count,
    2,
  );
});

test("two different source keys are two different runs", () => {
  const store = new EnsembleStore(db);
  insert(store, "manual:a");
  insert(store, "manual:b");
  assert.equal(store.listRuns().length, 2);
});

test("identity keys are rejected rather than truncated or aliased", () => {
  const store = new EnsembleStore(db);
  const tooLongSource = "s".repeat(ENSEMBLE_LIMITS.sourceKey + 1);
  assert.throws(() => insert(store, tooLongSource), /source key exceeds/);
  assert.equal(store.listRuns().length, 0);

  const sourceKey = "s".repeat(ENSEMBLE_LIMITS.sourceKey);
  const { run } = insert(store, sourceKey);
  assert.equal(run.sourceKey, sourceKey);
  assert.throws(
    () =>
      store.startStageAttempt({
        runId: run.id,
        stageId: "stage-1",
        driverKind: "member",
        driverKey: "member_wave@1",
        attempt: 1,
        commandKey: "c".repeat(ENSEMBLE_LIMITS.commandKey + 1),
        status: "running",
        input: {},
      }),
    /command key exceeds/,
  );
  assert.throws(
    () =>
      store.appendEvent({
        runId: run.id,
        kind: "created",
        payload: {},
        operationKey: "o".repeat(ENSEMBLE_LIMITS.operationKey + 1),
      }),
    /operation key exceeds/,
  );
  assert.equal(store.listStageAttempts(run.id).length, 0);
  assert.equal(store.listEvents(run.id).length, 0);
});

// ---- compare and set ----

test("a status only moves from a state the caller said it expected", () => {
  const store = new EnsembleStore(db);
  const { run } = insert(store);

  const ok = store.setRunStatus(run.id, ["planning"], "running", { activeStageId: "stage-1" }, 200);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.value.activeStageId, "stage-1");

  // The stale worker: it still believes the run is planning, and its write must not land.
  const stale = store.setRunStatus(run.id, ["planning"], "waiting", {}, 300);
  assert.equal(stale.ok, false);
  if (!stale.ok) {
    assert.equal(stale.reason, "precondition_failed");
    assert.equal(stale.current?.status, "running");
  }
  assert.equal(store.getRun(run.id)?.status, "running");
});

test("a cancelled run cannot be resurrected by a completion that was already in flight", () => {
  const store = new EnsembleStore(db);
  const { run } = insert(store);
  store.setRunStatus(run.id, ["planning"], "cancelled", { completedAt: 400 }, 400);
  const late = store.setRunStatus(run.id, ["running", "waiting", "evaluating"], "completed", {}, 500);
  assert.equal(late.ok, false);
  assert.equal(store.getRun(run.id)?.status, "cancelled");
});

test("a transition against a run that is gone says so rather than silently doing nothing", () => {
  const store = new EnsembleStore(db);
  const missing = store.setRunStatus("no-such-run", ["planning"], "running");
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.reason, "not_found");
});

test("a member transition takes the same precondition, and normalizes its task binding", () => {
  const store = new EnsembleStore(db);
  const { members } = insert(store);
  const member = members[0]!;
  const launched = store.setMemberStatus(member.id, ["pending"], "launching", { taskId: "task-1" }, 200);
  assert.equal(launched.ok, true);
  if (launched.ok) assert.equal(launched.value.taskId, "task-1");
  assert.equal(store.setMemberStatus(member.id, ["pending"], "active").ok, false);

  const cleared = store.setMemberStatus(member.id, ["launching"], "failed", { taskId: null });
  assert.equal(cleared.ok, true);
  if (cleared.ok) assert.equal(cleared.value.taskId, null);
  // Two unlaunched members must be able to coexist: the partial unique index is written
  // against the empty string, so a null here would defeat it.
  assert.equal(store.setMemberStatus(members[1]!.id, ["pending"], "failed", { taskId: null }).ok, true);
});

test("a member can select only one of its own attempts", () => {
  const store = new EnsembleStore(db);
  const { run, members } = insert(store);
  const first = store.insertAttempt({
    runId: run.id,
    memberId: members[0]!.id,
    attempt: 1,
    taskId: null,
    sessionId: null,
    agent: null,
    requestedModel: null,
    requestedEffort: null,
    baseSha: null,
    worktreePath: null,
    branch: null,
    status: "submitted",
  });
  const other = store.insertAttempt({
    runId: run.id,
    memberId: members[1]!.id,
    attempt: 1,
    taskId: null,
    sessionId: null,
    agent: null,
    requestedModel: null,
    requestedEffort: null,
    baseSha: null,
    worktreePath: null,
    branch: null,
    status: "submitted",
  });

  assert.throws(
    () =>
      store.setMemberStatus(
        members[0]!.id,
        ["pending"],
        "advanced",
        { selectedAttemptId: other.id },
        200,
      ),
    /does not belong to ensemble member/,
  );
  assert.equal(store.getMember(members[0]!.id)?.status, "pending");
  assert.equal(store.getMember(members[0]!.id)?.selectedAttemptId, null);

  const selected = store.setMemberStatus(
    members[0]!.id,
    ["pending"],
    "advanced",
    { selectedAttemptId: first.id },
    300,
  );
  assert.equal(selected.ok, true);
  if (selected.ok) assert.equal(selected.value.selectedAttemptId, first.id);
});

test("the pinned base is write-once and an identical retry is idempotent", () => {
  const store = new EnsembleStore(db);
  const { run } = insert(store);
  const first = store.setBase(run.id, "a".repeat(40), "main", 200);
  assert.equal(first.ok, true);
  const retry = store.setBase(run.id, "a".repeat(40), "moved", 300);
  assert.equal(retry.ok, true);
  if (retry.ok) assert.equal(retry.value.baseBranch, "main");
  const repin = store.setBase(run.id, "b".repeat(40), "main", 400);
  assert.equal(repin.ok, false);
  assert.equal(store.getRun(run.id)?.baseSha, "a".repeat(40));
});

// ---- idempotent appends ----

test("attempt numbers start at one and a repeat of the same number is one row", () => {
  const store = new EnsembleStore(db);
  const { run, members } = insert(store);
  const member = members[0]!;
  assert.equal(store.nextAttemptNumber(member.id), 1);

  const first = store.insertAttempt({
    runId: run.id,
    memberId: member.id,
    attempt: 1,
    taskId: "task-1",
    sessionId: null,
    agent: "claude",
    requestedModel: "claude-opus-4-8",
    requestedEffort: "high",
    baseSha: null,
    worktreePath: null,
    branch: null,
    status: "launching",
  });
  const replay = store.insertAttempt({
    runId: run.id,
    memberId: member.id,
    attempt: 1,
    taskId: "task-1",
    sessionId: null,
    agent: "claude",
    requestedModel: "claude-opus-4-8",
    requestedEffort: "high",
    baseSha: null,
    worktreePath: null,
    branch: null,
    status: "launching",
  });
  assert.equal(replay.id, first.id);
  assert.equal(store.nextAttemptNumber(member.id), 2);
  assert.equal(store.listAttempts(run.id).length, 1);
  assert.equal(first.agent, "claude");
  assert.equal(first.requestedEffort, "high");

  const submitted = store.setAttemptStatus(first.id, ["launching"], "submitted", {
    finishedAt: 300,
  });
  assert.equal(submitted.ok, true);
  assert.equal(store.setAttemptStatus(first.id, ["launching"], "running").ok, false);
  assert.equal(
    store.setAttemptStatus(first.id, ["submitted"], "running").ok,
    false,
    "even a bad caller cannot move a terminal attempt backward",
  );
});

test("an artifact is keyed by the operation that captured it, not by its contents", () => {
  const store = new EnsembleStore(db);
  const { run, members } = insert(store);
  const attempt = store.insertAttempt({
    runId: run.id,
    memberId: members[0]!.id,
    attempt: 1,
    taskId: "task-1",
    sessionId: null,
    agent: null,
    requestedModel: null,
    requestedEffort: null,
    baseSha: null,
    worktreePath: null,
    branch: null,
    status: "running",
  });
  const capture = {
    runId: run.id,
    attemptId: attempt.id,
    kind: "commit",
    formatVersion: 1,
    attempt: 1,
    status: "ready" as const,
    locator: { commit: "a".repeat(40), ref: "refs/mission-control/ensembles/x/y" },
    digest: "sha256:abc",
    metadata: { filesChanged: 3 },
    operationKey: `submit:${attempt.id}:1`,
    readyAt: 300,
  };
  const first = store.recordArtifact(capture);
  const replay = store.recordArtifact({ ...capture, digest: "sha256:different" });
  assert.equal(replay.id, first.id);
  assert.equal(replay.digest, "sha256:abc", "a replay must not rewrite an immutable artifact");
  assert.equal(store.listArtifacts(run.id).length, 1);
  assert.deepEqual(first.locator, capture.locator);

  // A genuinely new capture is a new attempt, and gets its own row.
  const second = store.recordArtifact({ ...capture, attempt: 2, operationKey: `submit:${attempt.id}:2` });
  assert.notEqual(second.id, first.id);
  assert.equal(store.listArtifacts(run.id).length, 2);
});

test("a command key is spent once, however many times the daemon replays it", () => {
  const store = new EnsembleStore(db);
  const { run } = insert(store);
  const command = {
    runId: run.id,
    stageId: "stage-1",
    driverKind: "member",
    driverKey: "member_wave@1",
    attempt: 1,
    commandKey: `${run.id}:stage-1:1`,
    status: "running" as const,
    input: { roleKeys: ["candidate-1", "candidate-2"] },
  };
  const first = store.startStageAttempt(command);
  const replay = store.startStageAttempt(command);
  assert.equal(replay.id, first.id);
  assert.equal(store.listStageAttempts(run.id).length, 1);
  assert.equal(store.stageAttemptByCommand(command.commandKey)?.id, first.id);

  const finished = store.finishStageAttempt(first.id, ["running"], "succeeded", {
    output: { launched: 2 },
  });
  assert.equal(finished.ok, true);
  if (!finished.ok) return;
  assert.equal(finished.value.status, "succeeded");
  assert.ok(finished.value.finishedAt);
  assert.deepEqual(finished.value.output, { launched: 2 });
  assert.equal(store.finishStageAttempt(first.id, ["running"], "waiting").ok, false);
  assert.equal(store.finishStageAttempt(first.id, ["succeeded"], "running").ok, false);
});

test("an evaluation is one row per stage attempt and attempt number, and reports what ran", () => {
  const store = new EnsembleStore(db);
  const { run } = insert(store);
  const stage = store.startStageAttempt({
    runId: run.id,
    stageId: "stage-2",
    driverKind: "review",
    driverKey: "comparative_review@1",
    attempt: 1,
    commandKey: `${run.id}:stage-2:1`,
    status: "running",
    input: {},
  });
  const input = {
    runId: run.id,
    stageAttemptId: stage.id,
    attempt: 1,
    method: "comparative_llm",
    runnerId: null,
    modelId: null,
    inputFingerprint: "sha256:packet",
    subjectArtifactIds: ["art-1", "art-2"],
    status: "running" as const,
  };
  const first = store.recordEvaluation(input);
  assert.equal(store.recordEvaluation(input).id, first.id);
  assert.equal(first.runnerId, null);
  const persisted = db
    .prepare(`SELECT runner_id, model_id FROM ensemble_evaluations WHERE id = ?`)
    .get(first.id) as { runner_id: string | null; model_id: string | null };
  assert.equal(persisted.runner_id, null);
  assert.equal(persisted.model_id, null);

  const done = store.finishEvaluation(first.id, ["running"], "succeeded", {
    runnerId: "claude",
    modelId: "claude-opus-4-8",
    result: { recommendedArtifactId: "art-1" },
  });
  assert.equal(done.ok, true);
  if (!done.ok) return;
  assert.equal(done.value.runnerId, "claude");
  assert.deepEqual(done.value.subjectArtifactIds, ["art-1", "art-2"]);
  assert.equal(store.finishEvaluation(first.id, ["running"], "failed").ok, false);
  assert.equal(store.finishEvaluation(first.id, ["succeeded"], "running").ok, false);
});

test("idempotency keys cannot resolve to records owned by another run", () => {
  const store = new EnsembleStore(db);
  const firstRun = insert(store, "manual:first");
  const secondRun = insert(store, "manual:second");
  const attempt = store.insertAttempt({
    runId: firstRun.run.id,
    memberId: firstRun.members[0]!.id,
    attempt: 1,
    taskId: null,
    sessionId: null,
    agent: null,
    requestedModel: null,
    requestedEffort: null,
    baseSha: null,
    worktreePath: null,
    branch: null,
    status: "running",
  });
  assert.throws(
    () =>
      store.insertAttempt({
        runId: secondRun.run.id,
        memberId: firstRun.members[0]!.id,
        attempt: 1,
        taskId: null,
        sessionId: null,
        agent: null,
        requestedModel: null,
        requestedEffort: null,
        baseSha: null,
        worktreePath: null,
        branch: null,
        status: "running",
      }),
    /attempt identity/,
  );

  const artifact = {
    runId: firstRun.run.id,
    attemptId: attempt.id,
    kind: "commit" as const,
    formatVersion: 1,
    attempt: 1,
    status: "ready" as const,
    locator: {},
    digest: "sha256:first",
    metadata: {},
    operationKey: "shared-artifact-operation",
    readyAt: 200,
  };
  store.recordArtifact(artifact);
  assert.throws(
    () => store.recordArtifact({ ...artifact, runId: secondRun.run.id }),
    /operation key/,
  );

  const stage = store.startStageAttempt({
    runId: firstRun.run.id,
    stageId: "stage-review",
    driverKind: "review",
    driverKey: "comparative_review@1",
    attempt: 1,
    commandKey: "shared-stage-command",
    status: "running",
    input: {},
  });
  assert.throws(
    () =>
      store.startStageAttempt({
        runId: secondRun.run.id,
        stageId: "stage-review",
        driverKind: "review",
        driverKey: "comparative_review@1",
        attempt: 1,
        commandKey: "shared-stage-command",
        status: "running",
        input: {},
      }),
    /command key/,
  );

  const evaluation = {
    runId: firstRun.run.id,
    stageAttemptId: stage.id,
    attempt: 1,
    method: "comparative_llm",
    runnerId: null,
    modelId: null,
    inputFingerprint: "sha256:packet",
    subjectArtifactIds: [],
    status: "running" as const,
  };
  store.recordEvaluation(evaluation);
  assert.throws(
    () => store.recordEvaluation({ ...evaluation, runId: secondRun.run.id }),
    /evaluation identity/,
  );

  const decision = {
    runId: firstRun.run.id,
    actor: "human" as const,
    actorId: null,
    selection: {},
    rationale: "",
    operationKey: "shared-decision-operation",
  };
  store.recordDecision(decision);
  assert.throws(
    () => store.recordDecision({ ...decision, runId: secondRun.run.id }),
    /operation key/,
  );

  const event = {
    runId: firstRun.run.id,
    kind: "created",
    payload: {},
    operationKey: "shared-event-operation",
  };
  store.appendEvent(event);
  assert.throws(
    () => store.appendEvent({ ...event, runId: secondRun.run.id }),
    /operation key/,
  );
});

test("a model call's unknown cost stays null, because unknown is not zero", () => {
  const store = new EnsembleStore(db);
  const { run } = insert(store);
  const call = store.startLlmCall({
    runId: run.id,
    stageAttemptId: null,
    evaluationId: null,
    purpose: "comparative_review",
    runnerId: "claude",
    modelId: "claude-opus-4-8",
    attempt: 1,
    state: "running",
    startedAt: 100,
  });
  const done = store.finishLlmCall(call.id, ["running"], "succeeded", {
    finishedAt: 200,
    durationMs: 100,
    inputBytes: 10,
    outputBytes: 20,
    costUsd: null,
    errorCode: null,
  });
  assert.equal(done.ok, true);
  if (!done.ok) return;
  assert.equal(done.value.costUsd, null);
  assert.equal(done.value.state, "succeeded");
  assert.equal(
    store.finishLlmCall(call.id, ["running"], "failed", {
      finishedAt: 300,
      durationMs: 200,
      inputBytes: 10,
      outputBytes: 0,
      costUsd: null,
      errorCode: "late",
    }).ok,
    false,
  );
  assert.equal(
    store.finishLlmCall(call.id, ["succeeded"], "running", {
      finishedAt: 300,
      durationMs: 200,
      inputBytes: 10,
      outputBytes: 0,
      costUsd: null,
      errorCode: null,
    }).ok,
    false,
  );
});

test("oversized UTF-8 JSON is refused before it can corrupt a row", () => {
  const store = new EnsembleStore(db);
  const { run } = insert(store);
  const stage = store.startStageAttempt({
    runId: run.id,
    stageId: "stage-large",
    driverKind: "review",
    driverKey: "comparative_review@1",
    attempt: 1,
    commandKey: "stage-large:1",
    status: "running",
    input: {},
  });
  const oversized = { value: "💥".repeat(ENSEMBLE_LIMITS.stagePayloadJsonBytes / 4) };
  assert.throws(
    () => store.finishStageAttempt(stage.id, ["running"], "succeeded", { output: oversized }),
    /UTF-8 bytes/,
  );
  const unchanged = store.listStageAttempts(run.id).find((row) => row.id === stage.id);
  assert.equal(unchanged?.status, "running");
  assert.equal(unchanged?.output, null);

  assert.throws(
    () =>
      store.appendEvent({
        runId: run.id,
        kind: "too_large",
        payload: { value: "💥".repeat(ENSEMBLE_LIMITS.eventPayloadJsonBytes / 4) },
        operationKey: "too-large-event",
      }),
    /UTF-8 bytes/,
  );
  assert.equal(store.listEvents(run.id).length, 0);
});

test("a decision is versioned, supersedes its predecessor, and is spent once", () => {
  const store = new EnsembleStore(db);
  const { run, members } = insert(store);
  const first = store.recordDecision({
    runId: run.id,
    actor: "human",
    actorId: null,
    selection: { memberId: members[0]!.id },
    rationale: "clearer diff",
    operationKey: `${run.id}:decide:1`,
  });
  assert.equal(first.version, 1);
  assert.equal(first.status, "recorded");

  // The click that records a decision is the click that starts reaping loser worktrees.
  assert.equal(store.recordDecision({
    runId: run.id,
    actor: "human",
    actorId: null,
    selection: { memberId: members[0]!.id },
    rationale: "clearer diff",
    operationKey: `${run.id}:decide:1`,
  }).id, first.id);

  const second = store.recordDecision({
    runId: run.id,
    actor: "human",
    actorId: null,
    selection: { memberId: members[1]!.id },
    rationale: "changed my mind",
    operationKey: `${run.id}:decide:2`,
  });
  assert.equal(second.version, 2);
  const decisions = store.listDecisions(run.id);
  assert.equal(decisions[0]?.status, "superseded");
  assert.equal(decisions[1]?.status, "recorded");

  const finalization = store.startStageAttempt({
    runId: run.id,
    stageId: "stage-finalize",
    driverKind: "finalize",
    driverKey: "select_one_finalize@1",
    attempt: 1,
    commandKey: `${run.id}:finalize:1`,
    status: "running",
    input: {},
  });
  const applied = store.applyDecision(second.id, finalization.id);
  assert.equal(applied.ok, true);
  assert.equal(store.applyDecision(second.id, finalization.id).ok, false);
});

test("a replayed audit record does not double the timeline an operator reads", () => {
  const store = new EnsembleStore(db);
  const { run } = insert(store);
  const event = { runId: run.id, kind: "run_created", payload: { members: 2 }, operationKey: `${run.id}:created` };
  const first = store.appendEvent(event);
  const replay = store.appendEvent(event);
  assert.equal(replay?.id, first?.id);
  assert.equal(store.listEvents(run.id).length, 1);
});

// ---- reads ----

test("a detail read returns every record the run owns", () => {
  const store = new EnsembleStore(db);
  const { run, members } = insert(store);
  const attempt = store.insertAttempt({
    runId: run.id,
    memberId: members[0]!.id,
    attempt: 1,
    taskId: "task-1",
    sessionId: "sess-1",
    agent: "claude",
    requestedModel: null,
    requestedEffort: null,
    baseSha: "b".repeat(40),
    worktreePath: "/wt",
    branch: "mancej/x",
    status: "running",
  });
  store.recordArtifact({
    runId: run.id,
    attemptId: attempt.id,
    kind: "commit",
    formatVersion: 1,
    attempt: 1,
    status: "ready",
    locator: { commit: "c".repeat(40) },
    digest: "sha256:1",
    metadata: {},
    operationKey: "op-artifact",
    readyAt: 200,
  });
  const stage = store.startStageAttempt({
    runId: run.id,
    stageId: "stage-1",
    driverKind: "member",
    driverKey: "member_wave@1",
    attempt: 1,
    commandKey: "op-stage",
    status: "succeeded",
    input: {},
  });
  store.recordEvaluation({
    runId: run.id,
    stageAttemptId: stage.id,
    attempt: 1,
    method: "comparative_llm",
    runnerId: "claude",
    modelId: "m",
    inputFingerprint: "f",
    subjectArtifactIds: [],
    status: "queued",
  });
  store.recordDecision({
    runId: run.id,
    actor: "human",
    actorId: null,
    selection: {},
    rationale: "",
    operationKey: "op-decide",
  });
  store.appendEvent({ runId: run.id, kind: "created", payload: {}, operationKey: "op-event" });

  const detail = store.detail(run.id);
  assert.ok(detail);
  assert.equal(detail.run.id, run.id);
  assert.equal(detail.members.length, 2);
  assert.equal(detail.attempts.length, 1);
  assert.equal(detail.artifacts.length, 1);
  assert.equal(detail.stageAttempts.length, 1);
  assert.equal(detail.evaluations.length, 1);
  assert.equal(detail.decisions.length, 1);
  assert.equal(detail.events.length, 1);
  // The plan survives the round trip exactly - it is the thing recovery executes.
  assert.deepEqual(detail.run.plan, plan());
  assert.equal(store.detail("no-such-run"), null);
});

test("a detail read returns the complete audit history", () => {
  const store = new EnsembleStore(db);
  const { run } = insert(store);
  for (let index = 0; index < ENSEMBLE_LIMITS.detailPageSize + 5; index += 1) {
    store.appendEvent({
      runId: run.id,
      kind: `event-${index}`,
      payload: { index },
      operationKey: `event-${index}`,
    });
  }
  const events = store.detail(run.id)?.events;
  assert.equal(events?.length, ENSEMBLE_LIMITS.detailPageSize + 5);
  assert.equal(events?.[0]?.kind, "event-0");
  assert.equal(events?.at(-1)?.kind, `event-${ENSEMBLE_LIMITS.detailPageSize + 4}`);
});

test("the compact summary counts progress without loading the run's children", () => {
  const store = new EnsembleStore(db);
  const { run, members } = insert(store);
  let summary = store.summary(run.id);
  assert.ok(summary);
  assert.equal(summary.memberCount, 2);
  assert.equal(summary.launchedMembers, 0);
  assert.equal(summary.readyArtifacts, 0);
  assert.equal(summary.maxMembers, 3, "the plan's own cap, not the roster length");
  assert.equal(summary.attention, false);

  store.setMemberStatus(members[0]!.id, ["pending"], "launching", { taskId: "task-1" });
  const attempt = store.insertAttempt({
    runId: run.id,
    memberId: members[0]!.id,
    attempt: 1,
    taskId: "task-1",
    sessionId: null,
    agent: null,
    requestedModel: null,
    requestedEffort: null,
    baseSha: null,
    worktreePath: null,
    branch: null,
    status: "running",
  });
  store.recordArtifact({
    runId: run.id,
    attemptId: attempt.id,
    kind: "commit",
    formatVersion: 1,
    attempt: 1,
    status: "ready",
    locator: {},
    digest: "d",
    metadata: {},
    operationKey: "op-1",
    readyAt: 1,
  });
  summary = store.summary(run.id);
  assert.equal(summary?.launchedMembers, 1);
  assert.equal(summary?.readyArtifacts, 1);

  store.setRunStatus(run.id, ["planning"], "awaiting_decision");
  assert.equal(store.summary(run.id)?.attention, true, "a run waiting on a person needs attention");
});

test("the compact summary does not treat an unknown member status as launched", () => {
  const store = new EnsembleStore(db);
  const { run, members } = insert(store);
  db.prepare(`UPDATE ensemble_members SET status = 'future' WHERE id = ?`).run(members[0]!.id);
  assert.equal(store.summary(run.id)?.launchedMembers, 0);

  store.setMemberStatus(members[1]!.id, ["pending"], "active");
  assert.equal(store.summary(run.id)?.launchedMembers, 1);
});

test("a completed run reports the member its outcome selected", () => {
  const store = new EnsembleStore(db);
  const { run, members } = insert(store);
  store.setRunStatus(run.id, ["planning"], "completed", {
    outcome: { kind: "selected", memberIds: [members[1]!.id], artifactIds: ["art-1"], materializedTaskId: null },
    completedAt: 900,
  });
  const summary = store.summary(run.id);
  assert.equal(summary?.selectedMemberId, members[1]!.id);
  assert.equal(summary?.outcomeKind, "selected");
  assert.equal(summary?.completedAt, 900);
});

test("the task projection names the member, its place in the roster, and nothing more", () => {
  const store = new EnsembleStore(db);
  const { members } = insert(store);
  assert.equal(store.taskLink("task-9"), null);
  store.setMemberStatus(members[1]!.id, ["pending"], "active", {
    taskId: "task-9",
    resultLabel: "rank 1",
  });
  const link = store.taskLink("task-9");
  assert.deepEqual(link, {
    runId: members[1]!.runId,
    strategyId: "best_of_n",
    strategyLabel: "Best of N",
    memberId: members[1]!.id,
    ordinal: 2,
    wave: 1,
    role: "candidate-2",
    launchedMembers: 1,
    maxMembers: 3,
    status: "active",
    resultLabel: "rank 1",
  });
  assert.deepEqual(store.listTaskLinks(), [{ taskId: "task-9", link }]);
});

test("projection rebuilding skips malformed linked members without weakening detail reads", () => {
  const store = new EnsembleStore(db);
  const { run, members } = insert(store);
  store.setMemberStatus(members[0]!.id, ["pending"], "active", { taskId: "task-bad" });
  store.setMemberStatus(members[1]!.id, ["pending"], "active", { taskId: "task-good" });
  db.prepare(`UPDATE ensemble_members SET ordinal = 'invalid' WHERE id = ?`).run(members[0]!.id);

  assert.deepEqual(
    store.listTaskLinks().map(({ taskId }) => taskId),
    ["task-good"],
  );
  assert.throws(() => store.listMembers(run.id), EnsembleRowError);
});

// ---- restart and version skew ----

test("the restart query returns exactly the runs that have not finished", () => {
  const store = new EnsembleStore(db);
  const running = insert(store, "manual:running").run;
  const done = insert(store, "manual:done").run;
  const cancelled = insert(store, "manual:cancelled").run;
  store.setRunStatus(running.id, ["planning"], "running");
  store.setRunStatus(done.id, ["planning"], "completed", { completedAt: 1 });
  store.setRunStatus(cancelled.id, ["planning"], "cancelled", { completedAt: 1 });

  assert.deepEqual(
    store.listNonTerminalRuns().map((run) => run.id),
    [running.id],
  );
});

test("a run written by a newer build loads, and says exactly why it will not run here", () => {
  const store = new EnsembleStore(db);
  const { run } = insert(store);
  db.prepare(`UPDATE ensemble_runs SET strategy_id = 'tournament', strategy_key = 'tournament@2' WHERE id = ?`).run(
    run.id,
  );
  const loaded = store.getRun(run.id);
  assert.ok(loaded, "a run nobody can see is a run nobody can cancel");
  assert.equal(loaded.strategyId, null);
  assert.equal(loaded.strategyKey, "tournament@2");
  assert.ok(loaded.unreadable);
  assert.ok(loaded.unreadable.fields.includes("strategy_id"));
  assert.equal(store.summary(run.id)?.attention, true);
  assert.equal(store.listNonTerminalRuns().some((r) => r.id === run.id), true);
});

test("a newer persisted strategy version stays visible but is not runnable", () => {
  const store = new EnsembleStore(db);
  const { run } = insert(store);
  const future = plan({ strategyKey: "best_of_n@2" });
  db.prepare(
    `UPDATE ensemble_runs
        SET strategy_version = 2, strategy_key = 'best_of_n@2', compiled_plan_json = ?
      WHERE id = ?`,
  ).run(JSON.stringify(future), run.id);
  const loaded = store.getRun(run.id);
  assert.ok(loaded?.plan);
  assert.equal(loaded.plan.strategyKey, "best_of_n@2");
  assert.ok(loaded.unreadable?.fields.includes("strategy_key"));
  assert.equal(ensembleIsRunnable(loaded), false);
});

test("a strategy version that disagrees with its persisted key degrades", () => {
  const store = new EnsembleStore(db);
  const { run } = insert(store);
  db.prepare(`UPDATE ensemble_runs SET strategy_version = 9 WHERE id = ?`).run(run.id);
  const loaded = store.getRun(run.id);
  assert.ok(loaded?.unreadable?.fields.includes("strategy_version"));
  assert.equal(loaded && ensembleIsRunnable(loaded), false);
});

test("a plan needing a driver this build does not ship stays readable and is still refused", () => {
  const store = new EnsembleStore(db);
  const { run } = insert(store);
  const future = plan({
    stages: [{ ...plan().stages[0]!, driverKey: "member_wave@9" } as CompiledEnsemblePlan["stages"][number]],
  });
  db.prepare(`UPDATE ensemble_runs SET compiled_plan_json = ? WHERE id = ?`).run(
    JSON.stringify(future),
    run.id,
  );
  const loaded = store.getRun(run.id);
  assert.ok(loaded?.plan, "the operator still has to be able to see what it was going to do");
  assert.equal(loaded.plan.stages[0]?.driverKey, "member_wave@9");
  assert.ok(loaded.unreadable?.reason.includes("member_wave@9"));
});

test("a plan whose shape this build cannot parse degrades that run and no other", () => {
  const store = new EnsembleStore(db);
  const broken = insert(store, "manual:broken").run;
  const healthy = insert(store, "manual:healthy").run;
  db.prepare(`UPDATE ensemble_runs SET compiled_plan_json = 'not json' WHERE id = ?`).run(broken.id);

  const summaries = store.listSummaries();
  assert.equal(summaries.length, 2, "one bad row must not take the whole list down");
  assert.equal(summaries.find((s) => s.id === broken.id)?.unreadable !== null, true);
  assert.equal(summaries.find((s) => s.id === healthy.id)?.unreadable, null);
  assert.equal(store.getRun(broken.id)?.plan, null);
});

test("a corrupt column on the RUN degrades it, because the daemon boots through this read", () => {
  // `EnsembleManager` builds the registry's summaries during daemon construction. A run row
  // that threw here would stop the daemon starting, leaving no dashboard from which to delete
  // the row that is stopping it - so one bad run costs that run its runnability and nothing
  // else, and the list it is in still loads.
  const store = new EnsembleStore(db);
  const broken = insert(store, "manual:broken-config").run;
  const healthy = insert(store, "manual:healthy-config").run;
  db.prepare(`UPDATE ensemble_runs SET strategy_config_json = '{', outcome_json = 'nope' WHERE id = ?`).run(
    broken.id,
  );

  const loaded = store.getRun(broken.id);
  assert.ok(loaded);
  assert.equal(loaded.strategyConfig, null);
  assert.equal(loaded.outcome, null);
  assert.ok(loaded.unreadable?.fields.includes("strategy_config_json"));
  assert.ok(loaded.unreadable?.fields.includes("outcome_json"));
  assert.equal(store.listSummaries().length, 2);
  assert.equal(store.summary(broken.id)?.attention, true);
  assert.equal(store.summary(healthy.id)?.unreadable, null);
});

test("malformed scalar run fields degrade instead of escaping the boot summary read", () => {
  const store = new EnsembleStore(db);
  const broken = insert(store, "manual:broken-scalars").run;
  insert(store, "manual:healthy-scalars");
  db.prepare(
    `UPDATE ensemble_runs SET strategy_version = 'future', created_at = 'yesterday' WHERE id = ?`,
  ).run(broken.id);

  const loaded = store.getRun(broken.id);
  assert.ok(loaded);
  assert.equal(loaded.strategyVersion, 0);
  assert.equal(loaded.createdAt, 0);
  assert.ok(loaded.unreadable?.fields.includes("strategy_version"));
  assert.ok(loaded.unreadable?.fields.includes("created_at"));
  assert.equal(store.listSummaries().length, 2);
});

test("unknown child enums degrade to null while malformed child JSON still throws", () => {
  const store = new EnsembleStore(db);
  const { run } = insert(store);
  store.recordArtifact({
    runId: run.id,
    attemptId: null,
    kind: "commit",
    formatVersion: 1,
    attempt: 1,
    status: "ready",
    locator: {},
    digest: "d",
    metadata: {},
    operationKey: "op-future-kind",
    readyAt: 1,
  });
  db.prepare(
    `UPDATE ensemble_artifacts SET kind = 'future_artifact' WHERE operation_key = 'op-future-kind'`,
  ).run();
  assert.equal(store.listArtifacts(run.id)[0]?.kind, null);
  db.prepare(
    `UPDATE ensemble_artifacts SET locator_json = '{' WHERE operation_key = 'op-future-kind'`,
  ).run();
  assert.throws(() => store.listArtifacts(run.id), EnsembleRowError);
});

test("a corrupt column on a CHILD throws, naming the table and row", () => {
  // The other half of the same decision. A child is read by an HTTP detail request, not at
  // boot, so failing loudly with the row named is better than a silently empty artifact list
  // that a later phase would read as "this member submitted nothing".
  const store = new EnsembleStore(db);
  const { run, members } = insert(store);
  const attempt = store.insertAttempt({
    runId: run.id,
    memberId: members[0]!.id,
    attempt: 1,
    taskId: "task-1",
    sessionId: null,
    agent: null,
    requestedModel: null,
    requestedEffort: null,
    baseSha: null,
    worktreePath: null,
    branch: null,
    status: "running",
  });
  store.recordArtifact({
    runId: run.id,
    attemptId: attempt.id,
    kind: "commit",
    formatVersion: 1,
    attempt: 1,
    status: "ready",
    locator: {},
    digest: "d",
    metadata: {},
    operationKey: "op-corrupt",
    readyAt: 1,
  });
  db.prepare(`UPDATE ensemble_artifacts SET locator_json = '{' WHERE operation_key = 'op-corrupt'`).run();
  assert.throws(() => store.listArtifacts(run.id), EnsembleRowError);
});

test("deleting a run takes its whole history with it and leaves the others alone", () => {
  const store = new EnsembleStore(db);
  const doomed = insert(store, "manual:doomed").run;
  const kept = insert(store, "manual:kept").run;
  store.appendEvent({ runId: doomed.id, kind: "created", payload: {}, operationKey: "op-doomed" });

  assert.equal(store.deleteRun(doomed.id), true);
  assert.equal(store.deleteRun(doomed.id), false);
  assert.equal(store.getRun(doomed.id), null);
  assert.equal(store.listEvents(doomed.id).length, 0);
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS count FROM ensemble_members WHERE run_id = ?`).get(doomed.id) as {
      count: number;
    }).count,
    0,
  );
  assert.equal(store.listMembers(kept.id).length, 2);
});
