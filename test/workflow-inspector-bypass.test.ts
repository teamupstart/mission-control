import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { WorkflowInspectorGateState } from "../src/shared/workflow.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";

// What is at stake: Inspector-only repair is a narrow, published bypass. It may advance
// only to a genuinely new PR head, creates no Persona attempt, and leaves enough audit
// to prove exactly which failed head and findings were bypassed.
const home = mkdtempSync(join(tmpdir(), "mission-workflow-inspector-bypass-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { adoptInspectorPr, openDb } = await import("../src/server/db.ts");
const { setInspectorConfig } = await import("../src/server/inspector/config.ts");
const { Registry } = await import("../src/server/registry.ts");
const { fallbackWorkflowContext } = await import("../src/server/workflows/context.ts");
const { priorFindingFingerprintAudit } = await import("../src/server/workflows/finding-audit.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const { WorkflowStore } = await import("../src/server/workflows/store.ts");

const db = openDb();
setInspectorConfig({ enabled: true, mode: "live", repoAllowlist: ["/repo"] });
const policy = JSON.stringify({
  kind: "inspector",
  onFindings: "inspector_only",
  missingPrAction: "wait",
});
const defaults = JSON.stringify({
  triggerMode: "manual",
  deliveryMode: "preview",
  maxRepairRounds: 1,
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
   ) VALUES ('w', 'Bypass', 'bypass', '', ?, ?, ?, 1, 'v', NULL, 1, 1)`,
).run(graph, policy, defaults);
db.prepare(
  `INSERT INTO workflow_versions (
     id, workflow_id, version, source_draft_revision, graph_json,
     completion_policy_json, binding_defaults_json, published_at
   ) VALUES ('v', 'w', 1, 1, ?, ?, ?, 1)`,
).run(graph, policy, defaults);

const store = new WorkflowStore(db);
adoptInspectorPr({
  key: "owner/repo#44",
  url: "https://github.com/owner/repo/pull/44",
  owner: "owner",
  repo: "repo",
  number: 44,
  repoRoot: "/repo",
  cwd: "/repo",
  sessionId: "session",
  source: "hook",
  state: "open",
  headSha: null,
  reviewPosture: "live",
  round: 1,
  lastReviewedAt: null,
  lastError: null,
  failCount: 0,
  lastFailKind: null,
  nextAttemptAt: null,
  lastAttemptSha: null,
  mergedAt: null,
  mergeBlock: null,
  observedHeadSha: null,
  observedState: null,
  observedAt: null,
  headRefName: null,
  adoptedAt: 1,
  updatedAt: 1,
});
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
  maxRepairRounds: 1,
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
const initial: WorkflowInspectorGateState = {
  prKey: "owner/repo#44",
  prUrl: "https://github.com/owner/repo/pull/44",
  targetHeadSha: "old-head",
  failedHeadSha: "old-head",
  enteredAt: 2,
  lastObservedAt: 3,
  observedHeadSha: "old-head",
  reviewPosture: "live",
  waitReason: "findings",
  findingFingerprints: ["finding-a"],
};
store.setSubmissionState("full-1", "completed", 3);
db.prepare(`UPDATE workflow_submissions SET pr_head_sha = 'old-head' WHERE id = 'full-1'`).run();
store.setRunState("run", "waiting_for_new_head", "inspector_findings", initial as never, 3);

test("large bypass audits retain identity without exceeding event limits", () => {
  const fingerprints = Array.from(
    { length: 2_000 },
    (_, index) => `${index.toString(16).padStart(64, "0")}`,
  );
  const audit = priorFindingFingerprintAudit(fingerprints);
  assert.equal(audit.priorFindingFingerprints.length, 100);
  assert.equal(audit.priorFindingFingerprintsTruncated, true);
  assert.equal(audit.priorFindingFingerprintCount, fingerprints.length);
  assert.match(audit.priorFindingFingerprintsSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.ok(Buffer.byteLength(JSON.stringify(audit), "utf8") < 64_000);
});

test("same-head retry fails closed and a new head creates an attempt-free audited submission", () => {
  const same = store.createInspectorOnlySubmission({
    id: "same-head",
    runId: "run",
    triggerKey: "inspector-head:run:old-head",
    newHeadSha: "old-head",
    failedHeadSha: "old-head",
    priorFindingFingerprints: ["finding-a"],
    bypassReason: "Published Inspector-only findings policy",
    expectedState: initial,
    state: initial,
    now: 4,
  });
  assert.equal(same, null);

  const nextState: WorkflowInspectorGateState = {
    ...initial,
    targetHeadSha: "new-head",
    observedHeadSha: "new-head",
    waitReason: "review_pending",
  };
  const created = store.createInspectorOnlySubmission({
    id: "inspector-only-1",
    runId: "run",
    triggerKey: "inspector-head:run:new-head",
    newHeadSha: "new-head",
    failedHeadSha: "old-head",
    priorFindingFingerprints: ["finding-a"],
    bypassReason: "Published Inspector-only findings policy",
    expectedState: initial,
    state: nextState,
    now: 5,
  });
  assert.ok(created);
  assert.equal(created.submission.mode, "inspector_only");
  assert.equal(created.submission.status, "completed");
  assert.equal(created.submission.prHeadSha, "new-head");
  assert.equal(store.listAttempts(created.submission.id).length, 0);
  assert.equal(store.runSummary("run")?.bypassedPersonaReview, true);
  const audit = store.listEvents("run").find((event) => event.kind === "inspector_persona_bypass_used");
  assert.deepEqual(audit?.payload, {
    submissionId: "inspector-only-1",
    failedHeadSha: "old-head",
    newHeadSha: "new-head",
    priorFindingFingerprints: ["finding-a"],
    bypassReason: "Published Inspector-only findings policy",
  });
});

test("repeat findings keep waiting on known heads and cannot reuse any reviewed head", async () => {
  const current = store.getRun("run")!.gateState as unknown as WorkflowInspectorGateState;
  const findingsAgain: WorkflowInspectorGateState = {
    ...current,
    failedHeadSha: "new-head",
    waitReason: "findings",
    findingFingerprints: ["finding-b"],
  };
  const waiting = store.updateInspectorGate({
    runId: "run",
    expectedState: current,
    state: findingsAgain,
    status: "waiting_for_new_head",
    phase: "inspector_findings",
    now: 6,
  });
  assert.ok(waiting);
  const manager = new WorkflowManager(new Registry(), store);
  await (manager as unknown as {
    evaluateInspectorGate(id: string, observation: null): Promise<void>;
  }).evaluateInspectorGate("run", null);
  assert.equal(store.getRun("run")?.status, "waiting_for_new_head");
  assert.equal(store.getRun("run")?.currentPhase, "inspector_findings");
  await manager.stop();

  const reused = store.createInspectorOnlySubmission({
    id: "reused",
    runId: "run",
    triggerKey: "inspector-head:run:old-head-again",
    newHeadSha: "old-head",
    failedHeadSha: "new-head",
    priorFindingFingerprints: ["finding-b"],
    bypassReason: "Published Inspector-only findings policy",
    expectedState: findingsAgain,
    state: { ...findingsAgain, targetHeadSha: "old-head" },
    now: 7,
  });
  assert.equal(reused, null, "a prior full-workflow head cannot be recycled");

  const capped = store.createInspectorOnlySubmission({
    id: "over-cap",
    runId: "run",
    triggerKey: "inspector-head:run:newer-head",
    newHeadSha: "newer-head",
    failedHeadSha: "new-head",
    priorFindingFingerprints: ["finding-b"],
    bypassReason: "Published Inspector-only findings policy",
    expectedState: findingsAgain,
    state: { ...findingsAgain, targetHeadSha: "newer-head" },
    now: 8,
  });
  assert.equal(capped, null, "round 2 already exceeds maxRepairRounds 1");
});

test("a refused Inspector-only feedback retry returns to the new-head wait", () => {
  const current = store.getRun("run")!.gateState as unknown as WorkflowInspectorGateState;
  const delivery = store.prepareDelivery({
    id: "inspector-feedback-retry",
    runId: "run",
    submissionId: "inspector-only-1",
    kind: "inspector_feedback",
    sessionId: "session",
    noteKey: "agent-session",
    payload: "repair the current Inspector findings",
    payloadSha256: "a".repeat(64),
  }, 8).delivery;
  assert.equal(store.claimDeliverySend(delivery.id, false, 9)?.state, "sending");
  assert.equal(store.finishDeliverySend(delivery.id, "refused", "pane_blocked", 10)?.state, "refused");
  store.setRunState("run", "blocked", "delivery_refused", current as never, 10);

  assert.equal(store.claimDeliverySend(delivery.id, true, 11)?.state, "sending");
  const confirmed = store.confirmDeliverySend(delivery.id, null, false, 12);
  assert.ok(confirmed);
  assert.equal(store.getRun("run")?.status, "waiting_for_new_head");
  assert.deepEqual(store.getRun("run")?.gateState, current);
});

test("uncertain Inspector-only feedback cannot escape policy and confirmed delivery resumes the new-head wait", async () => {
  const current = store.getRun("run")!.gateState as unknown as WorkflowInspectorGateState;
  const delivery = store.prepareDelivery({
    id: "inspector-feedback-uncertain",
    runId: "run",
    submissionId: "full-1",
    kind: "inspector_feedback",
    sessionId: "session",
    noteKey: "agent-session",
    payload: "repair packet whose send result was lost",
    payloadSha256: "b".repeat(64),
  }, 13).delivery;
  store.claimDeliverySend(delivery.id, false, 14);
  store.finishDeliverySend(delivery.id, "uncertain", "daemon_restarted", 15);
  store.setRunState("run", "blocked", "delivery_uncertain", current as never, 15);

  const manager = new WorkflowManager(new Registry(), store);
  const beforeDiscard = store.listSubmissions("run").length;
  const discarded = await manager.resolveDelivery(delivery.id, {
    requestId: "discard-inspector-only",
    resolution: "discard_and_new_round",
    confirmation: "DISCARD AND SEND A NEW REPAIR ROUND",
    expectedSessionId: "session",
    expectedNoteKey: "agent-session",
  }, 16);
  assert.equal(discarded.ok, false);
  if (!discarded.ok) assert.equal(discarded.reason, "invalid_delivery_state");
  assert.equal(store.getDelivery(delivery.id)?.state, "uncertain");
  assert.equal(store.listSubmissions("run").length, beforeDiscard);

  const resolved = store.resolveUncertainDelivery(
    delivery.id,
    "mark_delivered",
    "mark-inspector-delivered",
    17,
  );
  assert.ok(resolved);
  assert.equal(store.getRun("run")?.status, "waiting_for_new_head");
  assert.equal(store.getRun("run")?.currentPhase, "inspector_findings");
  assert.deepEqual(store.getRun("run")?.gateState, current);
  await manager.stop();
});

test("a Foreman completion claim cannot create a full submission during the new-head wait", () => {
  db.prepare(
    `INSERT INTO foreman_queues (
       note_key, cwd, branch, wrapup_asked_at, wrapup_answer, prompted_goal, updated_at
     ) VALUES ('agent-session', '/repo', 'feature', NULL, NULL, NULL, 12)`,
  ).run();
  db.prepare(
    `INSERT INTO foreman_queue_items (
       id, note_key, seq, intent, state, round, gaps, revision, created_at, updated_at, completed_at
     ) VALUES (
       'inspector-foreman-item', 'agent-session', 0, 'repair findings', 'verified',
       1, '[]', 0, 12, 12, 12
     )`,
  ).run();
  const before = store.listSubmissions("run").length;

  const claim = store.claimForemanCompletion({
    binding,
    fallbackBinding: null,
    completionKind: "drain",
    marker: "inspector-new-head-wait",
    summary: "Foreman observed a completed repair.",
    evidenceFingerprint: "foreman-head",
    expectedIntent: null,
    runId: "must-not-create-run",
    submissionId: "must-not-create-submission",
    now: 13,
  });

  assert.equal(claim.result.claimed, true);
  assert.equal(claim.result.state, "blocked");
  assert.equal(claim.result.submissionId, null);
  assert.equal(claim.created, false);
  assert.equal(store.listSubmissions("run").length, before);
  assert.equal(store.getRun("run")?.status, "waiting_for_new_head");
  assert.equal(
    store.listEvents("run").some((event) => event.kind === "workflow_completion_blocked"),
    true,
  );
});

test("PR switching blocks, and full restart requires confirmation before abandoning bypass", async () => {
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
    pid: 44,
    tty: "ttys44",
    terminals: [mkMuxHandle({ paneId: "%44" })],
    startedAt: 1,
  } as DiscoveredSession]);
  registry.applyHook({
    agent: "claude",
    event: "PostToolUse",
    sessionId: "agent-session",
    cwd: "/repo",
    transcriptPath: null,
    env: { tmuxPane: "%44" },
    prUrl: "https://github.com/owner/repo/pull/45",
    prCreated: false,
  });
  const manager = new WorkflowManager(registry, store, {
    readContextRaw: async (_registry, activeBinding) => {
      const raw = {
        primaryGoal: {
          rawPrompt: "Ship the reviewed change",
          refined: null,
          sourceNoteKey: activeBinding.noteKey,
        },
        humanDecisions: [],
        priorPersonaFeedback: [],
        session: { agent: "claude" as const, name: "work", cwd: "/repo", branch: "feature" },
        evidence: {
          headSha: "newer-head",
          diffFingerprint: "newer-diff",
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
      };
      return {
        raw,
        context: fallbackWorkflowContext(raw, null),
        boundary: {
          noteKey: activeBinding.noteKey,
          sessionId: activeBinding.sessionId!,
          headSha: "newer-head",
          transcriptPath: null,
          transcriptSize: 0,
          repositoryFingerprint: "repo-newer",
        },
      };
    },
    boundaryChanged: async () => false,
    compactContext: async (raw) => fallbackWorkflowContext(raw, null),
  });
  await (manager as unknown as {
    evaluateInspectorGate(id: string, observation: null): Promise<void>;
  }).evaluateInspectorGate("run", null);
  assert.equal(store.getRun("run")?.currentPhase, "inspector_pr_switch_refused");
  const genericResubmit = await manager.resubmit("run", {
    requestId: "generic-escape",
    resubmitUnchanged: false,
  });
  assert.equal(genericResubmit.ok, false);
  if (!genericResubmit.ok) assert.equal(genericResubmit.reason, "run_not_waiting");

  const noConfirmation = await manager.restartFull("run", { requestId: "restart-1" }, 9);
  assert.equal(noConfirmation.ok, false);
  if (!noConfirmation.ok) assert.equal(noConfirmation.reason, "confirmation_required");

  db.prepare(`UPDATE workflow_runs SET max_repair_rounds = 3 WHERE id = 'run'`).run();
  const restarted = await manager.restartFull("run", {
    requestId: "restart-2",
    confirmation: "RESTART FULL WORKFLOW",
  }, 10);
  assert.equal(restarted.ok, true);
  assert.equal(store.latestSubmission("run")?.mode, "full_workflow");
  assert.equal(store.getRun("run")?.gateState, null);
  assert.equal(
    store.listEvents("run").some((event) => event.kind === "inspector_only_abandoned_for_full_restart"),
    true,
  );
  await manager.stop();
});
