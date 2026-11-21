// A best-of-N run is one piece of work: the real engine chooses which member Tasks a new member,
// a retried member and the winner's replacement inherit their work unit from, and the production
// gateway and finalizer write those Tasks through the real TaskManager. The engine's process
// state stays on the fakes, so no agent launches.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import type { MemberTaskRequest, ReplacementTaskRequest } from "../src/server/ensembles/engine.ts";

const home = mkdtempSync(join(tmpdir(), "mission-work-unit-ensembles-"));
process.env.HARNESS_HOME = join(home, "state");

const db = await import("../src/server/db.ts");
const { EnsembleStore, clearEnsembleTables } = await import("../src/server/ensembles/store.ts");
const { EnsembleEngine } = await import("../src/server/ensembles/engine.ts");
const { TaskManagerGateway } = await import("../src/server/ensembles/member-launch.ts");
const { createFinalizeDeps } = await import("../src/server/ensembles/finalize-deps.ts");
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { isWorkUnitId } = await import("../src/shared/work-unit.ts");
const { FakeGateway, FakeFinalize, stubAdapters, singleWavePlan, decidePlan, runInsert } = await import("./ensemble-fixture.ts");

const sqlite = db.openDb();
after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => clearEnsembleTables(sqlite));

/** Real Task rows behind the engine's fakes: every member and replacement is a stored Task. */
function harness(finalizeSafeIdle = true) {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  (tasks as unknown as { dispatcher: { dispatch(id: string): Promise<void> } }).dispatcher = {
    dispatch: async () => {},
  };
  const production = new TaskManagerGateway(tasks, registry);
  class StoringGateway extends FakeGateway {
    override create(request: MemberTaskRequest): void {
      production.create(request);
      super.create(request);
    }
  }
  const productionFinalize = createFinalizeDeps({ registry, tasks, workflows: {} as never });
  class StoringFinalize extends FakeFinalize {
    override async materializeReplacement(request: ReplacementTaskRequest) {
      const stored = await productionFinalize.materializeReplacement(request);
      assert.equal(stored.ok, true, JSON.stringify(stored));
      return super.materializeReplacement(request);
    }
  }
  const finalize = new StoringFinalize();
  finalize.safeIdle = finalizeSafeIdle;
  const gateway = new StoringGateway();
  const store = new EnsembleStore(sqlite);
  const engine = new EnsembleEngine({
    store, tasks: gateway, publish: () => {}, adapters: stubAdapters(), finalize,
    now: () => 1000, armTimer: () => () => {},
  });
  return { store, gateway, finalize, engine };
}

const storedWorkUnit = (taskId: string) => db.getTask(taskId)?.workUnitId ?? null;

test("a wave's members and a retried member share the work unit the first member minted", async () => {
  const { store, gateway, engine } = harness();
  const { run } = store.createRun(runInsert(singleWavePlan(2, { maxMembers: 3 })));
  await engine.launch(run.id);
  const [first, second] = gateway.created;
  assert.ok(first && second);
  const unit = storedWorkUnit(first.taskId);
  assert.ok(isWorkUnitId(unit), "the first member Task minted one");
  assert.ok(second.workUnitFrom.includes(first.taskId), "the engine names the first member to the second");
  assert.equal(storedWorkUnit(second.taskId), unit);

  // Member one fails and is retried: a new attempt and a new Task.
  const failed = first.taskId;
  const memberId = store.listAttempts(run.id).find((a) => a.taskId === failed)!.memberId;
  gateway.fail(failed);
  await engine.wake(run.id);
  gateway.vanish(failed);
  assert.equal(await engine.retryMember(run.id, memberId), true);
  const retry = gateway.created.at(-1)!;
  assert.notEqual(retry.taskId, failed);
  assert.equal(retry.workUnitFrom.includes(retry.taskId), false, "a retry never names itself");
  assert.deepEqual([...retry.workUnitFrom].sort(), [first.taskId, second.taskId].sort(),
    "the retry names every earlier member Task of the run, the failed attempt included");
  assert.equal(storedWorkUnit(retry.taskId), unit, "the retried member keeps the run's work unit");
});

test("the winner's replacement names the winner first and keeps the run's work unit", async () => {
  const { store, gateway, finalize, engine } = harness(false); // not safe-idle: the replacement path
  const { run } = store.createRun(runInsert(decidePlan(3, 2)));
  await engine.launch(run.id);
  // A snapshot: the loop's own wakes may dispatch more.
  for (const dispatch of gateway.dispatched.slice()) {
    gateway.running(dispatch.taskId, `/wt/${dispatch.taskId}`);
    await engine.wake(run.id);
    const memberId = store.listAttempts(run.id).find((a) => a.taskId === dispatch.taskId)!.memberId;
    await engine.submit({ runId: run.id, memberId, claims: { summary: "done", checks: [], testEvidence: null }, source: "mcp", requireWorktree: null });
  }
  const members = gateway.created.map((request) => request.taskId);
  const unit = storedWorkUnit(members[0]!);
  assert.ok(isWorkUnitId(unit));
  for (const taskId of members) assert.equal(storedWorkUnit(taskId), unit, taskId);

  // Select the second candidate, so "winner first" is not the same as "first created".
  const winner = store.listMembers(run.id).find((m) => m.ordinal === 2)!;
  const winnerAttempt = store.listAttempts(run.id).find((a) => a.memberId === winner.id)!;
  const artifact = store.listArtifacts(run.id).find((a) => a.status === "ready" && a.kind === "commit" && a.attemptId === winnerAttempt.id)!;
  const decided = await engine.decide({
    runId: run.id, requestId: "req-1", expectedStatus: "awaiting_decision",
    selection: { kind: "selected", artifactId: artifact.id }, rationale: "it is the better one", actorId: null,
  });
  assert.equal(decided.ok, true);

  assert.equal(finalize.materialized.length, 1);
  const replacement = finalize.materialized[0]!;
  assert.equal(replacement.workUnitFrom[0], winnerAttempt.taskId, "the winner is named first");
  assert.deepEqual([...replacement.workUnitFrom].sort(), [...members].sort());
  assert.equal(replacement.workUnitFrom.includes(replacement.taskId), false);
  assert.ok(db.getTask(replacement.taskId), "the replacement Task was stored");
  assert.equal(storedWorkUnit(replacement.taskId), unit, "the replacement keeps the run's work unit");
});
