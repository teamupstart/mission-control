import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmRunner, LlmRunnerId } from "../src/shared/llm.ts";
import type {
  ClaudeSdkMessage,
  ClaudeSdkOneShotDeps,
} from "../src/server/harness/claude/sdk-types.ts";
import type {
  PersonaExecutionView,
  PublishedWorkflowGraph,
  WorkflowCheckSlot,
  WorkflowCommandOverride,
  WorkflowCommandView,
  WorkflowContextSnapshot,
} from "../src/shared/workflow.ts";
import { emptyWorkflowCommandView } from "../src/shared/workflow.ts";

const home = mkdtempSync(join(tmpdir(), "mission-workflow-engine-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

// A directory for the one test that needs a real one, kept OUTSIDE the state dir. The daemon
// owns what lives under `MISSION_HOME` and sweeps parts of it at startup; a test's stand-in
// worktree planted in there passes or fails depending on what ran before it.
const checkTree = mkdtempSync(join(tmpdir(), "mission-workflow-engine-tree-"));
after(() => rmSync(checkTree, { recursive: true, force: true }));

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { WorkflowStore, workflowJson } = await import("../src/server/workflows/store.ts");
const { WorkflowEngine } = await import("../src/server/workflows/engine.ts");
const { guidanceDigest } = await import("../src/server/workflows/test-evidence-audit.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const { runSupervisedCheck } = await import("../src/server/workflows/check-supervisor.ts");
const { liveCheckGroupCount } = await import("../src/server/workflows/check-group.ts");
const { checkRuntimeSupport } = await import("../src/server/workflows/check-identity.ts");
const { claudeRunner, configureClaudeRunnerTransport } = await import(
  "../src/server/llm/claude.ts"
);

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
    workingTreeStatusTruncated: false,
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
    { id: `run-${id}`, binding, triggerSource: "manual", triggerKey: `manual:${id}:request`, now: 2 },
    {
      id: `submission-${id}`,
      triggerSource: "manual",
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
    { id: "run", binding, triggerSource: "manual", triggerKey: "manual:binding:req", now: 2 },
    {
      id: "submission",
      triggerSource: "manual",
      triggerKey: "manual:binding:req",
      context: {},
      evidence: {},
      now: 2,
    },
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
    structuredOutput: null,
    sandbox: null,
    price: () => null,
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

test("every Persona receives the same retained pixels and image bytes enter call accounting", async () => {
  const imageGraph: PublishedWorkflowGraph = {
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      { id: "p1", kind: "persona", persona: persona("image-1", "Image one", "claude", "Inspect the image first"), position: { x: 100, y: 0 } },
      { id: "p2", kind: "persona", persona: persona("image-2", "Image two", "codex", "Inspect the image independently"), position: { x: 100, y: 200 } },
      { id: "join", kind: "all_pass", position: { x: 200, y: 100 } },
      { id: "end", kind: "end", outcome: "Complete", position: { x: 300, y: 100 } },
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
  const store = seedSubmission("image-pixels", imageGraph);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const sha256 = createHash("sha256").update(png).digest("hex");
  const storageRelativePath = "retained/submission-image-pixels/img_pixels.png";
  const storagePath = join(home, "workflow-evidence", storageRelativePath);
  mkdirSync(join(storagePath, ".."), { recursive: true });
  writeFileSync(storagePath, png);
  const images = store.finalizeSubmissionImages("submission-image-pixels", [{
    id: "img_pixels",
    stagingId: "staging-pixels",
    ordinal: 0,
    displayName: "pixels.png",
    caption: "The requested state is visible",
    repositoryScope: "repo-01",
    mimeType: "image/png",
    bytes: png.byteLength,
    sha256,
    storageRelativePath,
    createdAt: 4,
  }]);
  const imageContext: WorkflowContextSnapshot = {
    ...context,
    evidence: { ...context.evidence, images, stagedImageGeneration: 1 },
  };
  store.updateSubmissionCapture("submission-image-pixels", {
    context: workflowJson(imageContext),
    evidence: workflowJson(imageContext.evidence),
    fingerprint: "fingerprint-image-pixels",
    status: "running",
  }, 5);

  const prompts: string[] = [];
  const imageIds: string[][] = [];
  const fake: LlmRunner = {
    id: "claude",
    label: "image",
    runInThread: null,
    structuredOutput: null,
    sandbox: null,
    price: () => null,
    litter: null,
    killLiveRuns() {},
    async run(value, options) {
      prompts.push(value);
      imageIds.push(options?.images?.map((image) => image.id) ?? []);
      return JSON.stringify({
        verdict: "pass",
        summary: "Visible",
        approvalDetails: {
          reason: "The pixels demonstrate the requested state",
          evidence: [{ kind: "image", path: "img_pixels", quote: "The state is visible" }],
        },
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
  engine.activateSubmission("submission-image-pixels");
  await waitFor(() => store.getRun("run-image-pixels")?.status === "completed");
  await engine.stop();
  assert.equal(prompts.length, 2);
  assert.deepEqual(imageIds, [["img_pixels"], ["img_pixels"]]);
  for (const prompt of prompts) {
    assert.match(prompt, /workflow-image-manifest-untrusted/);
    assert.doesNotMatch(prompt, new RegExp(storagePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  const calls = openDb().prepare(
    `SELECT input_bytes FROM workflow_llm_calls WHERE run_id = 'run-image-pixels'`,
  ).all() as unknown as Array<{ input_bytes: number }>;
  assert.deepEqual(
    calls.map((call) => call.input_bytes).sort((a, b) => a - b),
    prompts.map((prompt) => Buffer.byteLength(prompt) + png.byteLength).sort((a, b) => a - b),
  );
});

test("missing retained pixels are infrastructure failure and spend no provider call", async () => {
  const missingGraph: PublishedWorkflowGraph = {
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      { id: "p", kind: "persona", persona: persona("missing", "Missing image", "claude", "Inspect it"), position: { x: 100, y: 0 } },
      { id: "end", kind: "end", outcome: "Complete", position: { x: 200, y: 0 } },
    ],
    edges: [
      { id: "s-p", source: "session", sourcePort: "submitted", target: "p", targetPort: "activate" },
      { id: "p-pass", source: "p", sourcePort: "pass", target: "end", targetPort: "terminal" },
      { id: "p-fail", source: "p", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
    ],
  };
  const store = seedSubmission("image-missing", missingGraph);
  const images = store.finalizeSubmissionImages("submission-image-missing", [{
    id: "img_missing",
    stagingId: "staging-missing",
    ordinal: 0,
    displayName: "missing.png",
    caption: "This retained body is unavailable",
    repositoryScope: "repo-01",
    mimeType: "image/png",
    bytes: 68,
    sha256: "a".repeat(64),
    storageRelativePath: "retained/submission-image-missing/img_missing.png",
    createdAt: 4,
  }]);
  const missingContext: WorkflowContextSnapshot = {
    ...context,
    evidence: { ...context.evidence, images, stagedImageGeneration: 1 },
  };
  store.updateSubmissionCapture("submission-image-missing", {
    context: workflowJson(missingContext),
    evidence: workflowJson(missingContext.evidence),
    fingerprint: "fingerprint-image-missing",
    status: "running",
  }, 5);

  let providerCalls = 0;
  const fake: LlmRunner = {
    id: "claude",
    label: "never called",
    runInThread: null,
    structuredOutput: null,
    sandbox: null,
    price: () => null,
    litter: null,
    killLiveRuns() {},
    async run() {
      providerCalls++;
      return "{}";
    },
  };
  const engine = new WorkflowEngine(store, () => {}, {
    runnerFor: () => fake,
    retryBaseMs: 1,
    resolveExecution: () => ({
      runner: { id: "claude", source: "config", unknown: null },
      model: { id: "fake-model", source: "config" },
    }),
  });
  engine.start();
  engine.activateSubmission("submission-image-missing");
  await waitFor(() => store.getRun("run-image-missing")?.status === "blocked");
  await engine.stop();
  assert.equal(providerCalls, 0);
  assert.equal(store.getRun("run-image-missing")?.currentPhase, "infrastructure_error");
  assert.equal(store.listLlmCallPage("run-image-missing", null, 10).items.length, 0);
});

// The validator used to refuse a second submitted route, so this shape could not be authored at
// all. Nothing in the engine changed to allow it: one submission writes one receipt per outgoing
// edge and each receipt queues its Persona. What has to stay true is that replaying the structure
// after a restart re-asserts those receipts idempotently instead of activating a second attempt.
test("one submission fans out to every submitted route and replay adds no duplicate receipt", async () => {
  const fanOutGraph: PublishedWorkflowGraph = {
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      { id: "p1", kind: "persona", persona: persona("first", "First", "claude", "REVIEW"), position: { x: 100, y: 0 } },
      { id: "p2", kind: "persona", persona: persona("second", "Second", "claude", "REVIEW"), position: { x: 100, y: 170 } },
      { id: "join", kind: "all_pass", position: { x: 200, y: 85 } },
      { id: "end", kind: "end", outcome: "Complete", position: { x: 300, y: 85 } },
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
  const store = seedSubmission("fan-out", fanOutGraph);
  const idle = new WorkflowEngine(store);
  idle.activateSubmission("submission-fan-out");

  const activated = store.listAttempts("submission-fan-out")
    .filter((attempt) => attempt.persona)
    .map((attempt) => [attempt.nodeId, attempt.attempt, attempt.state])
    .sort();
  assert.deepEqual(activated, [["p1", 1, "queued"], ["p2", 1, "queued"]]);
  const submitReceipts = () => store.listReceipts("submission-fan-out")
    .filter((receipt) => ["s-p1", "s-p2"].includes(receipt.edgeId));
  assert.deepEqual(submitReceipts().map((receipt) => receipt.edgeId).sort(), ["s-p1", "s-p2"]);

  const restarted = new WorkflowEngine(store);
  restarted.start();
  await restarted.stop();

  assert.deepEqual(submitReceipts().map((receipt) => receipt.edgeId).sort(), ["s-p1", "s-p2"]);
  assert.deepEqual(
    store.listAttempts("submission-fan-out")
      .filter((attempt) => attempt.persona)
      .map((attempt) => [attempt.nodeId, attempt.attempt])
      .sort(),
    [["p1", 1], ["p2", 1]],
  );
  store.cancelRun("run-fan-out", "test_cleanup", 30);
});

test("a Persona call carries its own timeout rather than inheriting the runner's default", async () => {
  const budgetGraph: PublishedWorkflowGraph = {
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      { id: "p", kind: "persona", persona: persona("budget", "Budget", "claude", "review"), position: { x: 100, y: 0 } },
      { id: "end", kind: "end", outcome: "Complete", position: { x: 200, y: 0 } },
    ],
    edges: [
      { id: "s-p", source: "session", sourcePort: "submitted", target: "p", targetPort: "activate" },
      { id: "p-pass", source: "p", sourcePort: "pass", target: "end", targetPort: "terminal" },
      { id: "p-fail", source: "p", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
    ],
  };
  const store = seedSubmission("budget", budgetGraph);
  const budgets: Array<number | undefined> = [];
  const fake: LlmRunner = {
    id: "claude",
    label: "budget",
    runInThread: null,
    structuredOutput: null,
    sandbox: null,
    price: () => null,
    litter: null,
    killLiveRuns() {},
    async run(_prompt, opts) {
      budgets.push(opts?.timeoutMs);
      return JSON.stringify({
        verdict: "pass",
        summary: "Approved",
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
  engine.activateSubmission("submission-budget");
  await waitFor(() => store.getRun("run-budget")?.status === "completed");
  await engine.stop();

  // Asserted as a VALUE, not merely as "defined". The number is what decides whether a
  // Persona reading a real submission finishes or is killed mid-answer, and the failure it
  // guards against is silent: an omitted `timeoutMs` falls back to the runner's own default
  // (two minutes in `claude-cli.ts`), which reads as a model that cannot answer rather than
  // as a budget that was never passed.
  assert.deepEqual(budgets, [600_000]);
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
    structuredOutput: null,
    sandbox: null,
    price: () => null,
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

test("SDK failures keep the existing persona_infrastructure vocabulary and durable retry", async () => {
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
  const sdkDeps: ClaudeSdkOneShotDeps = {
    executable: async () => "/fake/bin/claude",
    env: () => ({ PATH: "/usr/bin" }),
    query: async () => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          session_id: "sdk-infrastructure-failure",
          terminal_reason: "api_error",
          errors: ["provider unavailable"],
        } satisfies ClaudeSdkMessage;
      },
    }),
  };
  const restoreTransport = configureClaudeRunnerTransport(() => "sdk", sdkDeps);
  const engine = new WorkflowEngine(store, () => {}, {
    runnerFor: () => claudeRunner,
    resolveExecution: () => ({
      runner: { id: "claude", source: "config", unknown: null },
      model: { id: "fake-model", source: "config" },
    }),
    retryBaseMs: 1,
  });
  try {
    engine.start();
    engine.activateSubmission("submission-infra");
    await waitFor(() => store.getRun("run-infra")?.status === "blocked", 10_000);
  } finally {
    await engine.stop();
    restoreTransport();
  }

  const calls = openDb().prepare(
    `SELECT state, error_code FROM workflow_llm_calls
      WHERE run_id = 'run-infra' ORDER BY attempt`,
  ).all().map((row) => ({ ...(row as { state: string; error_code: string | null }) }));
  assert.deepEqual(calls, [
    { state: "failed", error_code: "persona_infrastructure" },
    { state: "failed", error_code: "persona_infrastructure" },
    { state: "failed", error_code: "persona_infrastructure" },
  ]);

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
  assert.equal(store.getSubmission("submission-infra")?.status, "running");
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

test("manual infrastructure retry survives restart before sibling activation", async () => {
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
  store.insertAttempt({
    id: "slow-attempt-2",
    submissionId: "submission-concurrent-retry",
    nodeId: "slow",
    attempt: 2,
    state: "error",
    persona: slow.persona,
    inputFingerprint: slow.inputFingerprint,
    error: "provider unavailable",
    now: 14,
  });
  store.insertAttempt({
    id: "slow-attempt-3",
    submissionId: "submission-concurrent-retry",
    nodeId: "slow",
    attempt: 3,
    state: "error",
    persona: slow.persona,
    inputFingerprint: slow.inputFingerprint,
    error: "provider unavailable",
    now: 15,
  });
  const cancelled = store.latestAttemptForNode("submission-concurrent-retry", "cancelled")!;
  store.finishAttempt(cancelled.id, {
    state: "cancelled",
    error: "Audit-only result after the submission stopped",
  }, 16);
  store.setSubmissionState("submission-concurrent-retry", "failed", 17);
  store.setRunState(
    "run-concurrent-retry",
    "blocked",
    "infrastructure_error",
    { nodeId: "failing" },
    17,
  );
  store.manualInfrastructureRetry(
    "run-concurrent-retry",
    "submission-concurrent-retry",
    exhausted,
    "retry-concurrent",
    "retry-concurrent-attempt",
    20,
  );
  engine.start();
  await engine.stop();

  assert.deepEqual(
    store.listAttempts("submission-concurrent-retry")
      .filter((attempt) => attempt.nodeId === "slow")
      .sort((a, b) => a.attempt - b.attempt)
      .map((attempt) => [attempt.attempt, attempt.state]),
    [[1, "error"], [2, "error"], [3, "error"], [4, "queued"]],
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
  assert.equal(store.getRun("run-concurrent-retry")?.status, "running");
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
    structuredOutput: null,
    sandbox: null,
    price: () => null,
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
    structuredOutput: null,
    sandbox: null,
    price: () => null,
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

// ---- Check nodes ----
//
// What is at stake: a Check writes a SYNTHETIC verdict so the Join, the repair packet and
// run detail need no special case. If any of that stopped being true the failure is silent -
// the run advances, the card renders, and a failing build simply never reaches the agent.
//
// The other half is the budget. `pump()` wraps a whole attempt in ONE limiter, so the kind
// has to be resolved before either is acquired. An inner check limiter would leave every
// waiting and running check occupying one of the three tool-less model-review slots, which
// is exactly what a separate budget exists to prevent, and nothing about the run would look
// wrong while it happened.

/** Session → p1 (Persona) and gate (Check) → Join → End, with the usual repair route. */
const checkGraph: PublishedWorkflowGraph = {
  nodes: [
    { id: "session", kind: "session", position: { x: 0, y: 0 } },
    { id: "p1", kind: "persona", persona: persona("p1", "Claude reviewer", "claude", "PASS_PERSONA"), position: { x: 200, y: 0 } },
    { id: "gate", kind: "check", slot: "test", position: { x: 200, y: 200 } },
    { id: "join", kind: "all_pass", position: { x: 450, y: 100 } },
    { id: "end", kind: "end", outcome: "Complete", position: { x: 700, y: 0 } },
  ],
  edges: [
    { id: "s-p1", source: "session", sourcePort: "submitted", target: "p1", targetPort: "activate" },
    { id: "s-gate", source: "session", sourcePort: "submitted", target: "gate", targetPort: "activate" },
    { id: "p1-pass", source: "p1", sourcePort: "pass", target: "join", targetPort: "result" },
    { id: "p1-fail", source: "p1", sourcePort: "fail", target: "join", targetPort: "result" },
    { id: "gate-pass", source: "gate", sourcePort: "pass", target: "join", targetPort: "result" },
    { id: "gate-fail", source: "gate", sourcePort: "fail", target: "join", targetPort: "result" },
    { id: "join-pass", source: "join", sourcePort: "pass", target: "end", targetPort: "terminal" },
    { id: "join-fail", source: "join", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
  ],
};

const passingRunner = (id: LlmRunnerId): LlmRunner => ({
  id,
  label: id,
  runInThread: null,
  structuredOutput: null,
  sandbox: null,
  price: () => null,
  litter: null,
  killLiveRuns() {},
  async run() {
    return JSON.stringify({
      verdict: "pass",
      summary: "Approved",
      approvalDetails: { reason: "Intent is met", evidence: [] },
      confidence: 0.9,
    });
  },
});

const passingExecution = (snapshot: { runner: LlmRunnerId | null; model: string | null }): PersonaExecutionView => ({
  runner: { id: snapshot.runner ?? "claude", source: "config", unknown: null },
  model: { id: snapshot.model ?? "fake-model", source: "config" },
});

/**
 * Consent, without commands. The two are separately owned now: policy is a settings blob and
 * the commands live in the Global Command catalog, so an engine fixture supplies both.
 */
const checkPolicy = (over: Record<string, unknown> = {}) => ({
  liveEnabled: false,
  repoAllowlist: ["/repo"],
  defaultWorkflowId: null,
  retention: { rawEvidenceDays: 30, completedRunDays: 180, maxCompletedRuns: 1_000 },
  checksEnabled: true,
  ...over,
});

/** A catalog reader over the given per-slot overrides, in the shape the engine injects. */
const checkCatalog = (
  bySlot: Partial<Record<WorkflowCheckSlot, WorkflowCommandOverride[]>> = {
    test: [{ repoRoot: "/repo", command: ["npm", "test"] }],
  },
  defaults: Partial<Record<WorkflowCheckSlot, string[]>> = {},
) =>
  (slot: WorkflowCheckSlot): WorkflowCommandView | null => ({
    ...emptyWorkflowCommandView(slot),
    defaultCommand: defaults[slot] ?? null,
    overrides: bySlot[slot] ?? [],
  });

/** The catalog a machine that has configured nothing projects: four empty slots. */
const emptyCatalog = () => checkCatalog({});

test("a passing check advances the graph and reaches the End through the Join", async () => {
  const store = seedSubmission("check-pass", checkGraph);
  const engine = new WorkflowEngine(store, () => {}, {
    concurrency: 3,
    runnerFor: passingRunner,
    resolveExecution: passingExecution,
    retryBaseMs: 1,
    workflowPolicy: () => checkPolicy(),
    workflowCommand: checkCatalog(),
    checkDeps: () => ({
      execute: async () => ({ kind: "exited", exitCode: 0, output: "42 passing\n", truncatedBytes: 0 }),
    }),
  });
  engine.start();
  engine.activateSubmission("submission-check-pass");
  await waitFor(() => store.getRun("run-check-pass")?.status === "completed");
  await engine.stop();

  const attempt = store.listAttempts("submission-check-pass").find((item) => item.nodeId === "gate");
  assert.ok(attempt);
  assert.equal(attempt.state, "completed");
  // No runner and no model: a check is not a model call, and stamping it with a provider it
  // never used would put a fiction in front of whoever reads the run.
  assert.equal(attempt.runner, null);
  assert.equal(attempt.model, null);
  assert.equal(attempt.persona, null);
  // The RAW outcome in output_json, so run detail prints an exit code rather than parsing
  // one back out of prose.
  const outcome = attempt.output as Record<string, unknown>;
  assert.equal(outcome.status, "passed");
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.slot, "test");
  assert.deepEqual(outcome.command, ["npm", "test"]);
  // And a synthetic verdict beside it, which is what the Join actually reads.
  assert.equal((attempt.verdict as Record<string, unknown>).verdict, "pass");
  const receipts = store.listReceipts("submission-check-pass");
  assert.equal(receipts.filter((receipt) => receipt.edgeId === "gate-pass").length, 1);
  assert.equal(receipts.filter((receipt) => receipt.edgeId === "gate-fail").length, 0);
  assert.equal(store.getRun("run-check-pass")?.currentPhase, "complete");
});

test("a downstream Persona receives frozen Check evidence in its prompt and input identity", async () => {
  const sequentialGraph: PublishedWorkflowGraph = {
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      { id: "gate", kind: "check", slot: "test", position: { x: 100, y: 0 } },
      {
        id: "auditor",
        kind: "persona",
        persona: persona("auditor", "Test Evidence Auditor", "claude", "Review the test evidence."),
        position: { x: 200, y: 0 },
      },
      { id: "end", kind: "end", outcome: "Complete", position: { x: 300, y: 0 } },
    ],
    edges: [
      { id: "submitted", source: "session", sourcePort: "submitted", target: "gate", targetPort: "activate" },
      { id: "checked", source: "gate", sourcePort: "pass", target: "auditor", targetPort: "activate" },
      { id: "check-repair", source: "gate", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
      { id: "approved", source: "auditor", sourcePort: "pass", target: "end", targetPort: "terminal" },
      { id: "review-repair", source: "auditor", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
    ],
  };
  const store = seedSubmission("check-evidence", sequentialGraph);
  const prompts: string[] = [];
  const engine = new WorkflowEngine(store, () => {}, {
    runnerFor: (id) => ({
      ...passingRunner(id),
      async run(prompt) {
        prompts.push(prompt);
        const check = store.listAttempts("submission-check-evidence")
          .find((attempt) => attempt.nodeId === "gate");
        assert.ok(check);
        return JSON.stringify({
          verdict: "pass",
          summary: "The frozen Check evidence passed",
          approvalDetails: {
            reason: "The retained output records the regression pass",
            evidence: [{
              kind: "check",
              path: check.id,
              quote: "ok 13 - regression retained",
            }],
          },
          confidence: 1,
        });
      },
    }),
    resolveExecution: passingExecution,
    retryBaseMs: 1,
    workflowPolicy: () => checkPolicy(),
    workflowCommand: checkCatalog(),
    checkDeps: () => ({
      execute: async () => ({
        kind: "exited",
        exitCode: 0,
        output: "TAP version 13\nok 13 - regression retained\n",
        truncatedBytes: 1_393,
      }),
    }),
  });
  engine.start();
  engine.activateSubmission("submission-check-evidence");
  await waitFor(() => store.getRun("run-check-evidence")?.status === "completed");
  await engine.stop();

  const attempts = store.listAttempts("submission-check-evidence");
  const check = attempts.find((attempt) => attempt.nodeId === "gate")!;
  const auditor = attempts.find((attempt) => attempt.nodeId === "auditor")!;
  assert.deepEqual(auditor.checkEvidence, [{
    nodeId: "gate",
    attemptId: check.id,
    attempt: 1,
    slot: "test",
    status: "passed",
    command: ["npm", "test"],
    exitCode: 0,
    outputTail: "TAP version 13\nok 13 - regression retained\n",
    omittedBytes: 1_393,
    headSha: "abc",
    note: "`npm test` passed.",
  }]);
  assert.notEqual(
    auditor.inputFingerprint,
    "fingerprint-check-evidence:auditor",
    "the Persona cache identity must include its frozen Check evidence",
  );
  assert.deepEqual(
    auditor.verdict,
    {
      verdict: "pass",
      summary: "The frozen Check evidence passed",
      approvalDetails: {
        reason: "The retained output records the regression pass",
        evidence: [{
          kind: "check",
          path: check.id,
          quote: "ok 13 - regression retained",
        }],
      },
      confidence: 1,
    },
  );
  assert.equal(prompts.length, 1);
  for (const expected of [check.id, "ok 13 - regression retained", '"omittedBytes": 1393', '"check"']) {
    assert.ok(prompts[0]!.includes(expected), `Persona prompt omitted ${expected}`);
  }
  const event = store.listEvents("run-check-evidence").find((item) => item.kind === "check_outcome")!;
  assert.deepEqual(event.payload, {
    nodeId: "gate",
    attemptId: check.id,
    slot: "test",
    status: "passed",
    exitCode: 0,
    headSha: "abc",
    outputBytes: Buffer.byteLength("TAP version 13\nok 13 - regression retained\n"),
    omittedBytes: 1_393,
  });
  const auditEvent = store.listEvents("run-check-evidence")
    .find((item) => item.kind === "test_evidence_audit")!;
  assert.deepEqual(auditEvent.payload, {
    nodeId: "auditor",
    submissionId: "submission-check-evidence",
    // The two identifiers a guidance-revision comparison is made of, asserted from the
    // engine rather than from the pure builder: the version is only reachable here, and a
    // telemetry event that cannot name which guidance produced it cannot be compared to the
    // next revision at all. The digest is derived, never a literal, so re-wording the
    // fixture's guidance cannot leave a stale hash asserted as this one's identity.
    workflowId: "workflow-check-evidence",
    workflowVersion: 1,
    guidance: {
      personaId: "auditor",
      revision: 1,
      digest: guidanceDigest("Review the test evidence."),
    },
    round: 1,
    segment: 0,
    firstSubmission: true,
    outcome: "pass",
    rejectionCategories: [],
    evidenceReadiness: {
      imageCount: 0,
      textArtifactCount: 0,
      checkCount: 1,
      checkOmittedBytes: 1_393,
      transcriptMessageCount: 0,
      transcriptTruncated: false,
      transcriptOmittedHeadBytes: 0,
      transcriptMiddleOmitted: false,
    },
    downstreamProofRequests: [],
    possibleDownstreamProofOverreach: false,
  });
});

test("a repository-neutral global default runs, at the checkout root", async () => {
  // The catalog's whole point, driven through the engine rather than through resolution
  // alone: this run's binding names `/repo`, the catalog holds NO override for it, and the
  // gate still runs. Before the catalog, a repository nobody had configured skipped forever.
  const store = seedSubmission("check-default", checkGraph);
  const seen: Array<{ command: string[]; workingSubpath: string }> = [];
  const engine = new WorkflowEngine(store, () => {}, {
    concurrency: 3,
    runnerFor: passingRunner,
    resolveExecution: passingExecution,
    retryBaseMs: 1,
    workflowPolicy: () => checkPolicy(),
    workflowCommand: checkCatalog({}, { test: ["npm", "test"] }),
    checkDeps: () => ({
      execute: async (request) => {
        seen.push({ command: request.command, workingSubpath: request.workingSubpath });
        return { kind: "exited", exitCode: 0, output: "ok\n", truncatedBytes: 0 };
      },
    }),
  });
  engine.start();
  engine.activateSubmission("submission-check-default");
  await waitFor(() => store.getRun("run-check-default")?.status === "completed");
  await engine.stop();

  assert.deepEqual(seen, [{ command: ["npm", "test"], workingSubpath: "" }]);
  const attempt = store.listAttempts("submission-check-default").find((item) => item.nodeId === "gate");
  assert.ok(attempt);
  assert.equal((attempt.output as Record<string, unknown>).status, "passed");
});

test("a failing check returns a repair packet to the Session, citing its own output", async () => {
  const store = seedSubmission("check-fail", checkGraph);
  const manager = new WorkflowManager(new Registry(), store, {
    engine: {
      concurrency: 3,
      runnerFor: passingRunner,
      resolveExecution: passingExecution,
      retryBaseMs: 1,
      workflowPolicy: () => checkPolicy(),
      workflowCommand: checkCatalog(),
      checkDeps: () => ({
        execute: async () => ({
          kind: "exited",
          exitCode: 1,
          output: "src/thing.ts(4,1): error TS2345: nope\n",
          truncatedBytes: 0,
        }),
      }),
    },
  });
  manager.engine.start();
  manager.engine.activateSubmission("submission-check-fail");
  await waitFor(() => store.getRun("run-check-fail")?.status === "waiting_for_session");
  await waitFor(() => store.listDeliveries("run-check-fail").length === 1);
  await manager.stop();

  const attempt = store.listAttempts("submission-check-fail").find((item) => item.nodeId === "gate")!;
  const verdict = attempt.verdict as {
    verdict: string;
    requestedChanges: Array<{ title: string; rationale: string; evidence: Array<{ kind: string; quote: string }> }>;
  };
  assert.equal(verdict.verdict, "fail");
  assert.equal(verdict.requestedChanges.length, 1);
  assert.match(verdict.requestedChanges[0]!.rationale, /TS2345/);
  // A requested change must cite something. This phase answers that by ADDING an evidence
  // kind rather than exempting check-authored changes: the rule exists so a human can trace
  // a claim to its source, and a command's own output is exactly that source.
  assert.deepEqual(verdict.requestedChanges[0]!.evidence.map((item) => item.kind), ["check"]);
  assert.match(verdict.requestedChanges[0]!.evidence[0]!.quote, /TS2345/);
  // The Join saw a fail and routed the round back to the Session.
  assert.equal(store.getRun("run-check-fail")?.currentPhase, "persona_feedback");
  assert.equal(store.getSubmission("submission-check-fail")?.status, "waiting_for_session");
  const delivery = store.listDeliveries("run-check-fail")[0]!;
  assert.equal(delivery.kind, "persona_feedback");
  assert.equal(delivery.state, "prepared");
  assert.match(delivery.payload, /## Command · test/);
  assert.match(delivery.payload, /TS2345/);
});

test("startup recovery retries a persisted Check infrastructure error", async () => {
  const recoveryGraph: PublishedWorkflowGraph = {
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      { id: "gate", kind: "check", slot: "test", position: { x: 100, y: 0 } },
      { id: "end", kind: "end", outcome: "Complete", position: { x: 200, y: 0 } },
    ],
    edges: [
      { id: "s-gate", source: "session", sourcePort: "submitted", target: "gate", targetPort: "activate" },
      { id: "gate-pass", source: "gate", sourcePort: "pass", target: "end", targetPort: "terminal" },
      { id: "gate-fail", source: "gate", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
    ],
  };
  const store = seedSubmission("check-recovery", recoveryGraph);
  const inactive = new WorkflowEngine(store);
  inactive.activateSubmission("submission-check-recovery");
  const first = store.latestAttemptForNode("submission-check-recovery", "gate")!;
  store.finishAttempt(first.id, { state: "error", error: "lease interrupted" }, 10);

  const recovered = new WorkflowEngine(store);
  recovered.start();
  const attempts = store.listAttempts("submission-check-recovery")
    .filter((attempt) => attempt.nodeId === "gate")
    .sort((a, b) => a.attempt - b.attempt);
  assert.deepEqual(attempts.map((attempt) => [attempt.attempt, attempt.state]), [
    [1, "error"],
    [2, "retry_wait"],
  ]);
  assert.equal(attempts[1]?.persona, null);
  await recovered.stop();
  store.cancelRun("run-check-recovery", "test_cleanup", 11);
});

test("an unconfigured slot passes without the executor ever being asked", async () => {
  // The contract a shipped workflow with check gates rests on, asserted end to end rather
  // than only at the unit boundary: a fresh install has configured nothing.
  const store = seedSubmission("check-skip", checkGraph);
  let asked = 0;
  const engine = new WorkflowEngine(store, () => {}, {
    concurrency: 3,
    runnerFor: passingRunner,
    resolveExecution: passingExecution,
    retryBaseMs: 1,
    workflowPolicy: () => checkPolicy(),
    workflowCommand: emptyCatalog(),
    checkDeps: () => ({
      execute: async () => {
        asked += 1;
        return { kind: "exited", exitCode: 1, output: "should never run", truncatedBytes: 0 };
      },
    }),
  });
  engine.start();
  engine.activateSubmission("submission-check-skip");
  await waitFor(() => store.getRun("run-check-skip")?.status === "completed");
  await engine.stop();

  assert.equal(asked, 0);
  const attempt = store.listAttempts("submission-check-skip").find((item) => item.nodeId === "gate")!;
  assert.equal((attempt.output as Record<string, unknown>).status, "skipped");
  assert.equal((attempt.verdict as Record<string, unknown>).verdict, "pass");
});

test("a check that could not run is an infrastructure retry, never a fail verdict", async () => {
  const store = seedSubmission("check-infra", checkGraph);
  let calls = 0;
  const engine = new WorkflowEngine(store, () => {}, {
    concurrency: 3,
    runnerFor: passingRunner,
    resolveExecution: passingExecution,
    retryBaseMs: 1,
    workflowPolicy: () => checkPolicy(),
    workflowCommand: checkCatalog(),
    checkDeps: () => ({
      execute: async () => {
        calls += 1;
        return { kind: "infrastructure", reason: "timed out after 600000ms" };
      },
    }),
  });
  engine.start();
  engine.activateSubmission("submission-check-infra");
  await waitFor(() => store.getRun("run-check-infra")?.status === "blocked");
  await engine.stop();

  // Three attempts and then blocked, exactly as a Persona's infrastructure path does.
  assert.equal(calls, 3);
  const attempts = store.listAttempts("submission-check-infra").filter((item) => item.nodeId === "gate");
  assert.equal(attempts.length, 3);
  assert.ok(attempts.every((item) => item.state === "error"));
  // The load-bearing assertion: no fail receipt anywhere, so nothing accused the change of
  // breaking a build that never finished running.
  const receipts = store.listReceipts("submission-check-infra");
  assert.equal(receipts.filter((receipt) => receipt.edgeId.startsWith("gate-")).length, 0);
  assert.equal(store.getRun("run-check-infra")?.currentPhase, "infrastructure_error");
});

test("a check does not spend a review slot, and a review does not spend a check slot", async () => {
  // Both directions, because getting the routing wrong in either produces a stall nobody
  // can see: a shared budget just looks like a slow daemon.
  const held: Array<() => void> = [];
  const holdOne = () => new Promise<void>((resolve) => held.push(resolve));

  const store = seedSubmission("check-budget", checkGraph);
  // A review scheduler already saturated at its ceiling, and a check limiter already
  // saturated at its own.
  const reviewBusy = { active: 0 };
  const checkBusy = { active: 0 };
  const engine = new WorkflowEngine(store, () => {}, {
    retryBaseMs: 1,
    runnerFor: passingRunner,
    resolveExecution: passingExecution,
    workflowPolicy: () => checkPolicy(),
    workflowCommand: checkCatalog(),
    schedule: async (fn) => {
      reviewBusy.active += 1;
      try {
        return await fn();
      } finally {
        reviewBusy.active -= 1;
      }
    },
    checkSchedule: async (fn) => {
      checkBusy.active += 1;
      try {
        return await fn();
      } finally {
        checkBusy.active -= 1;
      }
    },
    checkDeps: () => ({
      execute: async () => {
        // While the check runs, no review slot may be held by it.
        assert.equal(reviewBusy.active, 0, "a check must not occupy a review slot");
        await holdOne();
        return { kind: "exited", exitCode: 0, output: "", truncatedBytes: 0 };
      },
    }),
  });
  engine.start();
  engine.activateSubmission("submission-check-budget");
  await waitFor(() => checkBusy.active === 1);
  // The Persona review runs to completion while the check is still held, so it plainly did
  // not queue behind the check's budget.
  await waitFor(() =>
    store.listAttempts("submission-check-budget")
      .some((item) => item.nodeId === "p1" && item.state === "completed"));
  for (const release of held) release();
  await waitFor(() => store.getRun("run-check-budget")?.status === "completed");
  await engine.stop();
});

// ---- The shipped workflow's deterministic gate, end to end ----
//
// What is at stake is the entire reason No-Mistakes Review version 3 exists: a change that
// does not compile must cost ZERO model calls. That claim is about the shipped graph, not
// about a graph a test drew, so this drives the real catalog entry - if a future edit
// reordered the stages or wired the gate's pass route past the reviewers, every assertion
// above would still pass and this one would not.

const { BUILTIN_WORKFLOWS } = await import("../src/server/workflows/builtin-workflows.ts");

const shippedV3 = () => {
  const builtin = BUILTIN_WORKFLOWS.find((item) => item.definition.id === "builtin-workflow:no-mistakes-review")!;
  return builtin.versions[2]!.graph;
};

/** A runner that fails the test if a Persona is ever asked to review. */
const forbiddenRunner = (id: LlmRunnerId): LlmRunner => ({
  id,
  label: id,
  runInThread: null,
  structuredOutput: null,
  sandbox: null,
  price: () => null,
  litter: null,
  killLiveRuns() {},
  async run() {
    throw new Error("a Persona was asked to review a change whose deterministic gate failed");
  },
});

test("the shipped v3 gate fails a broken build at stage 1 with zero Persona calls spent", async () => {
  const store = seedSubmission("nmr-gate", shippedV3());
  const spawned: string[] = [];
  const manager = new WorkflowManager(new Registry(), store, {
    engine: {
      concurrency: 3,
      runnerFor: forbiddenRunner,
      resolveExecution: passingExecution,
      retryBaseMs: 1,
      workflowPolicy: () => checkPolicy(),
      workflowCommand: checkCatalog({
        typecheck: [{ repoRoot: "/repo", command: ["npm", "run", "typecheck"] }],
        test: [{ repoRoot: "/repo", command: ["npm", "test"] }],
      }),
      checkDeps: () => ({
        execute: async (request) => {
          spawned.push(request.slot);
          // Typecheck is broken; the test command would have passed. One failing gate is
          // enough, which is what an all-pass Join means.
          return request.slot === "typecheck"
            ? {
                kind: "exited",
                exitCode: 2,
                output: "src/thing.ts(4,1): error TS2345: nope\n",
                truncatedBytes: 0,
              }
            : { kind: "exited", exitCode: 0, output: "ok\n", truncatedBytes: 0 };
        },
      }),
    },
  });
  manager.engine.start();
  manager.engine.activateSubmission("submission-nmr-gate");
  await waitFor(() => store.getRun("run-nmr-gate")?.status === "waiting_for_session");
  await waitFor(() => store.listDeliveries("run-nmr-gate").length === 1);
  await manager.stop();

  const attempts = store.listAttempts("submission-nmr-gate");
  // THE assertion. Not one Persona node was attempted, so not one model call was spent.
  assert.deepEqual(
    attempts.filter((item) => item.persona !== null).map((item) => item.nodeId),
    [],
    "a Persona ran behind a failing deterministic gate",
  );
  for (const id of ["nmr-intent-conformance", "nmr-code-risk", "nmr-test-evidence", "nmr-documentation"]) {
    assert.ok(!attempts.some((item) => item.nodeId === id), `${id} was attempted`);
  }
  // Both checks in the stage ran - they are peers on one submission, not a short-circuit.
  assert.deepEqual([...spawned].sort(), ["test", "typecheck"]);

  // And the failure came back as a repair packet naming the gate and quoting its own output.
  const gate = attempts.find((item) => item.nodeId === "nmr-check-typecheck")!;
  const gateVerdict = gate.verdict as {
    verdict: string;
    requestedChanges: Array<{ evidence: Array<{ path?: string }> }>;
  };
  assert.equal(gateVerdict.verdict, "fail");
  assert.equal(gateVerdict.requestedChanges[0]?.evidence[0]?.path, gate.id);
  const delivery = store.listDeliveries("run-nmr-gate")[0]!;
  assert.match(delivery.payload, /## Command · typecheck/);
  assert.match(delivery.payload, /TS2345/);
  assert.equal(store.getSubmission("submission-nmr-gate")?.status, "waiting_for_session");
});

test("the shipped v3 gate passes untouched on a machine that configured no commands", async () => {
  // The safety property that makes shipping check gates in a built-in defensible: with
  // nothing configured the stage is skipped, passes, and the workflow behaves as version 1
  // did - so the four reviewers DO run, which is the other half of the claim.
  const store = seedSubmission("nmr-unconfigured", shippedV3());
  const reviewed: string[] = [];
  const manager = new WorkflowManager(new Registry(), store, {
    engine: {
      concurrency: 3,
      runnerFor: (id) => ({
        ...passingRunner(id),
        async run(...args: unknown[]) {
          reviewed.push(id);
          return passingRunner(id).run(...(args as Parameters<LlmRunner["run"]>));
        },
      }),
      resolveExecution: passingExecution,
      retryBaseMs: 1,
      // Checks enabled and the repository authorized, but NO command for either slot.
      workflowPolicy: () => checkPolicy(),
      workflowCommand: emptyCatalog(),
      checkDeps: () => ({
        execute: async () => {
          throw new Error("an unconfigured slot must never reach the execution runtime");
        },
      }),
    },
  });
  manager.engine.start();
  manager.engine.activateSubmission("submission-nmr-unconfigured");
  await waitFor(() => store.getRun("run-nmr-unconfigured")?.status === "completed", 10_000);
  await manager.stop();

  const attempts = store.listAttempts("submission-nmr-unconfigured");
  const gate = attempts.find((item) => item.nodeId === "nmr-check-typecheck")!;
  assert.equal((gate.verdict as { verdict: string }).verdict, "pass");
  // A skip is never mistaken for a gate that ran: it says which of the two happened.
  assert.match(JSON.stringify(gate.verdict), /skip|configur/i);
  // The reviewers behind it ran, so the workflow did what version 1 does.
  for (const id of ["nmr-intent-conformance", "nmr-code-risk", "nmr-test-evidence", "nmr-documentation"]) {
    assert.ok(attempts.some((item) => item.nodeId === id), `${id} did not run`);
  }
  assert.equal(store.getRun("run-nmr-unconfigured")?.status, "completed");
});

// --- Operator-disabled nodes: the per-run auto-pass toggle ---

/** Two reviewers where the second is authored to FAIL: if a disable does not hold, the
 *  round returns to Session instead of completing, so these tests cannot pass by accident. */
function disableGraph(): PublishedWorkflowGraph {
  return {
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      { id: "p1", kind: "persona", persona: persona("p1", "Honest reviewer", "claude", "PASS_PERSONA"), position: { x: 100, y: 0 } },
      { id: "p2", kind: "persona", persona: persona("p2", "Blocking reviewer", "codex", "FAIL_PERSONA"), position: { x: 100, y: 170 } },
      { id: "join", kind: "all_pass", position: { x: 200, y: 85 } },
      { id: "end", kind: "end", outcome: "Complete", position: { x: 300, y: 85 } },
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
}

/** A runner that records who was asked and fails any Persona whose guidance says so. */
function verdictRunner(reviewed: string[]) {
  return (id: LlmRunnerId): LlmRunner => ({
    ...passingRunner(id),
    async run(prompt: string) {
      reviewed.push(prompt.includes("FAIL_PERSONA") ? "blocking" : "honest");
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
}

test("a disabled reviewer auto-passes at claim time without a provider call", async () => {
  const store = seedSubmission("disable-claim", disableGraph());
  store.setRunDisabledNodes("run-disable-claim", ["p2"], [], 4);
  const reviewed: string[] = [];
  const engine = new WorkflowEngine(store, () => {}, {
    concurrency: 3,
    runnerFor: verdictRunner(reviewed),
    resolveExecution: passingExecution,
    retryBaseMs: 1,
  });
  engine.start();
  engine.activateSubmission("submission-disable-claim");
  await waitFor(() => store.getRun("run-disable-claim")?.status === "completed");
  await engine.stop();

  // The failing reviewer was never asked; the honest one still ran.
  assert.deepEqual(reviewed, ["honest"]);
  const attempts = store.listAttempts("submission-disable-claim");
  const skipped = attempts.find((attempt) => attempt.nodeId === "p2")!;
  assert.equal(skipped.state, "completed");
  // No provider is stamped onto a call that never happened.
  assert.equal(skipped.runner, null);
  assert.equal(skipped.model, null);
  assert.equal((skipped.verdict as { verdict: string }).verdict, "pass");
  // The verdict says plainly that nothing ran, and output carries the machine-readable flag.
  assert.match(JSON.stringify(skipped.verdict), /disabled/i);
  assert.deepEqual(skipped.output, { outcome: "pass", disabled: true });
  assert.ok(store.listEvents("run-disable-claim").some((event) =>
    event.kind === "disabled_node_auto_passed"
    && !Array.isArray(event.payload)
    && typeof event.payload === "object"
    && event.payload?.nodeId === "p2"));
});

test("disabling a reviewer after a failed round makes the repair round auto-pass it", async () => {
  const store = seedSubmission("disable-rerun", disableGraph());
  const reviewed: string[] = [];
  const engine = new WorkflowEngine(store, () => {}, {
    concurrency: 3,
    runnerFor: verdictRunner(reviewed),
    resolveExecution: passingExecution,
    retryBaseMs: 1,
  });
  engine.start();
  engine.activateSubmission("submission-disable-rerun");
  await waitFor(() => store.getRun("run-disable-rerun")?.status === "waiting_for_session");

  // Round 1 genuinely failed on the blocking reviewer. The operator disables it and
  // resubmits; round 2 must complete without asking that reviewer again.
  assert.deepEqual([...reviewed].sort(), ["blocking", "honest"]);
  store.setRunDisabledNodes("run-disable-rerun", ["p2"], [], 20);
  const repair = store.createRepairSubmission({
    id: "submission-disable-rerun-2",
    runId: "run-disable-rerun",
    round: 2,
    triggerSource: "manual",
    triggerKey: "manual:disable-rerun:round-2",
    context: {},
    evidence: {},
    now: 21,
  });
  store.updateSubmissionCapture(repair.submission.id, {
    context: workflowJson(context),
    evidence: workflowJson(context.evidence),
    fingerprint: "fingerprint-disable-rerun-2",
    status: "running",
  }, 22);
  engine.activateSubmission("submission-disable-rerun-2");
  await waitFor(() => store.getRun("run-disable-rerun")?.status === "completed");
  await engine.stop();

  assert.deepEqual([...reviewed].sort(), ["blocking", "honest", "honest"]);
  const skipped = store.listAttempts("submission-disable-rerun-2")
    .find((attempt) => attempt.nodeId === "p2")!;
  assert.equal(skipped.state, "completed");
  assert.equal((skipped.verdict as { verdict: string }).verdict, "pass");
  assert.deepEqual(skipped.output, { outcome: "pass", disabled: true });
  // Round 1's honest fail is history and stays exactly as it ran.
  const original = store.listAttempts("submission-disable-rerun")
    .find((attempt) => attempt.nodeId === "p2")!;
  assert.equal((original.verdict as { verdict: string }).verdict, "fail");
});

test("Persona feedback stays scoped to one reviewer and persists into repair rounds", async () => {
  const store = seedSubmission("directive-rerun", disableGraph());
  store.setRunPersonaDirective(
    "run-directive-rerun",
    "p1",
    "CRITICAL_OPERATOR_EXCEPTION",
    { kind: "persona_directive_set", payload: { nodeId: "p1", requestId: "set-1" } },
    4,
  );
  const prompts: Array<{ persona: "honest" | "blocking"; prompt: string }> = [];
  const engine = new WorkflowEngine(store, () => {}, {
    concurrency: 3,
    runnerFor: (id) => ({
      ...passingRunner(id),
      async run(prompt: string) {
        const blocking = prompt.includes("FAIL_PERSONA");
        prompts.push({ persona: blocking ? "blocking" : "honest", prompt });
        return blocking
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
    }),
    resolveExecution: passingExecution,
    retryBaseMs: 1,
  });
  engine.start();
  engine.activateSubmission("submission-directive-rerun");
  await waitFor(() => store.getRun("run-directive-rerun")?.status === "waiting_for_session");

  const roundOneHonest = prompts.find((item) => item.persona === "honest")!;
  const roundOneBlocking = prompts.find((item) => item.persona === "blocking")!;
  assert.match(roundOneHonest.prompt, /^# EXTREMELY CRITICAL OPERATOR DIRECTIVE/);
  assert.match(roundOneHonest.prompt, /CRITICAL_OPERATOR_EXCEPTION/);
  assert.doesNotMatch(roundOneBlocking.prompt, /CRITICAL_OPERATOR_EXCEPTION/);

  const repair = store.createRepairSubmission({
    id: "submission-directive-rerun-2",
    runId: "run-directive-rerun",
    round: 2,
    triggerSource: "manual",
    triggerKey: "manual:directive-rerun:round-2",
    context: {},
    evidence: {},
    now: 20,
  });
  store.updateSubmissionCapture(repair.submission.id, {
    context: workflowJson(context),
    evidence: workflowJson(context.evidence),
    fingerprint: "fingerprint-directive-rerun-2",
    status: "running",
  }, 21);
  engine.activateSubmission(repair.submission.id);
  await waitFor(() => prompts.filter((item) => item.persona === "honest").length === 2);
  await engine.stop();

  const roundTwoHonest = prompts.filter((item) => item.persona === "honest")[1]!;
  assert.match(roundTwoHonest.prompt, /^# EXTREMELY CRITICAL OPERATOR DIRECTIVE/);
  assert.match(roundTwoHonest.prompt, /CRITICAL_OPERATOR_EXCEPTION/);
  const attempt = store.listAttempts(repair.submission.id).find((item) => item.nodeId === "p1")!;
  assert.equal(attempt.operatorDirective?.feedback, "CRITICAL_OPERATOR_EXCEPTION");
});

test("a disabled check auto-passes without reaching the execution runtime", async () => {
  const disabledCheckGraph: PublishedWorkflowGraph = {
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      { id: "gate", kind: "check", slot: "test", position: { x: 100, y: 0 } },
      { id: "end", kind: "end", outcome: "Complete", position: { x: 300, y: 0 } },
    ],
    edges: [
      { id: "s-gate", source: "session", sourcePort: "submitted", target: "gate", targetPort: "activate" },
      { id: "gate-pass", source: "gate", sourcePort: "pass", target: "end", targetPort: "terminal" },
      { id: "gate-fail", source: "gate", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
    ],
  };
  const store = seedSubmission("disable-check", disabledCheckGraph);
  store.setRunDisabledNodes("run-disable-check", ["gate"], [], 4);
  const engine = new WorkflowEngine(store, () => {}, {
    concurrency: 3,
    runnerFor: passingRunner,
    resolveExecution: passingExecution,
    retryBaseMs: 1,
    workflowPolicy: () => checkPolicy(),
    workflowCommand: checkCatalog(),
    checkDeps: () => ({
      execute: async () => {
        throw new Error("a disabled check must never reach the execution runtime");
      },
    }),
  });
  engine.start();
  engine.activateSubmission("submission-disable-check");
  await waitFor(() => store.getRun("run-disable-check")?.status === "completed");
  await engine.stop();

  const gate = store.listAttempts("submission-disable-check")
    .find((attempt) => attempt.nodeId === "gate")!;
  assert.equal(gate.state, "completed");
  assert.deepEqual(gate.output, { outcome: "pass", disabled: true });
});

/**
 * A daemon restart must not wait out somebody's test suite.
 *
 * Before this, `stop()` set a flag and awaited every in-flight attempt - and a check attempt
 * is a build with up to its whole timeout left to run. The command below would have held
 * shutdown for a minute; a real `npm test` would hold it for the ten-minute default. Nothing
 * about that is visible from the outside: the daemon simply appears to hang on exit.
 *
 * The assertion is the WALL CLOCK, deliberately, because that is the defect. A test that only
 * checked "the group is gone afterwards" would pass against the unfixed code too - it would
 * just take a minute to say so.
 */
test("stop() cancels a live check group instead of waiting out its command", {
  skip: !checkRuntimeSupport().supported,
}, async () => {
  const store = seedSubmission("check-stop", checkGraph);
  const engine = new WorkflowEngine(store, () => {}, {
    concurrency: 3,
    runnerFor: passingRunner,
    resolveExecution: passingExecution,
    retryBaseMs: 1,
    workflowPolicy: () => checkPolicy(),
    workflowCommand: checkCatalog(),
    // The REAL supervisor, because the thing under test is whether `stop()` reaches the
    // process group it registered. A stubbed executor would register nothing and the test
    // would prove that stopping an engine with no check running is fast.
    checkDeps: (attempt) => ({
      execute: async () => {
        const outcome = await runSupervisedCheck({
          attemptId: attempt.attemptId,
          command: [process.execPath, "-e", "setTimeout(() => {}, 60000)"],
          leasePath: checkTree,
          workingSubpath: "",
          timeoutMs: 60_000,
        }, {
          // No lease in this test: the question is the process group, and Contract P's
          // implementation is exercised where the lease is.
          registry: { record: () => {}, clear: () => {} },
          teardown: { graceMs: 300, confirmMs: 3_000, pollMs: 20 },
        });
        return outcome.result;
      },
    }),
  });
  engine.start();
  engine.activateSubmission("submission-check-stop");
  await waitFor(() => liveCheckGroupCount() > 0, 15_000);

  const started = Date.now();
  await engine.stop();
  const elapsed = Date.now() - started;

  // Generous, because what it has to exclude is a 60-second wait rather than a slow machine:
  // measured at 15-70ms, and 15 seconds still fails loudly against a stop() that awaits the
  // command. The bound is the defect, not the performance.
  assert.ok(elapsed < 15_000, `stop() waited ${elapsed}ms for a 60s command`);
  assert.equal(liveCheckGroupCount(), 0, "a check group survived the stop that cancelled it");
  // And the cancellation is infrastructure, never a fail verdict about the submission.
  const attempt = store.listAttempts("submission-check-stop").find((item) => item.nodeId === "gate")!;
  assert.equal(attempt.state, "error");
  assert.equal(attempt.verdict, null);
});
