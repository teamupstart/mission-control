import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * What is at stake: the daemon can die at any instant - mid-wave, mid-capture, between a stage
 * succeeding and the next starting - and it must resume from SQLite plus current Task state alone,
 * never from events it missed. The one failure it must make impossible is duplication: a resumed run
 * that launched a second fleet, re-captured over an immutable artifact, or re-ran a stage would spend
 * real money twice and corrupt the comparison. Every "restart" here is a fresh engine over the same
 * durable store, exactly as a restarted daemon rebuilds itself.
 */

const home = mkdtempSync(join(tmpdir(), "mission-ensemble-recovery-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { EnsembleStore, clearEnsembleTables } = await import("../src/server/ensembles/store.ts");
const { EnsembleEngine } = await import("../src/server/ensembles/engine.ts");
const { FakeGateway, stubAdapters, singleWavePlan, runInsert } = await import("./ensemble-fixture.ts");

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => clearEnsembleTables(db));

function makeEngine(gateway = new FakeGateway(), adapters = stubAdapters()) {
  const store = new EnsembleStore(db);
  const engine = new EnsembleEngine({ store, tasks: gateway, publish: () => {}, adapters });
  return { store, gateway, engine };
}

const CLAIMS = { summary: "done", checks: [] as string[], testEvidence: null };

test("recovery before any launch starts the wave, and a second recovery does not duplicate it", async () => {
  const store = new EnsembleStore(db);
  const { run } = store.createRun(runInsert(singleWavePlan(3)));
  // Nothing launched yet - the crash happened right after the run was persisted.
  const gateway = new FakeGateway();
  const engine = new EnsembleEngine({ store, tasks: gateway, publish: () => {}, adapters: stubAdapters() });

  await engine.recover(run.id);
  assert.equal(gateway.created.length, 3, "the wave is launched on recovery");
  await engine.recover(run.id);
  assert.equal(gateway.created.length, 3, "a second recovery launches nothing new");
  assert.equal(store.listStageAttempts(run.id).filter((s) => s.stageId === "stage-1").length, 1);
});

test("recovery reconciles surviving member agents without recreating their tasks", async () => {
  const first = makeEngine();
  const { run } = first.store.createRun(runInsert(singleWavePlan(2)));
  await first.engine.launch(run.id);
  const tasks = first.gateway.dispatched.map((d) => d.taskId);
  assert.equal(tasks.length, 2);

  // Restart: a fresh engine and a fresh gateway that reports both agents survived (running).
  const survivor = new FakeGateway();
  for (const taskId of tasks) survivor.running(taskId, `/wt/${taskId}`);
  const second = makeEngine(survivor);
  await second.engine.recover(run.id);

  assert.equal(survivor.created.length, 0, "recovery created no new tasks");
  const members = second.store.listMembers(run.id);
  assert.ok(members.every((m) => m.status === "active"), "both members reconciled to active");
  const attempts = second.store.listAttempts(run.id);
  assert.equal(attempts.length, 2, "no duplicate attempts");
});

test("recovery fails a capture interrupted by the crash so the member can submit again", async () => {
  const store = new EnsembleStore(db);
  const { run } = store.createRun(runInsert(singleWavePlan(2)));
  const member = store.listMembers(run.id)[0]!;
  store.insertAttempt({
    runId: run.id,
    memberId: member.id,
    attempt: 1,
    taskId: "t-a",
    sessionId: null,
    agent: "claude",
    requestedModel: null,
    requestedEffort: null,
    baseSha: "a".repeat(40),
    worktreePath: "/wt/a",
    branch: null,
    status: "running",
  });
  store.setMemberStatus(member.id, ["pending"], "launching", { taskId: "t-a" });
  store.setMemberStatus(member.id, ["launching"], "active", {});
  const attempt = store.listAttempts(run.id)[0]!;
  // A capture that never finished: a `capturing` artifact and (in reality) a possibly-orphaned ref.
  store.recordArtifact({
    runId: run.id,
    attemptId: attempt.id,
    kind: "commit",
    formatVersion: 1,
    attempt: 1,
    status: "capturing",
    locator: null,
    digest: "",
    metadata: {},
    operationKey: `capture:${attempt.id}:1`,
    readyAt: null,
  });

  const survivor = new FakeGateway();
  survivor.running("t-a", "/wt/a");
  const engine = new EnsembleEngine({ store, tasks: survivor, publish: () => {}, adapters: stubAdapters() });
  await engine.recover(run.id);

  const artifacts = store.listArtifacts(run.id);
  assert.equal(artifacts.filter((a) => a.status === "capturing").length, 0, "no capture is left mid-flight");
  assert.equal(artifacts.filter((a) => a.status === "failed").length, 1, "the interrupted capture is failed");
  assert.equal(store.getMember(member.id)!.status, "active", "the member is still active and may resubmit");
});

test("recovery after a submission neither re-captures nor duplicates the ready artifact", async () => {
  const first = makeEngine();
  const { run } = first.store.createRun(runInsert(singleWavePlan(2)));
  await first.engine.launch(run.id);
  const task = first.gateway.dispatched[0]!.taskId;
  first.gateway.running(task, `/wt/${task}`);
  await first.engine.wake(run.id);
  const memberId = first.store.listAttempts(run.id).find((a) => a.taskId === task)!.memberId;
  await first.engine.submit({ runId: run.id, memberId, claims: CLAIMS, source: "mcp", requireWorktree: `/wt/${task}` });
  const readyBefore = first.store.listArtifacts(run.id).filter((a) => a.status === "ready");
  assert.equal(readyBefore.length, 1);

  // Restart and recover: both agents survived (so the run stays open), and the submitted member and
  // its immutable artifact are untouched.
  const survivor = new FakeGateway();
  for (const dispatched of first.gateway.dispatched) survivor.running(dispatched.taskId, `/wt/${dispatched.taskId}`);
  const second = makeEngine(survivor);
  await second.engine.recover(run.id);
  const readyAfter = second.store.listArtifacts(run.id).filter((a) => a.status === "ready");
  assert.equal(readyAfter.length, 1, "no second artifact");
  assert.equal(readyAfter[0]!.id, readyBefore[0]!.id, "the same immutable artifact");
  assert.equal(second.store.getMember(memberId)!.status, "submitted");
});

// ---- the internal actions delegate Task/worktree effects to their owners ----

test("cancelRun cancels every live member Task through its owner and keeps refs", async () => {
  const { store, gateway, engine } = makeEngine();
  const { run } = store.createRun(runInsert(singleWavePlan(2)));
  await engine.launch(run.id);
  const cancelled = await engine.cancelRun(run.id, "operator stopped it");
  assert.equal(cancelled, true);
  assert.equal(store.getRun(run.id)!.status, "cancelled");
  assert.deepEqual([...gateway.cancelled].sort(), gateway.dispatched.map((d) => d.taskId).sort());
});

test("withdrawMember cancels only that member's Task and recomputes the barrier", async () => {
  const { store, gateway, engine } = makeEngine();
  const { run } = store.createRun(runInsert(singleWavePlan(3, { maxConcurrentMembers: 3 })));
  await engine.launch(run.id);
  const victimTask = gateway.dispatched[0]!.taskId;
  const victim = store.listAttempts(run.id).find((a) => a.taskId === victimTask)!.memberId;
  await engine.withdrawMember(run.id, victim, "operator withdrew it");
  assert.ok(gateway.cancelled.includes(victimTask), "the withdrawn member's task was cancelled");
  assert.equal(gateway.cancelled.length, 1, "only that member's task");
  assert.equal(store.getMember(victim)!.status, "withdrawn");
});

test("restoreArtifact verifies the private ref, then restores through the adapter", async () => {
  const verified: string[] = [];
  const restored: string[] = [];
  const spyAdapters = {
    ...stubAdapters(),
    commit: {
      ...stubAdapters().commit!,
      async verify() {
        verified.push("v");
        return true;
      },
      async restore() {
        restored.push("r");
      },
    },
  };
  const first = makeEngine();
  const { run } = first.store.createRun(runInsert(singleWavePlan(2)));
  await first.engine.launch(run.id);
  const task = first.gateway.dispatched[0]!.taskId;
  first.gateway.running(task, `/wt/${task}`);
  await first.engine.wake(run.id);
  const memberId = first.store.listAttempts(run.id).find((a) => a.taskId === task)!.memberId;
  await first.engine.submit({ runId: run.id, memberId, claims: CLAIMS, source: "mcp", requireWorktree: `/wt/${task}` });
  const artifact = first.store.listArtifacts(run.id).find((a) => a.status === "ready")!;

  // A fresh engine with the spy adapters restores that artifact into its member's worktree.
  const gateway = new FakeGateway();
  gateway.running(task, `/wt/${task}`);
  const store = new EnsembleStore(db);
  const engine = new EnsembleEngine({ store, tasks: gateway, publish: () => {}, adapters: spyAdapters });
  const result = await engine.restoreArtifact(run.id, artifact.id);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(verified, ["v"], "the ref was verified before touching a checkout");
  assert.deepEqual(restored, ["r"], "restore went through the adapter");
});
