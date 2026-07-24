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

test("recovery completes a partially persisted member wave before dispatching", async () => {
  const { store, gateway, engine } = makeEngine();
  const { run } = store.createRun(runInsert(singleWavePlan(3)));
  const stage = run.plan!.stages[0]!;
  store.startStageAttempt({
    runId: run.id,
    stageId: stage.id,
    driverKind: stage.driverKind,
    driverKey: stage.driverKey,
    attempt: 1,
    commandKey: `wave:${run.id}:${stage.id}:1`,
    status: "running",
    input: {},
  });
  const member = store.listMembers(run.id)[0]!;
  const role = run.plan!.roles[0]!;
  store.reserveAttempt(
    {
      runId: run.id,
      memberId: member.id,
      attempt: 1,
      taskId: "reserved-task",
      sessionId: null,
      agent: "claude",
      requestedModel: role.model,
      requestedEffort: role.effort,
      baseSha: run.baseSha,
      worktreePath: null,
      branch: null,
      status: "pending",
    },
    ["pending"],
  );
  await engine.recover(run.id);
  assert.equal(store.listAttempts(run.id).length, 3);
  assert.equal(gateway.created.length, 3);
  assert.equal(gateway.dispatched.length, 3);
  assert.ok(gateway.created.some((created) => created.taskId === "reserved-task"));
});

test("recovery creates a preallocated Task after a crash following association persistence", async () => {
  const first = makeEngine();
  const { run } = first.store.createRun(runInsert(singleWavePlan(2)));
  const originalCreate = first.gateway.create.bind(first.gateway);
  first.gateway.create = () => {
    throw new Error("crash after reservation");
  };
  await assert.rejects(first.engine.launch(run.id), /crash after reservation/);
  const reserved = first.store.listAttempts(run.id)[0]!;
  assert.ok(reserved.taskId);
  first.gateway.create = originalCreate;

  const survivor = new FakeGateway();
  const second = makeEngine(survivor);
  await second.engine.recover(run.id);
  assert.ok(survivor.created.some((created) => created.taskId === reserved.taskId));
  assert.equal(second.store.listAttempts(run.id).length, 2);
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

test("recovery completes an interrupted capture whose deterministic ref is durable", async () => {
  const store = new EnsembleStore(db);
  const { run } = store.createRun(runInsert(singleWavePlan(2)));
  const member = store.listMembers(run.id)[0]!;
  store.insertAttempt({
    runId: run.id,
    memberId: member.id,
    attempt: 1,
    taskId: "t-recover",
    sessionId: null,
    agent: "claude",
    requestedModel: null,
    requestedEffort: null,
    baseSha: run.baseSha,
    worktreePath: "/wt/recover",
    branch: null,
    status: "running",
  });
  store.setMemberStatus(member.id, ["pending"], "active", { taskId: "t-recover" });
  const attempt = store.listAttempts(run.id)[0]!;
  const artifact = store.recordArtifact({
    runId: run.id,
    attemptId: attempt.id,
    kind: "commit",
    formatVersion: 1,
    attempt: 1,
    status: "capturing",
    locator: null,
    digest: "",
    metadata: { claimsDigest: "digest", reported: { summary: "done" }, source: "mcp" },
    operationKey: `capture:${attempt.id}:1`,
    readyAt: null,
  });
  const adapters = stubAdapters();
  adapters.commit = {
    ...adapters.commit!,
    async recover() {
      return {
        locator: { snapshotSha: "a".repeat(40) },
        fingerprint: "b".repeat(40),
        observed: { filesChanged: 1 },
      };
    },
  };
  const gateway = new FakeGateway();
  gateway.running("t-recover", "/wt/recover");
  const engine = new EnsembleEngine({ store, tasks: gateway, publish: () => {}, adapters });
  await engine.recover(run.id);
  assert.equal(store.listArtifacts(run.id).find((row) => row.id === artifact.id)!.status, "ready");
  assert.equal(store.getMember(member.id)!.status, "submitted");
  assert.equal(store.listArtifacts(run.id).length, 1);
});

test("recovery repairs an active member already backed by a ready artifact", async () => {
  const store = new EnsembleStore(db);
  const { run } = store.createRun(runInsert(singleWavePlan(2)));
  const member = store.listMembers(run.id)[0]!;
  store.insertAttempt({
    runId: run.id,
    memberId: member.id,
    attempt: 1,
    taskId: "t-ready",
    sessionId: null,
    agent: "claude",
    requestedModel: null,
    requestedEffort: null,
    baseSha: run.baseSha,
    worktreePath: "/wt/ready",
    branch: null,
    status: "running",
  });
  store.setMemberStatus(member.id, ["pending"], "active", { taskId: "t-ready" });
  const attempt = store.listAttempts(run.id)[0]!;
  store.recordArtifact({
    runId: run.id,
    attemptId: attempt.id,
    kind: "commit",
    formatVersion: 1,
    attempt: 1,
    status: "ready",
    locator: { snapshotSha: "a".repeat(40) },
    digest: "b".repeat(40),
    metadata: { claimsDigest: "digest" },
    operationKey: `capture:${attempt.id}:1`,
    readyAt: 1,
  });
  const gateway = new FakeGateway();
  gateway.running("t-ready", "/wt/ready");
  const engine = new EnsembleEngine({ store, tasks: gateway, publish: () => {}, adapters: stubAdapters() });
  await engine.recover(run.id);
  assert.equal(store.getMember(member.id)!.status, "submitted");
  assert.equal(store.listAttempts(run.id).find((row) => row.id === attempt.id)!.status, "submitted");
});

test("recovery invalidates a ready artifact whose private ref no longer verifies", async () => {
  const store = new EnsembleStore(db);
  const { run } = store.createRun(runInsert(singleWavePlan(2)));
  const member = store.listMembers(run.id)[0]!;
  store.insertAttempt({
    runId: run.id,
    memberId: member.id,
    attempt: 1,
    taskId: "t-missing-ref",
    sessionId: null,
    agent: "claude",
    requestedModel: null,
    requestedEffort: null,
    baseSha: run.baseSha,
    worktreePath: "/wt/missing",
    branch: null,
    status: "submitted",
  });
  store.setMemberStatus(member.id, ["pending"], "submitted", {
    taskId: "t-missing-ref",
    selectedAttemptId: store.listAttempts(run.id)[0]!.id,
  });
  const attempt = store.listAttempts(run.id)[0]!;
  const artifact = store.recordArtifact({
    runId: run.id,
    attemptId: attempt.id,
    kind: "commit",
    formatVersion: 1,
    attempt: 1,
    status: "ready",
    locator: { snapshotSha: "a".repeat(40) },
    digest: "b".repeat(40),
    metadata: {},
    operationKey: `capture:${attempt.id}:1`,
    readyAt: 1,
  });
  const adapters = stubAdapters();
  adapters.commit = { ...adapters.commit!, async verify() { return false; } };
  const engine = new EnsembleEngine({ store, tasks: new FakeGateway(), publish: () => {}, adapters });
  await engine.recover(run.id);
  assert.equal(store.listArtifacts(run.id).find((row) => row.id === artifact.id)!.status, "failed");
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

test("cancelRun also cancels submitted members whose Tasks are still live", async () => {
  const { store, gateway, engine } = makeEngine();
  const { run } = store.createRun(runInsert(singleWavePlan(2)));
  await engine.launch(run.id);
  const taskId = gateway.dispatched[0]!.taskId;
  gateway.running(taskId, `/wt/${taskId}`);
  await engine.wake(run.id);
  const memberId = store.listAttempts(run.id).find((attempt) => attempt.taskId === taskId)!.memberId;
  await engine.submit({ runId: run.id, memberId, claims: CLAIMS, source: "mcp", requireWorktree: `/wt/${taskId}` });
  const artifactId = store.listArtifacts(run.id).find((artifact) => artifact.status === "ready")!.id;
  assert.equal(await engine.cancelRun(run.id, "stop"), true);
  assert.ok(gateway.cancelled.includes(taskId));
  assert.equal(store.listArtifacts(run.id).find((artifact) => artifact.id === artifactId)!.status, "ready");
});

test("a Task cancellation failure leaves the run recoverable instead of falsely cancelled", async () => {
  const { store, gateway, engine } = makeEngine();
  const { run } = store.createRun(runInsert(singleWavePlan(2)));
  await engine.launch(run.id);
  const taskId = gateway.dispatched[0]!.taskId;
  gateway.failCancel(taskId);
  assert.equal(await engine.cancelRun(run.id, "stop"), false);
  assert.equal(store.getRun(run.id)!.status, "cancelling");
  assert.notEqual(store.getMember(store.listAttempts(run.id).find((attempt) => attempt.taskId === taskId)!.memberId)!.status, "withdrawn");
  gateway.cancelFailures.delete(taskId);
  await engine.recover(run.id);
  assert.equal(store.getRun(run.id)!.status, "cancelled");
});

test("an unreadable run can still cancel its linked member Tasks", async () => {
  const { store, gateway, engine } = makeEngine();
  const { run } = store.createRun(runInsert(singleWavePlan(2)));
  await engine.launch(run.id);
  const persisted = run.plan!;
  persisted.stages[0]!.driverKey = "member_wave@99";
  db.prepare(`UPDATE ensemble_runs SET compiled_plan_json = ? WHERE id = ?`).run(JSON.stringify(persisted), run.id);
  assert.ok(store.getRun(run.id)!.unreadable);
  assert.equal(await engine.cancelRun(run.id, "version skew"), true);
  assert.equal(store.getRun(run.id)!.status, "cancelled");
  assert.equal(gateway.cancelled.length, 2);
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

test("restoreArtifact refuses a historical path no longer owned by the member Task", async () => {
  const first = makeEngine();
  const { run } = first.store.createRun(runInsert(singleWavePlan(2)));
  await first.engine.launch(run.id);
  const task = first.gateway.dispatched[0]!.taskId;
  first.gateway.running(task, `/wt/${task}`);
  await first.engine.wake(run.id);
  const memberId = first.store.listAttempts(run.id).find((attempt) => attempt.taskId === task)!.memberId;
  await first.engine.submit({ runId: run.id, memberId, claims: CLAIMS, source: "mcp", requireWorktree: `/wt/${task}` });
  const artifact = first.store.listArtifacts(run.id).find((row) => row.status === "ready")!;
  const reused = new FakeGateway();
  reused.running(task, "/wt/reused");
  const engine = new EnsembleEngine({ store: first.store, tasks: reused, publish: () => {}, adapters: stubAdapters() });
  const result = await engine.restoreArtifact(run.id, artifact.id);
  assert.equal(result.ok, false);
  assert.match(result.detail ?? "", /no live worktree/);
});
