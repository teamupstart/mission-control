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
const { Registry, noteKeyFor } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { ensureToken } = await import("../src/server/auth.ts");

type ReviewManagerT = import("../src/server/reviews.ts").ReviewManager;
type TaskManager = import("../src/server/tasks.ts").TaskManager;

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

test("a session whose task already finished cannot report a blocker", () => {
  const registry = new Registry();
  const d = mkDiscovered();
  registry.applyDiscovery([d]);
  const task = mkTask({ id: `task-finished-${seq}`, sessionId: d.syntheticId, status: "running", worktreePath: d.cwd });
  registry.upsertTask(task);
  registry.upsertTask({ ...task, status: "done" });
  assert.equal(registry.getSession(d.syntheticId)?.task?.id, task.id, "the session still names its finished task");
  const refused = registry.reportBlocker(d.syntheticId, BODY);
  assert.equal(refused.ok, false);
  assert.ok(!refused.ok && refused.status === 409 && /already done/.test(refused.error));
  assert.equal(registry.getBlocker(d.syntheticId), null, "a blocker was stored against a terminal task");
  assert.ok(!loadSessionBlockers().some((b) => b.noteKey === noteKeyFor(registry.getSession(d.syntheticId)!)));
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

test("moving a blocker to a key a session already holds blocks that session at once", () => {
  const registry = new Registry();
  const fromKey = `agent-move-from-${++seq}`;
  const toKey = `agent-move-to-${seq}`;
  const from = mkDiscovered({ agentSessionId: fromKey } as Partial<DiscoveredSession>);
  const to = mkDiscovered({ agentSessionId: toKey } as Partial<DiscoveredSession>);
  registry.applyDiscovery([from, to]);
  registry.reportBlocker(from.syntheticId, BODY);
  assert.equal(registry.getSession(to.syntheticId)?.blocker, null);
  // A reset's rebind: the destination session already exists when the blocker moves to it.
  registry.moveBlockerKey(fromKey, toKey);
  assert.equal(registry.getSession(to.syntheticId)?.blocker?.reason, BODY.reason, "Session.blocker was not re-projected");
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
    queues: {} as InstanceType<typeof QueueManager>,
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

test("the daemon refuses to advance a blocked session's queue items, as a backstop to the worker", async () => {
  const registry = new Registry();
  const queues = new QueueManager(registry);
  const app = buildApp({ registry, reviews: new ReviewManager(registry) as ReviewManagerT, tasks: {} as TaskManager, queues });
  const d = mkDiscovered({ agentSessionId: `agent-queue-${++seq}` } as Partial<DiscoveredSession>);
  registry.applyDiscovery([d]);
  // A hook-instrumented session, which is what a work queue requires.
  Object.assign(registry.getSession(d.syntheticId)!, { hooksSeen: true, instrumented: true });
  const item = queues.add(d.syntheticId, "Write the migration")!;
  assert.ok(item);
  const put = (state: string) => app.request(`/api/sessions/${d.syntheticId}/queue/${item.id}/state`, {
    method: "PUT", headers: { host: "127.0.0.1:7317", "content-type": "application/json" }, body: JSON.stringify({ state }),
  });
  const sent = () => app.request(`/api/sessions/${d.syntheticId}/queue/${item.id}/sent`, {
    method: "POST", headers: { host: "127.0.0.1:7317", "content-type": "application/json" }, body: JSON.stringify({ baseSha: null, transcriptAnchor: null }),
  });
  // The orphan sweep's keyed route reaches the same write, so it is held at the shared boundary.
  const putByKey = (state: string) => app.request(`/api/queues/${encodeURIComponent(item.noteKey)}/items/${item.id}/state`, {
    method: "PUT", headers: { host: "127.0.0.1:7317", "content-type": "application/json" }, body: JSON.stringify({ state }),
  });
  // A delivery already in flight when the blocker arrives is still recorded: the stamp is
  // bookkeeping for text that left, and refusing it would strand the item in `sending`.
  assert.equal((await put("sending")).status, 200);
  registry.reportBlocker(d.syntheticId, BODY);
  assert.equal((await sent()).status, 200, "an in-flight delivery's acknowledgement was refused");
  for (const state of ["sending", "awaiting_pickup", "in_progress", "verifying", "verified"]) {
    assert.equal((await put(state)).status, 409, `${state} advanced a blocked session's item`);
    assert.equal((await putByKey(state)).status, 409, `${state} advanced a blocked session's item through the keyed route`);
  }
  // Tidying the queue stays open while blocked, through either route.
  assert.equal((await putByKey("escalated")).status, 200);
  assert.equal((await put("cancelled")).status, 200);
});

test("the daemon refuses Foreman's automated writes and wrap-up ask into a blocked idle session", async () => {
  const registry = new Registry();
  const queues = new QueueManager(registry);
  const app = buildApp({ registry, reviews: new ReviewManager(registry) as ReviewManagerT, tasks: {} as TaskManager, queues });
  const d = mkDiscovered({ agentSessionId: `agent-foreman-${++seq}` } as Partial<DiscoveredSession>);
  registry.applyDiscovery([d]);
  Object.assign(registry.getSession(d.syntheticId)!, { hooksSeen: true, instrumented: true });
  registry.setForemanInvite(d.syntheticId, "dispatch");
  const post = (path: string, body: unknown) => app.request(`/api/sessions/${d.syntheticId}${path}`, {
    method: "POST", headers: { host: "127.0.0.1:7317", "content-type": "application/json" }, body: JSON.stringify(body),
  });
  registry.reportBlocker(d.syntheticId, BODY);

  const injected = await post("/inject", { text: "Wrap up and open the PR", origin: "foreman" });
  assert.equal(injected.status, 409);
  const body = await injected.json() as { error: string; pasted: boolean };
  assert.match(body.error, /blocked/);
  assert.equal(body.pasted, false, "the refusal must say nothing reached the pane, so the worker re-queues cleanly");
  const typed = await post("/send", { text: "draft", submit: false, origin: "foreman" });
  assert.equal(typed.status, 409);

  assert.equal((await post("/queue/wrapup/asked", {})).status, 409, "a blocked session was asked to ship");
  assert.equal((await post("/queue/wrapup/asked", { clearAnswer: true })).status, 200, "the reset must stay open");

  // Asking the operator does not reopen free text: a stale wrap-up or recovery payload is
  // still refused. A structured answer to the question on screen is the triage that stays open.
  Object.assign(registry.getSession(d.syntheticId)!, { state: "awaiting_input", stateConfirmed: true });
  const whileAsking = await post("/inject", { text: "Wrap up and open the PR", origin: "foreman" });
  assert.equal(whileAsking.status, 409, "a blocked session that is asking took a free-text Foreman write");
  const menuAnswer = await post("/select-option", { requestId: "r1", number: 1, label: "Yes", by: "foreman" });
  assert.doesNotMatch(((await menuAnswer.json()) as { error?: string }).error ?? "", /blocked on someone else/,
    "a structured triage answer was refused for the blocker");
  Object.assign(registry.getSession(d.syntheticId)!, { state: "idle" });

  // Cleared, the same Foreman write is no longer refused for the blocker.
  registry.clearBlocker(d.syntheticId, "operator");
  const after = await post("/inject", { text: "Wrap up and open the PR", origin: "foreman" });
  assert.doesNotMatch(((await after.json()) as { error?: string }).error ?? "", /blocked/);
});

test("a blocker reported while a Foreman write or wrap-up ask is in flight still refuses it", async () => {
  const registry = new Registry();
  const queues = new QueueManager(registry);
  const delivered: string[] = [];
  let duringSend: (() => void) | null = null;
  // The supervisor runs the delivery guard inside its per-session lock, after the route has
  // already passed its own checks. Reporting the blocker here is the in-flight window.
  const sdkSessions = {
    send: async (_id: string, input: { text: string }, guard?: () => string | null) => {
      duringSend?.();
      const blocked = guard?.();
      if (blocked) throw new Error(blocked);
      delivered.push(input.text);
      return "started";
    },
  } as unknown as import("../src/server/sdk/supervisor.ts").SdkSupervisor;
  const app = buildApp({ registry, reviews: new ReviewManager(registry) as ReviewManagerT, tasks: {} as TaskManager, queues, sdkSessions });
  const s = registry.registerSdkSession({ id: `sdk:inflight-${++seq}`, agent: "claude", name: "embedded", cwd: "/repo", agentSessionId: `agent-inflight-${seq}` });
  const report = () => { registry.reportBlocker(s.id, BODY); };
  const post = (path: string, body: unknown) => app.request(`/api/sessions/${s.id}${path}`, {
    method: "POST", headers: { host: "127.0.0.1:7317", "content-type": "application/json" }, body: JSON.stringify(body),
  });

  for (const [path, body] of [
    ["/inject", { text: "Wrap up and open the PR", origin: "foreman" }],
    ["/send", { text: "Wrap up and open the PR", submit: true, origin: "foreman" }],
  ] as const) {
    duringSend = report;
    const res = await post(path, body);
    duringSend = null;
    const json = await res.json() as { ok?: boolean; error?: string };
    assert.notEqual(json.ok, true, `${path} delivered after a blocker landed mid-delivery`);
    assert.match(json.error ?? "", /blocked on someone else/);
    assert.deepEqual(delivered, []);
    registry.clearBlocker(s.id, "operator");
  }

  // The wrap-up ask: the blocker lands while the daemon is still reading the request body.
  const encoder = new TextEncoder();
  const streamed = new ReadableStream<Uint8Array>({
    pull(controller) {
      report();
      controller.enqueue(encoder.encode("{}"));
      controller.close();
    },
  });
  const asked = await app.request(new Request(`http://127.0.0.1:7317/api/sessions/${s.id}/queue/wrapup/asked`, {
    method: "POST", headers: { host: "127.0.0.1:7317", "content-type": "application/json" }, body: streamed,
    duplex: "half",
  } as RequestInit));
  assert.equal(asked.status, 409, "the wrap-up ask read a session snapshot from before the blocker");
});
