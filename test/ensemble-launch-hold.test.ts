import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemberDispatchRequest } from "../src/server/ensembles/engine.ts";

/**
 * What is at stake: Pause all with launches held, or a priority session, promises the operator
 * that nothing new starts on the machine until they say so. An ensemble launched before the hold
 * keeps wanting agents - a member a freed slot opens, the replacement Task a finished comparison
 * starts for its winner - and each of those is the engine launching on its own, not the person
 * who launched the run. Those wait the hold out, pending rather than failed, and go when it lifts.
 * Only the person's own Launch and their own Retry go through it.
 */

const home = mkdtempSync(join(tmpdir(), "mission-ensemble-hold-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { EnsembleStore, clearEnsembleTables } = await import("../src/server/ensembles/store.ts");
const { EnsembleEngine, MemberLaunchHeldError } = await import("../src/server/ensembles/engine.ts");
const { EnsembleManager } = await import("../src/server/ensembles/manager.ts");
const { TaskManagerGateway } = await import("../src/server/ensembles/member-launch.ts");
const { createFinalizeDeps } = await import("../src/server/ensembles/finalize-deps.ts");
const { Registry } = await import("../src/server/registry.ts");
const { EMPTY_PAUSE_STATE } = await import("../src/shared/pause.ts");
const { FakeGateway, FakeFinalize, stubAdapters, singleWavePlan, decidePlan, runInsert, gitRepo } = await import(
  "./ensemble-fixture.ts"
);

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => clearEnsembleTables(db));

const HOLD = "everything is paused - automatic launches are held until you resume";

function harness(options: { finalize?: InstanceType<typeof FakeFinalize>; gateway?: InstanceType<typeof FakeGateway> } = {}) {
  const store = new EnsembleStore(db);
  const gateway = options.gateway ?? new FakeGateway();
  const hold = { reason: null as string | null };
  const engine = new EnsembleEngine({
    store,
    tasks: gateway,
    publish: () => {},
    adapters: stubAdapters(),
    finalize: options.finalize,
    now: () => 1000,
    armTimer: () => () => {},
    launchHold: () => hold.reason,
  });
  return { store, gateway, engine, hold };
}

function memberOf(store: InstanceType<typeof EnsembleStore>, runId: string, taskId: string): string {
  return store.listAttempts(runId).find((a) => a.taskId === taskId)!.memberId;
}

async function settle(
  engine: InstanceType<typeof EnsembleEngine>,
  gateway: InstanceType<typeof FakeGateway>,
  store: InstanceType<typeof EnsembleStore>,
  runId: string,
  taskId: string,
) {
  gateway.running(taskId, `/wt/${taskId}`);
  await engine.wake(runId);
  await engine.submit({
    runId,
    memberId: memberOf(store, runId, taskId),
    claims: { summary: "done", checks: [], testEvidence: null },
    source: "mcp",
    requireWorktree: null,
  });
}

test("the operator's own Launch goes through the hold, and a member a freed slot opens waits it out", async () => {
  const { store, gateway, engine, hold } = harness();
  const { run } = store.createRun(runInsert(singleWavePlan(2, { maxConcurrentMembers: 1 })));
  hold.reason = HOLD;

  await engine.launch(run.id, { byOperator: true });
  assert.equal(gateway.dispatched.length, 1, "the person's Launch started its first member");
  assert.equal(gateway.dispatched[0]!.overridePauseHold, true, "and claimed the pause override for it");

  // The first member settles, which frees the slot for the second: the engine's own launch.
  await settle(engine, gateway, store, run.id, gateway.dispatched[0]!.taskId);
  assert.equal(gateway.dispatched.length, 1, "nothing new launched while the hold stands");
  const waiting = store.listMembers(run.id).find((m) => m.ordinal === 2)!;
  assert.equal(waiting.status, "launching", "the second member is waiting, not failed");
  const waitingAttempt = store.listAttempts(run.id).find((a) => a.memberId === waiting.id)!;
  assert.equal(waitingAttempt.status, "pending", "its attempt was never dispatched");
  assert.notEqual(store.getRun(run.id)!.status, "failed");

  hold.reason = null;
  await engine.wake(run.id);
  assert.equal(gateway.dispatched.length, 2, "the hold lifted, so the second member launches");
  assert.equal(gateway.dispatched[1]!.overridePauseHold, undefined, "with no override claim of its own");
});

test("a launch that is not the operator's own holds even the first wave", async () => {
  const { store, gateway, engine, hold } = harness();
  const { run } = store.createRun(runInsert(singleWavePlan(2)));
  hold.reason = HOLD;
  await engine.launch(run.id);
  assert.equal(gateway.dispatched.length, 0);
  assert.ok(store.listAttempts(run.id).every((a) => a.status === "pending"));
  assert.ok(store.listMembers(run.id).every((m) => m.status === "launching"));

  hold.reason = null;
  await engine.wake(run.id);
  assert.equal(gateway.dispatched.length, 2);
});

test("the operator's own Retry claims the pause override", async () => {
  const { store, gateway, engine, hold } = harness();
  const { run } = store.createRun(runInsert(singleWavePlan(2, { maxMembers: 3 })));
  await engine.launch(run.id, { byOperator: true });
  const failed = gateway.dispatched[0]!.taskId;
  const memberId = memberOf(store, run.id, failed);
  gateway.fail(failed);
  await engine.wake(run.id);
  gateway.vanish(failed);

  hold.reason = HOLD;
  assert.equal(await engine.retryMember(run.id, memberId), true);
  const retried = gateway.dispatched.at(-1)!;
  assert.notEqual(retried.taskId, failed, "a fresh attempt was dispatched");
  assert.equal(retried.overridePauseHold, true, "a person's Retry is their own launch");
});

test("a member launch refused because the hold began meanwhile goes back to pending, not failed", async () => {
  class HoldsMidDispatch extends FakeGateway {
    hold: { reason: string | null } | null = null;
    override async dispatch(request: MemberDispatchRequest): Promise<void> {
      // TaskManager read the hold after the engine did, and the operator paused in between.
      this.hold!.reason = HOLD;
      throw new MemberLaunchHeldError(HOLD);
    }
  }
  const gateway = new HoldsMidDispatch();
  const { store, engine, hold } = harness({ gateway });
  gateway.hold = hold;
  const { run } = store.createRun(runInsert(singleWavePlan(1)));
  await engine.launch(run.id);
  // The rejection is handled off the launch's own promise.
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  await engine.wake(run.id);

  const [member] = store.listMembers(run.id);
  const [attempt] = store.listAttempts(run.id);
  assert.equal(attempt!.status, "pending", "back to pending, to launch when the hold lifts");
  assert.equal(member!.status, "launching", "the member did not fail");
  assert.notEqual(store.getRun(run.id)!.status, "failed");
});

test("a launch refused for the hold is still kept, and launched, when the hold lifted before the refusal was handled", async () => {
  // TaskManager refused for the hold; by the time the rejection runs, the operator has resumed and
  // the wake that lift sent has come and gone. Asking the hold again would read null and fail the
  // member for good. The refusal itself says it was the hold.
  class RefusedOnce extends FakeGateway {
    refusals = 0;
    override async dispatch(request: MemberDispatchRequest): Promise<void> {
      if (this.refusals === 0) {
        this.refusals += 1;
        throw new MemberLaunchHeldError(HOLD);
      }
      return super.dispatch(request);
    }
  }
  const gateway = new RefusedOnce();
  const { store, engine, hold } = harness({ gateway });
  assert.equal(hold.reason, null, "the engine's own check never sees the hold");
  const { run } = store.createRun(runInsert(singleWavePlan(1)));
  await engine.launch(run.id);
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));

  const [member] = store.listMembers(run.id);
  assert.notEqual(member!.status, "failed", "a hold is a wait, not a failure");
  assert.equal(gateway.refusals, 1);
  assert.equal(gateway.dispatched.length, 1, "relaunched by the rejection's own wake, the hold being gone");
  assert.notEqual(store.getRun(run.id)!.status, "failed");
});

test("a launch refused for any other reason still fails the member", async () => {
  const gateway = new FakeGateway();
  gateway.failAllDispatches();
  const { store, engine, hold } = harness({ gateway });
  hold.reason = null;
  const { run } = store.createRun(runInsert(singleWavePlan(1)));
  await engine.launch(run.id);
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  const [member] = store.listMembers(run.id);
  assert.equal(member!.status, "failed");
});

test("the winner's replacement task waits out the hold, the run stays finalizing, and it starts when the hold lifts", async () => {
  const finalize = new FakeFinalize();
  finalize.safeIdle = false; // force the replacement path
  const { store, gateway, engine, hold } = harness({ finalize });
  const { run } = store.createRun(runInsert(decidePlan(2, 2)));
  await engine.launch(run.id, { byOperator: true });
  for (const dispatch of gateway.dispatched.slice()) await settle(engine, gateway, store, run.id, dispatch.taskId);
  assert.equal(store.getRun(run.id)!.status, "awaiting_decision");

  hold.reason = HOLD;
  const winnerMember = store.listMembers(run.id).find((m) => m.ordinal === 1)!;
  const winnerAttempts = new Set(store.listAttempts(run.id).filter((a) => a.memberId === winnerMember.id).map((a) => a.id));
  const artifact = store
    .listArtifacts(run.id)
    .find((a) => a.status === "ready" && a.kind === "commit" && a.attemptId !== null && winnerAttempts.has(a.attemptId))!;
  await engine.decide({
    runId: run.id,
    requestId: "req-hold",
    expectedStatus: "awaiting_decision",
    selection: { kind: "selected", artifactId: artifact.id },
    rationale: "it is the better one",
    actorId: null,
  });
  assert.equal(finalize.materialized.length, 0, "no replacement task was started while the hold stands");
  const parked = store.getRun(run.id)!;
  assert.equal(parked.status, "finalizing", "parked, not failed");
  assert.match(parked.error ?? "", /starts when the launch hold lifts/);

  hold.reason = null;
  await engine.wake(run.id);
  assert.equal(finalize.materialized.length, 1, "the hold lifted, so the replacement starts");
  assert.equal(store.getRun(run.id)!.status, "completed");
});

test("a replacement launch refused for a hold that already lifted is re-driven, not left finalizing", async () => {
  // TaskManager saw a hold the engine's check did not, and the hold lifted before the run parked:
  // the lift's wake has already passed, so the refusal itself has to re-drive the step.
  class HeldOnce extends FakeFinalize {
    refusals = 0;
    override async materializeReplacement(request: Parameters<InstanceType<typeof FakeFinalize>["materializeReplacement"]>[0]) {
      if (this.refusals === 0) {
        this.refusals += 1;
        return { ok: false as const, detail: HOLD, launchHeld: true as const };
      }
      return super.materializeReplacement(request);
    }
  }
  const finalize = new HeldOnce();
  finalize.safeIdle = false;
  const { store, gateway, engine } = harness({ finalize });
  const { run } = store.createRun(runInsert(decidePlan(2, 2)));
  await engine.launch(run.id, { byOperator: true });
  for (const dispatch of gateway.dispatched.slice()) await settle(engine, gateway, store, run.id, dispatch.taskId);
  const winnerMember = store.listMembers(run.id).find((m) => m.ordinal === 1)!;
  const winnerAttempts = new Set(store.listAttempts(run.id).filter((a) => a.memberId === winnerMember.id).map((a) => a.id));
  const artifact = store
    .listArtifacts(run.id)
    .find((a) => a.status === "ready" && a.kind === "commit" && a.attemptId !== null && winnerAttempts.has(a.attemptId))!;
  await engine.decide({
    runId: run.id,
    requestId: "req-held-once",
    expectedStatus: "awaiting_decision",
    selection: { kind: "selected", artifactId: artifact.id },
    rationale: "it is the better one",
    actorId: null,
  });
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finalize.refusals, 1);
  assert.equal(finalize.materialized.length, 1, "the refusal's own wake started the replacement");
  assert.equal(store.getRun(run.id)!.status, "completed");
});

test("the manager wakes a run left waiting the moment the hold lifts, and not while it stands", async () => {
  const registry = new Registry();
  const store = new EnsembleStore(db);
  const gateway = new FakeGateway();
  const hold = { reason: HOLD as string | null };
  new EnsembleManager(registry, store, {
    tasks: gateway,
    adapters: stubAdapters(),
    launchHold: () => hold.reason,
  });
  store.createRun(runInsert(singleWavePlan(2)));
  const fleet = { since: 1, resumeAt: null, holdDispatch: true };

  registry.setPauseState({ fleet, priority: null });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gateway.dispatched.length, 0, "a pause_state while the hold stands wakes nothing");

  hold.reason = null;
  registry.setPauseState(EMPTY_PAUSE_STATE);
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gateway.dispatched.length, 2, "lifting the hold woke the waiting run, which launched");
});

test("the operator's create launches its first wave through a standing hold", async () => {
  const { path } = gitRepo();
  const gateway = new FakeGateway();
  const manager = new EnsembleManager(new Registry(), new EnsembleStore(db), {
    tasks: gateway,
    adapters: stubAdapters(),
    agentBinPresent: async () => true,
    missionMcpAvailable: async () => true,
    launchHold: () => HOLD,
  });
  const outcome = await manager.createAndLaunch({
    sourceKey: "hold-create",
    title: "Held create",
    intent: "implement the feature",
    repoRoot: path,
    strategyId: "best_of_n",
    strategyConfig: { members: [{}, {}] },
  });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(gateway.dispatched.length, 2);
  assert.ok(gateway.dispatched.every((d) => d.overridePauseHold === true), "the person's own launch claims the override");
});

test("the real gateway claims the pause override only when the request does", async () => {
  const seen: Array<boolean | undefined> = [];
  const fakeTasks = {
    async dispatch(_taskId: string, opts: { overridePauseHold?: boolean }) {
      seen.push(opts.overridePauseHold);
      return { ok: true as const };
    },
  };
  const gateway = new TaskManagerGateway(fakeTasks as never, { getTask: () => undefined } as never);
  await gateway.dispatch({ taskId: "t1", baseSha: "a".repeat(40), model: null, effort: null });
  await gateway.dispatch({ taskId: "t2", baseSha: "a".repeat(40), model: null, effort: null, overridePauseHold: true });
  assert.deepEqual(seen, [false, true]);
});

test("the real gateway reports a launch-hold refusal as one, and any other refusal as a failure", async () => {
  const outcomes = [
    { ok: false as const, error: HOLD, launchHeld: true as const },
    { ok: false as const, error: "no such task" },
  ];
  const fakeTasks = { dispatch: async () => outcomes.shift()! };
  const gateway = new TaskManagerGateway(fakeTasks as never, { getTask: () => undefined } as never);
  const request = { taskId: "t1", baseSha: "a".repeat(40), model: null, effort: null };
  await assert.rejects(gateway.dispatch(request), (err: unknown) => err instanceof MemberLaunchHeldError);
  await assert.rejects(gateway.dispatch(request), (err: unknown) => err instanceof Error && !(err instanceof MemberLaunchHeldError));
});

test("the finalizer's replacement dispatch claims no pause override", async () => {
  const seen: Array<boolean | undefined> = [];
  const fakeTasks = {
    create() {},
    async dispatch(_taskId: string, opts: { overridePauseHold?: boolean }) {
      seen.push(opts.overridePauseHold);
      return { ok: false as const, error: HOLD };
    },
  };
  const fakeRegistry = { getTask: () => ({ id: "r1", status: "backlog" }) };
  const deps = createFinalizeDeps({ registry: fakeRegistry as never, tasks: fakeTasks as never, workflows: {} as never });
  const result = await deps.materializeReplacement({
    taskId: "r1",
    runId: "run-1",
    repoRoot: "/repo",
    title: "selected result",
    intent: "continue",
    agent: "claude",
    model: null,
    effort: null,
    snapshotSha: "a".repeat(40),
  });
  assert.deepEqual(seen, [undefined], "no override claimed");
  assert.deepEqual(result, { ok: false, detail: HOLD }, "a held refusal parks finalization rather than launching");
});
