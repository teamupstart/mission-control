import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * What is at stake: the public backend API is the surface the dashboard drives, and it must expose
 * only behavior the daemon can execute safely. Every mutating route goes through `parseBody`, ids
 * in the URL select records but never bypass current-state checks, a decision names the state it
 * expects, and deletion demands the run id echoed back. These tests hit the real routes through
 * `buildApp` and assert the status codes and body-parsing contracts that the UI (Phase 7) relies on.
 */

const home = mkdtempSync(join(tmpdir(), "mission-ensemble-http-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { EnsembleManager } = await import("../src/server/ensembles/manager.ts");
const { EnsembleStore, clearEnsembleTables } = await import("../src/server/ensembles/store.ts");
const { EnsembleEngine } = await import("../src/server/ensembles/engine.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { FakeGateway, FakeFinalize, stubAdapters, decidePlan, runInsert } = await import("./ensemble-fixture.ts");

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => clearEnsembleTables(db));

function req(app: ReturnType<typeof buildApp>, path: string, body?: unknown, method = "POST") {
  return app.request(path, {
    method,
    headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function build() {
  const registry = new Registry();
  const store = new EnsembleStore(db);
  const gateway = new FakeGateway();
  const finalize = new FakeFinalize();
  const manager = new EnsembleManager(registry, store, { tasks: gateway, finalize, adapters: stubAdapters() });
  const app = buildApp(registry, new ReviewManager(registry), new TaskManager(registry), new QueueManager(registry), undefined, undefined, undefined, undefined, manager);
  // A separate engine on the SAME store/gateway/finalize drives a run to awaiting_decision without
  // needing the manager's private launch path or a real repository.
  const driver = new EnsembleEngine({ store, tasks: gateway, publish: () => {}, adapters: stubAdapters(), finalize, now: () => 1000, armTimer: () => () => {} });
  return { registry, store, gateway, finalize, manager, app, driver };
}

async function driveToDecision(store: InstanceType<typeof EnsembleStore>, gateway: InstanceType<typeof FakeGateway>, driver: InstanceType<typeof EnsembleEngine>) {
  const { run } = store.createRun(runInsert(decidePlan(3, 2)));
  await driver.launch(run.id);
  for (const dispatch of [...gateway.dispatched]) {
    gateway.running(dispatch.taskId, `/wt/${dispatch.taskId}`);
    await driver.wake(run.id);
    const memberId = store.listAttempts(run.id).find((a) => a.taskId === dispatch.taskId)!.memberId;
    await driver.submit({ runId: run.id, memberId, claims: { summary: "did it", checks: [], testEvidence: null }, source: "mcp", requireWorktree: null });
  }
  return run.id;
}

test("GET /api/ensembles lists compact summaries and filters by status", async () => {
  const { store, app } = build();
  store.createRun(runInsert(decidePlan(2, 2), { sourceKey: "a", status: "running" }));
  store.createRun(runInsert(decidePlan(2, 2), { sourceKey: "b", status: "planning" }));
  const all = await req(app, "/api/ensembles", undefined, "GET");
  assert.equal(all.status, 200);
  const body = (await all.json()) as { ensembles: unknown[]; total: number };
  assert.equal(body.total, 2);
  const running = await req(app, "/api/ensembles?status=running", undefined, "GET");
  const filtered = (await running.json()) as { ensembles: Array<{ status: string }>; total: number };
  assert.equal(filtered.total, 1);
  assert.equal(filtered.ensembles[0]!.status, "running");
});

test("POST /api/ensembles/preview validates a draft side-effect-free and never persists", async () => {
  const { store, app } = build();
  const ok = await req(app, "/api/ensembles/preview", {
    sourceKey: "p1",
    title: "Try it",
    intent: "implement the feature",
    repoRoot: "/repo",
    strategyId: "best_of_n",
    strategyConfig: { members: [{}, {}, {}] },
  });
  assert.equal(ok.status, 200);
  const okBody = (await ok.json()) as { ok: boolean; estimate: { initialMembers: number } | null };
  assert.equal(okBody.ok, true);
  assert.equal(okBody.estimate?.initialMembers, 3);
  // A draft below the roster minimum is a 200 carrying its own validation issues, not a refusal.
  const bad = await req(app, "/api/ensembles/preview", {
    sourceKey: "p2",
    title: "Too few",
    intent: "x",
    repoRoot: "/repo",
    strategyId: "best_of_n",
    strategyConfig: { members: [{}] },
  });
  assert.equal(bad.status, 200);
  const badBody = (await bad.json()) as { ok: boolean; issues: unknown[] };
  assert.equal(badBody.ok, false);
  assert.ok(badBody.issues.length > 0);
  // Preview persisted nothing.
  assert.equal(store.listRuns().length, 0);
});

test("POST /api/ensembles refuses an invalid config with a 400 and launches nothing", async () => {
  const { store, gateway, app } = build();
  const res = await req(app, "/api/ensembles", {
    sourceKey: "c1",
    title: "Bad",
    intent: "x",
    repoRoot: "/repo",
    strategyId: "best_of_n",
    strategyConfig: { members: [{}] },
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { code: string };
  assert.match(body.code, /ensemble_create_/);
  assert.equal(store.listRuns().length, 0, "an invalid create persisted no run");
  assert.equal(gateway.dispatched.length, 0, "and launched nothing");
});

test("POST /api/ensembles refuses a mismatched source-key replay with a 409", async () => {
  const { manager, app } = build();
  const request = {
    sourceKey: "create-conflict",
    title: "Original",
    intent: "original intent",
    repoRoot: "/repo",
    strategyId: "best_of_n" as const,
    strategyConfig: { members: [{}, {}] },
  };
  const created = manager.create(request, 100);
  assert.equal(created.ok, true);

  const conflict = await req(app, "/api/ensembles", {
    ...request,
    intent: "different intent",
    workflow: { workflowId: "unsupported-workflow", workflowVersion: 1 },
  });
  assert.equal(conflict.status, 409);
  const body = (await conflict.json()) as { code: string };
  assert.equal(body.code, "ensemble_create_request_conflict");
});

test("POST /api/ensembles/:id/actions decides through the manager and reaches completed", async () => {
  const { store, gateway, driver, app } = build();
  const runId = await driveToDecision(store, gateway, driver);
  const member = store.listMembers(runId).find((m) => m.ordinal === 1)!;
  const attemptIds = new Set(store.listAttempts(runId).filter((a) => a.memberId === member.id).map((a) => a.id));
  const artifactId = store.listArtifacts(runId).find((a) => a.status === "ready" && a.attemptId !== null && attemptIds.has(a.attemptId))!.id;

  // A missing destructive confirmation is rejected at the schema boundary before any effect.
  const noConfirm = await req(app, `/api/ensembles/${runId}/actions`, { kind: "decide", requestId: "r1", expectedStatus: "awaiting_decision", selection: { kind: "selected", artifactId } });
  assert.equal(noConfirm.status, 400);

  const decided = await req(app, `/api/ensembles/${runId}/actions`, { kind: "decide", requestId: "r1", expectedStatus: "awaiting_decision", selection: { kind: "selected", artifactId }, confirmDestructive: true, rationale: "ship it" });
  assert.equal(decided.status, 200);
  assert.equal(store.getRun(runId)!.status, "completed");

  // A conflicting current-state check: deciding again in the wrong expected state is a 409.
  const conflict = await req(app, `/api/ensembles/${runId}/actions`, { kind: "decide", requestId: "r2", expectedStatus: "awaiting_decision", selection: { kind: "selected", artifactId }, confirmDestructive: true });
  assert.equal(conflict.status, 409);
});

test("DELETE /api/ensembles/:id demands the id echoed and a terminal run", async () => {
  const { store, registry, manager, app } = build();
  const events: string[] = [];
  registry.subscribe((e) => { if (e.type === "ensemble_remove") events.push(e.id); });
  const running = store.createRun(runInsert(decidePlan(2, 2), { sourceKey: "d1", status: "running" })).run;
  manager.publish(running.id);

  // Wrong confirmation id: refused.
  const mismatch = await req(app, `/api/ensembles/${running.id}`, { confirmId: "not-it" }, "DELETE");
  assert.equal(mismatch.status, 400);
  // A non-terminal run cannot be deleted: cancel it first.
  const live = await req(app, `/api/ensembles/${running.id}`, { confirmId: running.id }, "DELETE");
  assert.equal(live.status, 409);

  const done = store.createRun(runInsert(decidePlan(2, 2), { sourceKey: "d2", status: "completed" })).run;
  manager.publish(done.id);
  const deleted = await req(app, `/api/ensembles/${done.id}`, { confirmId: done.id }, "DELETE");
  assert.equal(deleted.status, 200);
  assert.equal(store.getRun(done.id), null, "the terminal run's rows are gone");
  assert.deepEqual(events, [done.id], "ensemble_remove was emitted");
});
