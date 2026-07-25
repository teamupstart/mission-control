import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * What is at stake: this is where a human's confirmed choice becomes destructive - a loser worktree
 * reaped, a branch reset to an exact snapshot, a run marked completed. Every failure it must rule
 * out is silent and irreversible: a decision recorded twice, a run finalized in the wrong state, a
 * loser reaped around a winner whose ref is gone, a continuation typed into an agent twice, a run
 * reported completed while an agent still holds a live worktree. Each test drives the engine's
 * finalization against a fake finalize-deps and a fake gateway, so the whole destructive state
 * machine is exercised deterministically without touching Git, a real agent, or a real Workflow.
 */

const home = mkdtempSync(join(tmpdir(), "mission-ensemble-final-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { EnsembleStore, clearEnsembleTables } = await import("../src/server/ensembles/store.ts");
const { EnsembleEngine } = await import("../src/server/ensembles/engine.ts");
const { FakeGateway, FakeFinalize, stubAdapters, decidePlan, runInsert } = await import("./ensemble-fixture.ts");
import type { EnsembleFinalizeDeps } from "../src/server/ensembles/engine.ts";

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => clearEnsembleTables(db));

function harness(finalize: EnsembleFinalizeDeps) {
  const store = new EnsembleStore(db);
  const gateway = new FakeGateway();
  const engine = new EnsembleEngine({
    store,
    tasks: gateway,
    publish: () => {},
    adapters: stubAdapters(),
    finalize,
    now: () => 1000,
    armTimer: () => () => {},
  });
  return { store, gateway, engine };
}

/** Launch a decide-plan run, submit every member, and return it parked in `awaiting_decision`. */
async function driveToDecision(store: InstanceType<typeof EnsembleStore>, gateway: InstanceType<typeof FakeGateway>, engine: InstanceType<typeof EnsembleEngine>, count = 3) {
  const { run } = store.createRun(runInsert(decidePlan(count, 2)));
  await engine.launch(run.id);
  for (const dispatch of [...gateway.dispatched]) {
    gateway.running(dispatch.taskId, `/wt/${dispatch.taskId}`);
    await engine.wake(run.id);
    const memberId = store.listAttempts(run.id).find((a) => a.taskId === dispatch.taskId)!.memberId;
    await engine.submit({ runId: run.id, memberId, claims: { summary: `did ${memberId}`, checks: ["tests"], testEvidence: null }, source: "mcp", requireWorktree: null });
  }
  return run.id;
}

function winnerOf(store: InstanceType<typeof EnsembleStore>, runId: string, ordinal = 1) {
  const member = store.listMembers(runId).find((m) => m.ordinal === ordinal)!;
  const attemptIds = new Set(store.listAttempts(runId).filter((a) => a.memberId === member.id).map((a) => a.id));
  const artifact = store.listArtifacts(runId).find((a) => a.status === "ready" && a.kind === "commit" && a.attemptId !== null && attemptIds.has(a.attemptId))!;
  return { memberId: member.id, artifactId: artifact.id };
}

function decide(engine: InstanceType<typeof EnsembleEngine>, runId: string, artifactId: string, requestId = "req-1") {
  return engine.decide({
    runId,
    requestId,
    expectedStatus: "awaiting_decision",
    selection: { kind: "selected", artifactId },
    rationale: "the reviewer preferred it and so do I",
    actorId: null,
  });
}

// ---- the boundary ----

test("a run reaches awaiting_decision and stays there - a recommendation is never an implicit decision", async () => {
  const finalize = new FakeFinalize();
  const { store, gateway, engine } = harness(finalize);
  const runId = await driveToDecision(store, gateway, engine);
  const run = store.getRun(runId)!;
  assert.equal(run.status, "awaiting_decision");
  assert.equal(run.outcome, null, "no outcome is recorded without a human decision");
  assert.equal(finalize.restored.length, 0, "nothing was restored");
  assert.equal(gateway.cancelled.length, 0, "no loser was reaped");
});

test("a decision request id is idempotent, and a conflicting replay is refused", async () => {
  const finalize = new FakeFinalize();
  finalize.safeIdle = true;
  const { store, gateway, engine } = harness(finalize);
  const runId = await driveToDecision(store, gateway, engine);
  const winner = winnerOf(store, runId, 1);
  const first = await decide(engine, runId, winner.artifactId, "req-A");
  assert.equal(first.ok, true);
  // The same request id, replayed after the run has moved on to completed, returns the SAME decision.
  const replay = await engine.decide({ runId, requestId: "req-A", expectedStatus: "awaiting_decision", selection: { kind: "selected", artifactId: winner.artifactId }, rationale: "again", actorId: null });
  assert.equal(replay.ok, true);
  if (replay.ok && first.ok) assert.equal(replay.decision.id, first.decision.id);
  if (replay.ok) assert.equal(replay.replayed, true);
  // A different selection under the same id is a conflict, never an adoption.
  const other = winnerOf(store, runId, 2);
  const conflict = await engine.decide({ runId, requestId: "req-A", expectedStatus: "awaiting_decision", selection: { kind: "selected", artifactId: other.artifactId }, rationale: "x", actorId: null });
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.reason, "conflict");
});

test("deciding in the wrong state, on an ineligible artifact, is refused", async () => {
  const finalize = new FakeFinalize();
  const { store, gateway, engine } = harness(finalize);
  const runId = await driveToDecision(store, gateway, engine);
  // An artifact id that is not eligible (a made-up id) is refused, not a nearest match.
  const bad = await engine.decide({ runId, requestId: "req-bad", expectedStatus: "awaiting_decision", selection: { kind: "selected", artifactId: "not-an-artifact" }, rationale: "x", actorId: null });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.reason, "ineligible_artifact");
  // An expected-status mismatch is refused before any effect.
  const winner = winnerOf(store, runId, 1);
  const wrong = await engine.decide({ runId, requestId: "req-ws", expectedStatus: "running", selection: { kind: "selected", artifactId: winner.artifactId }, rationale: "x", actorId: null });
  assert.equal(wrong.ok, false);
  if (!wrong.ok) assert.equal(wrong.reason, "wrong_state");
});

test("a missing selected ref prevents ALL cleanup and stays finalizing", async () => {
  const finalize = new FakeFinalize();
  finalize.verify = () => null; // the private ref no longer resolves
  const { store, gateway, engine } = harness(finalize);
  const runId = await driveToDecision(store, gateway, engine);
  const winner = winnerOf(store, runId, 1);
  await decide(engine, runId, winner.artifactId);
  const run = store.getRun(runId)!;
  assert.equal(run.status, "finalizing", "the run stays finalizing on a missing ref");
  assert.match(run.error ?? "", /ref/i);
  assert.equal(gateway.cancelled.length, 0, "no loser is reaped while the winner ref is missing");
  assert.equal(finalize.restored.length, 0);
});

test("the live winner is restored to its exact snapshot, losers reaped through TaskManager, run completed", async () => {
  const finalize = new FakeFinalize();
  const { store, gateway, engine } = harness(finalize);
  const runId = await driveToDecision(store, gateway, engine);
  const winner = winnerOf(store, runId, 1);
  const winnerTask = store.listAttempts(runId).find((a) => a.memberId === winner.memberId)!.taskId!;
  const result = await decide(engine, runId, winner.artifactId);
  assert.equal(result.ok, true);

  const run = store.getRun(runId)!;
  assert.equal(run.status, "completed");
  assert.equal(run.outcome?.kind, "selected");
  if (run.outcome?.kind === "selected") {
    assert.deepEqual(run.outcome.memberIds, [winner.memberId]);
    assert.deepEqual(run.outcome.artifactIds, [winner.artifactId]);
    assert.equal(run.outcome.materializedTaskId, null, "the live winner needed no replacement Task");
  }
  // The winner was restored once; every loser was cancelled through the gateway; the winner was not.
  assert.equal(finalize.restored.length, 1);
  assert.equal(store.getMember(winner.memberId)!.status, "retained");
  assert.equal(gateway.cancelled.includes(winnerTask), false, "the winner Task is never cancelled");
  const losers = store.listMembers(runId).filter((m) => m.id !== winner.memberId);
  for (const loser of losers) {
    assert.equal(loser.status, "eliminated");
    const loserTask = store.listAttempts(runId).find((a) => a.memberId === loser.id)!.taskId!;
    assert.equal(gateway.cancelled.includes(loserTask), true, "each loser Task was cancelled through TaskManager");
  }
  assert.equal(finalize.continuations.length, 1, "exactly one continuation was delivered");
});

test("a loser whose cancel fails leaves the run finalizing, and a retry completes it", async () => {
  const finalize = new FakeFinalize();
  const { store, gateway, engine } = harness(finalize);
  const runId = await driveToDecision(store, gateway, engine);
  const winner = winnerOf(store, runId, 1);
  const loser = store.listMembers(runId).find((m) => m.id !== winner.memberId)!;
  const loserTask = store.listAttempts(runId).find((a) => a.memberId === loser.id)!.taskId!;
  gateway.failCancel(loserTask);
  await decide(engine, runId, winner.artifactId);
  assert.equal(store.getRun(runId)!.status, "finalizing", "a cleanup failure keeps the run finalizing");
  assert.notEqual(store.getMember(loser.id)!.status, "eliminated");

  // The winner was still preserved before the loser stalled cleanup; now let the cancel succeed and resume.
  gateway.cancelFailures.delete(loserTask);
  const resumed = await engine.resolveFinalization(runId, false);
  assert.equal(resumed.ok, true);
  assert.equal(store.getRun(runId)!.status, "completed");
  assert.equal(store.getMember(loser.id)!.status, "eliminated");
});

test("a winner whose session is not safe-idle gets exactly one replacement Task, across a restart", async () => {
  const finalize = new FakeFinalize();
  finalize.safeIdle = false; // force the replacement path
  const { store, gateway, engine } = harness(finalize);
  const runId = await driveToDecision(store, gateway, engine);
  const winner = winnerOf(store, runId, 1);
  await decide(engine, runId, winner.artifactId);
  assert.equal(store.getRun(runId)!.status, "completed");
  assert.equal(finalize.materialized.length, 1, "one replacement Task was materialized");
  const run = store.getRun(runId)!;
  assert.equal(run.outcome?.kind === "selected" && run.outcome.materializedTaskId !== null, true, "materializedTaskId is persisted");
  const replacementId = run.outcome?.kind === "selected" ? run.outcome.materializedTaskId : null;

  // A restart re-drives finalization: it must reconcile to the SAME replacement, never a second.
  await engine.recover(runId);
  assert.equal(finalize.materialized.length, 1, "recovery did not materialize a second replacement");
  assert.equal(run.outcome?.kind === "selected" ? run.outcome.materializedTaskId : null, replacementId);
  assert.equal(finalize.continuations.length, 0, "a replacement carries its continuation in its intent, not a second delivery");
});

test("the continuation is delivered exactly once even when finalization is re-driven", async () => {
  const finalize = new FakeFinalize();
  const { store, gateway, engine } = harness(finalize);
  const runId = await driveToDecision(store, gateway, engine);
  const winner = winnerOf(store, runId, 1);
  await decide(engine, runId, winner.artifactId);
  assert.equal(finalize.continuations.length, 1);
  // Re-drive (as a stray wake or a resolve would): the delivery receipt makes it a no-op.
  await engine.resolveFinalization(runId, false);
  assert.equal(finalize.continuations.length, 1, "the continuation was not delivered twice");
});

test("a no_consensus decision retains every member and reaps nothing", async () => {
  const finalize = new FakeFinalize();
  const { store, gateway, engine } = harness(finalize);
  const runId = await driveToDecision(store, gateway, engine);
  const readyBefore = store.listArtifacts(runId).filter((a) => a.status === "ready").length;
  const result = await engine.decide({ runId, requestId: "req-nc", expectedStatus: "awaiting_decision", selection: { kind: "no_consensus", reason: "none was clearly best" }, rationale: "retain all", actorId: null });
  assert.equal(result.ok, true);
  const run = store.getRun(runId)!;
  assert.equal(run.status, "completed");
  assert.equal(run.outcome?.kind, "no_consensus");
  // Non-destructive means every artifact ref SURVIVES - `retain all`. The agents are still stopped
  // (a completed run leaves none running), but no artifact is invalidated and no member eliminated.
  for (const member of store.listMembers(runId)) assert.equal(member.status, "retained");
  assert.equal(store.listArtifacts(runId).filter((a) => a.status === "ready").length, readyBefore, "every artifact is retained");
});
