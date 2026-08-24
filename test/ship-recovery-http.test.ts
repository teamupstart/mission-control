import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shipRecoveryMarker } from "../src/shared/ship-recovery.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import { mkMuxHandle, mkTask } from "./helpers/session-fixture.ts";

const root = mkdtempSync(join(tmpdir(), "mission-ship-recovery-http-"));
const home = join(root, "home");
const repo = join(root, "repo");
process.env.MISSION_HOME = home;

execFileSync("git", ["init", "-b", "main", repo]);
writeFileSync(join(repo, "README.md"), "fixture\n");
execFileSync("git", ["add", "README.md"], { cwd: repo });
execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"], { cwd: repo });

const {
  openDb,
  markWorkCycleActive,
  completeWorkCycle,
  workCycleFor,
  consumePromptedGeneration,
  getQueueRow,
} = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { setForemanConfig } = await import("../src/server/foreman/config.ts");

after(() => rmSync(root, { recursive: true, force: true }));
openDb();

const registry = new Registry();
const reviews = new ReviewManager(registry);
const tasks = new TaskManager(registry);
const queues = new QueueManager(registry);
const workflows = new WorkflowManager(registry);
const app = buildApp(registry, reviews, tasks, queues, undefined, undefined, workflows);
const headers = { host: "127.0.0.1:7317", "content-type": "application/json" };

function seed(
  suffix = "",
  decision: Parameters<typeof consumePromptedGeneration>[0]["decision"] = null,
): { sessionId: string; noteKey: string; taskId: string } {
  const sessionId = `ship-recovery-session${suffix}`;
  const noteKey = `ship-recovery-conversation${suffix}`;
  const taskId = `ship-recovery-task${suffix}`;
  const discovered: DiscoveredSession = {
    syntheticId: sessionId,
    agent: "claude",
    name: "ship recovery",
    nameSource: "process",
    cwd: repo,
    gitBranch: "main",
    gitRoot: repo,
    repoRoot: repo,
    agentSessionId: noteKey,
    pid: 71001,
    tty: "ttys71001",
    terminals: [mkMuxHandle({ session: "ship-recovery", paneId: "%71001" })],
    startedAt: 1,
  };
  registry.applyDiscovery([discovered]);
  registry.upsertTask(mkTask({
    id: taskId,
    title: "Recover the ship task",
    intent: "Implement the requested fix",
    kind: "ship",
    status: "running",
    sessionId,
    repoRoot: repo,
    worktreePath: repo,
  }));
  registry.setForemanInvite(sessionId, "dispatch");
  registry.upsertGoal(sessionId, {
    prompt: "Implement the requested fix",
    text: "Implement the requested fix",
    objective: "Implement the requested fix",
    focus: "Implement the requested fix",
    relationship: "initial",
    rationale: "Initial task objective",
    objectiveVersion: 1,
    promptRevision: 1,
    resolvedPromptRevision: 1,
    pendingPrompts: [],
    source: "heuristic",
  }, Date.now() - 3 * 60_000);
  const session = registry.getSession(sessionId)!;
  session.hooksSeen = true;
  session.instrumented = true;
  session.stateConfirmed = true;
  session.state = "idle";
  session.lastActivity = Date.now() - 2 * 60_000;
  session.pendingTurns = [];
  assert.equal(registry.ensureQueue(sessionId), noteKey);
  markWorkCycleActive(noteKey, Date.now() - 3 * 60_000);
  completeWorkCycle(noteKey, Date.now() - 2 * 60_000, Date.now() - 2 * 60_000);
  session.workCycle = workCycleFor(noteKey) ?? undefined;
  assert.equal(consumePromptedGeneration({
    noteKey,
    sessionCwd: repo,
    generation: 1,
    episodeKey: "intent:1:1",
    ask: false,
    directHandoff: null,
    decision,
    now: Date.now() - 2 * 60_000,
  }), true);
  setForemanConfig({
    enabled: true,
    mode: "live",
    repoAllowlist: [repo],
    keepShipTasksMoving: true,
    shipRecoveryMinutes: 1,
  });
  return { sessionId, noteKey, taskId };
}

test("the daemon revalidates, claims, releases, and suppresses pre-PR recovery on a new PR", async () => {
  const { sessionId, noteKey, taskId } = seed();
  const identity = {
    taskId,
    logicalKey: noteKey,
    generation: 1,
    decisionGeneration: null,
    decisionOutcome: null,
    reason: "idle_empty" as const,
    attempt: 1,
  };
  const claim = {
    ...identity,
    marker: shipRecoveryMarker(identity),
    payloadSummary: "Resume the bounded implementation task.",
  };

  const first = await app.request(`/api/sessions/${sessionId}/queue/ship-recovery/claim`, {
    method: "POST",
    headers,
    body: JSON.stringify(claim),
  });
  assert.equal(first.status, 200, await first.clone().text());
  const firstQueue = (await first.json()) as {
    promptedRecovery: { attempt: number; lastDelivery: string } | null;
  };
  assert.deepEqual(firstQueue.promptedRecovery, {
    ...firstQueue.promptedRecovery,
    attempt: 1,
    lastDelivery: "unknown",
  });
  assert.equal(
    firstQueue.promptedRecovery && "episodeKey" in firstQueue.promptedRecovery,
    false,
    "a legacy claim payload remains accepted and retains its legacy shape",
  );

  const duplicate = await app.request(`/api/sessions/${sessionId}/queue/ship-recovery/claim`, {
    method: "POST",
    headers,
    body: JSON.stringify(claim),
  });
  assert.equal(duplicate.status, 409, "an unknown claim is already spent");

  const released = await app.request(`/api/sessions/${sessionId}/queue/ship-recovery/delivery`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...identity, marker: claim.marker, delivery: "confirmed_undelivered" }),
  });
  assert.equal(released.status, 200, await released.clone().text());
  const retry = await app.request(`/api/sessions/${sessionId}/queue/ship-recovery/claim`, {
    method: "POST",
    headers,
    body: JSON.stringify(claim),
  });
  assert.equal(retry.status, 200, "positive non-delivery retries the same attempt");

  const beforeForgery = queues.get(sessionId)?.promptedRecovery;
  writeFileSync(join(repo, "README.md"), "fixture\nambiguous local work\n");
  const forgedTerminal = {
    ...identity,
    reason: "idle_ambiguous" as const,
    attempt: 4,
    marker: shipRecoveryMarker({
      ...identity,
      reason: "idle_ambiguous",
      attempt: 4,
    }),
    payloadSummary: "Claim the reviewer escalated.",
    terminal: true,
  };
  const forged = await app.request(`/api/sessions/${sessionId}/queue/ship-recovery/claim`, {
    method: "POST",
    headers,
    body: JSON.stringify(forgedTerminal),
  });
  assert.equal(forged.status, 409, "request shape cannot manufacture a reviewer escalation");
  assert.deepEqual(
    queues.get(sessionId)?.promptedRecovery,
    beforeForgery,
    "a forged terminal claim cannot replace the current durable attempt",
  );
  writeFileSync(join(repo, "README.md"), "fixture\n");

  const session = registry.getSession(sessionId)!;
  session.prUrl = "https://github.com/acme/repo/pull/7";
  session.prNumber = 7;
  session.prState = "open";
  const withPr = await app.request(`/api/sessions/${sessionId}/queue/ship-recovery/claim`, {
    method: "POST",
    headers,
    body: JSON.stringify(claim),
  });
  assert.equal(withPr.status, 409, "an observed task-owned PR suppresses every recovery");
});

test("the daemon admits immediate held-gap claims through the existing recovery ledger", async () => {
  const heldDecision = {
    outcome: "held" as const,
    summary: "A focused retry test is missing.",
    gaps: [{ id: "retry-test", path: "test/retry.test.ts", detail: "Cover the 500 path." }],
  };
  const { sessionId, noteKey, taskId } = seed("-immediate", heldDecision);
  const identity = {
    taskId,
    logicalKey: noteKey,
    generation: 1,
    episodeKey: "intent:1:1",
    decisionGeneration: 1,
    decisionOutcome: "held" as const,
    reason: "held_gaps" as const,
    attempt: 1,
  };
  const claim = {
    ...identity,
    marker: shipRecoveryMarker(identity),
    payloadSummary: "Deliver the held completion gaps.",
  };

  setForemanConfig({
    enabled: true,
    mode: "live",
    repoAllowlist: [repo],
    keepShipTasksMoving: false,
    shipRecoveryMinutes: 20,
  });
  const disabled = await app.request(`/api/sessions/${sessionId}/queue/ship-recovery/claim`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...claim, deliveryRoute: "immediate-held" }),
  });
  assert.equal(disabled.status, 409, "the existing keepShipTasksMoving flag governs immediate delivery");

  setForemanConfig({ keepShipTasksMoving: true });
  const quietWindow = await app.request(`/api/sessions/${sessionId}/queue/ship-recovery/claim`, {
    method: "POST",
    headers,
    body: JSON.stringify(claim),
  });
  assert.equal(quietWindow.status, 409, "the ordinary shepherd route still waits for its quiet window");

  const immediate = await app.request(`/api/sessions/${sessionId}/queue/ship-recovery/claim`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...claim, deliveryRoute: "immediate-held" }),
  });
  assert.equal(immediate.status, 200, await immediate.clone().text());
  const queue = (await immediate.json()) as {
    promptedRecovery: { reason: string; attempt: number; lastDelivery: string } | null;
  };
  assert.deepEqual(queue.promptedRecovery, {
    ...queue.promptedRecovery,
    episodeKey: "intent:1:1",
    reason: "held_gaps",
    attempt: 1,
    lastDelivery: "unknown",
  });

  markWorkCycleActive(noteKey, Date.now());
  completeWorkCycle(noteKey, Date.now() + 1, Date.now() + 1);
  const secondCycle = workCycleFor(noteKey)!;
  registry.getSession(sessionId)!.workCycle = secondCycle;
  assert.equal(consumePromptedGeneration({
    noteKey,
    sessionCwd: repo,
    generation: 2,
    episodeKey: "intent:1:1",
    ask: false,
    directHandoff: null,
    decision: {
      outcome: "held",
      summary: "The same focused retry test is still missing.",
      gaps: [{
        id: "retry-test",
        severity: "blocking",
        kind: "untested",
        path: "test/retry.test.ts",
        detail: "Cover the 500 path.",
        strikes: 1,
      }],
    },
    now: Date.now() + 2,
  }), true);
  const continued = getQueueRow(noteKey);
  assert.equal(continued?.promptedDecision?.heldRound, 2);
  assert.equal(continued?.promptedRecovery?.attempt, 1);
  assert.equal(continued?.promptedRecovery?.episodeKey, "intent:1:1");

  const makeDue = (): void => {
    const state = getQueueRow(noteKey)?.promptedRecovery;
    assert.ok(state);
    openDb().prepare(`UPDATE foreman_queues SET prompted_recovery = ? WHERE note_key = ?`).run(
      JSON.stringify({ ...state, lastDelivery: "delivered", nextEligibleAt: 0 }),
      noteKey,
    );
    registry.refreshQueue(noteKey);
  };
  const claimAttempt = async (generation: number, attempt: number) => {
    const attemptIdentity = {
      taskId,
      logicalKey: noteKey,
      generation,
      episodeKey: "intent:1:1",
      decisionGeneration: generation,
      decisionOutcome: "held" as const,
      reason: "held_gaps" as const,
      attempt,
    };
    return app.request(`/api/sessions/${sessionId}/queue/ship-recovery/claim`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...attemptIdentity,
        marker: shipRecoveryMarker(attemptIdentity),
        payloadSummary: "Deliver the held completion gaps.",
        deliveryRoute: "immediate-held",
      }),
    });
  };

  makeDue();
  const second = await claimAttempt(2, 2);
  assert.equal(second.status, 200, await second.clone().text());

  markWorkCycleActive(noteKey, Date.now() + 3);
  completeWorkCycle(noteKey, Date.now() + 4, Date.now() + 4);
  registry.getSession(sessionId)!.workCycle = workCycleFor(noteKey)!;
  assert.equal(consumePromptedGeneration({
    noteKey,
    sessionCwd: repo,
    generation: 3,
    episodeKey: "intent:1:1",
    ask: false,
    directHandoff: null,
    decision: {
      outcome: "held",
      summary: "The focused retry test remains missing after a third delivery.",
      gaps: [{
        id: "retry-test",
        severity: "blocking",
        kind: "untested",
        path: "test/retry.test.ts",
        detail: "Cover the 500 path.",
        strikes: 2,
      }],
    },
    now: Date.now() + 5,
  }), true);
  registry.refreshQueue(noteKey);
  makeDue();
  const third = await claimAttempt(3, 3);
  assert.equal(third.status, 200, await third.clone().text());
  const exhausted = await claimAttempt(3, 4);
  assert.equal(exhausted.status, 200, await exhausted.clone().text());
  const exhaustedQueue = (await exhausted.json()) as {
    promptedRecovery: { attempt: number; lastDelivery: string; episodeKey?: string } | null;
  };
  assert.deepEqual(exhaustedQueue.promptedRecovery, {
    ...exhaustedQueue.promptedRecovery,
    episodeKey: "intent:1:1",
    attempt: 4,
    lastDelivery: "escalated",
  });
});

test("held-round accounting is episode-scoped and legacy predecessors reset safely", () => {
  const { noteKey } = seed("-held-rounds", {
    outcome: "held",
    summary: "First hold.",
    gaps: [{ id: "first", path: "src/first.ts", detail: "Finish the first path." }],
  });
  assert.equal(getQueueRow(noteKey)?.promptedDecision?.heldRound, 1);

  const consumeNext = (
    generation: number,
    episodeKey: string,
    decision: Parameters<typeof consumePromptedGeneration>[0]["decision"],
  ): void => {
    const now = Date.now() + generation * 10;
    markWorkCycleActive(noteKey, now);
    completeWorkCycle(noteKey, now + 1, now + 1);
    assert.equal(workCycleFor(noteKey)?.generation, generation);
    assert.equal(consumePromptedGeneration({
      noteKey,
      sessionCwd: repo,
      generation,
      episodeKey,
      ask: false,
      directHandoff: null,
      decision,
      now: now + 2,
    }), true);
  };

  consumeNext(2, "intent:1:1", {
    outcome: "held",
    summary: "Second hold with a completely different gap set.",
    gaps: [{ id: "second", path: "src/second.ts", detail: "Finish the second path." }],
  });
  assert.equal(getQueueRow(noteKey)?.promptedDecision?.heldRound, 2);

  consumeNext(3, "intent:1:1", { outcome: "empty", summary: "No changes.", gaps: [] });
  assert.equal(getQueueRow(noteKey)?.promptedDecision?.heldRound, undefined);
  consumeNext(4, "intent:1:1", {
    outcome: "held",
    summary: "Held after a non-held decision.",
    gaps: [{ id: "third", path: "src/third.ts", detail: "Finish the third path." }],
  });
  assert.equal(getQueueRow(noteKey)?.promptedDecision?.heldRound, 1);

  const legacyDecision = {
    logicalKey: noteKey,
    generation: 4,
    outcome: "held",
    summary: "Legacy held decision.",
    gaps: [{ id: "legacy", path: "src/legacy.ts", detail: "Finish the legacy path." }],
    decidedAt: 145,
  };
  openDb().prepare(`UPDATE foreman_queues SET prompted_decision = ? WHERE note_key = ?`)
    .run(JSON.stringify(legacyDecision), noteKey);
  assert.deepEqual(getQueueRow(noteKey)?.promptedDecision, legacyDecision);

  consumeNext(5, "intent:1:1", {
    outcome: "held",
    summary: "A new build follows a legacy predecessor.",
    gaps: [{ id: "new", path: "src/new.ts", detail: "Finish the new path." }],
  });
  assert.equal(getQueueRow(noteKey)?.promptedDecision?.heldRound, 1);

  consumeNext(6, "intent:1:2", {
    outcome: "held",
    summary: "The human accepted a new prompt.",
    gaps: [{ id: "new-intent", path: "src/new.ts", detail: "Follow the new prompt." }],
  });
  assert.equal(getQueueRow(noteKey)?.promptedDecision?.heldRound, 1);
  assert.equal(getQueueRow(noteKey)?.promptedDecision?.episodeKey, "intent:1:2");
});
