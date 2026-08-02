import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { InspectorComment, InspectorPr } from "../src/shared/types.ts";
import type { WorkflowContextSnapshot, WorkflowInspectorGateState } from "../src/shared/workflow.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";

// What is at stake: the default findings policy must really rerun the immutable graph.
// An approval of the failed head cannot leak across that repair into the second gate.
const home = mkdtempSync(join(tmpdir(), "mission-workflow-inspector-restart-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const {
  adoptInspectorPr,
  openDb,
  updateInspectorPr,
  upsertInspectorComment,
} = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { setInspectorConfig } = await import("../src/server/inspector/config.ts");
const { fallbackWorkflowContext } = await import("../src/server/workflows/context.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const { WorkflowStore, workflowJson } = await import("../src/server/workflows/store.ts");

const db = openDb();
const key = "owner/repo#61";
const url = "https://github.com/owner/repo/pull/61";
const oldHead = "old-committed-head";
const newHead = "new-committed-head";

function captured(headSha: string): WorkflowContextSnapshot {
  return {
    primaryGoal: { rawPrompt: "Repair and ship", refined: null, sourceNoteKey: "agent-session" },
    humanDecisions: [],
    constraints: [],
    acceptanceCriteria: [],
    priorPersonaFeedback: [],
    session: { agent: "claude", name: "work", cwd: "/repo", branch: "feature" },
    evidence: {
      headSha,
      diffFingerprint: `diff-${headSha}`,
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
}

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 2_000) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("findings deliver, full resubmit reruns, and only the newly approved clean head completes", async () => {
  const policy = JSON.stringify({
    kind: "inspector",
    onFindings: "restart_workflow",
    missingPrAction: "wait",
  });
  const defaults = JSON.stringify({
    triggerMode: "manual",
    deliveryMode: "preview",
    maxRepairRounds: 3,
  });
  const graph = JSON.stringify({
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      { id: "end", kind: "end", outcome: "Complete", position: { x: 160, y: 0 } },
    ],
    edges: [
      {
        id: "session-end",
        source: "session",
        sourcePort: "submitted",
        target: "end",
        targetPort: "terminal",
      },
    ],
  });
  db.prepare(
    `INSERT INTO workflow_definitions (
       id, name, normalized_name, description, draft_graph_json, completion_policy_json,
       binding_defaults_json, draft_revision, current_version_id, archived_at, created_at, updated_at
     ) VALUES ('w', 'Restart', 'restart', '', ?, ?, ?, 1, 'v', NULL, 1, 1)`,
  ).run(graph, policy, defaults);
  db.prepare(
    `INSERT INTO workflow_versions (
       id, workflow_id, version, source_draft_revision, graph_json,
       completion_policy_json, binding_defaults_json, published_at
     ) VALUES ('v', 'w', 1, 1, ?, ?, ?, 1)`,
  ).run(graph, policy, defaults);
  const pr: InspectorPr = {
    key,
    url,
    owner: "owner",
    repo: "repo",
    number: 61,
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
  adoptInspectorPr(pr);
  setInspectorConfig({ enabled: true, mode: "live", repoAllowlist: ["/repo"] });

  const registry = new Registry();
  registry.applyDiscovery([{
    syntheticId: "session",
    agent: "claude",
    name: "work",
    nameSource: "process",
    cwd: "/repo",
    gitBranch: "feature",
    gitRoot: "/repo",
    repoRoot: "/repo",
    pid: 61,
    tty: "ttys61",
    terminals: [mkMuxHandle({ paneId: "%61" })],
    startedAt: 1,
  } as DiscoveredSession]);
  registry.applyHook({
    agent: "claude",
    event: "PostToolUse",
    sessionId: "agent-session",
    cwd: "/repo",
    transcriptPath: null,
    env: { tmuxPane: "%61" },
    prUrl: url,
    prCreated: false,
  });

  let captureHead = newHead;
  const store = new WorkflowStore(db);
  const binding = store.insertBinding({
    id: "b",
    workflowVersionId: "v",
    noteKey: "agent-session",
    sessionId: "session",
    sessionAgent: "claude",
    sessionName: "work",
    sessionCwd: "/repo",
    sessionRepoRoot: "/repo",
    triggerMode: "manual",
    deliveryMode: "preview",
    maxRepairRounds: 3,
    now: 1,
  });
  store.createInitialSubmission(
    { id: "run", binding, triggerSource: "manual", triggerKey: "manual:b:first", now: 2 },
    {
      id: "full-1",
      triggerSource: "manual",
      triggerKey: "manual:b:first",
      context: {},
      evidence: {},
      now: 2,
    },
  );
  const oldContext = captured(oldHead);
  store.updateSubmissionCapture("full-1", {
    context: workflowJson(oldContext),
    evidence: workflowJson(oldContext.evidence),
    fingerprint: "old-fingerprint",
    status: "running",
  }, 2);
  store.setRunState("run", "running", "persona_review", null, 2);

  const manager = new WorkflowManager(registry, store, {
    readContextRaw: async (_registry, activeBinding) => {
      const next = captured(captureHead);
      const raw = {
        primaryGoal: next.primaryGoal,
        humanDecisions: next.humanDecisions,
        priorPersonaFeedback: next.priorPersonaFeedback,
        session: next.session,
        evidence: next.evidence,
      };
      return {
        raw,
        context: fallbackWorkflowContext(raw, null),
        boundary: {
          noteKey: activeBinding.noteKey,
          sessionId: activeBinding.sessionId!,
          headSha: captureHead,
          transcriptPath: null,
          transcriptSize: 0,
          repositoryFingerprint: `repo-${captureHead}`,
        },
      };
    },
    boundaryChanged: async () => false,
    compactContext: async (raw) => fallbackWorkflowContext(raw, null),
  });
  const enteredAt = Date.now() - 1_000;
  assert.equal((manager as unknown as {
    enterInspectorGate(id: string, now: number): boolean;
  }).enterInspectorGate("full-1", enteredAt), true);
  manager.start();

  updateInspectorPr(key, {
    headSha: oldHead,
    lastAttemptSha: oldHead,
    reviewPosture: "live",
    round: 1,
    lastReviewedAt: Date.now(),
  }, Date.now());
  const finding: InspectorComment = {
    id: "finding",
    prKey: key,
    fingerprint: "finding",
    path: "src/file.ts",
    line: 5,
    title: "Repair this",
    body: "The old head is not safe.",
    severity: "major",
    round: 1,
    status: "open",
    replies: 0,
    answeredCommentId: null,
    createdAt: 3,
    updatedAt: 3,
  };
  upsertInspectorComment(finding);
  registry.inspectionUpdated(key, oldHead, "OPEN", Date.now());
  await waitFor(
    () => store.getRun("run")?.status === "waiting_for_session",
    "old-head findings did not prepare repair",
  );
  assert.equal(store.listDeliveries("run").length, 1);

  const resubmitted = await manager.resubmit("run", {
    requestId: "full-repair",
    resubmitUnchanged: false,
  });
  assert.equal(resubmitted.ok, true);
  const latest = store.latestSubmission("run")!;
  assert.equal(latest.mode, "full_workflow");
  assert.equal(latest.round, 2);
  assert.equal(latest.prHeadSha, newHead);
  await waitFor(
    () => store.getRun("run")?.status === "waiting_for_inspector",
    "successful full repair did not enter a second gate",
  );

  // The old ledger approval is current for oldHead only. Even a fresh observation of
  // it after the second entry must not approve the new submission.
  registry.inspectionUpdated(key, oldHead, "OPEN", Date.now());
  await waitFor(
    () => (store.getRun("run")?.gateState as { waitReason?: string })?.waitReason === "head_mismatch",
    "old approval leaked into the second gate",
  );
  assert.notEqual(store.getRun("run")?.status, "completed");

  upsertInspectorComment({ ...finding, status: "resolved", updatedAt: Date.now() });
  updateInspectorPr(key, {
    headSha: newHead,
    lastAttemptSha: newHead,
    reviewPosture: "live",
    round: 2,
    lastReviewedAt: Date.now(),
    lastError: null,
    nextAttemptAt: null,
  }, Date.now());
  registry.inspectionUpdated(key, newHead, "OPEN", Date.now());
  await waitFor(
    () => store.getRun("run")?.status === "completed",
    "new clean committed and pushed head did not complete",
  );
  const finalState = store.getRun("run")?.gateState as unknown as WorkflowInspectorGateState;
  assert.equal(finalState.targetHeadSha, newHead);
  assert.equal(finalState.waitReason, null);
  await manager.stop();
});
