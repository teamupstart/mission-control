import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SdkSupervisor } from "../src/server/sdk/supervisor.ts";

const home = mkdtempSync(join(tmpdir(), "mission-runtime-transfer-"));
process.env.MISSION_HOME = home;
process.env.MISSION_CLAUDE_BIN = process.execPath;
await (await import("./helpers/managed-resume-fixture.ts")).managedResumeFixture(home);
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { handOffToTerminal } = await import("../src/server/sdk/handoff.ts");
const { mkTask } = await import("./helpers/session-fixture.ts");
const { transferFixture } = await import("./helpers/session-transfer-fixture.ts");
const { getSessionTransfer, updateSessionTransfer, transferForSource } = await import("../src/server/session-transfers/store.ts");
const { SessionTransferCoordinator } = await import("../src/server/session-transfers/coordinator.ts");
const { openDb } = await import("../src/server/db.ts");
after(() => rmSync(home, { recursive: true, force: true }));

test("an early resume hook cannot revive the retiring SDK or rebind its reserved task", async (t) => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  registry.registerSdkSession({ id: "sdk:early", agent: "claude", name: "Transfer", cwd: "/fixture/checkout" });
  registry.applyDriverEvent("sdk:early", { kind: "bound", agentSessionId: "native-early", transcriptPath: null, modelId: null, pid: null });
  registry.upsertTask(mkTask({ id: "task-early", sessionId: "sdk:early", status: "running", worktreePath: "/fixture/checkout" }));
  const source = registry.getSession("sdk:early")!;
  const events: string[] = [];
  registry.subscribe((event) => { if (event.type === "task_upsert" && event.task.id === "task-early") events.push(event.task.status); });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const supervisor = {
    handleFor: () => ({ recoveryProcessId: process.pid }), beginHandoff: () => true, endHandoff: () => {},
    stop: async () => { registry.applyDriverEvent(source.id, { kind: "exited", reason: "stopped", resumable: true }); },
  } as unknown as SdkSupervisor;
  const result = await handOffToTerminal(registry, supervisor, source, {
    spawn: async ({ prepared }) => {
      prepared.beginLaunch();
      registry.applyHook({ agent: "claude", event: "SessionStart", transcriptPath: null, sessionId: source.agentSessionId!, cwd: source.cwd!, env: { tmuxPane: "%transfer" } });
      assert.equal(registry.getSession(source.id)?.state, "exited", "the hook belongs to a pending terminal, not the SDK");
      assert.equal(registry.getTask("task-early")?.sessionId, null);
      t.mock.timers.tick(9_000);
      assert.equal(registry.getSession(source.id), undefined);
      return { homeName: "transfer", homeBackend: "tmux", terminalResourceId: "multiplexer:tmux:transfer" };
    },
    waitForSessionAtCwd: async () => null,
    settleTask: (id) => tasks.settleAfterFailedHandoff(id),
  });
  assert.equal(result.ok, true);
  assert.equal(registry.getTask("task-early")?.status, "running");
  assert.ok(!events.includes("failed"), "no transient failure may be hidden by final-state checks");
});

for (const evictFirst of [false, true]) {
  test(`exact discovery adopts once ${evictFirst ? "after source removal" : "while the source lingers"}, with no transient task failure`, async (t) => {
    const f = transferFixture(t);
    const states: string[] = [];
    f.registry.subscribe((event) => { if (event.type === "task_upsert" && event.task.id === f.task!.id) states.push(event.task.status); });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const result = await handOffToTerminal(f.registry, f.supervisor, f.source, f.deps);
    assert.ok(result.ok);
    assert.equal(result.sessionId, null);
    if (evictFirst) t.mock.timers.tick(9_000);
    f.discover();
    const adopted = await f.transfers.recheck(result.transfer.id);
    assert.equal(adopted.state, "adopted");
    assert.equal(f.registry.getTask(f.task!.id)?.sessionId, f.candidate.syntheticId);
    assert.equal(f.registry.workEpisodeForTask(f.task!.id)?.sessionId, f.candidate.syntheticId);
    assert.notEqual(f.registry.workEpisodeForTask(f.task!.id)?.episodeId, adopted.facts.sourceEpisodeId);
    assert.equal(f.registry.findSessionByEnv({}, f.source.agentSessionId)?.id, f.candidate.syntheticId);
    t.mock.timers.tick(9_000);
    f.discover();
    assert.equal((await f.transfers.recheck(adopted.id)).revision, adopted.revision);
    assert.equal(f.registry.getTask(f.task!.id)?.status, "running");
    assert.ok(!states.includes("failed"));
    assert.equal(f.counts().launches, 1);
    assert.equal(openDb().prepare("SELECT count(*) AS n FROM task_worktree_returns WHERE task_id = ?").get(f.task!.id)!.n, 0);
  });
}

for (const mismatch of ["agent", "native", "cwd", "repo", "pane"] as const) {
  test(`a successor with the wrong ${mismatch} cannot acquire a reserved task`, async (t) => {
    const f = transferFixture(t);
    const result = await handOffToTerminal(f.registry, f.supervisor, f.source, f.deps);
    assert.ok(result.ok);
    const patch = mismatch === "agent" ? { agent: "codex" as const }
      : mismatch === "native" ? { agentSessionId: "another-conversation" }
      : mismatch === "cwd" ? { cwd: "/unrelated" }
      : mismatch === "repo" ? { repoRoot: "/unrelated" }
      : { terminals: [(await import("./helpers/session-fixture.ts")).mkMuxHandle({ session: "unrelated", paneId: "%unrelated" })] };
    f.discover(patch);
    assert.notEqual((await f.transfers.recheck(result.transfer.id)).state, "adopted");
    assert.equal(f.registry.getTask(f.task!.id)?.sessionId, null);
    assert.equal(f.registry.getTask(f.task!.id)?.status, "running");
  });
}

test("a target's other active task, a changed episode and a changed task attempt each fail closed", async (t) => {
  for (const conflict of ["task", "episode", "attempt"] as const) {
    const f = transferFixture(t);
    const result = await handOffToTerminal(f.registry, f.supervisor, f.source, f.deps);
    assert.ok(result.ok);
    if (conflict === "task") f.registry.upsertTask(mkTask({ id: `other-${f.task!.id}`, status: "running", sessionId: f.candidate.syntheticId }));
    if (conflict === "episode") f.registry.resetWorkEpisode(f.source.id);
    if (conflict === "attempt") f.registry.upsertTask({ ...f.registry.getTask(f.task!.id)!, dispatchedAt: 999 });
    f.discover();
    const checked = await f.transfers.recheck(result.transfer.id);
    assert.equal(checked.state, "recovery_required");
    assert.notEqual(f.registry.getTask(f.task!.id)?.sessionId, f.candidate.syntheticId);
    assert.equal(f.counts().launches, 1);
  }
});

test("pending transfers fence reset, cleanup and another request without creating a return obligation", async (t) => {
  const f = transferFixture(t);
  const result = await handOffToTerminal(f.registry, f.supervisor, f.source, f.deps);
  assert.ok(result.ok);
  const { resetSession } = await import("../src/server/reset.ts");
  const reset = await resetSession(f.registry, f.source, true, async () => assert.fail("a pending transfer must not reset the checkout"));
  assert.equal(reset.ok, false);
  assert.equal((await f.tasks.cancel(f.task!.id)).ok, false);
  assert.equal((await f.tasks.reclaim(f.task!.id)).ok, false);
  assert.equal((await f.tasks.reschedule(f.task!.id)).ok, false);
  assert.equal((await handOffToTerminal(f.registry, f.supervisor, f.source, f.deps)).ok, false);
  assert.equal(f.counts().launches, 1);
  await assert.rejects(f.transfers.resolve(result.transfer.id, result.transfer.revision), /may still be running|changed/);
});

test("restart after a lost launch acknowledgement adopts the claimed wrapper, never launches twice", async (t) => {
  const f = transferFixture(t);
  const result = await handOffToTerminal(f.registry, f.supervisor, f.source, f.deps);
  assert.ok(result.ok);
  await f.transfers.stop();
  const saved = getSessionTransfer(result.transfer.id)!;
  updateSessionTransfer(saved, { state: "launching", facts: { ...saved.facts, home: null } });
  const { claimResumeLease } = await import("../src/server/terminal/resume-lease.ts");
  assert.ok(claimResumeLease(f.prepared().lease, 200_001, 50));
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const { SdkSupervisor: Supervisor } = await import("../src/server/sdk/supervisor.ts");
  const sdk = new Supervisor(registry);
  assert.equal(sdk.prepareRestore(), 0, "the SDK must not be recreated beside its uncertain terminal");
  const row = { tty: "fixture", startRaw: "fixture", command: "fixture", agent: null, agentNative: false };
  const transfers = new SessionTransferCoordinator(registry, { settleTask: (id) => tasks.settleAfterFailedHandoff(id),
    processes: async () => [ { ...row, pid: 200_001, ppid: 1, startMs: 50 },
      { ...row, pid: f.candidate.pid, ppid: 200_001, startMs: f.candidate.startedAt } ] });
  transfers.start(); t.after(() => transfers.stop());
  registry.applyDiscovery([f.candidate]);
  assert.equal((await transfers.recheck(saved.id)).state, "adopted");
  assert.equal(registry.getTask(f.task!.id)?.sessionId, f.candidate.syntheticId);
  assert.equal(f.counts().launches, 1);
});

test("a recycled wrapper PID cannot prove a launch, and a late correct lifetime can", async (t) => {
  const f = transferFixture(t);
  const result = await handOffToTerminal(f.registry, f.supervisor, f.source, f.deps);
  assert.ok(result.ok);
  await f.transfers.stop();
  let saved = getSessionTransfer(result.transfer.id)!;
  saved = updateSessionTransfer(saved, { facts: { ...saved.facts, home: null } });
  const { claimResumeLease } = await import("../src/server/terminal/resume-lease.ts");
  assert.ok(claimResumeLease(f.prepared().lease, 200_002, 50));
  let start = 999;
  const row = { tty: "fixture", startRaw: "fixture", command: "fixture", agent: null, agentNative: false };
  const transfers = new SessionTransferCoordinator(f.registry, { settleTask: () => assert.fail("unknown is not absent"),
    processes: async () => [ { ...row, pid: 200_002, ppid: 1, startMs: start },
      { ...row, pid: f.candidate.pid, ppid: 200_002, startMs: f.candidate.startedAt } ] });
  f.discover();
  assert.notEqual((await transfers.recheck(saved.id)).state, "adopted");
  start = 50;
  assert.equal((await transfers.recheck(saved.id)).state, "adopted");
});

test("a revoked never-started launch settles through TaskManager and retains its checkout", async (t) => {
  const f = transferFixture(t);
  const result = await handOffToTerminal(f.registry, f.supervisor, f.source, f.deps);
  assert.ok(result.ok);
  const { revokeResumeLease } = await import("../src/server/terminal/resume-lease.ts");
  assert.ok(revokeResumeLease(f.prepared().lease));
  const failed = await f.transfers.recheck(result.transfer.id);
  assert.equal(failed.state, "failed");
  assert.equal(f.registry.getTask(f.task!.id)?.status, "failed");
  assert.equal(f.registry.getTask(f.task!.id)?.worktreePath, f.task!.worktreePath);
  assert.equal(f.counts().launches, 1);
});

test("a keyless early hook is retained durably and requires exact launch identity", async (t) => {
  const f = transferFixture(t);
  const result = await handOffToTerminal(f.registry, f.supervisor, f.source, f.deps); assert.ok(result.ok);
  f.registry.applyHook({ agent: "claude", event: "SessionStart", source: "resume", sessionId: f.source.agentSessionId,
    cwd: f.source.cwd, transcriptPath: null, env: {} });
  assert.ok(getSessionTransfer(result.transfer.id)?.facts.resumeHookAt);
  f.discover({ agentSessionId: null, terminals: [], pid: 100009 });
  assert.notEqual((await f.transfers.recheck(result.transfer.id)).state, "adopted");
  assert.equal(f.registry.getSession(f.candidate.syntheticId)?.agentSessionId, null);
  await f.transfers.stop();
  const registry = new Registry();
  const transfers = new SessionTransferCoordinator(registry, { processes: f.processes, settleTask: () => assert.fail("a live attempt is not failed") });
  transfers.start(); t.after(() => transfers.stop());
  registry.applyDiscovery([{ ...f.candidate, agentSessionId: null }]);
  assert.equal((await transfers.recheck(result.transfer.id)).state, "adopted");
  assert.equal(registry.getSession(f.candidate.syntheticId)?.agentSessionId, f.source.agentSessionId);
  assert.equal(registry.getTask(f.task!.id)?.sessionId, f.candidate.syntheticId);
});

test("queued human turns and an uncertain delivery remain intact through removal and adoption", async (t) => {
  const f = transferFixture(t);
  const { createPendingTurn, claimNextPendingTurn, markPendingTurnUncertain, listPendingTurns } = await import("../src/server/db.ts");
  const { PendingTurnManager } = await import("../src/server/pending-turns.ts");
  const { unexpectedActiveSdkDelivery } = await import("./helpers/pending-turn-sender.ts");
  const note = f.source.agentSessionId!;
  createPendingTurn({ id: `${note}-uncertain`, noteKey: note, text: "Possibly delivered", now: 1 });
  const sending = claimNextPendingTurn(note, 2)!;
  markPendingTurnUncertain(sending.id, sending.revision, "No acknowledgement", 3);
  createPendingTurn({ id: `${note}-queued`, noteKey: note, text: "Human's next turn", now: 4 });
  f.registry.refreshPendingTurns(note);
  const original = listPendingTurns(note);
  let sends = 0;
  const pending = new PendingTurnManager(f.registry, { ...unexpectedActiveSdkDelivery,
    sendWhenIdle: async () => { sends++; return "started"; } }, {
    idleSettleMs: 0, inject: async () => { sends++; return { ok: true, pasted: true, submitVerified: true }; },
  });
  pending.start(); t.after(() => pending.stop());
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const result = await handOffToTerminal(f.registry, f.supervisor, f.source, f.deps); assert.ok(result.ok);
  t.mock.timers.tick(9000); f.registry.applyDiscovery([]);
  assert.deepEqual(listPendingTurns(note), original);
  f.discover(); await f.transfers.recheck(result.transfer.id);
  t.mock.timers.tick(9000);
  await Promise.resolve();
  assert.deepEqual(listPendingTurns(note), original);
  assert.deepEqual(f.registry.getSession(f.candidate.syntheticId)?.pendingTurns.map((turn) => turn.state), ["uncertain", "queued"]);
  assert.equal(sends, 0, "handoff cannot retry an uncertain delivery or let queued work overtake it");
});

test("pending questions and answers made during the gap survive without duplicate continuation", async (t) => {
  const f = transferFixture(t);
  const pending = f.reviews.create(f.source.id, "input", "Which approach?", "Choose when ready");
  const answered = f.reviews.create(f.source.id, "input", "Which name?", "Name it");
  f.reviews.detachWait(answered.id, f.source.id);
  const continuations: Array<{ id: string; sessionId: string; text: string }> = [];
  f.reviews.startContinuationRecovery((review, text) => {
    continuations.push({ id: review.id, sessionId: review.sessionId, text });
    openDb().prepare("UPDATE reviews SET continuation_queued_at=1 WHERE id=?").run(review.id);
    return true;
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const result = await handOffToTerminal(f.registry, f.supervisor, f.source, f.deps); assert.ok(result.ok);
  f.reviews.resolve(answered.id, "answer", "Chosen name");
  t.mock.timers.tick(9000); f.registry.applyDiscovery([]);
  assert.equal(f.registry.getReview(pending.id)?.status, "pending");
  assert.equal(f.registry.getReview(answered.id)?.response, "Chosen name");
  assert.equal(continuations.length, 0);
  f.discover(); await f.transfers.recheck(result.transfer.id);
  assert.equal(f.registry.getReview(pending.id)?.sessionId, f.candidate.syntheticId);
  assert.equal(f.registry.getReview(pending.id)?.status, "pending");
  assert.equal(continuations.length, 1);
  assert.equal(continuations[0]!.sessionId, f.candidate.syntheticId);
  assert.match(continuations[0]!.text, /Chosen name/);
  assert.equal(f.registry.getReview(answered.id)?.sessionId, f.source.id, "answered history is not rewritten");
  await f.transfers.recheck(result.transfer.id); f.discover();
  assert.equal(continuations.length, 1);
});

for (const failure of ["unavailable", "missing", "unreadable", "replaced"] as const) {
  test(`handoff leaves the source usable when its process lifetime is ${failure}`, async (t) => {
    let pid: number | null = failure === "missing" ? null : process.pid;
    const f = transferFixture(t, { workflows: 2, processSnapshot: async () => {
      const process = { pid: pid!, ppid: 1, tty: null, startRaw: "fixture", startMs: failure === "unreadable" ? 0 : 100,
        command: "fixture", agent: null, agentNative: false };
      if (failure === "replaced") pid = null;
      return { processes: [process], unknownReason: failure === "unavailable" ? "inventory unavailable" : null,
        cwdScopePids: [], completedCollectorPids: [] };
    } });
    t.mock.method(f.supervisor, "handleFor", () => ({ recoveryProcessId: pid }));
    const pins = f.bindings.map((id) => f.store.getBinding(id));
    const result = await handOffToTerminal(f.registry, f.supervisor, f.source, f.deps);
    assert.equal(result.ok, false);
    assert.equal(result.transfer?.state, "aborted");
    assert.deepEqual(f.counts(), { stops: 0, launches: 0, injections: 0 });
    assert.equal(f.registry.getTask(f.task!.id)?.sessionId, f.source.id);
    assert.equal(f.registry.getTask(f.task!.id)?.status, "running");
    assert.deepEqual(f.bindings.map((id) => f.store.getBinding(id)), pins);
  });
}

for (const [inventory, sdkStatus] of [["live", "failed"], ["live", "exited"], ["unavailable", "failed"],
  ["unreadable", "failed"], ["throws", "failed"]] as const) {
  test(`a failed stop with a missing handle holds ownership until source exit: ${inventory} inventory, ${sdkStatus} SDK row`, async (t) => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    t.after(() => { child.kill("SIGKILL"); });
    await once(child, "spawn");
    const { listProcessesSnapshot } = await import("../src/server/discovery/processes.ts");
    const { setSdkSessionStatus } = await import("../src/server/sdk/store.ts");
    let live = true;
    let proveExit = false;
    let stops = 0;
    const f = transferFixture(t, { workflows: 2, processSnapshot: async () => {
      const snapshot = await listProcessesSnapshot();
      if (live || proveExit) return snapshot;
      if (inventory === "throws") throw new Error("process inventory failed");
      if (inventory === "unavailable") return { ...snapshot, processes: [], unknownReason: "inventory unavailable" };
      if (inventory === "unreadable") return { ...snapshot,
        processes: snapshot.processes.map((p) => p.pid === child.pid ? { ...p, startMs: 0 } : p) };
      return snapshot;
    } });
    t.mock.method(f.supervisor, "handleFor", () => live ? { recoveryProcessId: child.pid } : null);
    t.mock.method(f.supervisor, "stop", async () => {
      stops++;
      live = false;
      // The event pump can drop its handle and persist either outcome without observing
      // the child exit. Reproduce that boundary while the actual child remains alive.
      setSdkSessionStatus(f.source.id, sdkStatus);
      f.registry.applyDriverEvent(f.source.id, { kind: "exited", reason: "driver stream ended", resumable: false });
      throw new Error("stop rejected after the handle disappeared");
    });
    const pins = f.bindings.map((id) => f.store.getBinding(id));
    const submissions = f.bindings.map((id) => f.store.getSubmission(id.replace("binding-", "submission-")));
    const taskStates: string[] = [];
    f.registry.subscribe((event) => { if (event.type === "task_upsert" && event.task.id === f.task!.id) taskStates.push(event.task.status); });
    const result = await handOffToTerminal(f.registry, f.supervisor, f.source, f.deps);
    assert.equal(result.ok, false);
    assert.equal(result.transfer?.state, "recovery_required", JSON.stringify(result));
    const held = getSessionTransfer(result.transfer!.id)!;
    assert.equal(held.facts.sourceProcess?.pid, child.pid);
    assert.equal(held.facts.sourceStopped, false);
    assert.equal(held.facts.canEnd, false);
    assert.equal(f.registry.getTask(f.task!.id)?.status, "running");
    assert.equal(f.registry.getTask(f.task!.id)?.sessionId, null);
    assert.equal((await f.transfers.recheck(held.id)).state, "recovery_required");
    await f.transfers.stop(); f.transfers.start();
    const restarted = await f.transfers.recheck(held.id);
    assert.equal(restarted.state, "recovery_required");
    await assert.rejects(f.transfers.resolve(held.id, restarted.revision), /not yet safe/);
    assert.deepEqual(f.bindings.map((id) => f.store.getBinding(id)), pins);
    assert.deepEqual(f.bindings.map((id) => f.store.getSubmission(id.replace("binding-", "submission-"))), submissions);
    assert.ok(!taskStates.includes("failed"), "a recheck or restart must not bypass source lifetime proof");
    assert.equal(stops, 1);
    assert.equal(f.counts().launches, 0);
    assert.equal(f.counts().injections, 0);

    const exited = once(child, "exit");
    child.kill("SIGKILL"); await exited;
    proveExit = true;
    assert.equal((await f.transfers.recheck(held.id)).state, "failed");
    assert.equal(getSessionTransfer(held.id)?.facts.sourceStopped, true);
    assert.equal(f.registry.getTask(f.task!.id)?.status, "failed");
    for (const pin of pins) {
      const settled = f.store.getBinding(pin!.id)!;
      assert.equal(settled.state, "orphaned");
      assert.equal(settled.workflowVersionId, pin!.workflowVersionId);
    }
    assert.deepEqual(f.bindings.map((id) => f.store.getSubmission(id.replace("binding-", "submission-"))), submissions);
    assert.equal(openDb().prepare("SELECT count(*) AS n FROM task_worktree_returns WHERE task_id = ?").get(f.task!.id)!.n, 0);
    assert.equal(stops, 1);
    assert.equal(f.counts().launches, 0);
  });
}

for (const point of ["prepared-persisted", "stopping-persisted", "sdk-detached", "task-detached", "taskless-stopping-persisted", "stop-intent-persisted", "stop-entered", "taskless-stop-entered", "ownership-changed"] as const) {
  test(`restart from the actual prelaunch boundary: ${point}`, async (t) => {
    const manifest = join(home, `crash-${point}.json`);
    const child = spawnSync(process.execPath, ["--import", "tsx", "test/helpers/prelaunch-transfer-crash.ts",
      point === "ownership-changed" ? "task-detached" : point, manifest], {
      env: { ...process.env }, encoding: "utf8", timeout: 20000,
    });
    assert.equal(child.status, 81, child.stdout + child.stderr);
    const { sourceId, taskId, bindings, sourcePid } = JSON.parse(readFileSync(manifest, "utf8")) as {
      sourceId: string; taskId: string | null; bindings: string[]; sourcePid: number | null;
    };
    if (sourcePid) t.after(() => { try { process.kill(sourcePid, "SIGKILL"); } catch { /* Already exited. */ } });
    const before = transferForSource(sourceId)!;
    assert.equal(before.state, point === "prepared-persisted" ? "prepared" : "stopping");
    assert.equal(before.facts.launchAt, null);
    assert.equal(before.facts.launchOutcome, "not_started");
    assert.equal(existsSync(`${manifest}.stop`), point.endsWith("stop-entered"));
    assert.equal(existsSync(`${manifest}.launch`), false);
    const { getSdkSession } = await import("../src/server/sdk/store.ts");
    const { SdkSupervisor } = await import("../src/server/sdk/supervisor.ts");
    const { WorkflowStore } = await import("../src/server/workflows/store.ts");
    const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
    const store = new WorkflowStore();
    const pins = bindings.map((id) => store.getBinding(id));
    const submissions = bindings.map((id) => store.getSubmission(id.replace("binding-", "submission-")));
    if (point === "ownership-changed") openDb().prepare("UPDATE tasks SET dispatched_at=dispatched_at+1 WHERE id=?").run(taskId);
    const registry = new Registry();
    const tasks = new TaskManager(registry);
    const workflows = new WorkflowManager(registry, store);
    const { listProcessesSnapshot } = await import("../src/server/discovery/processes.ts");
    let inventoryMode: "normal" | "unknown" | "unreadable" | "recycled" = "normal";
    const transfers = new SessionTransferCoordinator(registry, { workflows, settleTask: (id) => tasks.settleAfterFailedHandoff(id),
      processSnapshot: async () => {
        const snapshot = await listProcessesSnapshot();
        if (inventoryMode === "unknown") return { ...snapshot, unknownReason: "injected inventory failure" };
        if (inventoryMode === "unreadable") return { ...snapshot,
          processes: snapshot.processes.map((p) => p.pid === sourcePid ? { ...p, startMs: 0 } : p) };
        if (inventoryMode === "recycled") snapshot.processes.push({ pid: sourcePid!, ppid: 1, tty: null,
          startMs: before.facts.sourceProcess!.startMs + 1000, startRaw: "later lifetime", command: "unrelated",
          agent: null, agentNative: false });
        return snapshot;
      } });
    transfers.start(); t.after(() => transfers.stop());
    const sdk = new SdkSupervisor(registry);
    if (sourcePid) {
      const held = await transfers.recheck(before.id);
      assert.equal(held.state, "recovery_required");
      assert.equal(held.facts.canEnd, false);
      sdk.prepareRestore();
      assert.equal(registry.snapshot().restoringSessions.some((row) => row.id === sourceId), false);
      await assert.rejects(() => transfers.resolve(held.id, held.revision), /not yet safe/);
      assert.equal(getSdkSession(sourceId)?.status, "running");
      assert.equal(before.facts.sourceProcess?.pid, sourcePid);
      inventoryMode = "unreadable";
      assert.equal((await transfers.recheck(before.id)).facts.sourceStopped, false, "a malformed lifetime is not PID reuse");
      inventoryMode = "normal";
      // The source survives its old daemon, then exits without an SDK event. Neither
      // recovery nor this test fabricates an exited row or repeats the original stop.
      process.kill(sourcePid, "SIGKILL");
      const { setTimeout: delay } = await import("node:timers/promises");
      for (let tries = 0; tries < 100; tries++) {
        const snapshot = await listProcessesSnapshot();
        assert.equal(snapshot.unknownReason, null);
        if (!snapshot.processes.some((p) => p.pid === sourcePid)) break;
        await delay(10);
      }
      inventoryMode = "unknown";
      assert.equal((await transfers.recheck(before.id)).state, "recovery_required", "a failed inventory cannot prove absence");
      assert.deepEqual(bindings.map((id) => store.getBinding(id)), pins);
      inventoryMode = point === "stop-intent-persisted" ? "recycled" : "normal";
      assert.equal((await transfers.recheck(before.id)).state, "failed");
      assert.equal(getSdkSession(sourceId)?.status, "running", "absence does not rewrite the last driver event");
      assert.equal(transferForSource(sourceId), null);
      if (taskId) assert.equal(registry.getTask(taskId)?.status, "failed");
      for (const pin of pins) {
        const settled = store.getBinding(pin!.id)!;
        assert.equal(settled.state, "orphaned");
        assert.equal(settled.workflowVersionId, pin!.workflowVersionId);
      }
      assert.deepEqual(bindings.map((id) => store.getSubmission(id.replace("binding-", "submission-"))), submissions);
      const sdkAfterSettlement = new SdkSupervisor(registry);
      sdkAfterSettlement.prepareRestore();
      assert.equal(registry.snapshot().restoringSessions.some((row) => row.id === sourceId), false);
    } else if (point === "ownership-changed") {
      assert.equal(getSessionTransfer(before.id)?.state, "recovery_required");
      assert.equal(getSdkSession(sourceId)?.taskId, null);
      assert.equal(registry.getTask(taskId!)?.sessionId, null);
      assert.equal(registry.getTask(taskId!)?.dispatchedAt, 11);
      assert.deepEqual(bindings.map((id) => store.getBinding(id)), pins);
      sdk.prepareRestore();
      assert.equal(registry.snapshot().restoringSessions.some((row) => row.id === sourceId), false);
    } else {
      assert.equal(getSessionTransfer(before.id)?.state, "aborted");
      assert.equal(transferForSource(sourceId), null);
      assert.equal(getSdkSession(sourceId)?.taskId, taskId);
      if (taskId) {
        assert.equal(registry.getTask(taskId)?.sessionId, sourceId);
        assert.equal(registry.getTask(taskId)?.status, "running");
      }
      assert.deepEqual(bindings.map((id) => store.getBinding(id)), pins);
      sdk.prepareRestore();
      assert.equal(registry.snapshot().restoringSessions.some((row) => row.id === sourceId), true);
      // Another startup is idempotent and does not detach the restored task again.
      await transfers.stop(); transfers.start();
      assert.equal((await transfers.recheck(before.id)).state, "aborted");
      if (taskId) assert.equal(registry.getTask(taskId)?.sessionId, sourceId);
    }
    assert.equal(existsSync(`${manifest}.launch`), false);
  });
}

for (const state of ["launching", "awaiting_successor", "recovery_required"] as const) {
  test(`restart at ${state} never replays stop or spawn`, async (t) => {
    const f = transferFixture(t);
    const result = await handOffToTerminal(f.registry, f.supervisor, f.source, f.deps); assert.ok(result.ok);
    await f.transfers.stop();
    const current = getSessionTransfer(result.transfer.id)!;
    updateSessionTransfer(current, { state });
    const registry = new Registry();
    const transfers = new SessionTransferCoordinator(registry, { processes: f.processes, settleTask: () => assert.fail("no positive absence") });
    transfers.start(); t.after(() => transfers.stop());
    registry.applyDiscovery([]);
    const recovered = await transfers.recheck(current.id);
    assert.equal(recovered.state, state === "awaiting_successor" ? state : "recovery_required");
    assert.deepEqual({ launches: f.counts().launches, stops: f.counts().stops }, { launches: 1, stops: 1 });
    (await import("../src/server/terminal/resume-lease.ts")).claimResumeLease(f.prepared().lease, 200001, 50);
    registry.applyDiscovery([f.candidate]);
    assert.equal((await transfers.recheck(current.id)).state, "adopted");
    assert.equal(registry.getTask(f.task!.id)?.status, "running");
  });
}

test("outgoing PR provenance survives adoption and a later source merge settles the same task", async (t) => {
  const f = transferFixture(t);
  const db = await import("../src/server/db.ts");
  const binding = f.registry.workEpisodeForTask(f.task!.id)!;
  const pr = "https://github.com/example/project/pull/17";
  db.bindTaskWorkEpisode({ ...binding, prUrl: pr, prHeadSha: "source-head" });
  const result = await handOffToTerminal(f.registry, f.supervisor, f.source, f.deps); assert.ok(result.ok);
  f.discover(); await f.transfers.recheck(result.transfer.id);
  const historical = db.historicalTaskWorkEpisodeBindingsForTask(f.task!.id);
  assert.equal(historical[0]?.episodeId, binding.episodeId);
  assert.equal(historical[0]?.prUrl, pr);
  assert.ok(db.markWorkEpisodeMerged(f.source.id, binding.episodeId, pr, Date.now()));
  // Simulate a later confirmed successor exit through the same disappearance owner.
  f.tasks.settleAfterFailedHandoff(f.task!.id);
  assert.equal(f.registry.getTask(f.task!.id)?.status, "done");
  assert.equal(f.registry.getTask(f.task!.id)?.worktreePath, f.task!.worktreePath);
});
