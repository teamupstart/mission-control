import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InspectionUpdated, InspectorPr } from "../src/shared/types.ts";
import type { WorkflowInspectorGateState } from "../src/shared/workflow.ts";

// What is at stake: workflows must wake from Inspector's existing expensive poll cycle.
// A second timer would race the durable ledger and double GitHub/reviewer traffic.
const home = mkdtempSync(join(tmpdir(), "mission-workflow-inspector-update-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const {
  adoptInspectorPr,
  openDb,
  updateInspectorPr,
} = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { setInspectorConfig } = await import("../src/server/inspector/config.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const { WorkflowStore } = await import("../src/server/workflows/store.ts");

const db = openDb();
const key = "owner/repo#31";
const url = "https://github.com/owner/repo/pull/31";
const adopted: InspectorPr = {
  key,
  url,
  owner: "owner",
  repo: "repo",
  number: 31,
  repoRoot: "/repo",
  cwd: "/repo",
  sessionId: "session",
  source: "hook",
  state: "open",
  headSha: null,
  reviewPosture: null,
  round: 0,
  lastReviewedAt: null,
  lastError: null,
  failCount: 0,
  lastFailKind: null,
  nextAttemptAt: null,
  lastAttemptSha: null,
  mergedAt: null,
  mergeBlock: null,
  adoptedAt: 1,
  updatedAt: 1,
};
adoptInspectorPr(adopted);

test("adoption, same-head observation, review completion, and failure emit current ledger state", () => {
  const registry = new Registry();
  const events: InspectionUpdated[] = [];
  const unsubscribe = registry.onInspectionUpdated((event) => events.push(event));

  registry.inspectionUpdated(key, null, null, 10);
  registry.inspectionUpdated(key, "head-a", "OPEN", 11);
  updateInspectorPr(key, {
    headSha: "head-a",
    lastAttemptSha: "head-a",
    reviewPosture: "live",
    round: 1,
    lastReviewedAt: 12,
  }, 12);
  registry.inspectionUpdated(key, "head-a", "OPEN", 12);
  updateInspectorPr(key, {
    lastAttemptSha: "head-b",
    lastError: "review provider failed",
    failCount: 1,
    nextAttemptAt: 99,
  }, 13);
  registry.inspectionUpdated(key, "head-b", "OPEN", 13);
  unsubscribe();

  assert.deepEqual(events.map((event) => event.observedHeadSha), [
    null,
    "head-a",
    "head-a",
    "head-b",
  ]);
  assert.equal(events[0]?.ledger.source, "hook");
  assert.equal(events[2]?.ledger.headSha, "head-a");
  assert.equal(events[2]?.ledger.round, 1);
  assert.equal(events[3]?.ledger.lastError, "review provider failed");
});

test("config changes wake gates without inventing a GitHub observation", () => {
  const registry = new Registry();
  const events: InspectionUpdated[] = [];
  const unsubscribe = registry.onInspectionUpdated((event) => events.push(event));
  registry.inspectorConfigChanged(40);
  unsubscribe();
  assert.equal(events.length, 1);
  assert.equal(events[0]?.observedHeadSha, null);
  assert.equal(events[0]?.observedState, null);
  assert.equal(events[0]?.observedAt, 40);
});

test("daemon restart clears observation freshness and waits for Inspector again", async () => {
  setInspectorConfig({ enabled: true, mode: "live", repoAllowlist: ["/repo"] });
  const policy = JSON.stringify({
    kind: "inspector",
    onFindings: "restart_workflow",
    missingPrAction: "wait",
  });
  const defaults = JSON.stringify({
    triggerMode: "manual",
    deliveryMode: "preview",
    maxRepairRounds: 2,
  });
  const graph = JSON.stringify({
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      { id: "end", kind: "end", outcome: "Complete", position: { x: 100, y: 0 } },
    ],
    edges: [],
  });
  db.prepare(
    `INSERT INTO workflow_definitions (
       id, name, normalized_name, description, draft_graph_json, completion_policy_json,
       binding_defaults_json, draft_revision, current_version_id, archived_at, created_at, updated_at
     ) VALUES ('update-w', 'Update', 'update', '', ?, ?, ?, 1, 'update-v', NULL, 1, 1)`,
  ).run(graph, policy, defaults);
  db.prepare(
    `INSERT INTO workflow_versions (
       id, workflow_id, version, source_draft_revision, graph_json,
       completion_policy_json, binding_defaults_json, published_at
     ) VALUES ('update-v', 'update-w', 1, 1, ?, ?, ?, 1)`,
  ).run(graph, policy, defaults);
  const store = new WorkflowStore(db);
  const binding = store.insertBinding({
    id: "update-b",
    workflowVersionId: "update-v",
    noteKey: "session",
    sessionId: "session",
    sessionAgent: "claude",
    sessionName: "work",
    sessionCwd: "/repo",
    sessionRepoRoot: "/repo",
    triggerMode: "manual",
    deliveryMode: "preview",
    maxRepairRounds: 2,
    now: 1,
  });
  store.createInitialSubmission(
    { id: "update-run", binding, triggerSource: "manual", triggerKey: "manual:update", now: 2 },
    {
      id: "update-sub",
      triggerSource: "manual",
      triggerKey: "manual:update",
      context: {},
      evidence: {},
      now: 2,
    },
  );
  const state: WorkflowInspectorGateState = {
    prKey: key,
    prUrl: url,
    targetHeadSha: "head-a",
    failedHeadSha: null,
    enteredAt: 2,
    lastObservedAt: 20,
    observedHeadSha: "head-a",
    reviewPosture: "live",
    waitReason: "review_pending",
    findingFingerprints: [],
  };
  store.setRunState("update-run", "waiting_for_inspector", "inspector_review", state as never, 20);
  const registry = new Registry();
  const manager = new WorkflowManager(registry, store);
  manager.start();
  const recovered = store.getRun("update-run")?.gateState as unknown as WorkflowInspectorGateState;
  assert.equal(recovered.lastObservedAt, null);
  assert.equal(recovered.observedHeadSha, null);
  assert.equal(recovered.waitReason, "awaiting_fresh_observation");
  await manager.stop();

  const waitingRepair: WorkflowInspectorGateState = {
    ...recovered,
    failedHeadSha: "head-a",
    lastObservedAt: 25,
    observedHeadSha: "head-a",
    waitReason: "findings",
    findingFingerprints: ["finding-a"],
  };
  store.setRunState(
    "update-run",
    "waiting_for_session",
    "inspector_findings",
    waitingRepair as never,
    25,
  );
  const repairRestart = new WorkflowManager(new Registry(), store);
  repairRestart.start();
  const stillWaiting = store.getRun("update-run")!;
  assert.equal(stillWaiting.status, "waiting_for_session");
  assert.equal(stillWaiting.currentPhase, "inspector_findings");
  assert.equal(
    (stillWaiting.gateState as unknown as WorkflowInspectorGateState).waitReason,
    "findings",
  );
  assert.equal(
    (stillWaiting.gateState as unknown as WorkflowInspectorGateState).lastObservedAt,
    null,
  );
  await repairRestart.stop();

  const refused: WorkflowInspectorGateState = {
    ...recovered,
    failedHeadSha: "head-a",
    lastObservedAt: 30,
    observedHeadSha: "head-a",
    waitReason: "head_mismatch",
  };
  store.setRunState(
    "update-run",
    "blocked",
    "inspector_same_head_refused",
    refused as never,
    30,
  );
  const restarted = new WorkflowManager(new Registry(), store);
  restarted.start();
  const stillBlocked = store.getRun("update-run")!;
  assert.equal(stillBlocked.status, "blocked");
  assert.equal(stillBlocked.currentPhase, "inspector_same_head_refused");
  assert.equal(
    (stillBlocked.gateState as unknown as WorkflowInspectorGateState).lastObservedAt,
    null,
  );
  await (restarted as unknown as {
    evaluateInspectorGate(id: string, observation: null): Promise<void>;
  }).evaluateInspectorGate("update-run", null);
  assert.equal(store.getRun("update-run")?.currentPhase, "inspector_same_head_refused");
  await restarted.stop();
});

test("three concurrent gate wakeups serialize on one run", async () => {
  const manager = new WorkflowManager(new Registry(), new WorkflowStore(db));
  let active = 0;
  let maximum = 0;
  const order: number[] = [];
  const lock = (manager as unknown as {
    withGateLock<T>(id: string, fn: () => Promise<T>): Promise<T>;
  }).withGateLock.bind(manager);
  await Promise.all([1, 2, 3].map((id) => lock("serialized-run", async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    order.push(id);
    active -= 1;
  })));
  assert.equal(maximum, 1);
  assert.deepEqual(order, [1, 2, 3]);
  await manager.stop();
});

test("workflow integration subscribes to Inspector and introduces no Inspector poller", () => {
  const manager = readFileSync(new URL("../src/server/workflows/manager.ts", import.meta.url), "utf8");
  assert.match(manager, /onInspectionUpdated/);
  assert.doesNotMatch(manager, /INSPECTOR_POLL_MS|fetchPr|gh pr/);
  assert.match(manager, /setInterval\([\s\S]*sweepRetention/);
  const index = readFileSync(new URL("../src/server/index.ts", import.meta.url), "utf8");
  assert.match(index, /startInspector\(registry,\s*\{[\s\S]*workflowGatePending/);
  const routes = readFileSync(new URL("../src/server/routes.ts", import.meta.url), "utf8");
  for (const action of ["prepare-pr", "recheck-inspector", "restart-full"]) {
    assert.match(
      routes,
      new RegExp(`workflow-runs/:id/${action.replace("-", "\\-")}[\\s\\S]{0,300}parseBody`),
      `${action} must use the shared body parser`,
    );
  }
});
