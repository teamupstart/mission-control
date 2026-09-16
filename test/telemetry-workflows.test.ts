import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const home = mkdtempSync(join(tmpdir(), "mission-workflow-telemetry-"));
process.env.MISSION_HOME = home;
const { openDb, closeDb } = await import("../src/server/db.ts");
const { setTelemetryConfig } = await import("../src/server/telemetry/config.ts");
const { registerBuiltinTelemetry } = await import("../src/server/telemetry/service.ts");
const { runProjectionPass } = await import("../src/server/telemetry/projection.ts");
const { listSeries, telemetryTransaction } = await import("../src/server/telemetry/store.ts");
const { runWorkflowGoldenFixture, seedTelemetryWorkflow, goldenWorkflowGraph } = await import("./helpers/workflow-telemetry.ts");
const { observeWorkflowWrite, observeWorkflowAttempt, observeWorkflowDelivery } = await import("../src/server/telemetry/workflows.ts");
const { recordWorkflowAction } = await import("../src/server/telemetry/workflow-actions.ts");
const { parsePersonaVerdict } = await import("../src/server/workflows/verdict.ts");
registerBuiltinTelemetry();
after(() => { closeDb(); rmSync(home, { recursive: true, force: true }); });
beforeEach(() => {
  closeDb(); rmSync(join(home, "harness.db"), { force: true });
  openDb();
  assert.equal(setTelemetryConfig({ enabled: true, user: { enabled: true, endpoint: "http://127.0.0.1:4318" },
    product: { enabled: true, endpoint: "http://127.0.0.1:4319" } }).ok, true);
  runProjectionPass();
});
function events(name: string, profile = "local") {
  return (openDb().prepare(`SELECT facts_json, refs_json, actor_json FROM telemetry_journal WHERE name = ? AND EXISTS (SELECT 1 FROM json_each(profiles_json) WHERE value = ?) ORDER BY seq`)
    .all(`mission.${name}`, profile) as { facts_json: string; refs_json: string; actor_json: string }[])
    .map((row) => ({ facts: JSON.parse(row.facts_json), refs: JSON.parse(row.refs_json), actor: JSON.parse(row.actor_json) }));
}
function total(name: string, dimension?: [string, string]) {
  return listSeries(openDb(), "local").filter((s) => s.instrument === `mission.${name}`
    && (!dimension || s.dimensions[dimension[0]] === dimension[1])).reduce((sum, s) => sum + (s.histogram?.count ?? s.value), 0);
}
function goldenTotals() {
  return { reviews: total("persona.verdicts"), passes: total("persona.verdicts", ["verdict", "pass"]),
    fails: total("persona.verdicts", ["verdict", "fail"]), calls: total("persona.executions"), invalid: total("persona.response.errors"),
    reused: total("workflow.nodes", ["disposition", "reused"]), packets: total("workflow.repair.packets"),
    rounds: total("workflow.repair.rounds"), recoveries: total("workflow.interventions", ["intent", "recovery"]) };
}
test("P3 golden: 3 reviews, 4 calls, one malformed response, one reused pass, packet, round and recovery survive restart/replay", async () => {
  const { store, runId, repairSubmissionId } = await runWorkflowGoldenFixture("golden");
  assert.equal(store.getRun(runId)?.status, "completed");
  const expected = { reviews: 3, passes: 2, fails: 1, calls: 4, invalid: 1, reused: 1, packets: 1, rounds: 1, recoveries: 1 };
  runProjectionPass();
  assert.deepEqual(goldenTotals(), expected);
  const count = events("workflow.review.finished").length;
  store.appendEvent(runId, "persona_verdict", { verdict: "pass", nodeId: "p1" });
  for (const attempt of store.listAttempts(repairSubmissionId)) observeWorkflowWrite(openDb(), (scope) => observeWorkflowAttempt(scope, store, attempt.id, Date.now()));
  closeDb(); openDb(); runProjectionPass(); runProjectionPass();
  assert.deepEqual(goldenTotals(), expected);
  assert.equal(events("workflow.review.finished").length, count);
  assert.equal(events("workflow.finding")[0]?.facts.category, "test_coverage");
  assert.equal(events("workflow.repair.cause").length, 1);
  const stages = events("workflow.stage").filter((e) => e.facts.observation === "settled");
  assert.equal(stages.length, 2);
  assert.ok(stages.every((e) => e.facts.duration_ms >= 0));
  assert.equal(events("workflow.submission").length, 2);
  assert.equal(total("workflow.started"), 1);
  assert.equal(total("workflow.finished"), 1);
  assert.ok(events("workflow.review.finished").every((e) => e.facts.reviewer_effort === "unknown"));
  const outbound = openDb().prepare("SELECT payload_json FROM telemetry_batches").all();
  const journal = openDb().prepare("SELECT facts_json, refs_json FROM telemetry_journal").all();
  assert.ok(!JSON.stringify([outbound, journal]).includes("PRIVATE_SENTINEL"));
  for (const profile of ["user", "product"] as const) {
    assert.equal(listSeries(openDb(), profile).filter((s) => s.instrument === "mission.persona.verdicts").reduce((sum, s) => sum + s.value, 0), 3);
  }
});
test("telemetry savepoints cannot roll back business writes and business rollback leaves no phantom observations", () => {
  const d = openDb();
  d.exec("CREATE TABLE transaction_probe (value TEXT)");
  d.exec("BEGIN IMMEDIATE"); d.prepare("INSERT INTO transaction_probe VALUES (?)").run("kept");
  observeWorkflowWrite(d, () => { d.prepare("INSERT INTO transaction_probe VALUES (?)").run("rolled-back"); throw new Error("simulated telemetry failure"); });
  d.exec("COMMIT");
  assert.deepEqual(d.prepare("SELECT value FROM transaction_probe").all().map((r) => r.value), ["kept"]);
  const before = events("workflow.submission").length;
  d.exec("BEGIN IMMEDIATE"); seedTelemetryWorkflow("rollback"); d.exec("ROLLBACK");
  assert.equal(events("workflow.submission").length, before);
  assert.equal(d.prepare("SELECT COUNT(*) AS n FROM telemetry_source_state").get()?.n, 0);
  telemetryTransaction(() => {});
});
test("registered workflow observer contains capture failure and records a gap without changing the write", () => {
  const d = openDb();
  d.exec(`CREATE TEMP TRIGGER refuse_workflow_capture BEFORE INSERT ON telemetry_journal
    WHEN NEW.source_kind = 'mission.workflow'
    BEGIN SELECT RAISE(ABORT, 'simulated observer storage failure'); END`);
  try {
    const { store, run, submission } = seedTelemetryWorkflow("observer-failure");
    assert.equal(store.getRun(run.id)?.status, run.status);
    assert.equal(store.getSubmission(submission.id)?.status, "running");
    assert.equal(events("workflow.submission").length, 0);
    assert.equal(d.prepare("SELECT COUNT(*) AS n FROM telemetry_source_state").get()?.n, 0);
    const gap = d.prepare("SELECT count, detail FROM telemetry_gaps WHERE kind = 'capture_refused'").get();
    assert.ok(gap && Number(gap.count) > 0);
    assert.equal(gap.detail, "workflow observation unavailable");
    assert.equal(d.isTransaction, false);
  } finally { d.exec("DROP TRIGGER refuse_workflow_capture"); }
});
test("invalid or absent general categories never invalidate a historically valid review", () => {
  for (const category of [undefined, "incorrect-new-category", 7, { raw: "PRIVATE_SENTINEL" }, "security"]) {
    const verdict = parsePersonaVerdict(JSON.stringify({ verdict: "fail", summary: "needs work", confidence: 1,
      requestedChanges: [{ category, title: "fix", rationale: "why", evidence: [{ kind: "goal", quote: "goal" }] }] }));
    assert.equal(verdict?.verdict, "fail");
    if (verdict?.verdict === "fail") assert.equal(verdict.requestedChanges[0]?.category,
      category === "security" ? "security" : category === undefined ? undefined : "unknown");
  }
});
test("uncertain packet resolution preserves one packet identity and ambiguous actors never count as human recovery", () => {
  const { store, run, submission } = seedTelemetryWorkflow("uncertain");
  store.setRunState(run.id, "waiting_for_session", "persona_feedback");
  const packet = store.prepareDelivery({ id: "packet", runId: run.id, submissionId: submission.id, kind: "persona_feedback",
    sessionId: "session-uncertain", noteKey: "uncertain", payload: "PRIVATE_SENTINEL", payloadSha256: "hash" });
  store.claimDeliverySend(packet.delivery.id);
  store.finishDeliverySend(packet.delivery.id, "uncertain", "PRIVATE_SENTINEL");
  runProjectionPass(); assert.equal(total("workflow.repair.packets"), 0);
  store.resolveUncertainDelivery(packet.delivery.id, "mark_delivered", "resolved");
  observeWorkflowWrite(openDb(), (scope) => observeWorkflowDelivery(scope, store, packet.delivery.id, Date.now()));
  const before = store.getRun(run.id)!;
  for (const kind of ["unknown", "foreman", "human"] as const) recordWorkflowAction({ action: "workflow.retry", before,
    operationId: kind, context: { operationId: null, surface: "unknown", actor: { kind, basis: "declared", origin: "mcp" } },
    startedAt: Date.now(), now: Date.now(), outcome: "applied" });
  runProjectionPass(); assert.equal(total("workflow.repair.packets"), 1); assert.equal(total("workflow.interventions"), 0);
});
test("cancelled late verdict is not an executed review, even when a persona is disabled after claim", () => {
  const { store, run, submission } = seedTelemetryWorkflow("late");
  const node = goldenWorkflowGraph.nodes.find((n) => n.kind === "persona")!;
  if (node.kind !== "persona") throw new Error("fixture persona missing");
  const a = store.insertAttempt({ id: "late-attempt", submissionId: submission.id, nodeId: node.id, attempt: 1,
    state: "queued", persona: node.persona, inputFingerprint: "input", now: Date.now() });
  store.claimAttempt(a.id, "claude", "fake-model");
  store.cancelRun(run.id, "cancelled");
  store.finishAttempt(a.id, { state: "cancelled", verdict: { verdict: "pass", summary: "ok", approvalDetails: { reason: "ok", evidence: [] }, confidence: 1 } });
  runProjectionPass(); assert.equal(total("persona.verdicts"), 0);
  assert.equal(events("workflow.node").filter((e) => e.facts.observation === "late_result").length, 1);
  assert.equal(total("workflow.nodes", ["disposition", "cancelled"]) >= 1, true);
});

test("parallel stage wall time uses its barrier, same-persona occurrences stay distinct, missing projection retains nodes", () => {
  const { store, run, submission } = seedTelemetryWorkflow("parallel");
  const now = Date.now();
  const nodes = goldenWorkflowGraph.nodes.filter((n) => n.kind === "persona");
  for (const [i, node] of nodes.entries()) {
    store.insertAttempt({ id: `p-${i}`, submissionId: submission.id, nodeId: node.id, attempt: 1,
      state: "queued", persona: nodes[0]!.persona, inputFingerprint: "input", now });
    store.claimAttempt(`p-${i}`, "claude", "fake-model", now + 10);
  }
  for (const i of [0, 1]) store.finishAttemptWithReceipts(`p-${i}`, {
    verdict: { verdict: "pass", summary: "ok", approvalDetails: { reason: "ok", evidence: [] }, confidence: 1 },
    output: { outcome: "pass" }, receipts: [],
  }, now + 100);
  store.insertAttempt({ id: "barrier", submissionId: submission.id, nodeId: "join", attempt: 1,
    state: "completed", persona: null, inputFingerprint: "join", now: now + 110 });
  const stage = events("workflow.stage").find((e) => e.facts.observation === "settled")!;
  assert.equal(stage.facts.duration_ms, 110);
  const reviews = events("workflow.review.finished");
  assert.equal(new Set(reviews.map((e) => e.refs.attempt_id)).size, 2);
  assert.equal(new Set(reviews.map((e) => e.refs.persona_id)).size, 1);
  const malformed = structuredClone(goldenWorkflowGraph);
  malformed.edges = [];
  openDb().prepare("UPDATE workflow_versions SET graph_json = ? WHERE id = ?").run(JSON.stringify(malformed), run.workflowVersionId);
  store.insertAttempt({ id: "unprojected", submissionId: submission.id, nodeId: nodes[0]!.id, attempt: 2,
    state: "queued", persona: nodes[0]!.persona, inputFingerprint: "input", now: now + 200 });
  assert.equal(events("workflow.node").find((e) => e.refs.attempt_id === "unprojected")?.facts.stage_projection, "unavailable");
});

test("disabled and reused synthetic verdicts never enter the executed review denominator", () => {
  const { store, submission } = seedTelemetryWorkflow("skip");
  const node = goldenWorkflowGraph.nodes.find((n) => n.kind === "persona")!;
  if (node.kind !== "persona") throw new Error("missing persona");
  for (const [index, output] of [{ outcome: "pass", disabled: true }, { outcome: "pass", reusedPassAttemptId: "earned-pass" }].entries()) {
    const id = `skipped-${index}`;
    store.insertAttempt({ id, submissionId: submission.id, nodeId: node.id, attempt: index + 1,
      state: "queued", persona: node.persona, inputFingerprint: "input", now: Date.now() });
    store.claimAttempt(id, null, null);
    store.finishAttemptWithReceipts(id, { verdict: { verdict: "pass", summary: "synthetic",
      approvalDetails: { reason: "synthetic", evidence: [] }, confidence: 1 }, output: JSON.parse(JSON.stringify(output)), receipts: [] });
  }
  runProjectionPass();
  assert.equal(total("persona.verdicts"), 0);
  assert.equal(total("persona.executions"), 0);
  assert.equal(total("workflow.nodes", ["disposition", "disabled"]), 1);
  assert.equal(total("workflow.nodes", ["disposition", "reused"]), 1);
});

test("author context freezes at submission and does not adopt later pending effort or restart defaults", async () => {
  const { attachSessionTelemetry, resetSessionTelemetryForTesting } = await import("../src/server/telemetry/sessions.ts");
  resetSessionTelemetryForTesting();
  let publish: (event: { type: string } & Record<string, unknown>) => void = () => {};
  const detach = attachSessionTelemetry({ subscribe(listener) { publish = listener; return () => {}; }, getTask: () => undefined });
  try {
    const base = { id: "session-author", agent: "claude", runtime: "sdk", state: "idle", terminals: [],
      agentSessionId: "conversation", pendingEffort: { level: "high" } };
    publish({ type: "session_upsert", session: { ...base, meta: { modelId: "claude-opus-5", thinkingLevel: "medium", nativeEffort: null, source: "driver" } } });
    const { store, submission } = seedTelemetryWorkflow("author");
    publish({ type: "session_upsert", session: { ...base, meta: { modelId: "new-default", thinkingLevel: "high", nativeEffort: null, source: "driver" } } });
    const node = goldenWorkflowGraph.nodes.find((n) => n.kind === "persona")!;
    if (node.kind !== "persona") throw new Error("missing persona");
    store.insertAttempt({ id: "attributed", submissionId: submission.id, nodeId: node.id, attempt: 1,
      state: "queued", persona: node.persona, inputFingerprint: "input", now: Date.now() });
    store.reattachBinding("b-author", { noteKey: "reattached", sessionId: "replacement-session", sessionAgent: "claude",
      sessionName: "replacement", sessionCwd: "/tmp", sessionRepoRoot: "/tmp" });
    closeDb(); openDb();
    const { WorkflowStore } = await import("../src/server/workflows/store.ts");
    new WorkflowStore().claimAttempt("attributed", "codex", "reviewer-override");
    const facts = events("workflow.node").findLast((e) => e.refs.attempt_id === "attributed")!.facts;
    assert.equal(facts.author_effort, "medium");
    assert.equal(facts.author_quality, "observed");
    assert.equal(facts.reviewer_model, "other");
    assert.notEqual(facts.author_model, "new-default");
    assert.equal(events("workflow.node").findLast((e) => e.refs.attempt_id === "attributed")!.refs.session_id, "session-author");
  } finally { detach(); resetSessionTelemetryForTesting(); }
});

for (const profile of ["user", "product"] as const) {
  test(`${profile} consent windows isolate author context without resetting other audiences`, async () => {
    const { attachSessionTelemetry, resetSessionTelemetryForTesting } = await import("../src/server/telemetry/sessions.ts");
    const { observeWorkflowAsset } = await import("../src/server/telemetry/workflows.ts");
    resetSessionTelemetryForTesting();
    let publish: (event: { type: string } & Record<string, unknown>) => void = () => {};
    const detach = attachSessionTelemetry({ subscribe(listener) { publish = listener; return () => {}; }, getTask: () => undefined });
    try {
      const id = `consent-${profile}`;
      publish({ type: "session_upsert", session: { id: `session-${id}`, agent: "claude", runtime: "sdk",
        state: "idle", terminals: [], agentSessionId: "conversation", meta: {
          modelId: "claude-opus-5", thinkingLevel: "medium", nativeEffort: null, source: "driver",
        } } });
      const seeded = seedTelemetryWorkflow(id);
      const { run, submission } = seeded;
      let { store } = seeded;
      const uninterrupted = profile === "user" ? "product" : "user";
      assert.equal(events("workflow.submission", profile)[0]?.facts.author_effort, "medium");
      setTelemetryConfig({ [profile]: { enabled: false } });
      store.setRunState(run.id, "waiting_for_session", "persona_feedback");
      assert.equal(events("workflow.run", profile).length, 1, "withdrawn audience captures nothing");
      const others = events("workflow.run", uninterrupted);
      const assets = events("workflow.asset", uninterrupted);
      setTelemetryConfig({ [profile]: { enabled: true } });
      closeDb(); openDb();
      const { WorkflowStore } = await import("../src/server/workflows/store.ts");
      store = new WorkflowStore();
      // A current observation after restart belongs to each audience's own window.
      store.appendEvent(run.id, "persona_verdict", {});
      observeWorkflowWrite(openDb(), (scope) => observeWorkflowAsset(scope, store, "binding", run.bindingId, Date.now()));
      assert.deepEqual(events("workflow.run", uninterrupted), others);
      assert.deepEqual(events("workflow.asset", uninterrupted), assets);
      const resumed = events("workflow.run", profile).at(-1)!;
      assert.equal(resumed.facts.status, "waiting_for_session");
      assert.equal(resumed.facts.author_quality, "unknown");
      assert.equal(resumed.facts.author_effort, "unknown");
      assert.equal(resumed.refs.session_id, undefined);
      assert.equal(resumed.facts.wait_ms, null);
      assert.equal(resumed.facts.time_quality, "unknown");
      assert.equal(events("workflow.run", uninterrupted).at(-1)?.facts.author_effort, "medium");
      assert.equal(events("workflow.asset", profile).length, 2);
      const packet = store.prepareDelivery({ id: `packet-${id}`, runId: run.id, submissionId: submission.id,
        kind: "persona_feedback", sessionId: `session-${id}`, noteKey: id, payload: "PRIVATE_SENTINEL", payloadSha256: "hash" });
      store.claimDeliverySend(packet.delivery.id);
      store.confirmDeliverySend(packet.delivery.id, null, true);
      store.cancelRun(run.id, "cancelled");
      runProjectionPass();
      for (const audience of ["local", "user", "product"] as const) {
        assert.equal(events("workflow.run", audience).filter((e) => e.facts.observation === "finished").length, 1);
        assert.equal(events("workflow.repair.delivery", audience).filter((e) => e.facts.state === "delivered").length, 1);
        assert.equal(listSeries(openDb(), audience).filter((s) => s.instrument === "mission.workflow.repair.packets")
          .reduce((sum, s) => sum + s.value, 0), 1);
      }
      // Replaying a permanent owner result in another consent window is still a duplicate.
      setTelemetryConfig({ [profile]: { enabled: false } });
      setTelemetryConfig({ [profile]: { enabled: true } });
      store.appendEvent(run.id, "run_cancelled", { deliveryId: packet.delivery.id });
      assert.equal(events("workflow.run", profile).filter((e) => e.facts.observation === "finished").length, 1);
      assert.equal(events("workflow.repair.delivery", profile).filter((e) => e.facts.state === "delivered").length, 1);
    } finally { detach(); resetSessionTelemetryForTesting(); }
  });
}

test("bounded projection state rolls back oversized state and collection withdrawal clears source checkpoints", async () => {
  const { putProjectionState, usedBytes } = await import("../src/server/telemetry/store.ts");
  const { TELEMETRY_LIMITS } = await import("../src/shared/telemetry.ts");
  assert.throws(() => telemetryTransaction((d) => putProjectionState(d, "mission.test", "local", {
    stateVersion: 1, consumedSeq: 1, state: "x".repeat(TELEMETRY_LIMITS.maxProjectionStateBytes),
  }, Date.now())), /exceeds its budget/);
  const priorBytes = usedBytes(openDb());
  telemetryTransaction((d) => putProjectionState(d, "mission.test", "local", {
    stateVersion: 1, consumedSeq: 1, state: "界",
  }, Date.now()));
  assert.equal(usedBytes(openDb()) - priorBytes, Buffer.byteLength(JSON.stringify("界")));
  const { store, run } = seedTelemetryWorkflow("withdraw");
  assert.ok(Number(openDb().prepare("SELECT COUNT(*) AS n FROM telemetry_source_state").get()?.n) > 0);
  setTelemetryConfig({ enabled: false });
  assert.equal(openDb().prepare("SELECT COUNT(*) AS n FROM telemetry_source_state").get()?.n, 0);
  const count = events("workflow.submission").length;
  seedTelemetryWorkflow("off");
  assert.equal(events("workflow.submission").length, count);
  setTelemetryConfig({ enabled: true });
  store.setRunState(run.id, "waiting_for_session", "persona_feedback");
  assert.equal(events("workflow.run").findLast((e) => e.refs.run_id === run.id)?.facts.status, "waiting_for_session");
  store.cancelRun(run.id, "operator cancelled");
  assert.equal(events("workflow.run").filter((e) => e.facts.observation === "finished").length, 1);
  setTelemetryConfig({ enabled: false });
  setTelemetryConfig({ enabled: true });
  store.appendEvent(run.id, "run_cancelled", {});
  assert.equal(events("workflow.run").filter((e) => e.facts.observation === "finished").length, 1);
});

test("manual/preview resubmit is a required decision, automatic-run resubmit is recovery, and directives stay steering", async () => {
  const { workflowActionCause } = await import("../src/server/telemetry/workflow-actions.ts");
  const { store, run } = seedTelemetryWorkflow("intent");
  const waiting = store.setRunState(run.id, "waiting_for_session", "persona_feedback");
  assert.equal(workflowActionCause("workflow.resubmit", waiting, false).intent, "required_decision");
  assert.equal(workflowActionCause("workflow.resubmit", waiting, true).intent, "recovery");
  assert.equal(workflowActionCause("workflow.resubmit", waiting).intent, "unknown");
  assert.equal(workflowActionCause("workflow.directive", waiting, true).intent, "optional_steering");
  assert.equal(workflowActionCause("workflow.cancel", waiting).intent, "termination");
});

for (const scenario of [
  { name: "refused response", status: 409, throws: false, outcome: "refused" },
  { name: "server-error response", status: 503, throws: false, outcome: "failed" },
  { name: "thrown route error", status: 500, throws: true, outcome: "failed" },
] as const) {
  test(`workflow action middleware records ${scenario.name} without changing the HTTP response`, async () => {
    const { Hono } = await import("hono");
    const { workflowActionTelemetry } = await import("../src/server/telemetry/workflow-actions.ts");
    const { OPERATION_ID_HEADER, OPERATION_ACTOR_HEADER, OPERATION_SURFACE_HEADER } =
      await import("../src/shared/telemetry-ingress.ts");
    const { store, run } = seedTelemetryWorkflow(`http-${scenario.status}`);
    const payload = { requestId: "owner-request-id", rationale: "PRIVATE_SENTINEL" };
    const createApp = (instrumented: boolean) => {
      const app = new Hono();
      if (instrumented) app.use("/api/*", workflowActionTelemetry(() => store));
      app.onError((_error, c) => {
        c.header("x-workflow-result", "error-handler");
        return c.json({ error: "PRIVATE_SENTINEL" }, 500);
      });
      app.post("/api/workflow-runs/:id/retry", async (c) => {
        assert.deepEqual(await c.req.json(), payload, "the route still receives its original body");
        if (scenario.throws) throw new Error("PRIVATE_SENTINEL");
        c.header("x-workflow-result", "route");
        return c.json({ error: "PRIVATE_SENTINEL" }, scenario.status);
      });
      return app;
    };
    const path = `/api/workflow-runs/${run.id}/retry`;
    const init = { method: "POST", body: JSON.stringify(payload), headers: {
      "content-type": "application/json", [OPERATION_ID_HEADER]: "routefailure123",
      [OPERATION_ACTOR_HEADER]: "human", [OPERATION_SURFACE_HEADER]: "runs",
    } };
    const baseline = await createApp(false).request(path, init);
    assert.equal(events("action.result").length, 0);
    const response = await createApp(true).request(path, init);
    assert.equal(response.status, scenario.status);
    assert.equal(response.status, baseline.status);
    assert.deepEqual([...response.headers], [...baseline.headers]);
    assert.equal(await response.text(), await baseline.text());
    const retry = await createApp(true).request(path, { ...init, headers: {
      ...init.headers, [OPERATION_ID_HEADER]: "newhttpattempt123",
    } });
    assert.equal(retry.status, scenario.status);
    const observations = events("action.result");
    assert.equal(observations.length, 1, "retries preserve one persisted outcome per owner requestId");
    const [observation] = observations;
    assert.ok(observation);
    assert.equal(observation.facts.action, "workflow.retry");
    assert.equal(observation.facts.outcome, scenario.outcome);
    assert.equal(observation.facts.coverage, "owner_result");
    assert.ok(observation.facts.duration_ms >= 0);
    assert.deepEqual(observation.actor, { kind: "human", origin: "dashboard", basis: "app_context" });
    assert.equal(observation.refs.run_id, run.id);
    assert.equal(observation.refs.operation_id, `${run.id}:owner-request-id`);
    assert.ok(!JSON.stringify(observations).includes("PRIVATE_SENTINEL"));
    assert.deepEqual(store.getRun(run.id), run, "observation cannot mutate workflow state");
    runProjectionPass();
    assert.equal(total("action.count", ["outcome", scenario.outcome]), 1);
    assert.equal(total("workflow.interventions"), 0, "an unsuccessful action is not a completed human intervention");
  });
}

test("malformed action bodies retain the route response and fall back to the HTTP operation identity", async () => {
  const { Hono } = await import("hono");
  const { workflowActionTelemetry } = await import("../src/server/telemetry/workflow-actions.ts");
  const { OPERATION_ID_HEADER } = await import("../src/shared/telemetry-ingress.ts");
  const app = new Hono();
  app.use("/api/*", workflowActionTelemetry(() => null));
  app.post("/api/workflow-runs/:id/retry", async (c) => {
    try { await c.req.json(); } catch { return c.json({ error: "invalid JSON" }, 400); }
    return c.json({ error: "unexpected valid body" }, 500);
  });
  const response = await app.request("/api/workflow-runs/malformed/retry", {
    method: "POST", body: "{", headers: { "content-type": "application/json", [OPERATION_ID_HEADER]: "malformedrequest123" },
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid JSON" });
  const [observation] = events("action.result");
  assert.equal(observation?.facts.outcome, "refused");
  assert.equal(observation?.refs.operation_id, "malformed:malformedrequest123");
});

test("multiple failing reviewers link to one packet, provider contract errors and interrupted calls are not rejections", () => {
  const { store, run, submission } = seedTelemetryWorkflow("causes");
  const nodes = goldenWorkflowGraph.nodes.filter((n) => n.kind === "persona");
  for (const [index, node] of nodes.entries()) {
    const id = `cause-${index}`;
    store.insertAttempt({ id, submissionId: submission.id, nodeId: node.id, attempt: 1,
      state: "queued", persona: node.persona, inputFingerprint: "input", now: Date.now() });
    store.claimAttempt(id, "claude", "fake-model");
    store.insertLlmCall({ id: `call-${index}`, runId: run.id, submissionId: submission.id, nodeAttemptId: id,
      purpose: "persona_review", runner: "claude", model: "fake-model", attempt: 1, state: "running",
      startedAt: Date.now(), finishedAt: null, durationMs: null, inputBytes: 0, outputBytes: 0, costUsd: null, errorCode: null });
    if (index === 0) {
      store.retainRejectedPersonaVerdict(id, 1, "contract", "PRIVATE_SENTINEL");
      store.finishLlmCall(`call-${index}`, "failed", 0, "persona_parse");
    } else store.interruptRunningLlmCalls(run.id);
    store.finishAttemptWithReceipts(id, { verdict: { verdict: "fail", summary: "repair", confidence: 1,
      requestedChanges: [{ title: "fix", rationale: "reason", category: "correctness", evidence: [{ kind: "goal", quote: "goal" }] }] },
      output: { outcome: "fail" }, receipts: [] });
  }
  store.setRunState(run.id, "waiting_for_session", "persona_feedback");
  store.prepareDelivery({ id: "combined", runId: run.id, submissionId: submission.id, kind: "persona_feedback",
    sessionId: "session-causes", noteKey: "causes", payload: "PRIVATE_SENTINEL", payloadSha256: "combined" });
  store.claimDeliverySend("combined"); store.confirmDeliverySend("combined", null, true);
  runProjectionPass();
  assert.equal(events("workflow.repair.cause").length, 2);
  assert.equal(total("workflow.repair.packets"), 1);
  assert.equal(total("persona.response.errors", ["validity", "contract_violation"]), 1);
  assert.equal(total("persona.responses", ["validity", "unavailable"]), 1);
});

test("proven session-action pickup and a continuation segment retain timing without spending a repair round", () => {
  const { store, submission } = seedTelemetryWorkflow("pickup");
  const now = Date.now();
  const state = { wait: "awaiting_pickup" as const, deliveryId: "picked-packet", anchor: {
    deliveryId: "picked-packet", sessionId: "session-pickup", noteKey: "pickup", deliveredAt: now, transcriptBytes: null,
  }, pickedUpAt: null, settledAt: null, expectation: null, continuationSubmissionId: null, blocked: null };
  store.insertAttempt({ id: "action-pickup", submissionId: submission.id, nodeId: "action", attempt: 1,
    state: "waiting", persona: null, inputFingerprint: "action", now,
    sessionAction: { sourceSessionActionId: "action", sourceRevision: 1, name: "PRIVATE_SENTINEL", description: "",
      promptMarkdown: "PRIVATE_SENTINEL", requiredSkillId: null, completion: { kind: "session_turn" } }, sessionActionState: state });
  store.updateSessionActionState("action-pickup", { ...state, wait: "working", pickedUpAt: now + 10 }, now + 10);
  const child = store.reserveSessionActionContinuation({ attemptId: "action-pickup", submissionId: "continued",
    triggerKey: "continue-pickup", now: now + 30 });
  assert.equal(child.ok, true);
  store.completeSessionActionContinuation({ attemptId: "action-pickup", submissionId: "continued", receipts: [], now: now + 40 });
  const progress = events("workflow.repair.progress");
  assert.deepEqual(progress.map((e) => [e.facts.observation, e.facts.duration_ms]), [["pickup", 10], ["resubmitted", 20]]);
  runProjectionPass(); assert.equal(total("workflow.repair.rounds"), 0);
  assert.deepEqual(events("workflow.submission").map((e) => e.facts.segment), [0, 1]);
});
