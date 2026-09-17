import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const home = mkdtempSync(join(tmpdir(), "mission-analytics-"));
process.env.MISSION_HOME = home;
const { openDb, closeDb } = await import("../src/server/db.ts");
const { setTelemetryConfig } = await import("../src/server/telemetry/config.ts");
const { captureTelemetry } = await import("../src/server/telemetry/capture.ts");
const { runProjectionPass } = await import("../src/server/telemetry/projection.ts");
const { registerBuiltinTelemetry } = await import("../src/server/telemetry/service.ts");
const { getProjectionState, listSeries, recordGap, resetUsedBytesCache } = await import("../src/server/telemetry/store.ts");
const { TELEMETRY_EVENTS } = await import("../src/shared/telemetry-catalog.ts");
const { analyticalGoldenFixture, analyticalEvent, ANALYTICAL_DAY: DAY } = await import("./helpers/analytical-telemetry.ts");
const { ANALYTICAL_PROJECTION } = await import("../src/server/telemetry/projections/index.ts");
type Envelope = import("../src/shared/telemetry.ts").TelemetryEnvelope;
type Payload = import("../src/server/telemetry/projection.ts").MetricsBatchPayload;
const NOW = 1_800_000_000_000;
registerBuiltinTelemetry();
beforeEach(() => {
  for (const { name } of openDb().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'telemetry_%'").all() as Array<{ name: string }>) openDb().exec(`DELETE FROM ${name}`);
  openDb().exec("DELETE FROM app_config");
  resetUsedBytesCache();
});
after(() => { closeDb(); rmSync(home, { recursive: true, force: true }); });
function enable(now = NOW - 15 * DAY) {
  assert.equal(setTelemetryConfig({ enabled: true, user: { enabled: true, endpoint: "http://127.0.0.1:14318" } }, now).ok, true);
  runProjectionPass(now);
}
function capture(event: Envelope) {
  return captureTelemetry({ event: TELEMETRY_EVENTS[event.name]!, source: { kind: "mission.analytics.fixture", id: event.eventId, revision: 1 },
    actor: event.actor, facts: event.facts, refs: event.refs, occurredAt: event.occurredAt, now: event.observedAt });
}
function read(view: string, field: string, profile: "local" | "user" | "product" = "user") {
  return listSeries(openDb(), profile).find((s) => s.instrument === `mission.analytics.v1.${view}.${field}` && s.dimensions.slice_by === "all")?.value;
}
function batches(): Array<{ id: string; digest: string; payload_json: string }> {
  return openDb().prepare("SELECT id, digest, payload_json FROM telemetry_batches WHERE profile='user' AND signal='metrics' AND created_at=? ORDER BY id").all(NOW) as Array<{ id: string; digest: string; payload_json: string }>;
}
test("capture, checkpoint, state and output are atomic; restart/replay preserves one coherent oracle", () => {
  enable();
  for (const event of analyticalGoldenFixture(NOW)) assert.equal(capture(event).kind, "accepted");
  const before = getProjectionState(openDb(), ANALYTICAL_PROJECTION.id, "local");
  openDb().exec(`CREATE TRIGGER refuse_analytics_state BEFORE UPDATE ON telemetry_projection_state
    WHEN NEW.projection='mission.analytics.v1' BEGIN SELECT RAISE(FAIL, 'fixture interruption'); END`);
  assert.throws(() => runProjectionPass(NOW), /fixture interruption/);
  assert.deepEqual(getProjectionState(openDb(), ANALYTICAL_PROJECTION.id, "local"), before);
  assert.equal(batches().length, 0);
  openDb().exec("DROP TRIGGER refuse_analytics_state");
  closeDb(); openDb(); runProjectionPass(NOW);
  assert.equal(read("runs", "eligible"), 6); assert.equal(read("runs", "human_free"), 1);
  assert.equal(read("reviews", "executed"), 8);
  const queued = batches();
  assert.ok(queued.length > 0);
  const points = queued.flatMap((row) => (JSON.parse(row.payload_json) as Payload).metrics).filter((p) => p.name.startsWith("mission.analytics.v1."));
  assert.ok(points.length > 100);
  assert.ok(points.every((p) => p.endTimeMs === NOW && p.kind === "gauge"));
  assert.ok(points.filter((p) => p.name.endsWith(".calculated_at")).every((p) => p.value === NOW / 1000));
  assert.ok(!JSON.stringify(points).includes("R1"));
  closeDb(); openDb();
  for (const event of analyticalGoldenFixture(NOW)) assert.equal(capture(event).kind, "duplicate");
  runProjectionPass(NOW);
  assert.deepEqual(batches(), queued);
  assert.equal(read("reviews", "executed"), 8);
});
test("idle passes mature and expire populations, publish actual zeros, and surface storage gaps", () => {
  enable();
  const start = NOW - DAY;
  assert.equal(capture(analyticalEvent("workflow.run", "idle", start, {}, { run_id: "idle" })).kind, "accepted");
  runProjectionPass(NOW);
  assert.equal(read("runs", "eligible"), 0); assert.equal(read("runs", "immature"), 1);
  runProjectionPass(NOW + 7 * DAY);
  assert.equal(read("runs", "eligible"), 1); assert.equal(read("runs", "pending"), 1);
  recordGap(openDb(), "unknown_gap", "fixture capture gap", NOW + 7 * DAY + 1);
  runProjectionPass(NOW + 7 * DAY + 30_000);
  assert.equal(read("runs", "complete"), 0);
  runProjectionPass(NOW + 40 * DAY);
  assert.equal(read("runs", "eligible"), 0);
  const state = getProjectionState(openDb(), ANALYTICAL_PROJECTION.id, "user")!.state as { facts: object };
  assert.deepEqual(state.facts, {});
});
test("a product opt-in cannot inherit local/user history and withdrawal removes only its state", () => {
  enable();
  for (const event of analyticalGoldenFixture(NOW)) capture(event);
  runProjectionPass(NOW);
  assert.equal(setTelemetryConfig({ product: { enabled: true, endpoint: "http://127.0.0.1:14318" } }, NOW).ok, true);
  runProjectionPass(NOW + 30_000);
  assert.equal(read("runs", "eligible", "product"), 0);
  assert.equal(read("runs", "eligible", "user"), 6);
  assert.equal(setTelemetryConfig({ product: { enabled: false } }, NOW + 31_000).ok, true);
  assert.equal(getProjectionState(openDb(), ANALYTICAL_PROJECTION.id, "product"), null);
  assert.equal(read("runs", "eligible", "user"), 6);
});
test("a multi-page journal exports no intermediate analytical calculation", () => {
  enable();
  for (let i = 0; i < 300; i++) capture(analyticalEvent("workflow.run", `page-${i}`, NOW - 10 * DAY, {}, { run_id: `page-${i}` }));
  runProjectionPass(NOW);
  assert.equal(read("runs", "eligible"), 0, "the previous complete snapshot stays until the prefix is drained");
  runProjectionPass(NOW);
  assert.equal(read("runs", "eligible"), 300);
});

test("the real Phase 4 repair fixture feeds analytical reviews and confirmed recovery", async (t) => {
  const { runWorkflowGoldenFixture } = await import("./helpers/workflow-telemetry.ts");
  const start = NOW - 10 * DAY;
  const wall = performance.now();
  t.mock.method(Date, "now", () => start + Math.floor(performance.now() - wall));
  enable();
  await runWorkflowGoldenFixture("analytical-source", true);
  runProjectionPass(NOW);
  assert.equal(read("reviews", "executed"), 3);
  assert.equal(read("reviews", "invalid"), 1);
  assert.equal(read("reviews", "reused"), 1);
  assert.equal(read("runs", "with_recovery"), 1);
  assert.equal(read("runs", "automation_eligible"), 1);
  assert.equal(read("runs", "human_free"), 0);
});

test("authored human-gate eligibility is frozen at creation across binding changes and restart", async (t) => {
  t.mock.method(Date, "now", () => NOW - 10 * DAY);
  enable();
  const { seedTelemetryWorkflow } = await import("./helpers/workflow-telemetry.ts");
  const { store, run } = seedTelemetryWorkflow("analytical-gate");
  store.updateBinding(run.bindingId, { deliveryMode: "live" });
  store.setRunState(run.id, "waiting_for_session", "persona_feedback");
  closeDb(); openDb(); runProjectionPass(NOW);
  assert.equal(read("runs", "human_gate"), 1);
  assert.equal(read("runs", "automation_eligible"), 0);
  const rows = openDb().prepare("SELECT facts_json FROM telemetry_journal WHERE name='mission.workflow.run'").all();
  assert.ok(rows.length >= 2);
  assert.ok(rows.every((row) => JSON.parse(String(row.facts_json)).automation_eligibility === "human_gate"));
});

test("Phase 3 ownership-removal and late-merge facts revise cohorts without operational authority", (t) => {
  const start = NOW - 10 * DAY;
  t.mock.method(Date, "now", () => start);
  enable();
  const task = "analytical-late-task", session = "analytical-late-session";
  const url = "https://github.com/fixture/analytical-only/pull/1";
  openDb().prepare(`INSERT INTO tasks (id, title, intent, repo_root, agent, kind, status, session_id, created_at, updated_at)
    VALUES (?, 'fixture', 'fixture', '/fixture', 'claude', 'ship', 'running', ?, ?, ?)`).run(task, session, start, start);
  capture(analyticalEvent("dispatch.finished", "late-dispatch", start, {}, { task_id: task, session_id: session }));
  capture(analyticalEvent("session.ended", "late-ended", start + 1, {}, { task_id: task, session_id: session }));
  return import("../src/server/db.ts").then(async ({ bindTaskWorkEpisode, invalidateTaskWorkEpisodeBindings, taskWorkEpisodeForTask, historicalTaskWorkEpisodeBindings }) => {
    const { retainPrObservation, recordTelemetryPrMerges } = await import("../src/server/telemetry/pr-observations.ts");
    bindTaskWorkEpisode({ taskId: task, episodeId: "analytical-episode", sessionId: session, agentSessionId: "analytical-conversation",
      branch: "fixture", prUrl: url, prHeadSha: null, mergedAt: null, boundAt: start, updatedAt: start });
    assert.equal(retainPrObservation({ taskId: task, taskKind: "ship", repoRoot: "/fixture", primaryRepoRoot: "/fixture",
      prUrl: url, sessionId: session, creationVerified: true, now: start + 2 }).retained, true);
    invalidateTaskWorkEpisodeBindings(session);
    closeDb(); openDb(); runProjectionPass(NOW);
    assert.equal(read("tasks", "with_new_pr"), 1); assert.equal(read("tasks", "with_merged_pr"), 0);
    const status = openDb().prepare("SELECT status FROM tasks WHERE id=?").get(task)!.status;
    assert.equal(recordTelemetryPrMerges(new Map([[url, NOW + 30_000]]), () => false, NOW + 30_000), 1);
    runProjectionPass(NOW + 30_000);
    assert.equal(read("tasks", "with_merged_pr"), 1);
    assert.equal(read("prs", "merged"), 1); assert.equal(read("prs", "merged_within_horizon"), 0);
    assert.equal(recordTelemetryPrMerges(new Map([[url, NOW + 30_000]]), () => false, NOW + 60_000), 0);
    runProjectionPass(NOW + 60_000);
    assert.equal(read("prs", "merged"), 1);
    assert.equal(openDb().prepare("SELECT status FROM tasks WHERE id=?").get(task)!.status, status);
    assert.equal(taskWorkEpisodeForTask(task), null);
    assert.equal(historicalTaskWorkEpisodeBindings().length, 0);
    assert.equal(openDb().prepare("SELECT count(*) AS n FROM telemetry_journal WHERE name='mission.session.ended'").get()!.n, 1);
  });
});
