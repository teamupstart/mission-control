import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * What is at stake: the N-to-one boundary where a finalized winner is handed to the shipped
 * one-Session Workflow engine. The failures it must rule out are all ways a handoff creates
 * duplicate or wrong Workflow state: a second binding on a restart, a submission of a winner whose
 * checkout drifted, a hidden Preview downgrade of a Live selection, a note conflict silently
 * adopted, a run that both hands off AND types a shipping continuation. Each test drives the engine
 * against a fake Workflow boundary so the whole handoff state machine is exercised without a real
 * WorkflowManager, and asserts the exactly-once, exact-clean, block-visibly contract.
 */

const home = mkdtempSync(join(tmpdir(), "mission-ensemble-handoff-"));
process.env.HARNESS_HOME = join(home, "state");

import { mkTask } from "./helpers/session-fixture.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
const { openDb } = await import("../src/server/db.ts");
const { EnsembleStore, clearEnsembleTables } = await import("../src/server/ensembles/store.ts");
const { EnsembleEngine } = await import("../src/server/ensembles/engine.ts");
const { EnsembleManager } = await import("../src/server/ensembles/manager.ts");
const { Registry } = await import("../src/server/registry.ts");
const { FakeGateway, FakeFinalize, FakeWorkflow, stubAdapters, decidePlan, runInsert } = await import("./ensemble-fixture.ts");
import type { EnsembleWorkflowHandoff } from "../src/shared/ensemble.ts";

function discovered(over: Partial<DiscoveredSession> = {}): DiscoveredSession {
  return {
    syntheticId: "ens",
    agent: "claude",
    name: "Ensemble member",
    nameSource: "process",
    cwd: "/ens-wt",
    gitBranch: null,
    gitRoot: null,
    repoRoot: null,
    nomistakesGated: false,
    pid: 1,
    tty: "ttys77",
    terminals: [],
    startedAt: 0,
    ...over,
  };
}

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => clearEnsembleTables(db));

const PINNED: EnsembleWorkflowHandoff = {
  workflowId: "wf-1",
  workflowVersionId: "wfv-1",
  workflowVersion: 1,
  workflowName: "Ship it",
  triggerMode: "manual",
  deliveryMode: "preview",
  maxRepairRounds: 3,
  completionPolicy: "none",
  state: "pending",
  sourceKey: null,
  expectedHeadSha: null,
  bindingId: null,
  runId: null,
  submissionId: null,
  error: null,
};

function harness(finalize: InstanceType<typeof FakeFinalize>) {
  const store = new EnsembleStore(db);
  const gateway = new FakeGateway();
  const engine = new EnsembleEngine({ store, tasks: gateway, publish: () => {}, adapters: stubAdapters(), finalize, now: () => 1000, armTimer: () => () => {} });
  return { store, gateway, engine };
}

async function driveToDecision(store: InstanceType<typeof EnsembleStore>, gateway: InstanceType<typeof FakeGateway>, engine: InstanceType<typeof EnsembleEngine>, handoff: EnsembleWorkflowHandoff | null) {
  const { run } = store.createRun(runInsert(decidePlan(3, 2), { workflowHandoff: handoff }));
  await engine.launch(run.id);
  for (const dispatch of [...gateway.dispatched]) {
    gateway.running(dispatch.taskId, `/wt/${dispatch.taskId}`);
    await engine.wake(run.id);
    const memberId = store.listAttempts(run.id).find((a) => a.taskId === dispatch.taskId)!.memberId;
    await engine.submit({ runId: run.id, memberId, claims: { summary: "did it", checks: [], testEvidence: null }, source: "mcp", requireWorktree: null });
  }
  return run.id;
}

function winnerArtifact(store: InstanceType<typeof EnsembleStore>, runId: string) {
  const member = store.listMembers(runId).find((m) => m.ordinal === 1)!;
  const attemptIds = new Set(store.listAttempts(runId).filter((a) => a.memberId === member.id).map((a) => a.id));
  return store.listArtifacts(runId).find((a) => a.status === "ready" && a.kind === "commit" && a.attemptId !== null && attemptIds.has(a.attemptId))!;
}

function decide(engine: InstanceType<typeof EnsembleEngine>, runId: string, artifactId: string, requestId = "req-1") {
  return engine.decide({ runId, requestId, expectedStatus: "awaiting_decision", selection: { kind: "selected", artifactId }, rationale: "ship this one", actorId: null });
}

// ---- the handoff ----

test("a pinned handoff binds and submits the exact clean snapshot once, and sends NO continuation", async () => {
  const finalize = new FakeFinalize();
  const workflow = new FakeWorkflow();
  finalize.workflow = workflow;
  const { store, gateway, engine } = harness(finalize);
  const runId = await driveToDecision(store, gateway, engine, PINNED);
  const artifact = winnerArtifact(store, runId);
  await decide(engine, runId, artifact.id);

  const run = store.getRun(runId)!;
  assert.equal(run.status, "completed");
  assert.equal(workflow.bindings.length, 1, "exactly one external binding");
  assert.equal(workflow.submits.length, 1, "exactly one external submission");
  // The submission was pinned to the winner's exact snapshot.
  const snapshotSha = (artifact.locator as { snapshotSha: string }).snapshotSha;
  assert.equal(workflow.submits[0]!.expectedHeadSha, snapshotSha);
  const handoff = run.workflowHandoff!;
  assert.equal(handoff.state, "submitted");
  assert.equal(handoff.bindingId, "binding-1");
  assert.equal(handoff.runId, "wfrun-1");
  assert.equal(handoff.expectedHeadSha, snapshotSha);
  assert.equal(finalize.continuations.length, 0, "a Workflow handoff never also types the shipping continuation");
});

test("a note conflict blocks visibly; the operator can skip and finish with the continuation", async () => {
  const finalize = new FakeFinalize();
  const workflow = new FakeWorkflow();
  workflow.bindResult = { ok: false, reason: "conflict", detail: "another active binding owns this note" };
  finalize.workflow = workflow;
  const { store, gateway, engine } = harness(finalize);
  const runId = await driveToDecision(store, gateway, engine, PINNED);
  const artifact = winnerArtifact(store, runId);
  await decide(engine, runId, artifact.id);

  // Blocked, not adopted: the run stays finalizing with the typed conflict, nothing submitted.
  let run = store.getRun(runId)!;
  assert.equal(run.status, "finalizing");
  assert.equal(run.workflowHandoff!.state, "conflict");
  assert.equal(workflow.submits.length, 0, "a conflict never submits into the conflicting binding");
  assert.equal(finalize.continuations.length, 0);

  // Skip the handoff: the run finishes with the normal continuation instead, exactly once.
  const resolved = await engine.resolveFinalization(runId, true);
  assert.equal(resolved.ok, true);
  run = store.getRun(runId)!;
  assert.equal(run.status, "completed");
  assert.equal(run.workflowHandoff!.state, "skipped");
  assert.equal(finalize.continuations.length, 1, "the skipped handoff finishes with one continuation");
});

test("a replacement waiting on handoff receives continuation when handoff is skipped", async () => {
  const finalize = new FakeFinalize();
  finalize.safeIdle = false;
  const workflow = new FakeWorkflow();
  workflow.bindResult = { ok: false, reason: "conflict", detail: "another active binding owns this note" };
  finalize.workflow = workflow;
  const { store, gateway, engine } = harness(finalize);
  const runId = await driveToDecision(store, gateway, engine, PINNED);
  const artifact = winnerArtifact(store, runId);
  await decide(engine, runId, artifact.id);
  assert.equal(store.getRun(runId)!.status, "finalizing");
  assert.equal(finalize.materialized.length, 1);
  assert.equal(finalize.continuations.length, 0);

  await engine.resolveFinalization(runId, true);
  assert.equal(store.getRun(runId)!.status, "completed");
  assert.equal(finalize.continuations.length, 1);
});

test("a capture mismatch restores the winner and resumes the SAME submission - never a second binding", async () => {
  const finalize = new FakeFinalize();
  const workflow = new FakeWorkflow();
  workflow.submitResult = { ok: false, reason: "mismatch", detail: "HEAD drifted" };
  finalize.workflow = workflow;
  const { store, gateway, engine } = harness(finalize);
  const runId = await driveToDecision(store, gateway, engine, PINNED);
  const artifact = winnerArtifact(store, runId);
  const restoresBefore = finalize.restored.length;
  await decide(engine, runId, artifact.id);

  // The mismatch is healed by restoring the winner exactly; the run stays finalizing to resume.
  let run = store.getRun(runId)!;
  assert.equal(run.status, "finalizing");
  assert.equal(workflow.bindings.length, 1, "one binding");
  assert.ok(finalize.restored.length > restoresBefore, "the winner was restored to heal the mismatch");
  assert.equal(run.workflowHandoff!.bindingId, "binding-1", "the binding is kept for the resume");

  // Now the capture succeeds: resume submits into the SAME binding, without creating a second.
  workflow.submitResult = { ok: true, runId: "wfrun-1", submissionId: "wfsub-1" };
  const resolved = await engine.resolveFinalization(runId, false);
  assert.equal(resolved.ok, true);
  run = store.getRun(runId)!;
  assert.equal(run.status, "completed");
  assert.equal(workflow.bindings.length, 1, "the resume did not create a second binding");
  assert.equal(workflow.submits.length, 2, "the same external submission was resumed");
  assert.equal(run.workflowHandoff!.state, "submitted");
});

test("a crash after binding but before submit reuses the same binding on recovery", async () => {
  const finalize = new FakeFinalize();
  const workflow = new FakeWorkflow();
  // Bind succeeds, but submit throws once (a crash mid-submit) - the binding is durable, the run is not done.
  workflow.submitResult = { ok: false, reason: "other", detail: "the daemon exited mid-submit" };
  finalize.workflow = workflow;
  const { store, gateway, engine } = harness(finalize);
  const runId = await driveToDecision(store, gateway, engine, PINNED);
  const artifact = winnerArtifact(store, runId);
  await decide(engine, runId, artifact.id);
  assert.equal(store.getRun(runId)!.status, "finalizing");
  assert.equal(store.getRun(runId)!.workflowHandoff!.bindingId, "binding-1");
  assert.equal(workflow.bindings.length, 1);

  // Recovery re-drives: the persisted binding id means ensureBinding is NOT called again.
  workflow.submitResult = { ok: true, runId: "wfrun-1", submissionId: "wfsub-1" };
  await engine.recover(runId);
  assert.equal(store.getRun(runId)!.status, "completed");
  assert.equal(workflow.bindings.length, 1, "recovery reused the same binding");
});

// ---- the manual-binding guard ----

test("an active ensemble member's session cannot be bound to a workflow; a settled one can", () => {
  const registry = new Registry();
  registry.applyDiscovery([discovered()]);
  const store = new EnsembleStore(db);
  const manager = new EnsembleManager(registry, store);
  registry.upsertTask(mkTask({ id: "task-ens", status: "running", sessionId: "ens", worktreePath: "/ens-wt" }));
  const created = manager.create({
    sourceKey: "guard:1",
    sourceKind: "manual",
    sourceId: null,
    title: "guard",
    intent: "implement",
    repoRoot: "/repo",
    strategyId: "best_of_n",
    strategyConfig: { members: [{}, {}] },
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const member = store.listMembers(created.run.id)[0]!;
  store.reserveAttempt(
    { runId: created.run.id, memberId: member.id, attempt: 1, taskId: "task-ens", sessionId: null, agent: null, requestedModel: null, requestedEffort: null, baseSha: null, worktreePath: null, branch: null, status: "pending" },
    ["pending"],
  );
  // A launching (active) member owns the session - refused, with a human sentence.
  assert.match(manager.canBindSessionToWorkflow("ens") ?? "", /active ensemble member/);
  // The winner is bound only AFTER it is marked retained, and by then the session is eligible.
  store.setMemberStatus(member.id, ["launching"], "retained", {});
  assert.equal(manager.canBindSessionToWorkflow("ens"), null);
  // A session running no ensemble member is always eligible.
  assert.equal(manager.canBindSessionToWorkflow("nobody"), null);
});

test("no Workflow module imports the Ensemble store - the guard is a one-way answer", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const dir = fileURLToPath(new URL("../src/server/workflows/", import.meta.url));
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts")) continue;
    const src = readFileSync(join(dir, file), "utf8");
    assert.doesNotMatch(src, /ensembles\/(store|manager|engine)/, `${file} must not import the ensemble store/manager/engine`);
  }
});
