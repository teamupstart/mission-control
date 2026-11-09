import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { ReportBlockerBody } from "../src/shared/protocol.ts";
import { mkMuxHandle, mkTask } from "./helpers/session-fixture.ts";

// Durable session blockers (docs/plans/durable-session-blockers): the record is keyed by the
// note key, so it has to survive a daemon restart for terminal and SDK sessions alike, follow
// every key rotation, end with its task, and be pruned only once no session has held its key
// for the window. An exit alone must never end it.

const home = mkdtempSync(join(tmpdir(), "mission-session-blocker-"));
process.env.MISSION_HOME = home;

const {
  openDb, loadSessionBlockers, markWorkCycleActive, completeWorkCycle, workCycleFor, getQueueRow,
} = await import("../src/server/db.ts");
const { resolvedSessionIntent } = await import("../src/shared/goal.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { ensureToken } = await import("../src/server/auth.ts");

type ReviewManagerT = import("../src/server/reviews.ts").ReviewManager;
type TaskManager = import("../src/server/tasks.ts").TaskManager;
type QueueManager = import("../src/server/queue.ts").QueueManager;

after(() => rmSync(home, { recursive: true, force: true }));
openDb();

let seq = 0;

function mkDiscovered(over: Partial<DiscoveredSession> = {}): DiscoveredSession {
  const n = ++seq;
  return {
    syntheticId: `proc:ttys10${n}:${n}:0`,
    agent: "claude",
    name: "work",
    nameSource: "process",
    cwd: `/wt/blocker-${n}`,
    gitBranch: "harness/blocker",
    pid: 1000 + n,
    tty: `ttys10${n}`,
    terminals: [mkMuxHandle({ session: "s", windowName: "w", windowIndex: 0, paneId: `%${100 + n}` })],
    startedAt: 0,
    ...over,
  } as DiscoveredSession;
}

const BODY: ReportBlockerBody = {
  kind: "question",
  reason: "Need the retention window for audit logs",
  waitingOn: "Dana (platform) in #data-platform",
  resumeWhen: "A platform owner answers with a retention window",
  referenceUrl: "https://example.com/threads/8812",
  details: "Two options: 30 days or 400 days.",
};

test("a terminal session's blocker survives a daemon restart and an exit", () => {
  const d = mkDiscovered({ agentSessionId: `agent-term-${seq}` } as Partial<DiscoveredSession>);
  const first = new Registry();
  first.applyDiscovery([d]);
  const r = first.reportBlocker(d.syntheticId, BODY, 1_000);
  assert.equal(r.ok, true);
  assert.equal(first.getSession(d.syntheticId)?.blocker?.startedAt, 1_000);

  // The pane disappears: the session exits, and its blocker stays.
  first.applyDiscovery([]);
  assert.equal(first.getSession(d.syntheticId)?.state, "exited");
  assert.equal(first.getSession(d.syntheticId)?.blocker?.reason, BODY.reason);

  const second = new Registry();
  second.applyDiscovery([d]);
  const s = second.getSession(d.syntheticId);
  assert.equal(s?.blocker?.reason, BODY.reason);
  assert.equal(s?.blocker?.startedAt, 1_000);
  assert.equal(s?.blocker?.referenceUrl, BODY.referenceUrl);
});

test("an SDK session's blocker survives a daemon restart", () => {
  const agentSessionId = `agent-sdk-${++seq}`;
  const register = (registry: InstanceType<typeof Registry>) => registry.registerSdkSession({
    id: `sdk:blocker-${seq}`, agent: "claude", name: "embedded", cwd: "/repo", agentSessionId,
  });
  const first = new Registry();
  const s1 = register(first);
  assert.equal(first.reportBlocker(s1.id, BODY, 2_000).ok, true);
  const second = new Registry();
  const s2 = register(second);
  assert.equal(s2.blocker?.startedAt, 2_000);
  assert.equal(second.getSession(s2.id)?.blocker?.waitingOn, BODY.waitingOn);
});

test("key rotation moves the blocker to the new note key", () => {
  const registry = new Registry();
  const d = mkDiscovered();
  registry.applyDiscovery([d]);
  assert.equal(registry.reportBlocker(d.syntheticId, BODY).ok, true);
  assert.ok(loadSessionBlockers().some((b) => b.noteKey === d.syntheticId));

  const agentSessionId = `agent-rotate-${seq}`;
  registry.applyHook({
    agent: "claude",
    event: "SessionStart",
    sessionId: agentSessionId,
    cwd: d.cwd,
    transcriptPath: null,
    env: { tmuxPane: (d.terminals[0] as { paneId: string }).paneId },
  });
  const s = registry.getSession(d.syntheticId);
  assert.equal(s?.agentSessionId, agentSessionId);
  assert.equal(s?.blocker?.reason, BODY.reason, "the blocker followed the key");
  const keys = loadSessionBlockers().map((b) => b.noteKey);
  assert.ok(keys.includes(agentSessionId));
  assert.ok(!keys.includes(d.syntheticId), "nothing strands under the old key");
});

test("a re-report keeps startedAt; after a reply flag it clears the reply and stamps checkedAt", () => {
  const registry = new Registry();
  const d = mkDiscovered();
  registry.applyDiscovery([d]);
  registry.reportBlocker(d.syntheticId, BODY, 10);
  const updated = registry.reportBlocker(d.syntheticId, { ...BODY, reason: "Still need the window" }, 20);
  assert.ok(updated.ok && !updated.created);
  let b = registry.getBlocker(d.syntheticId)!;
  assert.equal(b.startedAt, 10);
  assert.equal(b.updatedAt, 20);
  assert.equal(b.checkedAt, null);
  assert.equal(b.reason, "Still need the window");

  registry.flagBlockerReply(d.syntheticId, "operator", { note: "Dana answered", referenceUrl: "https://example.com/r" }, 30);
  b = registry.getBlocker(d.syntheticId)!;
  assert.deepEqual(b.reply, { flaggedAt: 30, flaggedBy: "operator", note: "Dana answered", referenceUrl: "https://example.com/r" });

  registry.reportBlocker(d.syntheticId, BODY, 40);
  b = registry.getBlocker(d.syntheticId)!;
  assert.equal(b.reply, null, "a re-report after a flag means checked, still blocked");
  assert.equal(b.checkedAt, 40);
  assert.equal(b.startedAt, 10);
});

test("a session with a pending request_input of its own cannot report a blocker", () => {
  const registry = new Registry();
  const reviews = new ReviewManager(registry);
  const d = mkDiscovered();
  registry.applyDiscovery([d]);
  const review = reviews.create(d.syntheticId, "input", "Pick one", "Which?");
  const refused = registry.reportBlocker(d.syntheticId, BODY);
  assert.equal(refused.ok, false);
  assert.ok(!refused.ok && refused.status === 409 && /request_input/.test(refused.error));
  assert.equal(registry.getBlocker(d.syntheticId), null);
  reviews.resolve(review.id, "approve", "the first");
  assert.equal(registry.reportBlocker(d.syntheticId, BODY).ok, true);
});

test("a task reaching a terminal status ends its session's blocker", () => {
  const registry = new Registry();
  const d = mkDiscovered();
  registry.applyDiscovery([d]);
  const task = mkTask({ id: `task-blocker-${seq}`, sessionId: d.syntheticId, status: "running", worktreePath: d.cwd });
  registry.upsertTask(task);
  assert.equal(registry.reportBlocker(d.syntheticId, BODY).ok, true);
  registry.upsertTask({ ...task, status: "running", title: "renamed" });
  assert.ok(registry.getBlocker(d.syntheticId), "a non-terminal write leaves it");
  registry.upsertTask({ ...task, status: "done" });
  assert.equal(registry.getBlocker(d.syntheticId), null);
  assert.ok(!loadSessionBlockers().some((b) => b.noteKey === d.syntheticId));
  const events = openDb().prepare(`SELECT payload FROM session_events WHERE session_id = ? AND kind = 'session_blocker_cleared'`)
    .all(d.syntheticId) as Array<{ payload: string }>;
  assert.equal(JSON.parse(events.at(-1)!.payload).actor, "task");
});

test("a late terminal write for an earlier task leaves the blocker of the session's current task", () => {
  const registry = new Registry();
  const d = mkDiscovered();
  registry.applyDiscovery([d]);
  const earlier = mkTask({ id: `task-earlier-${seq}`, sessionId: d.syntheticId, status: "running", worktreePath: d.cwd });
  registry.upsertTask(earlier);
  registry.upsertTask({ ...earlier, status: "done" });
  const current = mkTask({ id: `task-current-${seq}`, sessionId: d.syntheticId, status: "running", worktreePath: d.cwd });
  registry.upsertTask(current);
  assert.equal(registry.getSession(d.syntheticId)?.task?.id, current.id);
  assert.equal(registry.reportBlocker(d.syntheticId, BODY).ok, true);
  assert.equal(loadSessionBlockers().find((b) => b.noteKey === d.syntheticId)?.taskId, current.id);

  // A stale writer still holding the earlier row, which names the same session, lands late.
  registry.upsertTask({ ...earlier, status: "failed", sessionId: d.syntheticId });
  assert.ok(registry.getBlocker(d.syntheticId), "the earlier task's terminal write cleared the current task's blocker");

  registry.upsertTask({ ...current, status: "done" });
  assert.equal(registry.getBlocker(d.syntheticId), null, "the current task's own terminal write still clears it");
});

test("a restart does not prune a blocker whose session is briefly missing from the first sweep", () => {
  const key = `agent-restart-gap-${++seq}`;
  const d = mkDiscovered({ agentSessionId: key } as Partial<DiscoveredSession>);
  const first = new Registry();
  first.applyDiscovery([d]);
  // An old blocker: reported long ago, but its session held the key right up to the restart.
  first.reportBlocker(d.syntheticId, BODY, 100);
  first.pruneBlockers(50, 10_000);
  assert.equal(loadSessionBlockers().find((b) => b.noteKey === key)?.lastHeldAt, 10_000, "the hold is stored");

  const second = new Registry();
  second.applyDiscovery([]);
  // The window covers the last time the key was held, though not the original report.
  second.pruneBlockers(5_000, 10_500);
  assert.ok(loadSessionBlockers().some((b) => b.noteKey === key), "a blocker held just before the restart was pruned");
  second.applyDiscovery([d]);
  assert.equal(second.getSession(d.syntheticId)?.blocker?.startedAt, 100, "the rediscovered session is still blocked");

  // Absence observed for the whole window does prune it.
  const third = new Registry();
  third.applyDiscovery([]);
  assert.ok(third.pruneBlockers(20_000, 30_000) >= 1);
  assert.ok(!loadSessionBlockers().some((b) => b.noteKey === key));
});

test("a stranded key is pruned after the window, while a resumed one keeps its blocker", () => {
  const liveKey = `agent-live-${++seq}`;
  const goneKey = `agent-gone-${seq}`;
  const live = mkDiscovered({ agentSessionId: liveKey } as Partial<DiscoveredSession>);
  const gone = mkDiscovered({ agentSessionId: goneKey } as Partial<DiscoveredSession>);
  const first = new Registry();
  first.applyDiscovery([live, gone]);
  first.reportBlocker(live.syntheticId, BODY, 100);
  first.reportBlocker(gone.syntheticId, BODY, 100);

  const second = new Registry();
  // Before the first sweep nothing is known to be stranded, so nothing is pruned.
  assert.equal(second.pruneBlockers(Number.MAX_SAFE_INTEGER), 0);
  second.applyDiscovery([live]);
  // Both were last reported at 100, so only liveness separates them.
  assert.ok(second.pruneBlockers(1_000, 5_000) >= 1);
  const keys = loadSessionBlockers().map((b) => b.noteKey);
  assert.ok(keys.includes(liveKey));
  assert.ok(!keys.includes(goneKey));
  assert.equal(second.getSession(live.syntheticId)?.blocker?.startedAt, 100);
});

test("prompted completion is refused while blocked, and the same generation is consumed once cleared", () => {
  const registry = new Registry();
  const noteKey = `agent-prompted-${++seq}`;
  const d = mkDiscovered({ agentSessionId: noteKey } as Partial<DiscoveredSession>);
  registry.applyDiscovery([d]);
  registry.upsertGoal(d.syntheticId, {
    prompt: "Implement the fix", text: "Implement the fix", objective: "Implement the fix",
    focus: "Implement the fix", relationship: "initial", rationale: "Initial task objective",
    objectiveVersion: 1, promptRevision: 1, resolvedPromptRevision: 1, pendingPrompts: [], source: "heuristic",
  }, Date.now() - 3 * 60_000);
  // An eligible settled generation: confirmed idle, hook-instrumented, an empty queue row, and
  // one completed work cycle - exactly what `consumePromptedGeneration` re-verifies.
  const session = registry.getSession(d.syntheticId)!;
  Object.assign(session, { hooksSeen: true, instrumented: true, stateConfirmed: true, state: "idle", pendingTurns: [] });
  assert.equal(registry.ensureQueue(d.syntheticId), noteKey);
  markWorkCycleActive(noteKey, Date.now() - 3 * 60_000);
  completeWorkCycle(noteKey, Date.now() - 2 * 60_000, Date.now() - 2 * 60_000);
  session.workCycle = workCycleFor(noteKey) ?? undefined;
  const intent = resolvedSessionIntent(registry.getGoal(d.syntheticId))!;
  const request = {
    logicalKey: noteKey,
    generation: 1,
    expectedIntent: {
      objective: intent.objective, objectiveVersion: intent.objectiveVersion,
      promptRevision: intent.promptRevision, episodeKey: intent.episodeKey,
    },
    ask: false,
    directHandoff: null,
    decision: null,
  };

  assert.equal(registry.reportBlocker(d.syntheticId, BODY).ok, true);
  assert.equal(registry.consumePromptedGeneration(d.syntheticId, request), false, "a blocked session's generation was consumed");
  assert.equal(getQueueRow(noteKey)?.promptedConsumedGeneration ?? null, null, "the refusal spent the generation");

  registry.clearBlocker(d.syntheticId, "operator");
  assert.equal(registry.consumePromptedGeneration(d.syntheticId, request), true, "clearing did not release the generation");
  assert.equal(getQueueRow(noteKey)?.promptedConsumedGeneration, 1);
});

function mkApp(registry: InstanceType<typeof Registry>) {
  return buildApp({
    registry,
    reviews: new ReviewManager(registry) as ReviewManagerT,
    tasks: {} as TaskManager,
    queues: {} as QueueManager,
  });
}

test("the MCP routes bind to the caller; the dashboard routes flag and clear as the operator", async () => {
  const registry = new Registry();
  const app = mkApp(registry);
  const sdk = registry.registerSdkSession({ id: `sdk:route-${++seq}`, agent: "claude", name: "embedded", cwd: "/repo", agentSessionId: `agent-route-${seq}` });
  const mcp = (path: string, body: unknown) => app.request(path, {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json", "x-harness-token": ensureToken() },
    body: JSON.stringify(body),
  });
  const api = (path: string, body: unknown) => app.request(path, {
    method: "POST",
    headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  assert.equal((await mcp("/mcp/blocker", { env: {}, sessionId: sdk.id, ...BODY, referenceUrl: "ftp://nope" })).status, 400);
  assert.equal((await mcp("/mcp/blocker", { env: {}, sessionId: sdk.id, ...BODY, kind: "user" })).status, 400);
  const set = await mcp("/mcp/blocker", { env: {}, sessionId: sdk.id, ...BODY });
  assert.equal(set.status, 200);
  assert.equal((await set.json()).created, true);
  assert.equal(registry.getBlocker(sdk.id)?.kind, "question");

  // Reply flag: the blocker stays, attributed to the operator.
  assert.equal((await api(`/api/sessions/${sdk.id}/blocker/reply`, { note: "answered" })).status, 200);
  assert.equal(registry.getBlocker(sdk.id)?.reply?.flaggedBy, "operator");

  // Clearing twice: the second is a no-op success.
  const cleared = await api(`/api/sessions/${sdk.id}/blocker/clear`, {});
  assert.deepEqual(await cleared.json(), { ok: true, cleared: true });
  assert.equal(registry.getBlocker(sdk.id), null);
  assert.equal((await api(`/api/sessions/${sdk.id}/blocker/reply`, {})).status, 409, "nothing to flag");
  const again = await mcp("/mcp/blocker/clear", { env: {}, sessionId: sdk.id, resolution: "done" });
  assert.deepEqual(await again.json(), { sessionId: sdk.id, cleared: false });
  assert.equal((await mcp("/mcp/blocker", { env: {}, sessionId: "sdk:nobody", ...BODY })).status, 404);
});
