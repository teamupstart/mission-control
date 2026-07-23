import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmRunner } from "../src/shared/llm.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type {
  PublishedWorkflowGraph,
  WorkflowContextSnapshot,
  WorkflowEdgeReceipt,
} from "../src/shared/workflow.ts";

const home = mkdtempSync(join(tmpdir(), "mission-workflow-recovery-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { openDb } = await import("../src/server/db.ts");
const { WorkflowStore, workflowJson } = await import("../src/server/workflows/store.ts");
const { WorkflowEngine } = await import("../src/server/workflows/engine.ts");

const snapshot = {
  sourcePersonaId: "p",
  sourceRevision: 1,
  name: "Reviewer",
  description: "",
  guidanceMarkdown: "Review the work.",
  runner: "claude" as const,
  model: "fake",
};
const graph: PublishedWorkflowGraph = {
  nodes: [
    { id: "session", kind: "session", position: { x: 0, y: 0 } },
    { id: "p", kind: "persona", persona: snapshot, position: { x: 100, y: 0 } },
    { id: "end", kind: "end", outcome: "Complete", position: { x: 200, y: 0 } },
  ],
  edges: [
    { id: "s-p", source: "session", sourcePort: "submitted", target: "p", targetPort: "activate" },
    { id: "p-pass", source: "p", sourcePort: "pass", target: "end", targetPort: "terminal" },
    { id: "p-fail", source: "p", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
  ],
};
const context: WorkflowContextSnapshot = {
  primaryGoal: { rawPrompt: "recover safely", refined: null, sourceNoteKey: "note" },
  humanDecisions: [],
  constraints: [],
  acceptanceCriteria: [],
  priorPersonaFeedback: [],
  session: { agent: "claude", name: "work", cwd: "/repo", branch: "feature" },
  evidence: {
    headSha: "abc",
    diffFingerprint: "diff",
    diff: "",
    diffTruncated: false,
    workingTreeDirty: false,
    workingTreeStatus: [],
    workingTreeStatusTruncated: false,
    transcript: [],
    transcriptAnchor: null,
    transcriptTruncated: false,
    standards: [],
    standardsTruncated: false,
  },
  compaction: { status: "fallback", runner: null, model: null, error: null },
};

function seed(): InstanceType<typeof WorkflowStore> {
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
     ) VALUES ('v', 'w', 1, 1, ?, '{"kind":"none"}', ?, 1)`,
  ).run(JSON.stringify(graph), defaults);
  const store = new WorkflowStore();
  const binding = store.insertBinding({
    id: "b",
    workflowVersionId: "v",
    noteKey: "note",
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
  store.createInitialSubmission(
    { id: "run", binding, triggerKey: "manual:b:req", now: 2 },
    { id: "sub", triggerKey: "manual:b:req", context: {}, evidence: {}, now: 2 },
  );
  store.updateSubmissionCapture("sub", {
    context: workflowJson(context),
    evidence: workflowJson(context.evidence),
    fingerprint: "fingerprint",
    status: "running",
  }, 3);
  store.setRunState("run", "running", "persona_review", null, 3);
  store.insertAttempt({
    id: "interrupted",
    submissionId: "sub",
    nodeId: "p",
    attempt: 1,
    state: "queued",
    persona: snapshot,
    inputFingerprint: "fingerprint:p",
    now: 3,
  });
  store.claimAttempt("interrupted", "claude", "fake", 4);
  store.insertLlmCall({
    id: "call",
    runId: "run",
    submissionId: "sub",
    nodeAttemptId: "interrupted",
    purpose: "persona_review",
    runner: "claude",
    model: "fake",
    attempt: 1,
    state: "running",
    startedAt: 4,
    finishedAt: null,
    durationMs: null,
    inputBytes: 10,
    outputBytes: 0,
    costUsd: null,
    errorCode: null,
  });
  return store;
}

async function waitFor(check: () => boolean): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 3_000) throw new Error("timed out waiting for recovery");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("restart interrupts fresh calls, retries safely, and never duplicates receipts", async () => {
  const store = seed();
  const fake: LlmRunner = {
    id: "claude",
    label: "fake",
    runInThread: null,
    sandbox: null,
    litter: null,
    killLiveRuns() {},
    async run(_prompt, options) {
      assert.equal(options?.grant, undefined);
      return JSON.stringify({
        verdict: "pass",
        summary: "approved",
        approvalDetails: { reason: "safe", evidence: [] },
        confidence: 1,
      });
    },
  };
  const engine = new WorkflowEngine(store, () => {}, {
    runnerFor: () => fake,
    resolveExecution: () => ({
      runner: { id: "claude", source: "config", unknown: null },
      model: { id: "fake", source: "config" },
    }),
    retryBaseMs: 1,
  });
  engine.start();
  await waitFor(() => store.getRun("run")?.status === "completed");
  await engine.stop();
  assert.equal(store.getAttempt("interrupted")?.state, "error");
  assert.equal(store.attemptForNode("sub", "p", 2)?.state, "completed");
  const call = openDb().prepare(`SELECT state, error_code FROM workflow_llm_calls WHERE id = 'call'`).get() as {
    state: string;
    error_code: string;
  };
  assert.equal(call.state, "interrupted");
  assert.equal(call.error_code, "daemon_restart");
  assert.equal(
    store.listReceipts("sub").filter((receipt: WorkflowEdgeReceipt) => receipt.edgeId === "p-pass").length,
    1,
  );
});

test("a missing immutable version fails visibly instead of reading the current draft", async () => {
  const store = new WorkflowStore();
  openDb().prepare(`UPDATE workflow_runs SET workflow_version_id = 'missing', status = 'running' WHERE id = 'run'`).run();
  const engine = new WorkflowEngine(store);
  engine.start();
  await engine.stop();
  assert.equal(store.getRun("run")?.status, "failed");
  assert.equal(store.getRun("run")?.currentPhase, "missing_workflow_version");
  assert.equal(store.runDetail("run")?.version, null);
});

test("manager startup preserves prepared packets and makes every surviving send uncertain before engine recovery", async () => {
  const { Registry } = await import("../src/server/registry.ts");
  const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
  const store = new WorkflowStore();
  const binding = store.insertBinding({
    id: "delivery-recovery-binding",
    workflowVersionId: "v",
    noteKey: "delivery-recovery-session",
    sessionId: "delivery-recovery-session",
    sessionAgent: "claude",
    sessionName: "work",
    sessionCwd: "/repo",
    sessionRepoRoot: "/repo",
    triggerMode: "manual",
    deliveryMode: "preview",
    maxRepairRounds: 5,
    now: 20,
  });
  store.createInitialSubmission(
    { id: "delivery-recovery-run", binding, triggerKey: "manual:delivery-recovery", now: 21 },
    { id: "delivery-recovery-sub", triggerKey: "manual:delivery-recovery", context: {}, evidence: {}, now: 21 },
  );
  const prepared = store.prepareDelivery({
    id: "delivery-prepared",
    runId: "delivery-recovery-run",
    submissionId: "delivery-recovery-sub",
    kind: "persona_feedback",
    sessionId: "delivery-recovery-session",
    noteKey: "delivery-recovery-session",
    payload: "safe to resume",
    payloadSha256: "b".repeat(64),
  }).delivery;
  const sending = store.prepareDelivery({
    id: "delivery-sending",
    runId: "delivery-recovery-run",
    submissionId: "delivery-recovery-sub",
    kind: "persona_feedback",
    sessionId: "delivery-recovery-session",
    noteKey: "delivery-recovery-session",
    payload: "outcome unknown",
    payloadSha256: "c".repeat(64),
  }).delivery;
  store.claimDeliverySend(sending.id);
  const registry = new Registry();
  registry.applyDiscovery([{
    syntheticId: "delivery-recovery-session",
    agent: "claude",
    name: "work",
    nameSource: "process",
    cwd: "/repo",
    gitBranch: "feature",
    gitRoot: "/repo",
    repoRoot: "/repo",
    nomistakesGated: false,
    pid: 92,
    tty: "tty-delivery-recovery",
    terminals: [],
    startedAt: 1,
  } as DiscoveredSession]);
  const manager = new WorkflowManager(registry, store);
  manager.start();
  assert.equal(store.getDelivery(prepared.id)?.state, "prepared");
  assert.equal(store.getDelivery(sending.id)?.state, "uncertain");
  assert.equal(store.getRun("delivery-recovery-run")?.currentPhase, "delivery_uncertain");
  await manager.stop();
});
