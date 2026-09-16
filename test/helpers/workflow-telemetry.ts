import type { LlmRunner, LlmRunnerId } from "../../src/shared/llm.ts";
import type { PersonaExecutionView, PublishedWorkflowGraph, WorkflowContextSnapshot } from "../../src/shared/workflow.ts";
import { workflowRunResumesItself } from "../../src/shared/workflow.ts";
import { openDb, closeDb } from "../../src/server/db.ts";
import { WorkflowStore, workflowJson } from "../../src/server/workflows/store.ts";
import { WorkflowEngine } from "../../src/server/workflows/engine.ts";
import { recordWorkflowAction } from "../../src/server/telemetry/workflow-actions.ts";
import { FIXTURE_RUN_INTENT } from "./workflow-run-intent.ts";
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

export const goldenWorkflowGraph: PublishedWorkflowGraph = {
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

export const goldenWorkflowContext: WorkflowContextSnapshot = {
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


export function seedTelemetryWorkflow(id: string, graph = goldenWorkflowGraph, deliveryMode: "live" | "preview" = "preview") {
  const d = openDb();
  const defaults = JSON.stringify({ triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 });
  d.prepare(`INSERT INTO workflow_definitions (id, name, normalized_name, description, draft_graph_json,
    completion_policy_json, binding_defaults_json, draft_revision, current_version_id, created_at, updated_at)
    VALUES (?, ?, ?, '', '{"nodes":[],"edges":[]}', '{"kind":"none"}', ?, 1, ?, 1, 1)`).run(id, id, id, defaults, `v-${id}`);
  d.prepare(`INSERT INTO workflow_versions (id, workflow_id, version, source_draft_revision, graph_json,
    completion_policy_json, binding_defaults_json, resumption_policy, published_at) VALUES (?, ?, 1, 1, ?, '{"kind":"none"}', ?, 'auto', 1)`)
    .run(`v-${id}`, id, JSON.stringify(graph), defaults);
  const store = new WorkflowStore();
  const binding = store.insertBinding({ id: `b-${id}`, workflowVersionId: `v-${id}`, noteKey: id,
    sessionId: `session-${id}`, sessionAgent: "claude", sessionName: "PRIVATE_SENTINEL", sessionCwd: "/PRIVATE_SENTINEL",
    sessionRepoRoot: "/PRIVATE_SENTINEL", triggerMode: "manual", deliveryMode, maxRepairRounds: 5, now: Date.now() });
  const created = store.createInitialSubmission({ id: `r-${id}`, binding, intent: FIXTURE_RUN_INTENT,
    triggerSource: "manual", triggerKey: `start-${id}`, now: Date.now() }, {
    id: `s-${id}`, triggerSource: "manual", triggerKey: `start-${id}`, context: {}, evidence: {}, now: Date.now(),
  });
  store.updateSubmissionCapture(created.submission.id, { context: workflowJson(goldenWorkflowContext),
    evidence: workflowJson(goldenWorkflowContext.evidence), fingerprint: "first", status: "running" });
  return { store, ...created };
}
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("golden workflow did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
export async function runWorkflowGoldenFixture(id: string, restart = true) {
  let { store, run, submission } = seedTelemetryWorkflow(id, goldenWorkflowGraph, "live");
  let aCalls = 0;
  const pass = JSON.stringify({ verdict: "pass", summary: "PRIVATE_SENTINEL", approvalDetails: { reason: "met", evidence: [] }, confidence: 1 });
  const runner = (id: LlmRunnerId): LlmRunner => ({ id, label: id, runInThread: null,
    structuredOutput: null, sandbox: null, price: () => null, litter: null, killLiveRuns() {},
    async run() {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (id !== "claude") return pass;
      aCalls++;
      if (aCalls === 1) return "malformed PRIVATE_SENTINEL";
      if (aCalls > 2) return pass;
      return JSON.stringify({ verdict: "fail", summary: "PRIVATE_SENTINEL", confidence: 1,
        requestedChanges: [{ title: "PRIVATE_SENTINEL", rationale: "PRIVATE_SENTINEL", basis: "substantive",
          category: "test_coverage", evidence: [{ kind: "goal", quote: "PRIVATE_SENTINEL" }] }] });
    } });
  const resolveExecution = (snapshot: { runner: LlmRunnerId | null; model: string | null }): PersonaExecutionView => ({
    runner: { id: snapshot.runner ?? "claude", source: "config", unknown: null },
    model: { id: snapshot.model ?? "fake-model", source: "config" },
  });
  let engine = new WorkflowEngine(store, () => {}, { runnerFor: runner, resolveExecution });
  try {
    engine.start(); engine.activateSubmission(submission.id);
    await waitFor(() => store.getRun(run.id)?.status === "waiting_for_session");
    await engine.stop();
    const packet = store.prepareDelivery({ id: `d-${id}`, runId: run.id, submissionId: submission.id,
      kind: "persona_feedback", sessionId: `session-${id}`, noteKey: id, payload: "PRIVATE_SENTINEL", payloadSha256: "packet" });
    store.claimDeliverySend(packet.delivery.id);
    store.confirmDeliverySend(packet.delivery.id, null, true);
    if (restart) { closeDb(); openDb(); store = new WorkflowStore(); }
    const before = store.getRun(run.id)!;
    const automaticResumption = workflowRunResumesItself({
      deliveryMode: store.getBinding(before.bindingId)!.deliveryMode,
      resumptionPolicy: store.getWorkflowVersionById(before.workflowVersionId)!.resumptionPolicy,
    });
    for (let replay = 0; replay < 2; replay++) recordWorkflowAction({ action: "workflow.resubmit", before, automaticResumption,
      operationId: `resubmit-${id}`, context: { operationId: "goldenresubmit01", surface: "runs",
        actor: { kind: "human", origin: "dashboard", basis: "app_context" } },
      outcome: "applied", startedAt: Date.now(), now: Date.now() });
    const repair = store.createRepairSubmission({ id: `s2-${id}`, runId: run.id, round: 2,
      triggerSource: "manual", triggerKey: `repair-${id}`, context: {}, evidence: {}, now: Date.now() });
    store.updateSubmissionCapture(repair.submission.id, { context: workflowJson(goldenWorkflowContext),
      evidence: workflowJson(goldenWorkflowContext.evidence), fingerprint: "second", status: "running" });
    engine = new WorkflowEngine(store, () => {}, { runnerFor: runner, resolveExecution });
    engine.start(); engine.activateSubmission(repair.submission.id);
    await waitFor(() => store.getRun(run.id)?.status === "completed");
    return { store, runId: run.id, submissionId: submission.id, repairSubmissionId: repair.submission.id };
  } finally { await engine.stop(); }
}
