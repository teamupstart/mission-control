import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowContextSnapshot } from "../src/shared/workflow.ts";

const home = mkdtempSync(join(tmpdir(), "mission-workflow-export-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const { WorkflowStore, workflowJson } = await import("../src/server/workflows/store.ts");
const { normalizePersonaName, normalizeWorkflowName } = await import("../src/shared/workflow.ts");
const db = openDb();
const store = new WorkflowStore(db);

const context: WorkflowContextSnapshot = {
  primaryGoal: { rawPrompt: "Exact operator goal", refined: null, sourceNoteKey: "note" },
  humanDecisions: [],
  constraints: [],
  acceptanceCriteria: [],
  priorPersonaFeedback: [],
  session: { agent: "codex", name: "Worker", cwd: "/repo", branch: "feature" },
  evidence: {
    headSha: "a".repeat(40),
    diffFingerprint: "fingerprint",
    diff: "diff body",
    diffTruncated: false,
    workingTreeDirty: false,
    workingTreeStatus: [],
    workingTreeStatusTruncated: false,
    transcript: [],
    transcriptAnchor: null,
    transcriptTruncated: false,
    standards: [],
    standardsTruncated: false,
    retention: { state: "full" },
  },
  compaction: { status: "fallback", runner: null, model: null, error: null },
};

test("version and run exports are versioned, complete, and preserve immutable snapshots", () => {
  store.insertPersona({
    id: "persona",
    name: "Exact reviewer",
    normalizedName: normalizePersonaName("Exact reviewer"),
    description: "",
    guidanceMarkdown: "# Exact guidance",
    runner: "codex",
    model: "gpt-test",
    createdAt: 1,
    updatedAt: 1,
  });
  const definition = store.insertWorkflow({
    id: "workflow",
    name: "Review",
    normalizedName: normalizeWorkflowName("Review"),
    description: "",
    draft: {
      nodes: [
        { id: "session", kind: "session", position: { x: 0, y: 0 } },
        { id: "persona-node", kind: "persona", personaId: "persona", position: { x: 200, y: 0 } },
        { id: "end", kind: "end", outcome: "Complete", position: { x: 400, y: 0 } },
      ],
      edges: [
        { id: "start", source: "session", sourcePort: "submitted", target: "persona-node", targetPort: "activate" },
        { id: "pass", source: "persona-node", sourcePort: "pass", target: "end", targetPort: "terminal" },
        { id: "fail", source: "persona-node", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
      ],
    },
    completionPolicy: { kind: "none" },
    resumptionPolicy: "manual",
    bindingDefaults: { triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 },
    createdAt: 2,
    updatedAt: 2,
  });
  assert.equal(definition.ok, true);
  const published = store.publishWorkflow("workflow", 1, "version", 3);
  assert.equal(published.ok, true);
  if (!published.ok) return;
  const binding = store.insertBinding({
    id: "binding",
    workflowVersionId: published.version.id,
    noteKey: "note",
    sessionId: "session-id",
    sessionAgent: "codex",
    sessionName: "Worker",
    sessionCwd: "/repo",
    sessionRepoRoot: "/repo",
    triggerMode: "manual",
    deliveryMode: "preview",
    maxRepairRounds: 5,
    now: 4,
  });
  store.createInitialSubmission({
    id: "run",
    binding,
    triggerSource: "manual",
    triggerKey: "run-trigger",
    now: 5,
  }, {
    id: "submission",
    triggerSource: "manual",
    triggerKey: "submission-trigger",
    context: workflowJson(context),
    evidence: workflowJson(context.evidence),
    status: "completed",
    now: 5,
  });
  store.setRunState("run", "completed", "complete", null, 6);
  store.insertLlmCall({
    id: "call",
    runId: "run",
    submissionId: "submission",
    nodeAttemptId: null,
    purpose: "context_compaction",
    runner: "codex",
    model: "gpt-test",
    attempt: 1,
    state: "succeeded",
    startedAt: 5,
    finishedAt: 6,
    durationMs: 1,
    inputBytes: 100,
    outputBytes: 50,
    costUsd: null,
    errorCode: null,
  });
  store.prepareDelivery({
    id: "delivery",
    runId: "run",
    submissionId: "submission",
    kind: "persona_feedback",
    sessionId: "session-id",
    noteKey: "note",
    payload: "private feedback packet",
    payloadSha256: "b".repeat(64),
  }, 5);
  store.setDeliveryState("delivery", "delivered", null, 6);

  const manager = new WorkflowManager(new Registry(), store);
  const versionExport = manager.exportVersion("workflow", 1, 10)!;
  assert.equal(versionExport.schemaVersion, 1);
  assert.equal(versionExport.kind, "workflow_version");
  const personaNode = versionExport.data.graph.nodes.find((node) => node.kind === "persona");
  assert.ok(personaNode?.kind === "persona");
  if (personaNode?.kind === "persona") {
    assert.equal(personaNode.persona.guidanceMarkdown, "# Exact guidance");
    assert.equal(personaNode.persona.sourceRevision, 1);
  }

  const runExport = manager.exportRun("run", 10)!;
  assert.equal(runExport.schemaVersion, 1);
  assert.equal(runExport.kind, "workflow_run");
  assert.equal(runExport.data.events.length, runExport.data.eventCount);
  assert.equal(runExport.data.llmCalls?.length, 1);
  assert.equal(runExport.data.llmCalls?.[0]?.costUsd, null);
  assert.equal(
    (runExport.data.submissions[0]!.context as unknown as WorkflowContextSnapshot)
      .primaryGoal.rawPrompt,
    "Exact operator goal",
  );

  const retained = store.runRetention({
    rawEvidenceBefore: 6,
    completedRunsBefore: -1,
    maxCompletedRuns: 100,
    now: 20,
  });
  assert.deepEqual(retained.compactedRunIds, ["run"]);
  const prunedExport = manager.exportRun("run", 21)!;
  const prunedContext = prunedExport.data.submissions[0]!.context as unknown as WorkflowContextSnapshot;
  assert.equal(prunedContext.primaryGoal.rawPrompt, "Exact operator goal");
  assert.equal(prunedContext.evidence.diff, "");
  assert.deepEqual(prunedContext.evidence.retention, {
    state: "pruned",
    prunedAt: 20,
    diffBytes: Buffer.byteLength("diff body"),
    workingTreeStatusEntries: 0,
    transcriptMessages: 0,
    standardsDocuments: 0,
    imageCount: 0,
    imageBytes: 0,
    textArtifactCount: 0,
    textArtifactBytes: 0,
  });
  assert.equal(prunedExport.data.deliveries[0]?.payload, "");
  assert.equal(prunedExport.data.deliveries[0]?.payloadPrunedAt, 20);
  assert.doesNotMatch(JSON.stringify(prunedExport), /diff body|private feedback packet/);
});
