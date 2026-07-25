import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * What is at stake: the ensemble kernel promises exactly-once durable identities and at-least-once
 * idempotent effects across any daemon restart. ensemble-recovery.test.ts proves that for Best-of-N
 * (one wave, one evaluation). This suite proves the SAME generic guarantee holds for the materially
 * different extension shapes whose recovery paths Best-of-N never exercises: a pairwise run with
 * several separate evaluations, a two-wave successive-halving run gated on a review, and a matrix
 * fan-out interrupted mid-launch. A restart must never re-run a completed comparison, re-dispatch a
 * live member, or duplicate a member, attempt, evaluation, or stage.
 */

const home = mkdtempSync(join(tmpdir(), "mission-ensemble-fault-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { EnsembleStore, clearEnsembleTables } = await import("../src/server/ensembles/store.ts");
const { EnsembleEngine } = await import("../src/server/ensembles/engine.ts");
const { FakeGateway, stubAdapters, runInsert } = await import("./ensemble-fixture.ts");
const fx = await import("./ensemble-strategy-fixtures.ts");

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => clearEnsembleTables(db));

let counter = 0;
function makeRun(store: InstanceType<typeof EnsembleStore>, plan: ReturnType<typeof fx.pairwisePlan>) {
  return store.createRun(runInsert(plan, { sourceKey: `fault:${(counter += 1)}` })).run;
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("a restart at the decision boundary of a pairwise run preserves every evaluation and re-runs none", async () => {
  const store = new EnsembleStore(db);
  const first = fx.reviewEngine(store);
  const run = makeRun(store, fx.pairwisePlan(3));
  await fx.runAllMembers(first.engine, first.gateway, store, run.id);
  await waitFor(() => store.getRun(run.id)?.status === "awaiting_decision");

  const before = store.listEvaluations(run.id);
  assert.equal(before.length, 3, "three pairs, three separate evaluations");
  assert.ok(before.every((e) => e.status === "succeeded"));
  const beforeIds = before.map((e) => e.id).sort();

  // Restart: a brand-new engine and gateway over the same durable store, then recover.
  const second = fx.reviewEngine(store);
  await second.engine.recover(run.id);

  assert.equal(second.modelCalls(), 0, "recovery ran no new comparison - the evidence was already judged");
  assert.equal(second.gateway.dispatched.length, 0, "no member was re-dispatched");
  const after = store.listEvaluations(run.id);
  assert.deepEqual(after.map((e) => e.id).sort(), beforeIds, "the exact same evaluation rows survive");
  assert.equal(store.getRun(run.id)?.status, "awaiting_decision", "the run stays parked on the human");
});

test("a restart of a two-wave successive-halving run duplicates no member, attempt, stage, or evaluation", async () => {
  const store = new EnsembleStore(db);
  const first = fx.reviewEngine(store);
  const run = makeRun(store, fx.successiveHalvingPlan(4, 2));
  await fx.runAllMembers(first.engine, first.gateway, store, run.id);
  await waitFor(() => store.getRun(run.id)?.status === "awaiting_decision");

  const members = store.listMembers(run.id).length;
  const attempts = store.listAttempts(run.id).length;
  const stages = store.listStageAttempts(run.id).length;
  const evals = store.listEvaluations(run.id).length;
  assert.equal(members, 6);
  assert.equal(evals, 2, "the wide cull and the finalist comparison");

  const second = fx.reviewEngine(store);
  await second.engine.recover(run.id);
  await second.engine.recover(run.id); // a second pass must also be a no-op

  assert.equal(store.listMembers(run.id).length, members, "no duplicate member across two recoveries");
  assert.equal(store.listAttempts(run.id).length, attempts, "no duplicate attempt");
  assert.equal(store.listStageAttempts(run.id).length, stages, "no duplicate stage attempt");
  assert.equal(store.listEvaluations(run.id).length, evals, "no duplicate evaluation");
  assert.equal(second.gateway.dispatched.length, 0, "neither wave was re-launched");
});

test("a matrix fan-out interrupted after launch, before submission, reconciles its members without duplication", async () => {
  const store = new EnsembleStore(db);
  const gateway = new FakeGateway();
  const engine = new EnsembleEngine({ store, tasks: gateway, publish: () => {}, armTimer: () => () => {}, adapters: stubAdapters() });
  const run = store.createRun(
    runInsert(fx.fixedMatrixPlan([{ agent: "claude" }, { agent: "codex" }, { agent: "claude" }, { agent: "codex" }]), { sourceKey: `fault:${(counter += 1)}` }),
  ).run;
  await engine.launch(run.id);
  const tasks = gateway.dispatched.map((d) => d.taskId);
  assert.equal(tasks.length, 4, "every matrix cell was dispatched in one wave");

  // Crash mid-flight: the four agents survive. A fresh engine + gateway reports them running.
  const survivor = new FakeGateway();
  for (const t of tasks) survivor.running(t, `/wt/${t}`);
  const engine2 = new EnsembleEngine({ store, tasks: survivor, publish: () => {}, armTimer: () => () => {}, adapters: stubAdapters() });
  await engine2.recover(run.id);

  assert.equal(survivor.created.length, 0, "recovery created no replacement member Task");
  assert.equal(store.listAttempts(run.id).length, 4, "no duplicate launch attempt");
  assert.equal(store.listMembers(run.id).length, 4);
  assert.ok(store.listMembers(run.id).every((m) => m.status === "active"), "the survivors reconciled to active");
});

test("a duplicate create request returns the same run and launches no second fleet", () => {
  const store = new EnsembleStore(db);
  const plan = fx.panelPlan(3, 3);
  const insert = runInsert(plan, { sourceKey: "dup-create-key" });
  const a = store.createRun(insert);
  const b = store.createRun(insert);
  assert.equal(a.run.id, b.run.id, "the stable source key returns the existing run");
  assert.equal(b.created, false, "the second create launched nothing new");
  assert.equal(store.listMembers(a.run.id).length, 3, "only one roster exists");
});

test("a submission racing a run cancellation settles to one terminal state with no duplicate artifact", async () => {
  const store = new EnsembleStore(db);
  const { engine, gateway } = fx.reviewEngine(store);
  const run = makeRun(store, fx.panelPlan(3, 3));
  await engine.launch(run.id);
  const dispatch = gateway.dispatched[0]!;
  const attempt = store.listAttempts(run.id).find((a) => a.taskId === dispatch.taskId)!;
  gateway.running(dispatch.taskId, `/wt/${dispatch.taskId}`);
  await engine.wake(run.id);

  // Fire the submission and the cancellation together; the per-run serialization must order them.
  await Promise.allSettled([
    engine.submit({ runId: run.id, memberId: attempt.memberId, claims: { summary: "x", checks: [], testEvidence: null }, source: "mcp", requireWorktree: `/wt/${dispatch.taskId}` }),
    engine.cancelRun(run.id, "operator changed their mind"),
  ]);
  await waitFor(() => {
    const s = store.getRun(run.id)?.status;
    return s === "cancelled" || s === "awaiting_decision" || s === "failed";
  });

  const status = store.getRun(run.id)?.status;
  assert.ok(status === "cancelled" || status === "failed", `a cancelled run settles terminal, got ${status}`);
  // Whatever the ordering, at most one ready artifact exists for that member - never two.
  const ready = store.listArtifacts(run.id).filter((a) => a.attemptId === attempt.id && a.status === "ready");
  assert.ok(ready.length <= 1, "no duplicate artifact was produced by the race");
});
