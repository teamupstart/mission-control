import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmRunner, LlmRunnerId } from "../src/shared/llm.ts";
import type {
  PersonaExecutionView,
  PublishedWorkflowGraph,
  WorkflowContextSnapshot,
} from "../src/shared/workflow.ts";

const home = mkdtempSync(join(tmpdir(), "mission-workflow-engine-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { openDb } = await import("../src/server/db.ts");
const { WorkflowStore, workflowJson } = await import("../src/server/workflows/store.ts");
const { WorkflowEngine } = await import("../src/server/workflows/engine.ts");

function persona(
  id: string,
  name: string,
  runner: LlmRunnerId,
  guidanceMarkdown: string,
) {
  return {
    sourcePersonaId: id,
    sourceRevision: 1,
    name,
    description: "",
    guidanceMarkdown,
    runner,
    model: "fake-model",
  };
}

const graph: PublishedWorkflowGraph = {
  nodes: [
    { id: "session", kind: "session", position: { x: 0, y: 0 } },
    { id: "p1", kind: "persona", persona: persona("p1", "Claude reviewer", "claude", "PASS_PERSONA"), position: { x: 200, y: 0 } },
    { id: "p2", kind: "persona", persona: persona("p2", "Codex reviewer", "codex", "FAIL_PERSONA"), position: { x: 200, y: 200 } },
    { id: "join", kind: "all_pass", position: { x: 450, y: 100 } },
    { id: "end", kind: "end", outcome: "Complete", position: { x: 700, y: 0 } },
  ],
  edges: [
    { id: "s-p1", source: "session", sourcePort: "submitted", target: "p1", targetPort: "activate" },
    { id: "s-p2", source: "session", sourcePort: "submitted", target: "p2", targetPort: "activate" },
    { id: "p1-pass", source: "p1", sourcePort: "pass", target: "join", targetPort: "result" },
    { id: "p1-fail", source: "p1", sourcePort: "fail", target: "join", targetPort: "result" },
    { id: "p2-pass", source: "p2", sourcePort: "pass", target: "join", targetPort: "result" },
    { id: "p2-fail", source: "p2", sourcePort: "fail", target: "join", targetPort: "result" },
    { id: "join-pass", source: "join", sourcePort: "pass", target: "end", targetPort: "terminal" },
    { id: "join-fail", source: "join", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
  ],
};

const context: WorkflowContextSnapshot = {
  primaryGoal: { rawPrompt: "ONE IMMUTABLE SNAPSHOT", refined: null, sourceNoteKey: "note-1" },
  humanDecisions: [],
  constraints: [],
  acceptanceCriteria: [],
  priorPersonaFeedback: [],
  session: { agent: "claude", name: "work", cwd: "/repo", branch: "feature" },
  evidence: {
    headSha: "abc",
    diffFingerprint: "diff",
    diff: "patch",
    diffTruncated: false,
    workingTreeDirty: false,
    workingTreeStatus: [],
    transcript: [],
    transcriptAnchor: null,
    transcriptTruncated: false,
    standards: [],
    standardsTruncated: false,
  },
  compaction: { status: "fallback", runner: null, model: null, error: null },
};

function seedVersion(): void {
  const db = openDb();
  const defaults = JSON.stringify({ triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 });
  db.prepare(
    `INSERT INTO workflow_definitions (
       id, name, normalized_name, description, draft_graph_json, completion_policy_json,
       binding_defaults_json, draft_revision, current_version_id, archived_at, created_at, updated_at
     ) VALUES ('workflow', 'Review', 'review', '', ?, '{"kind":"none"}', ?, 1, 'version', NULL, 1, 1)`,
  ).run(JSON.stringify({ nodes: [], edges: [] }), defaults);
  db.prepare(
    `INSERT INTO workflow_versions (
       id, workflow_id, version, source_draft_revision, graph_json,
       completion_policy_json, binding_defaults_json, published_at
     ) VALUES ('version', 'workflow', 1, 1, ?, '{"kind":"none"}', ?, 1)`,
  ).run(JSON.stringify(graph), defaults);
}

function seedNamedVersion(id: string, executionGraph: PublishedWorkflowGraph): void {
  const db = openDb();
  const defaults = JSON.stringify({ triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 });
  db.prepare(
    `INSERT INTO workflow_definitions (
       id, name, normalized_name, description, draft_graph_json, completion_policy_json,
       binding_defaults_json, draft_revision, current_version_id, archived_at, created_at, updated_at
     ) VALUES (?, ?, ?, '', '{"nodes":[],"edges":[]}', '{"kind":"none"}', ?, 1, ?, NULL, 1, 1)`,
  ).run(`workflow-${id}`, `Review ${id}`, `review-${id}`, defaults, `version-${id}`);
  db.prepare(
    `INSERT INTO workflow_versions (
       id, workflow_id, version, source_draft_revision, graph_json,
       completion_policy_json, binding_defaults_json, published_at
     ) VALUES (?, ?, 1, 1, ?, '{"kind":"none"}', ?, 1)`,
  ).run(`version-${id}`, `workflow-${id}`, JSON.stringify(executionGraph), defaults);
}

function seedSubmission(
  id: string,
  executionGraph: PublishedWorkflowGraph,
): InstanceType<typeof WorkflowStore> {
  seedNamedVersion(id, executionGraph);
  const store = new WorkflowStore();
  const binding = store.insertBinding({
    id: `binding-${id}`,
    workflowVersionId: `version-${id}`,
    noteKey: `note-${id}`,
    sessionId: `session-${id}`,
    sessionAgent: "claude",
    sessionName: id,
    sessionCwd: "/repo",
    sessionRepoRoot: "/repo",
    triggerMode: "manual",
    deliveryMode: "preview",
    maxRepairRounds: 5,
    now: 1,
  });
  store.createInitialSubmission(
    { id: `run-${id}`, binding, triggerKey: `manual:${id}:request`, now: 2 },
    {
      id: `submission-${id}`,
      triggerKey: `manual:${id}:request`,
      context: {},
      evidence: {},
      now: 2,
    },
  );
  store.updateSubmissionCapture(`submission-${id}`, {
    context: workflowJson(context),
    evidence: workflowJson(context.evidence),
    fingerprint: `fingerprint-${id}`,
    status: "running",
  }, 3);
  return store;
}

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for workflow engine");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("concurrent provider-neutral Personas share one snapshot and Join aggregates fail receipts", async () => {
  seedVersion();
  const store = new WorkflowStore();
  const binding = store.insertBinding({
    id: "binding",
    workflowVersionId: "version",
    noteKey: "note-1",
    sessionId: "session-id",
    sessionAgent: "claude",
    sessionName: "work",
    sessionCwd: "/repo",
    sessionRepoRoot: "/repo",
    triggerMode: "manual",
    deliveryMode: "preview",
    maxRepairRounds: 5,
    now: 1,
  });
  const created = store.createInitialSubmission(
    { id: "run", binding, triggerKey: "manual:binding:req", now: 2 },
    { id: "submission", triggerKey: "manual:binding:req", context: {}, evidence: {}, now: 2 },
  );
  store.updateSubmissionCapture(created.submission.id, {
    context: workflowJson(context),
    evidence: workflowJson(context.evidence),
    fingerprint: "fingerprint",
    status: "running",
  }, 3);

  let active = 0;
  let maxActive = 0;
  const prompts: Record<LlmRunnerId, string[]> = { claude: [], codex: [] };
  const runner = (id: LlmRunnerId): LlmRunner => ({
    id,
    label: id,
    runInThread: null,
    sandbox: null,
    litter: null,
    killLiveRuns() {},
    async run(prompt, options) {
      assert.equal(options?.grant, undefined);
      prompts[id].push(prompt);
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 30));
      active--;
      return prompt.includes("FAIL_PERSONA")
        ? JSON.stringify({
            verdict: "fail",
            summary: "Needs repair",
            requestedChanges: [{
              title: "Fix it",
              rationale: "Intent is not met",
              evidence: [{ kind: "goal", quote: "ONE IMMUTABLE SNAPSHOT" }],
            }],
            confidence: 0.8,
          })
        : JSON.stringify({
            verdict: "pass",
            summary: "Approved",
            approvalDetails: { reason: "Intent is met", evidence: [] },
            confidence: 0.9,
          });
    },
  });
  const resolveExecution = (snapshot: { runner: LlmRunnerId | null; model: string | null }): PersonaExecutionView => ({
    runner: { id: snapshot.runner ?? "claude", source: "config", unknown: null },
    model: { id: snapshot.model ?? "fake-model", source: "config" },
  });
  const engine = new WorkflowEngine(store, () => {}, {
    concurrency: 3,
    runnerFor: runner,
    resolveExecution,
    retryBaseMs: 1,
  });
  engine.start();
  engine.activateSubmission("submission");
  await waitFor(() => store.getRun("run")?.status === "waiting_for_session");
  await engine.stop();

  assert.equal(maxActive, 2);
  assert.equal(prompts.claude.length, 1);
  assert.equal(prompts.codex.length, 1);
  assert.ok(prompts.claude[0]!.includes("ONE IMMUTABLE SNAPSHOT"));
  assert.ok(prompts.codex[0]!.includes("ONE IMMUTABLE SNAPSHOT"));
  const attempts = store.listAttempts("submission");
  assert.equal(attempts.filter((attempt) => attempt.persona && attempt.state === "completed").length, 2);
  assert.equal(attempts.find((attempt) => attempt.nodeId === "join")?.state, "completed");
  const receipts = store.listReceipts("submission");
  assert.equal(receipts.filter((receipt) => receipt.edgeId === "join-fail").length, 1);
  assert.equal(new Set(receipts.map((receipt) => `${receipt.edgeId}:${receipt.sourceAttemptId}`)).size, receipts.length);
  assert.equal(store.getRun("run")?.currentPhase, "persona_feedback");
});

test("each structured provider attempt has its own durable LLM call receipt", async () => {
  const retryParseGraph: PublishedWorkflowGraph = {
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      { id: "p", kind: "persona", persona: persona("parse", "Parse", "claude", "review"), position: { x: 100, y: 0 } },
      { id: "end", kind: "end", outcome: "Complete", position: { x: 200, y: 0 } },
    ],
    edges: [
      { id: "s-p", source: "session", sourcePort: "submitted", target: "p", targetPort: "activate" },
      { id: "p-pass", source: "p", sourcePort: "pass", target: "end", targetPort: "terminal" },
      { id: "p-fail", source: "p", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
    ],
  };
  const store = seedSubmission("parse", retryParseGraph);
  let calls = 0;
  const fake: LlmRunner = {
    id: "claude",
    label: "parse retry",
    runInThread: null,
    sandbox: null,
    litter: null,
    killLiveRuns() {},
    async run() {
      calls++;
      if (calls === 1) return "not json";
      return JSON.stringify({
        verdict: "pass",
        summary: "Approved after a clean parse",
        approvalDetails: { reason: "Intent is met", evidence: [] },
        confidence: 0.9,
      });
    },
  };
  const engine = new WorkflowEngine(store, () => {}, {
    runnerFor: () => fake,
    resolveExecution: () => ({
      runner: { id: "claude", source: "config", unknown: null },
      model: { id: "fake-model", source: "config" },
    }),
  });
  engine.start();
  engine.activateSubmission("submission-parse");
  await waitFor(() => store.getRun("run-parse")?.status === "completed");
  await engine.stop();

  const llmCalls = openDb().prepare(
    `SELECT attempt, state, error_code FROM workflow_llm_calls
      WHERE run_id = 'run-parse' ORDER BY attempt`,
  ).all().map((row) => ({ ...(row as {
    attempt: number;
    state: string;
    error_code: string | null;
  }) }));
  assert.deepEqual(llmCalls, [
    { attempt: 1, state: "failed", error_code: "persona_parse" },
    { attempt: 2, state: "succeeded", error_code: null },
  ]);
});

test("infrastructure failures retry durably, exhaust without fail receipts, and deduplicate manual retry", async () => {
  const retryGraph: PublishedWorkflowGraph = {
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      { id: "p", kind: "persona", persona: persona("infra", "Infrastructure", "claude", "review"), position: { x: 100, y: 0 } },
      { id: "end", kind: "end", outcome: "Complete", position: { x: 200, y: 0 } },
    ],
    edges: [
      { id: "s-p", source: "session", sourcePort: "submitted", target: "p", targetPort: "activate" },
      { id: "p-pass", source: "p", sourcePort: "pass", target: "end", targetPort: "terminal" },
      { id: "p-fail", source: "p", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
    ],
  };
  const store = seedSubmission("infra", retryGraph);
  const fake: LlmRunner = {
    id: "claude",
    label: "failure",
    runInThread: null,
    sandbox: null,
    litter: null,
    killLiveRuns() {},
    async run() {
      throw new Error("provider unavailable");
    },
  };
  const engine = new WorkflowEngine(store, () => {}, {
    runnerFor: () => fake,
    resolveExecution: () => ({
      runner: { id: "claude", source: "config", unknown: null },
      model: { id: "fake-model", source: "config" },
    }),
    retryBaseMs: 1,
  });
  engine.start();
  engine.activateSubmission("submission-infra");
  await waitFor(() => store.getRun("run-infra")?.status === "blocked");
  await engine.stop();

  const attempts = store.listAttempts("submission-infra").filter((attempt) => attempt.nodeId === "p");
  assert.deepEqual(attempts.map((attempt) => attempt.attempt), [1, 2, 3]);
  assert.ok(attempts.every((attempt) => attempt.state === "error"));
  assert.equal(store.listReceipts("submission-infra").some((receipt) => receipt.edgeId === "p-fail"), false);
  assert.equal(store.getRun("run-infra")?.currentPhase, "infrastructure_error");

  const failed = attempts.at(-1)!;
  const first = store.manualInfrastructureRetry(
    "run-infra",
    "submission-infra",
    attempts[0]!,
    "retry-request",
    "manual-retry-attempt",
    20,
  );
  const repeated = store.manualInfrastructureRetry(
    "run-infra",
    "submission-infra",
    failed,
    "retry-request",
    "duplicate-attempt",
    21,
  );
  assert.equal(first.idempotent, false);
  assert.equal(repeated.idempotent, true);
  assert.deepEqual(
    store.listAttempts("submission-infra")
      .filter((attempt) => attempt.nodeId === "p")
      .map((attempt) => attempt.attempt)
      .sort((a, b) => a - b),
    [1, 2, 3, 4],
  );
  assert.equal(store.addReceipt("submission-infra", "p-pass", failed.id, { outcome: "pass" }, 22), true);
  assert.equal(
    store.addReceipt("submission-infra", "p-pass", "manual-retry-attempt", { outcome: "pass" }, 23),
    false,
  );
  store.cancelRun("run-infra", "test_cleanup", 24);
});

test("manual infrastructure retry reactivates concurrent stranded Personas", async () => {
  const retryGraph: PublishedWorkflowGraph = {
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      { id: "failing", kind: "persona", persona: persona("failing", "Failing", "claude", "FAIL_THREE"), position: { x: 100, y: 0 } },
      { id: "slow", kind: "persona", persona: persona("slow", "Slow", "codex", "SLOW_ONCE"), position: { x: 100, y: 100 } },
      { id: "cancelled", kind: "persona", persona: persona("cancelled", "Cancelled", "codex", "CANCELLED"), position: { x: 100, y: 200 } },
      { id: "join", kind: "all_pass", position: { x: 200, y: 50 } },
      { id: "end", kind: "end", outcome: "Complete", position: { x: 300, y: 50 } },
    ],
    edges: [
      { id: "s-failing", source: "session", sourcePort: "submitted", target: "failing", targetPort: "activate" },
      { id: "s-slow", source: "session", sourcePort: "submitted", target: "slow", targetPort: "activate" },
      { id: "s-cancelled", source: "session", sourcePort: "submitted", target: "cancelled", targetPort: "activate" },
      { id: "failing-pass", source: "failing", sourcePort: "pass", target: "join", targetPort: "result" },
      { id: "failing-fail", source: "failing", sourcePort: "fail", target: "join", targetPort: "result" },
      { id: "slow-pass", source: "slow", sourcePort: "pass", target: "join", targetPort: "result" },
      { id: "slow-fail", source: "slow", sourcePort: "fail", target: "join", targetPort: "result" },
      { id: "cancelled-pass", source: "cancelled", sourcePort: "pass", target: "join", targetPort: "result" },
      { id: "cancelled-fail", source: "cancelled", sourcePort: "fail", target: "join", targetPort: "result" },
      { id: "join-pass", source: "join", sourcePort: "pass", target: "end", targetPort: "terminal" },
      { id: "join-fail", source: "join", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
    ],
  };
  const store = seedSubmission("concurrent-retry", retryGraph);
  const engine = new WorkflowEngine(store);
  engine.activateSubmission("submission-concurrent-retry");
  const firstFailing = store.latestAttemptForNode("submission-concurrent-retry", "failing")!;
  store.finishAttempt(firstFailing.id, { state: "error", error: "provider unavailable" }, 10);
  store.insertAttempt({
    id: "failing-attempt-2",
    submissionId: "submission-concurrent-retry",
    nodeId: "failing",
    attempt: 2,
    state: "error",
    persona: firstFailing.persona,
    inputFingerprint: firstFailing.inputFingerprint,
    error: "provider unavailable",
    now: 11,
  });
  const exhausted = store.insertAttempt({
    id: "failing-attempt-3",
    submissionId: "submission-concurrent-retry",
    nodeId: "failing",
    attempt: 3,
    state: "error",
    persona: firstFailing.persona,
    inputFingerprint: firstFailing.inputFingerprint,
    error: "provider unavailable",
    now: 12,
  });
  const slow = store.latestAttemptForNode("submission-concurrent-retry", "slow")!;
  store.finishAttempt(slow.id, {
    state: "error",
    error: "Interrupted final attempt",
  }, 13);
  const cancelled = store.latestAttemptForNode("submission-concurrent-retry", "cancelled")!;
  store.finishAttempt(cancelled.id, {
    state: "cancelled",
    error: "Audit-only result after the submission stopped",
  }, 14);
  store.setSubmissionState("submission-concurrent-retry", "failed", 15);
  store.setRunState(
    "run-concurrent-retry",
    "blocked",
    "infrastructure_error",
    { nodeId: "failing" },
    15,
  );
  store.manualInfrastructureRetry(
    "run-concurrent-retry",
    "submission-concurrent-retry",
    exhausted,
    "retry-concurrent",
    "retry-concurrent-attempt",
    20,
  );
  engine.activateSubmission("submission-concurrent-retry", { reactivateErrors: true });

  assert.deepEqual(
    store.listAttempts("submission-concurrent-retry")
      .filter((attempt) => attempt.nodeId === "slow")
      .sort((a, b) => a.attempt - b.attempt)
      .map((attempt) => [attempt.attempt, attempt.state]),
    [[1, "error"], [2, "queued"]],
  );
  assert.deepEqual(
    store.listAttempts("submission-concurrent-retry")
      .filter((attempt) => attempt.nodeId === "cancelled")
      .sort((a, b) => a.attempt - b.attempt)
      .map((attempt) => [attempt.attempt, attempt.state]),
    [[1, "cancelled"], [2, "queued"]],
  );
  assert.equal(
    store.latestAttemptForNode("submission-concurrent-retry", "failing")?.attempt,
    4,
  );
  store.cancelRun("run-concurrent-retry", "test_cleanup", 21);
});

test("recovery blocks a persisted exhausted infrastructure attempt", async () => {
  const recoveryGraph: PublishedWorkflowGraph = {
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      { id: "p", kind: "persona", persona: persona("recover", "Recover", "claude", "REVIEW"), position: { x: 100, y: 0 } },
      { id: "end", kind: "end", outcome: "Complete", position: { x: 200, y: 0 } },
    ],
    edges: [
      { id: "s-p", source: "session", sourcePort: "submitted", target: "p", targetPort: "activate" },
      { id: "p-pass", source: "p", sourcePort: "pass", target: "end", targetPort: "terminal" },
      { id: "p-fail", source: "p", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
    ],
  };
  const store = seedSubmission("exhausted-recovery", recoveryGraph);
  const inactiveEngine = new WorkflowEngine(store);
  inactiveEngine.activateSubmission("submission-exhausted-recovery");
  const first = store.latestAttemptForNode("submission-exhausted-recovery", "p")!;
  store.finishAttempt(first.id, { state: "error", error: "provider unavailable" }, 10);
  store.insertAttempt({
    id: "exhausted-recovery-attempt-2",
    submissionId: "submission-exhausted-recovery",
    nodeId: "p",
    attempt: 2,
    state: "error",
    persona: first.persona,
    inputFingerprint: first.inputFingerprint,
    error: "provider unavailable",
    now: 11,
  });
  store.insertAttempt({
    id: "exhausted-recovery-attempt-3",
    submissionId: "submission-exhausted-recovery",
    nodeId: "p",
    attempt: 3,
    state: "error",
    persona: first.persona,
    inputFingerprint: first.inputFingerprint,
    error: "provider unavailable",
    now: 12,
  });

  const recoveryEngine = new WorkflowEngine(store);
  recoveryEngine.start();
  await recoveryEngine.stop();

  const run = store.getRun("run-exhausted-recovery");
  assert.equal(run?.status, "blocked");
  assert.equal(run?.currentPhase, "infrastructure_error");
  assert.equal(
    store.listAttempts("submission-exhausted-recovery")
      .filter((attempt) => attempt.nodeId === "p").length,
    3,
  );
  store.cancelRun("run-exhausted-recovery", "test_cleanup", 13);
});

test("cancelling a running Persona makes its later verdict audit-only", async () => {
  const cancelGraph: PublishedWorkflowGraph = {
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      { id: "p", kind: "persona", persona: persona("cancel", "Cancel", "codex", "review"), position: { x: 100, y: 0 } },
      { id: "end", kind: "end", outcome: "Complete", position: { x: 200, y: 0 } },
    ],
    edges: [
      { id: "s-p", source: "session", sourcePort: "submitted", target: "p", targetPort: "activate" },
      { id: "p-pass", source: "p", sourcePort: "pass", target: "end", targetPort: "terminal" },
      { id: "p-fail", source: "p", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
    ],
  };
  const store = seedSubmission("cancel", cancelGraph);
  let release!: (value: string) => void;
  const response = new Promise<string>((resolve) => { release = resolve; });
  let started = false;
  let auditedAttemptId: string | null = null;
  const fake: LlmRunner = {
    id: "codex",
    label: "deferred",
    runInThread: null,
    sandbox: null,
    litter: null,
    killLiveRuns() {},
    async run() {
      auditedAttemptId = store.listAttempts("submission-cancel")
        .find((attempt) => attempt.nodeId === "p" && attempt.state === "running")?.id ?? null;
      started = true;
      return response;
    },
  };
  let runUpdates = 0;
  const engine = new WorkflowEngine(store, () => { runUpdates++; }, {
    runnerFor: () => fake,
    resolveExecution: () => ({
      runner: { id: "codex", source: "config", unknown: null },
      model: { id: "fake-model", source: "config" },
    }),
  });
  engine.start();
  engine.activateSubmission("submission-cancel");
  await waitFor(() => started);
  assert.ok(auditedAttemptId);
  store.cancelRun("run-cancel", "cancelled:test", 10);
  const updatesBeforeAudit = runUpdates;
  release(JSON.stringify({
    verdict: "pass",
    summary: "late approval",
    approvalDetails: {
      reason: "late",
      evidence: [{ kind: "goal", quote: "ONE IMMUTABLE SNAPSHOT" }],
    },
    confidence: 1,
  }));
  await waitFor(() => store.getAttempt(auditedAttemptId!)?.verdict !== null);
  await engine.stop();

  assert.ok(runUpdates > updatesBeforeAudit);
  const attempt = store.getAttempt(auditedAttemptId);
  assert.equal(attempt?.state, "cancelled");
  assert.equal((attempt?.verdict as { verdict?: string } | null)?.verdict, "pass");
  assert.equal(store.listReceipts("submission-cancel").some((receipt) => receipt.edgeId === "p-pass"), false);
  const call = openDb().prepare(
    `SELECT state FROM workflow_llm_calls WHERE run_id = 'run-cancel'`,
  ).get() as { state: string };
  assert.equal(call.state, "cancelled");
});

test("cancelling during an invalid Persona reply prevents a fresh parse-retry call", async () => {
  const cancelGraph: PublishedWorkflowGraph = {
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      { id: "p", kind: "persona", persona: persona("cancel-retry", "Cancel retry", "codex", "review"), position: { x: 100, y: 0 } },
      { id: "end", kind: "end", outcome: "Complete", position: { x: 200, y: 0 } },
    ],
    edges: [
      { id: "s-p", source: "session", sourcePort: "submitted", target: "p", targetPort: "activate" },
      { id: "p-pass", source: "p", sourcePort: "pass", target: "end", targetPort: "terminal" },
      { id: "p-fail", source: "p", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
    ],
  };
  const store = seedSubmission("cancel-retry", cancelGraph);
  let release!: (value: string) => void;
  const response = new Promise<string>((resolve) => { release = resolve; });
  let calls = 0;
  const fake: LlmRunner = {
    id: "codex",
    label: "deferred invalid reply",
    runInThread: null,
    sandbox: null,
    litter: null,
    killLiveRuns() {},
    async run() {
      calls++;
      return response;
    },
  };
  let runUpdates = 0;
  const engine = new WorkflowEngine(store, () => { runUpdates++; }, {
    runnerFor: () => fake,
    resolveExecution: () => ({
      runner: { id: "codex", source: "config", unknown: null },
      model: { id: "fake-model", source: "config" },
    }),
  });
  engine.start();
  engine.activateSubmission("submission-cancel-retry");
  await waitFor(() => calls === 1);
  store.cancelRun("run-cancel-retry", "cancelled:test", 10);
  const updatesBeforeAudit = runUpdates;
  release("not json");
  await engine.stop();

  assert.ok(runUpdates > updatesBeforeAudit);
  assert.equal(calls, 1);
  assert.equal(store.latestAttemptForNode("submission-cancel-retry", "p")?.state, "cancelled");
  const llmCalls = openDb().prepare(
    `SELECT COUNT(*) AS total FROM workflow_llm_calls WHERE run_id = 'run-cancel-retry'`,
  ).get() as { total: number };
  assert.equal(llmCalls.total, 1);
});
