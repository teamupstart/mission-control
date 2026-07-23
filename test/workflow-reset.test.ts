import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";

const home = mkdtempSync(join(tmpdir(), "mission-workflow-reset-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { PersonaManager } = await import("../src/server/workflows/personas.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const { resetSession } = await import("../src/server/reset.ts");

function discovered(): DiscoveredSession {
  return {
    syntheticId: "session",
    agent: "claude",
    name: "work",
    nameSource: "process",
    cwd: "/repo",
    gitBranch: "feature",
    gitRoot: "/repo",
    repoRoot: "/repo",
    nomistakesGated: false,
    pid: 1,
    tty: "ttys1",
    terminals: [],
    startedAt: 1,
  } as DiscoveredSession;
}

function seedReusable(): void {
  const db = openDb();
  const defaults = JSON.stringify({ triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 });
  db.prepare(
    `INSERT INTO workflow_definitions (
       id, name, normalized_name, description, draft_graph_json, completion_policy_json,
       binding_defaults_json, draft_revision, current_version_id, archived_at, created_at, updated_at
     ) VALUES ('w', 'W', 'w', '', '{"nodes":[],"edges":[]}', '{"kind":"none"}', ?, 1, 'v', NULL, 1, 1)`,
  ).run(defaults);
  db.prepare(
    `INSERT INTO workflow_versions (
       id, workflow_id, version, source_draft_revision, graph_json,
       completion_policy_json, binding_defaults_json, published_at
     ) VALUES ('v', 'w', 1, 1, '{"nodes":[],"edges":[]}', '{"kind":"none"}', ?, 1)`,
  ).run(defaults);
}

test("successful reset uses resetSession to clear session workflow rows and preserve reusable definitions", async () => {
  seedReusable();
  const registry = new Registry();
  registry.applyDiscovery([discovered()]);
  const personas = new PersonaManager(registry);
  const workflows = new WorkflowManager(registry, personas.store);
  const binding = workflows.store.insertBinding({
    id: "b",
    workflowVersionId: "v",
    noteKey: "session",
    sessionId: "session",
    sessionAgent: "claude",
    sessionName: "work",
    sessionCwd: "/repo",
    sessionRepoRoot: "/repo",
    triggerMode: "manual",
    deliveryMode: "preview",
    maxRepairRounds: 5,
    now: 1,
  });
  workflows.store.createInitialSubmission(
    { id: "run", binding, triggerKey: "manual:b:req", now: 2 },
    { id: "sub", triggerKey: "manual:b:req", context: {}, evidence: {}, now: 2 },
  );
  workflows.store.insertAttempt({
    id: "attempt",
    submissionId: "sub",
    nodeId: "session",
    attempt: 1,
    state: "completed",
    persona: null,
    inputFingerprint: "input",
    now: 3,
  });
  workflows.store.addReceipt("sub", "edge", "attempt", { outcome: "submitted" }, 3);
  workflows.store.insertLlmCall({
    id: "call",
    runId: "run",
    submissionId: "sub",
    nodeAttemptId: null,
    purpose: "context_compaction",
    runner: "claude",
    model: "fake",
    attempt: 1,
    state: "failed",
    startedAt: 3,
    finishedAt: 4,
    durationMs: 1,
    inputBytes: 1,
    outputBytes: 0,
    costUsd: null,
    errorCode: "test",
  });
  openDb().prepare(
    `INSERT INTO workflow_deliveries (
       id, run_id, submission_id, kind, session_id, note_key, payload,
       payload_sha256, state, error, created_at, updated_at, delivered_at
     ) VALUES ('delivery', 'run', 'sub', 'persona_feedback', 'session', 'session',
       'preview', 'sha', 'prepared', NULL, 3, 3, NULL)`,
  ).run();
  workflows.store.appendEvent("run", "workflow_completion_claimed", {
    triggerKey: "foreman:b:drain:marker",
    completionKind: "drain",
  }, 3);
  const session = registry.getSession("session")!;
  await resetSession(registry, session, false, async () => ({
    ok: true,
    error: null,
    root: "/repo",
    cleared: false,
    detached: false,
    clean: true,
  }));
  const db = openDb();
  for (const table of [
    "workflow_bindings",
    "workflow_runs",
    "workflow_submissions",
    "workflow_node_attempts",
    "workflow_edge_receipts",
    "workflow_deliveries",
    "workflow_llm_calls",
    "workflow_events",
  ]) {
    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
      0,
      table,
    );
  }
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM workflow_definitions`).get() as { n: number }).n, 1);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM workflow_versions`).get() as { n: number }).n, 1);
});

test("failed reset clears no workflow state", async () => {
  const registry = new Registry();
  registry.applyDiscovery([discovered()]);
  const personas = new PersonaManager(registry);
  const workflows = new WorkflowManager(registry, personas.store);
  const binding = workflows.store.insertBinding({
    id: "failed-b",
    workflowVersionId: "v",
    noteKey: "session",
    sessionId: "session",
    sessionAgent: "claude",
    sessionName: "work",
    sessionCwd: "/repo",
    sessionRepoRoot: "/repo",
    triggerMode: "manual",
    deliveryMode: "preview",
    maxRepairRounds: 5,
    now: 3,
  });
  workflows.store.createInitialSubmission(
    { id: "failed-run", binding, triggerKey: "manual:failed-b:req", now: 4 },
    { id: "failed-sub", triggerKey: "manual:failed-b:req", context: {}, evidence: {}, now: 4 },
  );
  workflows.store.prepareDelivery({
    id: "failed-delivery",
    runId: "failed-run",
    submissionId: "failed-sub",
    kind: "persona_feedback",
    sessionId: "session",
    noteKey: "session",
    payload: "must survive failed reset",
    payloadSha256: "d".repeat(64),
  }, 4);
  workflows.store.appendEvent("failed-run", "workflow_completion_claimed", {
    triggerKey: "foreman:failed-b:drain:marker",
    completionKind: "drain",
  }, 4);
  await resetSession(registry, registry.getSession("session")!, false, async () => ({
    ok: false,
    error: "no",
    root: null,
    cleared: false,
    detached: false,
    clean: false,
  }));
  assert.equal(workflows.store.getBinding("failed-b")?.id, "failed-b");
  assert.equal(workflows.store.getDelivery("failed-delivery")?.state, "prepared");
  assert.equal(
    workflows.store.listEvents("failed-run").some((event) => event.kind === "workflow_completion_claimed"),
    true,
  );
});
