import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type { Task } from "../src/shared/types.ts";
const home = mkdtempSync(join(tmpdir(), "mission-workflow-transfer-"));
process.env.MISSION_HOME = home;
process.env.MISSION_CLAUDE_BIN = process.execPath;
await (await import("./helpers/managed-resume-fixture.ts")).managedResumeFixture(home);
after(() => rmSync(home, { recursive: true, force: true }));
const { transferFixture } = await import("./helpers/session-transfer-fixture.ts");
const { openDb } = await import("../src/server/db.ts");
const { handOffToTerminal } = await import("../src/server/sdk/handoff.ts");
const { getSessionTransfer, runtimeTransferConnects } = await import("../src/server/session-transfers/store.ts");
const { fallbackWorkflowContext } = await import("../src/server/workflows/context.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const { getForemanConfig, setForemanConfig } = await import("../src/server/foreman/config.ts");

for (const boundary of ["timeout", "shutdown"] as const) test(`a transfer-held capture survives ${boundary} as a retryable reservation`, async (t) => {
  const readers: string[] = [];
  const f = transferFixture(t, { workflows: 1, workflowOptions: {
    readContextRaw: async (_registry, binding) => {
      readers.push(binding.sessionId!);
      const raw = {
        primaryGoal: { rawPrompt: "Keep evidence", refined: null, sourceNoteKey: binding.noteKey },
        humanDecisions: [], priorPersonaFeedback: [],
        session: { agent: "claude", name: "work", cwd: binding.sessionCwd, branch: "feature" },
        evidence: { headSha: "a".repeat(40), diffFingerprint: "resumed-capture", diff: "patch", diffTruncated: false,
          workingTreeDirty: false, workingTreeStatus: [], workingTreeStatusTruncated: false,
          transcript: [], transcriptAnchor: 1, transcriptTruncated: false, standards: [], standardsTruncated: false },
      };
      return { raw, context: fallbackWorkflowContext(raw, null), boundary: { noteKey: binding.noteKey,
        sessionId: binding.sessionId!, headSha: raw.evidence.headSha, transcriptPath: null, transcriptSize: 1, repositoryFingerprint: "capture" } };
    }, boundaryChanged: async () => false, compactContext: async (raw) => fallbackWorkflowContext(raw, "fixture"),
  } });
  const result = await handOffToTerminal(f.registry, f.supervisor, f.source, f.deps); assert.ok(result.ok);
  const run = f.store.activeRunForBinding(f.bindings[0]!)!;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const listenerCount = f.registry.listenerCount("event");
  let finished = false;
  const input = { requestId: `wait-${boundary}`, resubmitUnchanged: true };
  const capture = f.workflows.resubmit(run.id, input).then((value) => { finished = true; return value; });
  const reserved = f.store.latestSubmission(run.id)!;
  assert.equal(reserved.status, "capturing");
  assert.deepEqual(readers, []);
  if (boundary === "shutdown") await f.workflows.stop();
  else t.mock.timers.tick(30_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(finished, "the request must finish within its transfer wait budget");
  assert.equal((await capture).ok, false);
  assert.equal(f.store.getRun(run.id)?.currentPhase, "capture_interrupted");
  assert.equal(f.store.getSubmission(reserved.id)?.status, "failed");
  assert.ok(f.registry.listenerCount("event") <= listenerCount, "the transfer waiter unsubscribes");
  t.mock.timers.reset();
  f.discover(); await f.transfers.recheck(result.transfer.id);
  const resumed = await f.workflows.resubmit(run.id, input);
  assert.ok(resumed.ok, JSON.stringify(resumed));
  assert.equal(resumed.value.submission.id, reserved.id);
  assert.equal(resumed.value.submission.round, reserved.round);
  assert.equal(resumed.value.submission.segment, reserved.segment);
  assert.deepEqual(readers, [f.candidate.syntheticId]);
});

test("delivered anchors apply their limit only to the connected transfer chain", async (t) => {
  const f = transferFixture(t, { workflows: 1 });
  const run = f.store.activeRunForBinding(f.bindings[0]!)!;
  const submission = f.store.listSubmissions(run.id)[0]!;
  const result = await handOffToTerminal(f.registry, f.supervisor, f.source, f.deps); assert.ok(result.ok);
  f.discover(); await f.transfers.recheck(result.transfer.id);
  const note = f.source.agentSessionId!;
  const target = f.candidate.syntheticId;
  for (const [index, sessionId] of [f.source.id, target, "unconnected-a", "unconnected-b", "unconnected-c"].entries()) {
    const id = `${run.id}-anchor-${index}`;
    f.store.prepareDelivery({ id, runId: run.id, submissionId: submission.id, kind: "persona_feedback",
      sessionId, noteKey: note, payload: `feedback-${index}`, payloadSha256: `feedback-${index}` }, index + 10);
    // Preserve historical attribution as it stood at send time, before transport adoption.
    openDb().prepare("UPDATE workflow_deliveries SET session_id=? WHERE id=?").run(sessionId, id);
    f.store.setDeliveryState(id, "delivered", null, index + 10);
    f.store.appendEvent(run.id, "delivery_delivered", { deliveryId: id, transcriptAnchor: index + 1 }, index + 10);
  }
  assert.deepEqual(f.store.listDeliveredTranscriptAnchors(target, note, 2), [
    { payload: "feedback-1", transcriptAnchor: 2 }, { payload: "feedback-0", transcriptAnchor: 1 },
  ]);
});

test("injected workflow stores observe uncommitted transfer holds on their own connection", async (t) => {
  const f = transferFixture(t, { workflows: 1 });
  const run = f.store.activeRunForBinding(f.bindings[0]!)!;
  const submission = f.store.listSubmissions(run.id)[0]!;
  const packet = f.store.prepareDelivery({ id: `${run.id}-injected`, runId: run.id, submissionId: submission.id,
    kind: "persona_feedback", sessionId: f.source.id, noteKey: f.source.agentSessionId!, payload: "Held", payloadSha256: "held" }).delivery;
  const result = await handOffToTerminal(f.registry, f.supervisor, f.source, f.deps); assert.ok(result.ok);
  await f.transfers.stop();
  openDb().prepare("UPDATE session_runtime_transfers SET state='aborted' WHERE id=?").run(result.transfer.id);
  const db = new DatabaseSync(join(home, "harness.db"));
  const { WorkflowStore } = await import("../src/server/workflows/store.ts");
  try {
    db.exec("BEGIN IMMEDIATE");
    db.prepare("UPDATE session_runtime_transfers SET state='recovery_required' WHERE id=?").run(result.transfer.id);
    const store = new WorkflowStore(db);
    assert.equal(store.claimDeliverySend(packet.id), null);
    db.prepare("UPDATE session_runtime_transfers SET state='adopted',successor_session_id=? WHERE id=?").run(f.candidate.syntheticId, result.transfer.id);
    db.prepare("UPDATE workflow_bindings SET session_id=? WHERE id=?").run(f.candidate.syntheticId, f.bindings[0]!);
    assert.equal(store.prepareDelivery({ ...packet, id: `${packet.id}-after`, payloadSha256: "after" }).delivery.sessionId, f.candidate.syntheticId);
  } finally { if (db.isTransaction) db.exec("ROLLBACK"); db.close(); }
  assert.equal(f.store.getDelivery(packet.id)?.state, "prepared");
});

test("a coordinator refuses split database ownership before starting a transfer", async (t) => {
  const f = transferFixture(t);
  const db = new DatabaseSync(join(home, "harness.db"));
  const { WorkflowStore } = await import("../src/server/workflows/store.ts");
  const { SessionTransferCoordinator } = await import("../src/server/session-transfers/coordinator.ts");
  const workflows = new WorkflowManager(f.registry, new WorkflowStore(db));
  try {
    assert.throws(() => new SessionTransferCoordinator(f.registry, { workflows, settleTask: () => assert.fail("no settlement") }), /share the daemon database connection/);
    assert.equal(f.counts().stops, 0);
    assert.equal(f.counts().launches, 0);
  } finally { await workflows.stop(); db.close(); }
});

test("a capture already reading source evidence finishes before stop; no capture reads the ownership gap", { timeout: 10000 }, async (t) => {
  let entered!: () => void, release!: () => void;
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  const mayFinish = new Promise<void>((resolve) => { release = resolve; });
  const readers: string[] = [];
  const f = transferFixture(t, { workflows: 1, workflowOptions: {
    readContextRaw: async (_registry, binding) => {
      readers.push(binding.sessionId!); entered(); await mayFinish;
      assert.equal(f.counts().stops, 0, "source remains alive through its evidence read");
      const raw = {
        primaryGoal: { rawPrompt: "Keep evidence", refined: null, sourceNoteKey: binding.noteKey },
        humanDecisions: [], priorPersonaFeedback: [],
        session: { agent: "claude", name: "work", cwd: binding.sessionCwd, branch: "feature" },
        evidence: { headSha: "a".repeat(40), diffFingerprint: "capture-before-stop", diff: "patch", diffTruncated: false,
          workingTreeDirty: false, workingTreeStatus: [], workingTreeStatusTruncated: false,
          transcript: [], transcriptAnchor: 1, transcriptTruncated: false, standards: [], standardsTruncated: false },
      };
      return { raw, context: fallbackWorkflowContext(raw, null), boundary: { noteKey: binding.noteKey,
        sessionId: binding.sessionId!, headSha: raw.evidence.headSha, transcriptPath: null, transcriptSize: 1, repositoryFingerprint: "capture" } };
    },
    boundaryChanged: async () => false,
    compactContext: async (raw) => fallbackWorkflowContext(raw, "fixture"),
  } });
  const run = f.store.activeRunForBinding(f.bindings[0]!)!;
  const capture = f.workflows.resubmit(run.id, { requestId: "capture-before-stop" });
  await reading;
  const transferring = handOffToTerminal(f.registry, f.supervisor, f.source, f.deps);
  while (!f.registry.snapshot().sessionTransfers?.transfers.length) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(f.counts().stops, 0);
  release();
  const captured = await capture; assert.ok(captured.ok, JSON.stringify(captured));
  const result = await transferring; assert.ok(result.ok);
  assert.deepEqual(readers, [f.source.id]);
  const snapshot = openDb().prepare("SELECT context_json,evidence_json FROM workflow_submissions WHERE id=?").get(captured.value.submission.id);
  f.discover(); assert.equal((await f.transfers.recheck(result.transfer.id)).state, "adopted");
  assert.deepEqual(openDb().prepare("SELECT context_json,evidence_json FROM workflow_submissions WHERE id=?").get(captured.value.submission.id), snapshot);
});

for (const change of [
  { name: "without metadata changes", before: {}, after: {} },
  { name: "after a branch update", before: {}, after: { branch: "renamed-after-transfer" } },
  { name: "after dispatch finishes", before: { status: "dispatching" }, after: { status: "running" } },
] satisfies Array<{ name: string; before: Partial<Task>; after: Partial<Task> }>) {
test(`a transferred task preserves its paused workflow decision ${change.name}`, async (t) => {
  const enabled = getForemanConfig().enabled;
  setForemanConfig({ enabled: true });
  t.after(() => setForemanConfig({ enabled }));
  const f = transferFixture(t, { workflows: 1 });
  const binding = f.store.getBinding(f.bindings[0]!)!;
  const workflowId = f.store.getWorkflowVersionById(binding.workflowVersionId)!.workflowId;
  const currentVersionId = f.store.getWorkflow(workflowId)!.currentVersionId;
  assert.notEqual(currentVersionId, binding.workflowVersionId, "the catalog already has a newer version");
  f.registry.upsertTask({ ...f.task!, workflowId, ...change.before });
  openDb().prepare("UPDATE workflow_bindings SET state='paused' WHERE id=?").run(binding.id);
  const result = await handOffToTerminal(f.registry, f.supervisor, f.source, f.deps); assert.ok(result.ok);
  f.discover(); assert.equal((await f.transfers.recheck(result.transfer.id)).state, "adopted");
  const transferred = f.registry.getTask(f.task!.id)!;
  f.registry.upsertTask({ ...transferred, ...change.after });
  f.workflows.reconcileDispatchedTaskWorkflows();
  const assertPaused = () => {
    assert.equal(f.store.activeBindingsForNote(binding.noteKey).length, 0, "same attempt must not bind the newer catalog version");
    assert.equal(f.store.getBinding(binding.id)?.state, "paused");
    assert.equal(f.store.getBinding(binding.id)?.workflowVersionId, binding.workflowVersionId);
  };
  assertPaused();

  await f.workflows.stop();
  const restarted = new WorkflowManager(f.registry, f.store);
  t.after(() => restarted.stop());
  restarted.start();
  restarted.reconcileDispatchedTaskWorkflows();
  assertPaused();

  // A new attempt on this same task and successor must make its own binding decision.
  const current = f.registry.getTask(f.task!.id)!;
  f.registry.upsertTask({ ...current, dispatchedAt: current.dispatchedAt! + 1 });
  restarted.reconcileDispatchedTaskWorkflows();
  const next = f.store.activeBindingsForNote(binding.noteKey);
  assert.equal(next.length, 1, "the transfer guard must not leak into a new task attempt");
  assert.equal(next[0]!.workflowVersionId, currentVersionId);
  assert.equal(f.store.getBinding(binding.id)?.state, "paused");
});
}

for (const task of [true, false]) test(`all old pins, repository siblings and evidence survive a ${task ? "task" : "manual taskless"} transfer`, async (t) => {
  const f = transferFixture(t, { task, workflows: 2 });
  const db = openDb();
  const note = f.source.agentSessionId!;
  db.prepare("INSERT INTO workflow_evidence_owners VALUES (?, 7, 3, 1)").run(note);
  db.prepare(`INSERT INTO workflow_evidence_staging (id,note_key,client_item_id,source_kind,evidence_kind,source_root,source_locator,
    inline_content,command_exit_code,display_name,caption,repository_scope,mime_type,bytes,sha256,generation,state,created_at,updated_at)
    VALUES (?,?,'focused','command','text',?,'node focused','passed',0,'focused','proof','repo-01','text/plain',6,?,7,'staged',1,1)`)
    .run(`e-${note}`,note,f.source.cwd,createHash("sha256").update("passed").digest("hex"));
  db.prepare(`INSERT INTO workflow_evidence_coverage_staging (id,note_key,client_criterion_id,criterion,proof_class,repository_scope,
    source_root,links_json,generation,state,created_at,updated_at) VALUES (?,?,'criterion','Preserve work','focused_execution','repo-01',?,
    '[{"clientItemId":"focused","role":"execution"}]',7,'staged',1,1)`).run(`c-${note}`,note,f.source.cwd);
  const beforeBindings = f.bindings.map((id) => f.store.getBinding(id)!);
  const runIds = beforeBindings.map((b) => f.store.activeRunForBinding(b.id)!.id);
  const frozen = () => runIds.map((id) => ({ run: db.prepare("SELECT * FROM workflow_runs WHERE id=?").get(id),
    submissions: db.prepare("SELECT * FROM workflow_submissions WHERE run_id=? ORDER BY id").all(id) }));
  const staged = () => ["workflow_evidence_owners", "workflow_evidence_staging", "workflow_evidence_coverage_staging"]
    .map((table) => db.prepare(`SELECT * FROM ${table} WHERE note_key=? ORDER BY rowid`).all(note));
  const expectedFrozen = frozen(), expectedStaged = staged();
  const expectedParsed = f.store.listWorkflowEvidence(note);
  assert.equal(expectedParsed.artifacts[0]?.sha256, createHash("sha256").update("passed").digest("hex"));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const result = await handOffToTerminal(f.registry, f.supervisor, f.source, f.deps);
  assert.ok(result.ok);
  t.mock.timers.tick(9000);
  f.registry.applyDiscovery([]);
  assert.equal(f.registry.getSession(f.source.id), undefined);
  for (const id of f.bindings) assert.equal(f.store.getBinding(id)?.state, "active");
  f.discover();
  const adopted = await f.transfers.recheck(result.transfer.id);
  assert.equal(adopted.state, "adopted");
  for (const before of beforeBindings) {
    const after = f.store.getBinding(before.id)!;
    assert.deepEqual({ ...after, sessionId: before.sessionId, updatedAt: before.updatedAt }, before);
    assert.equal(after.sessionId, f.candidate.syntheticId);
    assert.ok(after.workflowVersionId.startsWith("old-"));
  }
  assert.deepEqual(frozen(), expectedFrozen); assert.deepEqual(staged(), expectedStaged);
  assert.deepEqual(f.store.listWorkflowEvidence(note), expectedParsed);
  assert.equal(f.counts().injections, 0, "no automatic workflow resubmission or delivery");
  assert.equal(f.registry.listTasks().filter((row) => row.sessionId === f.candidate.syntheticId).length, task ? 1 : 0);
  await f.transfers.recheck(result.transfer.id);
  assert.deepEqual(frozen(), expectedFrozen);
});

test("only unsent delivery targets move; uncertain and historical packets never replay", async (t) => {
  const f = transferFixture(t, { workflows: 1 });
  const run = f.store.activeRunForBinding(f.bindings[0]!)!;
  const submission = f.store.listSubmissions(run.id)[0]!;
  for (const state of ["prepared", "uncertain", "refused", "delivered"] as const) {
    f.store.prepareDelivery({ id: `${run.id}-${state}`, runId: run.id, submissionId: submission.id, kind: "persona_feedback",
      sessionId: f.source.id, noteKey: f.source.agentSessionId!, payload: state, payloadSha256: state });
    if (state !== "prepared") f.store.setDeliveryState(`${run.id}-${state}`, state, null);
  }
  const result = await handOffToTerminal(f.registry, f.supervisor, f.source, f.deps); assert.ok(result.ok);
  assert.equal(f.store.claimDeliverySend(`${run.id}-prepared`), null);
  f.discover(); assert.equal((await f.transfers.recheck(result.transfer.id)).state, "adopted");
  for (const state of ["prepared", "uncertain", "refused", "delivered"] as const) {
    const delivery = f.store.getDelivery(`${run.id}-${state}`)!;
    assert.equal(delivery.state, state);
    assert.equal(delivery.sessionId, state === "prepared" ? f.candidate.syntheticId : f.source.id);
    assert.equal(delivery.payloadSha256, state);
  }
  assert.equal(f.store.claimDeliverySend(`${run.id}-uncertain`, true), null);
  assert.equal(f.store.claimDeliverySend(`${run.id}-delivered`, true), null);
  assert.ok(runtimeTransferConnects(f.source.id, f.candidate.syntheticId, f.source.agentSessionId!));
  assert.equal(f.counts().injections, 0);
});

test("a conflicting sibling leaves all ownership unchanged, and transactional adoption rolls back on an owner failure", async (t) => {
  const f = transferFixture(t, { workflows: 2 });
  const result = await handOffToTerminal(f.registry, f.supervisor, f.source, f.deps); assert.ok(result.ok);
  const db = openDb();
  db.prepare("UPDATE workflow_bindings SET session_cwd = '/changed' WHERE id=?").run(f.bindings[1]!);
  f.discover();
  assert.equal((await f.transfers.recheck(result.transfer.id)).state, "recovery_required");
  assert.equal(f.registry.getTask(f.task!.id)?.sessionId, null);
  for (const id of f.bindings) assert.equal(f.store.getBinding(id)?.sessionId, f.source.id);
  const expected = getSessionTransfer(result.transfer.id)!.facts.bindings[1]!;
  db.prepare("UPDATE workflow_bindings SET session_cwd=? WHERE id=?").run(expected.sessionCwd, expected.id);
  const original = f.store.transferRuntimeBindings.bind(f.store);
  const mocked = t.mock.method(f.store, "transferRuntimeBindings", (...args: Parameters<typeof original>) => { original(...args); throw new Error("fail after owner writes"); });
  await f.transfers.recheck(result.transfer.id);
  assert.equal(f.registry.getTask(f.task!.id)?.sessionId, null);
  for (const id of f.bindings) assert.equal(f.store.getBinding(id)?.sessionId, f.source.id);
  mocked.mock.restore();
  assert.equal((await f.transfers.recheck(result.transfer.id)).state, "adopted");
});

test("feedback prepared by an evaluator after adoption targets the committed successor", async (t) => {
  const f = transferFixture(t, { workflows: 1 });
  const run = f.store.activeRunForBinding(f.bindings[0]!)!;
  const submission = f.store.listSubmissions(run.id)[0]!;
  const result = await handOffToTerminal(f.registry, f.supervisor, f.source, f.deps); assert.ok(result.ok);
  f.discover(); await f.transfers.recheck(result.transfer.id);
  const packet = f.store.prepareDelivery({ id: `late-${run.id}`, runId: run.id, submissionId: submission.id,
    sessionId: f.source.id, noteKey: f.source.agentSessionId!, kind: "persona_feedback", payload: "late immutable feedback", payloadSha256: "late" });
  assert.equal(packet.delivery.sessionId, f.candidate.syntheticId);
  assert.equal(packet.delivery.state, "prepared");
  assert.equal(f.counts().injections, 0, "preview stays preview");
});

for (const authorized of [true, false]) test(`an unsent live packet resumes through current consent gates: authorized=${authorized}`, async (t) => {
  const { getWorkflowPolicy, setWorkflowPolicy } = await import("../src/server/workflows/config.ts");
  const priorPolicy = getWorkflowPolicy(); t.after(() => setWorkflowPolicy(priorPolicy));
  const f = transferFixture(t, { workflows: 1 });
  const run = f.store.activeRunForBinding(f.bindings[0]!)!;
  const submission = f.store.listSubmissions(run.id)[0]!;
  openDb().prepare("UPDATE workflow_bindings SET delivery_mode='live' WHERE id=?").run(f.bindings[0]!);
  setWorkflowPolicy({ liveEnabled: true, repoAllowlist: [f.source.cwd!] });
  const result = await handOffToTerminal(f.registry, f.supervisor, f.source, f.deps); assert.ok(result.ok);
  // An evaluator completed while its transport was held. This is a packet the normal
  // restart policy may send, unlike an arbitrary prepared Preview packet.
  f.store.setRunState(run.id, "waiting_for_session", "unchanged_evidence", null);
  const packet = f.store.prepareDelivery({ id: `held-${run.id}`, runId: run.id, submissionId: submission.id,
    kind: "unchanged_evidence_nudge", sessionId: f.source.id, noteKey: f.source.agentSessionId!, payload: "Held feedback", payloadSha256: "held" }).delivery;
  if (!authorized) setWorkflowPolicy({ liveEnabled: false });
  f.discover(); await f.transfers.recheck(result.transfer.id);
  for (let i = 0; i < 100 && f.store.getDelivery(packet.id)?.state === "sending"; i++) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(f.store.getDelivery(packet.id)?.state, authorized ? "delivered" : "refused");
  assert.equal(f.store.getDelivery(packet.id)?.sessionId, f.candidate.syntheticId);
  assert.equal(f.counts().injections, authorized ? 1 : 0);
  await f.transfers.recheck(result.transfer.id);
  assert.equal(f.counts().injections, authorized ? 1 : 0);
});

test("restart completes failure settlement interrupted after the durable decision", async (t) => {
  const f = transferFixture(t, { workflows: 2 });
  const result = await handOffToTerminal(f.registry, f.supervisor, f.source, f.deps); assert.ok(result.ok);
  await f.transfers.stop();
  const { updateSessionTransfer } = await import("../src/server/session-transfers/store.ts");
  const { revokeResumeLease } = await import("../src/server/terminal/resume-lease.ts");
  assert.ok(revokeResumeLease(f.prepared().lease));
  updateSessionTransfer(getSessionTransfer(result.transfer.id)!, { state: "failed" });
  const { SessionTransferCoordinator } = await import("../src/server/session-transfers/coordinator.ts");
  const restarted = new SessionTransferCoordinator(f.registry, { workflows: f.workflows, reviews: f.reviews,
    settleTask: (id) => f.tasks.settleAfterFailedHandoff(id) });
  restarted.start(); t.after(() => restarted.stop());
  assert.equal(f.registry.getTask(f.task!.id)?.status, "failed");
  assert.equal(f.registry.getTask(f.task!.id)?.worktreePath, f.task!.worktreePath);
  for (const id of f.bindings) assert.equal(f.store.getBinding(id)?.state, "orphaned");
  assert.equal(openDb().prepare("SELECT COUNT(*) AS n FROM task_worktree_returns WHERE task_id=?").get(f.task!.id)!.n, 0);
});
