import { MISSION_TEST_MCP_DEPS } from "./helpers/mission-mcp-deps.ts";
import { ensureNativeStateLockAddon } from "./helpers/native-state-lock.ts";
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, renameSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

// Hibernating a task (issue #1547): what is at stake is the operator's work. A hibernated task
// must keep its conversation, worktree, blocker and workflow binding through its agent leaving,
// through a daemon restart and through a failed Resume - and a Resume must reopen the SAME
// conversation under the SAME session id, never start the task over.

ensureNativeStateLockAddon();

const home = mkdtempSync(join(tmpdir(), "mission-hibernation-"));
// Set before importing anything that resolves the state dir (see db-isolation.test.ts).
process.env.HARNESS_HOME = join(home, "state");

const db = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { SdkSupervisor } = await import("../src/server/sdk/supervisor.ts");
const { getSdkSession, setSdkSessionStatus } = await import("../src/server/sdk/store.ts");
const { HARNESSES } = await import("../src/server/harness/index.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { HibernationManager } = await import("../src/server/hibernation/manager.ts");
const { applyFeatureFlagIntent } = await import("../src/server/feature-flags/index.ts");
const {
  hibernateRefusal,
  hibernatedTasks,
  hibernationHoldsConversation,
  parseTaskHibernation,
} = await import("../src/shared/hibernation.ts");
const { mkSession, mkTask } = await import("./helpers/session-fixture.ts");

type Handle = import("../src/server/harness/types.ts").SdkSessionHandle;
type SdkEvent = import("../src/server/harness/types.ts").SdkEvent;
type SdkTurn = import("../src/server/harness/types.ts").SdkTurn;
type LaunchOptions = import("../src/server/harness/types.ts").SdkLaunchOptions;
type ServerEvent = import("../src/shared/types.ts").ServerEvent;
type Task = import("../src/shared/types.ts").Task;
type RegistryT = InstanceType<typeof Registry>;

after(() => {
  db.closeDb();
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  db.openDb().exec("DELETE FROM sdk_sessions; DELETE FROM tasks;");
  applyFeatureFlagIntent({ kind: "flag", id: "task-hibernation", enabled: true });
});

type FakeHandle = Handle & { push: (e: SdkEvent) => void; stopped: boolean; sent: SdkTurn[] };

/** A driver whose events the test pushes by hand. Stopping it ends its stream. */
function fakeHandle(): FakeHandle {
  const queued: SdkEvent[] = [];
  const sent: SdkTurn[] = [];
  let waiting: ((r: IteratorResult<SdkEvent>) => void) | null = null;
  const push = (e: SdkEvent): void => {
    const w = waiting;
    if (w) {
      waiting = null;
      w({ value: e, done: false });
      return;
    }
    queued.push(e);
  };
  const handle: FakeHandle = {
    push,
    sent,
    stopped: false,
    events: {
      async *[Symbol.asyncIterator](): AsyncGenerator<SdkEvent> {
        for (;;) {
          const next = queued.shift();
          if (next) {
            yield next;
            if (next.kind === "exited") return;
            continue;
          }
          const m = await new Promise<IteratorResult<SdkEvent>>((r) => (waiting = r));
          if (m.done) return;
          yield m.value;
          if (m.value.kind === "exited") return;
        }
      },
    },
    async send(turn: SdkTurn) {
      sent.push(turn);
      return "started" as const;
    },
    async sendIfIdle(turn: SdkTurn) {
      sent.push(turn);
      return "started" as const;
    },
    async interrupt() {},
    async answer() {},
    setPermissionMode: null,
    setEffort: null,
    setModel: null,
    clearContext: null,
    async stop() {
      handle.stopped = true;
      push({ kind: "exited", reason: "stopped", resumable: true });
    },
  } as unknown as FakeHandle;
  return handle;
}

/** A woken driver that reports reopening `conversation`, as a real one does when it binds. */
function boundTo(handle: FakeHandle, conversation: string): FakeHandle {
  handle.push({ kind: "bound", agentSessionId: conversation, transcriptPath: null, modelId: null, pid: null });
  return handle;
}

/** Point Claude's harness slot at a scripted driver for the duration of one test. */
function withFakeDriver(launch: (opts: LaunchOptions) => Promise<Handle>): { restore: () => void; calls: LaunchOptions[] } {
  const calls: LaunchOptions[] = [];
  const real = HARNESSES.claude.sdk;
  HARNESSES.claude.sdk = {
    answersRequests: true,
    launch: (opts) => {
      calls.push(opts);
      return launch(opts);
    },
  };
  return { restore: () => (HARNESSES.claude.sdk = real), calls };
}

async function drain(turns = 20): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r));
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function checkout(name: string): string {
  const dir = join(home, "worktrees", name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

let replacements = 0;
/**
 * Another directory standing at `dir`'s path, as when a worktree is removed and something else
 * is created there. The original is moved aside rather than deleted, so the two can never share
 * an inode: ext4 (CI's Linux) hands a just-freed inode number straight to the next directory,
 * which no stat can tell from the same one. APFS, on the macOS Mission Control runs on, does not
 * reuse file ids that way, which is what `checkoutIdentity` relies on.
 */
function replaceCheckout(dir: string): void {
  renameSync(dir, `${dir}.replaced-${++replacements}`);
  mkdirSync(dir, { recursive: true });
}

interface Fleet {
  registry: RegistryT;
  supervisor: InstanceType<typeof SdkSupervisor>;
  tasks: InstanceType<typeof TaskManager>;
  hibernation: InstanceType<typeof HibernationManager>;
  removed: string[];
}

function fleet(): Fleet {
  const registry = new Registry();
  const removed: string[] = [];
  registry.subscribe((e: ServerEvent) => {
    if (e.type === "session_remove") removed.push(e.id);
  });
  const supervisor = new SdkSupervisor(registry, MISSION_TEST_MCP_DEPS);
  // A real TaskManager, because it is the subscriber that fails a task whose agent leaves:
  // the point of the ordering is that it finds nothing to fail.
  const tasks = new TaskManager(registry, undefined, supervisor);
  // A short wait for a woken driver's own report, so a driver that never reports fails fast.
  const hibernation = new HibernationManager(registry, supervisor, { confirmMs: 300 });
  return { registry, supervisor, tasks, hibernation, removed };
}

/** An idle Agent SDK session bound to a running task, with its conversation id reported. */
async function idleTask(f: Fleet, handle: FakeHandle, id: string, cwd: string): Promise<{ task: Task; sessionId: string }> {
  const session = await f.supervisor.start({
    agent: "claude",
    name: id,
    cwd,
    prompt: "do the thing",
    model: null,
    effort: null,
    permissionMode: null,
    mcp: null,
    taskId: id,
  });
  handle.push({ kind: "bound", agentSessionId: `conv-${id}`, transcriptPath: null, modelId: null, pid: null });
  handle.push({ kind: "turn_done", usage: null });
  const task = mkTask({ id, title: id, status: "running", sessionId: session.id, worktreePath: cwd, repoRoot: cwd });
  f.registry.upsertTask(task);
  await waitFor(() => f.registry.getSession(session.id)?.state === "idle" && f.registry.getSession(session.id)?.task?.id === id);
  return { task, sessionId: session.id };
}

// ---- the shared predicate -----------------------------------------------------------------

test("only an idle session of a running task, with a known conversation, can be hibernated", () => {
  const task = { ...mkTask({ id: "t", status: "running" }), ensemble: null };
  const base = mkSession({
    agent: "claude",
    runtime: "sdk",
    state: "idle",
    agentSessionId: "conv",
    task: { id: "t", status: "running", kind: "ship", ensemble: null } as never,
  });
  assert.equal(hibernateRefusal(base), null);
  // A terminal agent is its own process whichever harness it is, Codex and Pi included.
  assert.equal(hibernateRefusal({ ...base, runtime: "terminal" }), null);
  assert.equal(hibernateRefusal({ ...base, runtime: "terminal", agent: "codex" }), null);
  assert.equal(hibernateRefusal({ ...base, runtime: "terminal", agent: "pi" }), null);
  // Only an embedded Pi, whose driver runs inside the daemon, has no memory to free.
  assert.match(hibernateRefusal({ ...base, agent: "pi" }) ?? "", /free no memory/);
  assert.equal(hibernateRefusal({ ...base, agent: "codex" }), null);
  assert.match(hibernateRefusal({ ...base, task: null }) ?? "", /task's session/);
  assert.match(hibernateRefusal({ ...base, task: { ...base.task!, status: "done" } }) ?? "", /not running/);
  assert.match(hibernateRefusal({ ...base, task: { ...base.task!, kind: "pipeline" } }) ?? "", /own lifecycle/);
  assert.match(hibernateRefusal({ ...base, state: "working" }) ?? "", /middle of a turn/);
  assert.match(hibernateRefusal({ ...base, state: "awaiting_input" }) ?? "", /waiting for an answer/);
  assert.match(hibernateRefusal({ ...base, state: "exited" }) ?? "", /already ending/);
  assert.match(hibernateRefusal({ ...base, agentSessionId: null }) ?? "", /could not reopen/);
  assert.match(hibernateRefusal({ ...base, pendingReviews: 1 }) ?? "", /question waiting/);
  assert.match(hibernateRefusal({ ...base, pendingTurns: [{} as never] }) ?? "", /Messages/);
  void task;
});

test("a stored hibernation reads back, and an unreadable one reads as none", () => {
  const record = { sessionId: "sdk:a", runtime: "sdk" as const, permissionMode: null, checkout: null, agentSessionId: "c", noteKey: "c", hibernatedAt: 5, blocker: null, failure: null };
  assert.deepEqual(parseTaskHibernation(JSON.stringify(record)), record);
  assert.equal(parseTaskHibernation("{not json"), null);
  assert.equal(parseTaskHibernation(JSON.stringify({ ...record, sessionId: "" })), null);
  assert.equal(parseTaskHibernation(null), null);
});

test("the record persists only while the task is hibernated, and hibernated tasks reload on start", () => {
  const hibernation = { sessionId: "sdk:p", runtime: "sdk" as const, permissionMode: null, checkout: null, agentSessionId: "c", noteKey: "c", hibernatedAt: 9, blocker: null, failure: null };
  db.upsertTask(mkTask({ id: "persist", status: "hibernated", hibernation }));
  assert.deepEqual(db.getTask("persist")?.hibernation, hibernation);
  assert.ok(db.loadActiveTasks().some((t) => t.id === "persist"), "a hibernated task is reloaded on start");
  // A status change that forgot to clear the record cannot leave it behind.
  db.upsertTask({ ...db.getTask("persist")!, status: "done" });
  assert.equal(db.getTask("persist")?.hibernation, null);
});

test("hibernated tasks list longest-asleep last, and only a hibernated task holds its session's conversation", () => {
  const rec = (sessionId: string, at: number) => ({ sessionId, runtime: "sdk" as const, permissionMode: null, checkout: null, agentSessionId: "c", noteKey: "c", hibernatedAt: at, blocker: null, failure: null });
  const tasks = [
    mkTask({ id: "old", status: "hibernated", hibernation: rec("sdk:old", 1) }),
    mkTask({ id: "run", status: "running", sessionId: "sdk:run" }),
    mkTask({ id: "new", status: "hibernated", hibernation: rec("sdk:new", 2) }),
  ];
  assert.deepEqual(hibernatedTasks(tasks).map((t) => t.id), ["new", "old"]);
  assert.equal(hibernationHoldsConversation(tasks, "sdk:old", "c"), true);
  assert.equal(hibernationHoldsConversation(tasks, "sdk:old", "another-conversation"), false, "only the hibernated conversation");
  assert.equal(hibernationHoldsConversation(tasks, "sdk:run", "c"), false);
  assert.equal(hibernationHoldsConversation(tasks, null, "c"), false);
});

// ---- hibernate ----------------------------------------------------------------------------

test("hibernate stops the agent and keeps the task, its conversation and its blocker", async (t) => {
  const handle = fakeHandle();
  const fake = withFakeDriver(async () => handle);
  t.after(fake.restore);
  const f = fleet();
  t.after(() => f.tasks.stopMissionSessionClosures());
  const cwd = checkout("keeps");
  const { sessionId } = await idleTask(f, handle, "keeps", cwd);
  const blocked = f.registry.reportBlocker(sessionId, {
    kind: "dependency", reason: "Needs the staging key", waitingOn: "Priya", resumeWhen: "the key arrives",
    referenceUrl: null, details: null,
  });
  assert.equal(blocked.ok, true);
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const result = await f.hibernation.hibernate(sessionId);
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  assert.equal(handle.stopped, true, "the agent's driver was stopped");
  const task = f.registry.getTask("keeps")!;
  assert.equal(task.status, "hibernated");
  assert.equal(task.sessionId, null);
  assert.equal(task.worktreePath, cwd, "the worktree is kept");
  assert.equal(task.hibernation?.sessionId, sessionId);
  assert.equal(task.hibernation?.agentSessionId, "conv-keeps");
  assert.deepEqual(task.hibernation?.blocker && { kind: task.hibernation.blocker.kind, reason: task.hibernation.blocker.reason },
    { kind: "dependency", reason: "Needs the staging key" });
  await drain();
  assert.equal(getSdkSession(sessionId)?.status, "hibernated", "the row waits for Resume, not for a restart");

  t.mock.timers.tick(9_000);
  await drain();
  assert.deepEqual(f.removed, [sessionId], "the stopped card leaves through the ordinary eviction");
  assert.equal(f.registry.getTask("keeps")?.status, "hibernated", "the agent leaving does not fail the task");
  assert.equal(db.getTask("keeps")?.status, "hibernated");
  // The blocker outlives its holder for as long as the task sleeps.
  f.registry.applyDiscovery([]);
  assert.equal(f.registry.pruneBlockers(Date.now() + 365 * 86_400_000), 0, "a hibernated task's blocker is never pruned");
});

test("hibernate is refused while the preview is off, mid-turn, or when the stop fails", async (t) => {
  const handle = fakeHandle();
  const fake = withFakeDriver(async () => handle);
  t.after(fake.restore);
  const f = fleet();
  t.after(() => f.tasks.stopMissionSessionClosures());
  const { sessionId } = await idleTask(f, handle, "refused", checkout("refused"));

  applyFeatureFlagIntent({ kind: "flag", id: "task-hibernation", enabled: false });
  const off = await f.hibernation.hibernate(sessionId);
  assert.deepEqual(off.ok ? null : off.status, 404);
  applyFeatureFlagIntent({ kind: "flag", id: "task-hibernation", enabled: true });

  handle.push({ kind: "state", state: "working", activity: "editing" } as SdkEvent);
  await waitFor(() => f.registry.getSession(sessionId)?.state === "working");
  const busy = await f.hibernation.hibernate(sessionId);
  assert.match(busy.ok ? "" : busy.error, /middle of a turn/);
  handle.push({ kind: "turn_done", usage: null });
  await waitFor(() => f.registry.getSession(sessionId)?.state === "idle");

  handle.stop = async () => {
    throw new Error("driver refused stop");
  };
  const stuck = await f.hibernation.hibernate(sessionId);
  assert.match(stuck.ok ? "" : stuck.error, /still running: driver refused stop/);
  const task = f.registry.getTask("refused")!;
  assert.equal(task.status, "running", "a stop that failed puts the task back");
  assert.equal(task.sessionId, sessionId);
  assert.equal(task.hibernation ?? null, null);
});

// ---- resume -------------------------------------------------------------------------------

async function hibernated(f: Fleet, t: import("node:test").TestContext, id: string, cwd: string): Promise<string> {
  const handle = fakeHandle();
  const first = withFakeDriver(async () => handle);
  const { sessionId } = await idleTask(f, handle, id, cwd);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const result = await f.hibernation.hibernate(sessionId);
  assert.equal(result.ok, true);
  await drain();
  t.mock.timers.tick(9_000);
  await drain();
  t.mock.timers.reset();
  first.restore();
  assert.equal(f.registry.getSession(sessionId), undefined);
  return sessionId;
}

test("resume reopens the same conversation under the same session id and binds the task back", async (t) => {
  const f = fleet();
  t.after(() => f.tasks.stopMissionSessionClosures());
  const sessionId = await hibernated(f, t, "wake", checkout("wake"));

  const resumed = boundTo(fakeHandle(), "conv-wake");
  const fake = withFakeDriver(async () => resumed);
  t.after(fake.restore);
  const result = await f.hibernation.resume("wake");
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]!.resume, "conv-wake", "the same conversation is reopened");
  assert.equal(fake.calls[0]!.prompt, "", "and the task is not started over");
  const task = f.registry.getTask("wake")!;
  assert.equal(task.status, "running");
  assert.equal(task.sessionId, sessionId, "under the same session id every binding is keyed on");
  assert.equal(task.hibernation ?? null, null);
  assert.equal(f.registry.getSession(sessionId)?.task?.id, "wake");
  assert.deepEqual(resumed.sent, [], "an idle conversation is reopened without a turn");
});

test("switching the preview off after Hibernate still lets the task Resume its conversation", async (t) => {
  const f = fleet();
  t.after(() => f.tasks.stopMissionSessionClosures());
  const sessionId = await hibernated(f, t, "flag-off", checkout("flag-off"));
  applyFeatureFlagIntent({ kind: "flag", id: "task-hibernation", enabled: false });

  // Hibernate is gone with the preview...
  const refused = await f.hibernation.hibernate(sessionId);
  assert.deepEqual(refused.ok ? null : refused.status, 404);
  // ...and Resume, through the route a dashboard calls, is not: nothing is stranded.
  const resumed = boundTo(fakeHandle(), "conv-flag-off");
  const fake = withFakeDriver(async () => resumed);
  t.after(fake.restore);
  const { Hono } = await import("hono");
  const { registerHibernationRoutes } = await import("../src/server/hibernation/routes.ts");
  const app = new Hono();
  registerHibernationRoutes(app, f.hibernation);
  const response = await app.request("/api/tasks/flag-off/resume", { method: "POST" });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]!.resume, "conv-flag-off", "the same conversation is reopened");
  const task = f.registry.getTask("flag-off")!;
  assert.equal(task.status, "running");
  assert.equal(task.sessionId, sessionId);
});

test("an Agent SDK Resume binds the task only once its driver reports reopening the saved conversation", async (t) => {
  // The woken driver reports a DIFFERENT conversation.
  const f = fleet();
  t.after(() => f.tasks.stopMissionSessionClosures());
  const sessionId = await hibernated(f, t, "sdk-other", checkout("sdk-other"));
  const other = boundTo(fakeHandle(), "conv-something-else");
  const first = withFakeDriver(async () => other);
  const wrong = await f.hibernation.resume("sdk-other");
  first.restore();
  assert.match(wrong.ok ? "" : wrong.error, /its driver opened conversation conv-something-else instead of conv-sdk-other/);
  assert.equal(other.stopped, true, "that driver was stopped again");
  await drain();
  assert.equal(getSdkSession(sessionId)?.status, "hibernated", "and its row is resumable");
  const parked = f.registry.getTask("sdk-other")!;
  assert.equal(parked.status, "hibernated", "the task was not bound to it");
  assert.equal(parked.sessionId, null);
  assert.equal(parked.hibernation?.agentSessionId, "conv-sdk-other", "and still waits for its own conversation");

  // The woken driver never reports any conversation.
  const g = fleet();
  t.after(() => g.tasks.stopMissionSessionClosures());
  const silentId = await hibernated(g, t, "sdk-silent", checkout("sdk-silent"));
  const silent = fakeHandle();
  const second = withFakeDriver(async () => silent);
  const unconfirmed = await g.hibernation.resume("sdk-silent");
  second.restore();
  assert.match(unconfirmed.ok ? "" : unconfirmed.error, /its driver did not report reopening the conversation within 0 seconds/);
  assert.equal(silent.stopped, true);
  await drain();
  assert.equal(getSdkSession(silentId)?.status, "hibernated");
  assert.equal(g.registry.getTask("sdk-silent")?.status, "hibernated");
  assert.equal(g.registry.getTask("sdk-silent")?.sessionId, null);
});

test("a failed resume says why, keeps the task hibernated, and a retry succeeds", async (t) => {
  const f = fleet();
  t.after(() => f.tasks.stopMissionSessionClosures());
  const cwd = checkout("retry");
  const sessionId = await hibernated(f, t, "retry", cwd);

  // The checkout moved away: refused before any process starts.
  const aside = `${cwd}-aside`;
  renameSync(cwd, aside);
  const launches = withFakeDriver(async () => fakeHandle());
  const gone = await f.hibernation.resume("retry");
  assert.match(gone.ok ? "" : gone.error, /no longer exists/);
  assert.equal(launches.calls.length, 0, "nothing was launched into a missing checkout");
  assert.match(f.registry.getTask("retry")?.hibernation?.failure?.reason ?? "", /no longer exists/);
  assert.equal(db.getTask("retry")?.hibernation?.failure !== null, true, "the reason is durable");
  launches.restore();
  renameSync(aside, cwd);

  // The harness refuses: the reason is recorded, the row stays resumable.
  const refusing = withFakeDriver(async () => {
    throw new Error("conversation file missing");
  });
  const refused = await f.hibernation.resume("retry");
  refusing.restore();
  assert.match(refused.ok ? "" : refused.error, /conversation file missing/);
  assert.equal(f.registry.getTask("retry")?.status, "hibernated");
  assert.match(f.registry.getTask("retry")?.hibernation?.failure?.reason ?? "", /conversation file missing/);
  assert.equal(getSdkSession(sessionId)?.status, "hibernated");

  const handle = boundTo(fakeHandle(), "conv-retry");
  const working = withFakeDriver(async () => handle);
  t.after(working.restore);
  const retried = await f.hibernation.resume("retry");
  assert.equal(retried.ok, true, retried.ok ? "" : retried.error);
  assert.equal(f.registry.getTask("retry")?.status, "running");
  assert.equal(f.registry.getTask("retry")?.hibernation ?? null, null, "a success clears the failure");
});

test("a restart leaves a hibernated task's conversation for the operator's Resume", async (t) => {
  const handle = fakeHandle();
  const fake = withFakeDriver(async () => handle);
  t.after(fake.restore);
  const cwd = checkout("restart");
  const hibernation = { sessionId: "sdk:restart", runtime: "sdk" as const, permissionMode: null, checkout: null, agentSessionId: "conv-r", noteKey: "conv-r", hibernatedAt: 1, blocker: null, failure: null };
  db.upsertTask(mkTask({ id: "restart", status: "hibernated", worktreePath: cwd, hibernation }));
  // The daemon died after recording the hibernation and before the driver's end was written.
  const { upsertSdkSession } = await import("../src/server/sdk/store.ts");
  upsertSdkSession({ id: "sdk:restart", agent: "claude", agentSessionId: "conv-r", cwd, taskId: "restart",
    model: null, effort: null, permissionMode: null, status: "running", turnInProgress: false });
  const registry = new Registry();
  const supervisor = new SdkSupervisor(registry, MISSION_TEST_MCP_DEPS);
  await supervisor.restore();
  assert.equal(fake.calls.length, 0, "restore does not wake a hibernated conversation");
  assert.equal(getSdkSession("sdk:restart")?.status, "hibernated");
  // And an ordinary hibernated row is not live, so a later restart leaves it too.
  setSdkSessionStatus("sdk:restart", "hibernated");
  await new SdkSupervisor(new Registry(), MISSION_TEST_MCP_DEPS).restore();
  assert.equal(fake.calls.length, 0);
});

// ---- the routes ---------------------------------------------------------------------------

test("hibernate and resume are operator actions, and answer without a supervisor", async () => {
  const { Hono } = await import("hono");
  const { registerHibernationRoutes } = await import("../src/server/hibernation/routes.ts");
  const f = fleet();
  const app = new Hono();
  registerHibernationRoutes(app, f.hibernation);
  const agent = await app.request("/api/sessions/sdk:x/hibernate", { method: "POST", headers: { "x-harness-token": "t" } });
  assert.equal(agent.status, 403);
  assert.match(((await agent.json()) as { error: string }).error, /Only the operator/);
  const foreign = await app.request("/api/tasks/x/resume", { method: "POST", headers: { origin: "https://evil.example" } });
  assert.equal(foreign.status, 403);
  const missing = await app.request("/api/tasks/nope/resume", { method: "POST" });
  assert.equal(missing.status, 404);

  const bare = new Hono();
  registerHibernationRoutes(bare, undefined);
  assert.equal((await bare.request("/api/sessions/sdk:x/hibernate", { method: "POST" })).status, 503);
  f.tasks.stopMissionSessionClosures();
});

// ---- terminal sessions --------------------------------------------------------------------

type Discovered = import("../src/server/discovery/correlate.ts").DiscoveredSession;
const { mkMuxHandle } = await import("./helpers/session-fixture.ts");

function discovered(id: string, cwd: string, pane: string, pid: number): Discovered {
  return {
    syntheticId: id,
    agent: "claude",
    name: "work",
    nameSource: "process",
    cwd,
    gitBranch: "harness/terminal",
    pid,
    tty: `ttys${pid}`,
    terminals: [mkMuxHandle({ session: `home-${pid}`, paneId: pane })],
    startedAt: pid,
  } as Discovered;
}

/** The hook a terminal agent fires once it is up, which is what names its conversation. */
function started(registry: RegistryT, cwd: string, pane: string, conversation: string): void {
  registry.applyHook({ agent: "claude", event: "SessionStart", sessionId: conversation, cwd, transcriptPath: null,
    env: { tmuxPane: pane } } as never);
  registry.applyHook({ agent: "claude", event: "Stop", sessionId: conversation, cwd, transcriptPath: null,
    env: { tmuxPane: pane } } as never);
}

interface TerminalFleet {
  /** Discovery ids are unique per process, and the registry remembers each one's conversation. */
  old: string;
  fresh: string;
  registry: RegistryT;
  hibernation: InstanceType<typeof HibernationManager>;
  tasks: InstanceType<typeof TaskManager>;
  stopped: string[];
  spawned: Array<{ name: string; terminalBackend: string | null }>;
  closed: string[];
  prepared: Array<{ agentSessionId: string | null; permissionMode: string | null; cwd: string | null }>;
  /** The leases of preparations released through `dispose`, in order. */
  disposed: string[];
  /** Switches a test flips between attempts. */
  controls: {
    /** Whether the launched agent comes up on the conversation. */
    appear: boolean;
    /** Whether an agent the operator opened by hand comes up on the same conversation. */
    competitor: boolean;
    /** How many more closes of a launched terminal fail. */
    closeFailures: number;
    /** Whether a launch's lease is still live. */
    live: boolean;
    /** Whether closing a launch's home ends its agent, releasing the lease. */
    closeEnds: boolean;
  };
}

/**
 * A terminal task whose agent is idle at `cwd`. `appears` decides what a resume's launch does:
 * bring up a new agent on the conversation, or nothing.
 */
function terminalFleet(
  cwd: string,
  options: {
    appears?: boolean; stopFails?: boolean; prepareFails?: string; reports?: string; spawnRefusals?: number;
    competitor?: boolean; closeFailures?: number;
    /** The stop reports success but the agent stays up: an interrupted or not-yet-finished stop. */
    survives?: boolean;
    /**
     * Another agent already working in the checkout on a different conversation, which switches
     * to the hibernated one while the launch is coming up.
     */
    switcher?: boolean;
    /**
     * What happens while the launched agent's proof is being read: it switches conversation or
     * exits, or the operator deletes or cancels the task.
     */
    afterProof?: "switch" | "exit" | "delete" | "cancel";
    /** The checkout is removed and recreated at its path while the launch comes up. */
    replaceDuringLaunch?: boolean;
  } = {},
): TerminalFleet {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const old = `proc-old-${basename(cwd)}`;
  const fresh = `proc-new-${basename(cwd)}`;
  const stopped: string[] = [];
  const spawned: TerminalFleet["spawned"] = [];
  const closed: string[] = [];
  const prepared: TerminalFleet["prepared"] = [];
  const disposed: string[] = [];
  const controls: TerminalFleet["controls"] = {
    appear: options.appears !== false,
    competitor: options.competitor ?? false,
    closeFailures: options.closeFailures ?? 0,
    live: false,
    closeEnds: true,
  };
  let launches = 0;
  // Sessions that stay in every discovery sweep, whatever the test does to the others.
  const resident: Discovered[] = options.switcher ? [discovered(`proc-switch-${basename(cwd)}`, cwd, "%5", 5)] : [];
  const hibernation = new HibernationManager(registry, null, {
    terminal: {
      stop: async (session) => {
        if (options.stopFails) return { ok: false, error: "the pane refused" };
        stopped.push(session.id);
        if (!options.survives) registry.applyDiscovery([...resident]);
        return { ok: true };
      },
      prepare: async (source) => {
        if (options.prepareFails) throw new Error(options.prepareFails);
        prepared.push({ agentSessionId: source.agentSessionId, permissionMode: source.permissionMode ?? null, cwd: source.cwd });
        // `dispose` answers false: the guard claimed the lease, so the agent did start and only
        // closing its terminal can end it.
        const id = `lease-${prepared.length}`;
        return { lease: { id, root: "/fixture/leases" }, dispose: () => (disposed.push(id), false) } as never;
      },
      spawn: async (input) => {
        spawned.push({ name: input.name, terminalBackend: input.terminalBackend });
        if (options.replaceDuringLaunch) {
          replaceCheckout(cwd);
        }
        if ((options.spawnRefusals ?? 0) >= spawned.length) {
          throw new Error("tmux refused to create the session");
        }
        launches++;
        const launch = launches;
        setImmediate(() => {
          const up: Discovered[] = [];
          if (controls.appear) up.push(discovered(fresh, cwd, "%2", 2));
          if (controls.competitor) up.push(discovered(`proc-hand-${basename(cwd)}-${launch}`, cwd, "%7", 70 + launch));
          if (up.length === 0) return;
          registry.applyDiscovery([...up, ...resident]);
          if (controls.appear) started(registry, cwd, "%2", options.reports ?? "conv-t");
          if (controls.competitor) started(registry, cwd, "%7", "conv-t");
          if (options.switcher) started(registry, cwd, "%5", "conv-t");
        });
        return { homeName: input.name, homeBackend: "tmux", terminalResourceId: "multiplexer:tmux:$9" };
      },
      // The launch this resume started is the new agent at its own pane; anything else on the
      // conversation was opened some other way.
      provesLaunch: async (session) => {
        const ours = session.id === fresh;
        if (ours && options.afterProof) {
          // While the proof is being read - after the hooks that brought it up have landed.
          await new Promise((resolve) => setImmediate(resolve));
          if (options.afterProof === "switch") started(registry, cwd, "%2", "conv-elsewhere");
          else if (options.afterProof === "delete") registry.removeTask("term");
          else if (options.afterProof === "cancel") {
            registry.upsertTask({ ...registry.getTask("term")!, status: "cancelled", hibernation: null });
          } else registry.applyDiscovery([...resident]);
        }
        return ours;
      },
      closeHome: async (home) => {
        closed.push(home.homeName);
        if (controls.closeFailures > 0) {
          controls.closeFailures--;
          return { ok: false, error: "tmux: no server running" };
        }
        if (controls.closeEnds) controls.live = false;
        return { ok: true };
      },
      launchLive: () => controls.live,
      launchEndMs: 100,
      // The process is gone once the stop took effect; a survivor never goes.
      exited: async (session) => registry.getSession(session.id)?.state === "exited" || !registry.getSession(session.id),
      backendFor: () => "tmux",
      appearMs: 300,
    },
  });
  registry.applyDiscovery([discovered(old, cwd, "%1", 1), ...resident]);
  started(registry, cwd, "%1", "conv-t");
  if (options.switcher) started(registry, cwd, "%5", "conv-other");
  registry.upsertTask(mkTask({ id: "term", title: "Terminal task", status: "running", sessionId: old, worktreePath: cwd, repoRoot: cwd }));
  return { old, fresh, registry, hibernation, tasks, stopped, spawned, closed, prepared, disposed, controls };
}

test("a terminal session hibernates like Kill stops it, and Resume reopens its conversation in a new home", async (t) => {
  const cwd = checkout("terminal");
  const f = terminalFleet(cwd);
  t.after(() => f.tasks.stopMissionSessionClosures());
  const session = f.registry.getSession(f.old)!;
  assert.equal(session.state, "idle");
  assert.equal(session.agentSessionId, "conv-t");
  assert.equal(session.task?.id, "term");

  const hibernated = await f.hibernation.hibernate(f.old);
  assert.equal(hibernated.ok, true, hibernated.ok ? "" : hibernated.error);
  assert.deepEqual(f.stopped, [f.old], "the agent was stopped the way Kill stops it");
  const parked = f.registry.getTask("term")!;
  assert.equal(parked.status, "hibernated");
  assert.equal(parked.sessionId, null);
  assert.equal(parked.hibernation?.runtime, "terminal");
  assert.equal(parked.hibernation?.sessionId, f.old);
  assert.equal(parked.hibernation?.agentSessionId, "conv-t");
  f.registry.emit("event", { type: "session_remove", id: f.old });
  assert.equal(f.registry.getTask("term")?.status, "hibernated", "the agent leaving does not fail the task");

  const resumed = await f.hibernation.resume("term");
  assert.equal(resumed.ok, true, resumed.ok ? "" : resumed.error);
  assert.deepEqual(f.prepared, [{ agentSessionId: "conv-t", permissionMode: null, cwd }], "the same conversation, in the same checkout");
  assert.deepEqual(f.spawned, [{ name: "Terminal task", terminalBackend: "tmux" }]);
  const task = f.registry.getTask("term")!;
  assert.equal(task.status, "running");
  assert.equal(task.sessionId, f.fresh, "the task follows the new process");
  assert.equal(task.homeName, "Terminal task");
  assert.equal(task.terminalResourceId, "multiplexer:tmux:$9");
  assert.equal(task.hibernation ?? null, null);
  assert.equal(f.registry.getSession(f.fresh)?.task?.id, "term");
});

test("a terminal Resume whose agent never appears closes its home and stays hibernated", async (t) => {
  const cwd = checkout("terminal-silent");
  const f = terminalFleet(cwd, { appears: false });
  t.after(() => f.tasks.stopMissionSessionClosures());
  assert.equal((await f.hibernation.hibernate(f.old)).ok, true);
  const silent = await f.hibernation.resume("term");
  assert.match(silent.ok ? "" : silent.error, /did not reopen the conversation in Terminal task within/);
  assert.deepEqual(f.closed, ["Terminal task"], "the home it opened is closed rather than left to start late");
  assert.equal(f.registry.getTask("term")?.status, "hibernated");
  assert.match(f.registry.getTask("term")?.hibernation?.failure?.reason ?? "", /did not reopen the conversation/);
});

test("a terminal Resume binds only the agent that reports the hibernated conversation", async (t) => {
  const cwd = checkout("terminal-other-conversation");
  // The new agent at the checkout reports a DIFFERENT conversation id.
  const f = terminalFleet(cwd, { reports: "conv-someone-else" });
  t.after(() => f.tasks.stopMissionSessionClosures());
  const parked = await f.hibernation.hibernate(f.old);
  assert.equal(parked.ok, true, parked.ok ? "" : parked.error);
  const wrong = await f.hibernation.resume("term");
  assert.match(wrong.ok ? "" : wrong.error, /did not reopen the conversation/);
  assert.equal(f.registry.getSession(f.fresh)?.agentSessionId, "conv-someone-else", "the other agent did appear");
  assert.equal(f.registry.getSession(f.fresh)?.task ?? null, null, "and it was not given the task");
  const task = f.registry.getTask("term")!;
  assert.equal(task.status, "hibernated");
  assert.equal(task.sessionId, null);
  assert.equal(task.hibernation?.agentSessionId, "conv-t", "the task still waits for its own conversation");
  assert.deepEqual(f.closed, ["Terminal task"]);
});

test("a terminal launch the backend refuses leaves the task hibernated with the reason, and Retry succeeds", async (t) => {
  const f = terminalFleet(checkout("terminal-refused"), { spawnRefusals: 1 });
  t.after(() => f.tasks.stopMissionSessionClosures());
  assert.equal((await f.hibernation.hibernate(f.old)).ok, true);

  const refused = await f.hibernation.resume("term");
  assert.match(refused.ok ? "" : refused.error, /tmux refused to create the session/);
  assert.equal(f.spawned.length, 1, "the launch was attempted");
  assert.equal(f.registry.getSession(f.fresh), undefined, "no agent came up");
  const parked = f.registry.getTask("term")!;
  assert.equal(parked.status, "hibernated");
  assert.equal(parked.sessionId, null, "nothing was bound to the task");
  assert.match(parked.hibernation?.failure?.reason ?? "", /tmux refused to create the session/);
  assert.match(db.getTask("term")?.hibernation?.failure?.reason ?? "", /tmux refused/, "the reason is durable");
  assert.deepEqual(f.closed, [], "a home that was never created is not closed");

  const retried = await f.hibernation.resume("term");
  assert.equal(retried.ok, true, retried.ok ? "" : retried.error);
  assert.equal(f.spawned.length, 2);
  const task = f.registry.getTask("term")!;
  assert.equal(task.status, "running");
  assert.equal(task.sessionId, f.fresh);
  assert.equal(task.hibernation ?? null, null, "a success clears the failure");
});

test("a terminal launch that fails to spawn releases its preparation, and records a claimed lease until it ends", async (t) => {
  const f = terminalFleet(checkout("terminal-spawn-dispose"), { spawnRefusals: 2 });
  t.after(() => f.tasks.stopMissionSessionClosures());
  assert.equal((await f.hibernation.hibernate(f.old)).ok, true);

  // The launch failed and its lease was never claimed: released, and the reason is the launch's.
  const refused = await f.hibernation.resume("term");
  assert.equal(refused.ok ? "" : refused.error,
    "Could not resume: tmux refused to create the session. The task stays hibernated with its worktree and conversation kept.");
  assert.deepEqual(f.disposed, ["lease-1"], "the preparation is released though no home came back");

  // The launcher failed, but a guard had claimed the lease: it cannot be revoked, so the launch
  // is recorded - with no home, since none was named, and so none to close by a guessed name.
  f.controls.live = true;
  const unknown = await f.hibernation.resume("term");
  assert.match(unknown.ok ? "" : unknown.error,
    /tmux refused to create the session\. Its launch may have started anyway: stop that agent, then Retry/);
  assert.deepEqual(f.disposed, ["lease-1", "lease-2"]);
  const recorded = f.registry.getTask("term")!.hibernation!.failure!.launch;
  assert.deepEqual(recorded, { homeName: null, homeBackend: null, terminalResourceId: null, leaseRoot: "/fixture/leases", leaseId: "lease-2" });
  assert.deepEqual(db.getTask("term")?.hibernation?.failure?.launch, recorded, "durably");

  // Retry while that lease is held: nothing is prepared or launched, and nothing is closed.
  const blocked = await f.hibernation.resume("term");
  assert.match(blocked.ok ? "" : blocked.error,
    /the agent an earlier attempt may have started is still running, and Mission Control does not know its terminal\. Stop that agent, then Retry/);
  assert.equal(f.prepared.length, 2, "nothing new is prepared");
  assert.equal(f.spawned.length, 2, "nor launched");
  assert.deepEqual(f.closed, [], "and no terminal is closed by a guessed name");
  assert.equal(f.registry.getTask("term")?.hibernation?.failure?.launch?.leaseId, "lease-2", "still recorded");

  // Once its lease is released, Retry lets go of the record and launches.
  f.controls.live = false;
  const retried = await f.hibernation.resume("term");
  assert.equal(retried.ok, true, retried.ok ? "" : retried.error);
  assert.equal(f.spawned.length, 3);
});

test("a failed terminal Resume whose terminal cannot be closed refuses to launch again until it is gone", async (t) => {
  const f = terminalFleet(checkout("terminal-unclosed"), { appears: false, closeFailures: 2 });
  t.after(() => f.tasks.stopMissionSessionClosures());
  assert.equal((await f.hibernation.hibernate(f.old)).ok, true);

  // The launched agent never reopens the conversation, and its terminal cannot be closed.
  const first = await f.hibernation.resume("term");
  assert.match(first.ok ? "" : first.error, /could not be closed \(tmux: no server running\)\. Its agent may still be running: close that terminal, then Retry/);
  const recorded = f.registry.getTask("term")!.hibernation!.failure!;
  assert.equal(recorded.launch?.homeName, "Terminal task", "the launch it could not close is recorded");
  assert.equal(recorded.launch?.leaseId, "lease-1");
  assert.equal(db.getTask("term")?.hibernation?.failure?.launch?.leaseId, "lease-1", "durably");
  assert.equal(f.spawned.length, 1);
  f.controls.live = true;

  // Retry while that launch is live and still cannot be closed: nothing new is launched.
  const blocked = await f.hibernation.resume("term");
  assert.match(blocked.ok ? "" : blocked.error, /an earlier attempt started in Terminal task may still be running and could not be closed/);
  assert.equal(f.spawned.length, 1, "no second process is launched beside it");
  assert.equal(f.prepared.length, 1, "nor even prepared");
  assert.equal(f.registry.getTask("term")?.status, "hibernated");
  assert.equal(f.registry.getTask("term")?.hibernation?.failure?.launch?.leaseId, "lease-1", "still recorded");

  // Once it closes, Retry launches and binds the agent it started.
  f.controls.appear = true;
  const retried = await f.hibernation.resume("term");
  assert.equal(retried.ok, true, retried.ok ? "" : retried.error);
  assert.equal(f.spawned.length, 2);
  assert.equal(f.registry.getTask("term")?.sessionId, f.fresh);
  assert.equal(f.registry.getTask("term")?.hibernation ?? null, null);
});

test("a terminal Resume whose task is deleted or cancelled meanwhile undoes its launch and never binds it", async (t) => {
  // Deleted: the launch is undone through the same cleanup as any refused launch.
  const deleted = terminalFleet(checkout("terminal-task-deleted"), { afterProof: "delete" });
  t.after(() => deleted.tasks.stopMissionSessionClosures());
  assert.equal((await deleted.hibernation.hibernate(deleted.old)).ok, true);
  deleted.controls.live = true;
  const gone = await deleted.hibernation.resume("term");
  assert.equal(gone.ok ? 0 : gone.status, 409);
  assert.equal(gone.ok ? "" : gone.error, "The task changed while it was resuming.");
  assert.deepEqual(deleted.closed, ["Terminal task"], "its new home is closed");
  assert.equal(deleted.controls.live, false, "and its launch confirmed ended");
  assert.equal(deleted.registry.getTask("term"), undefined, "the task is not recreated");
  assert.equal(deleted.registry.getSession(deleted.fresh)?.task ?? null, null);

  // Cancelled, and the home cannot be closed: there is no task to record the launch on, so the
  // answer says what may still be running.
  const cancelled = terminalFleet(checkout("terminal-task-cancelled"), { afterProof: "cancel", closeFailures: 1 });
  t.after(() => cancelled.tasks.stopMissionSessionClosures());
  assert.equal((await cancelled.hibernation.hibernate(cancelled.old)).ok, true);
  cancelled.controls.live = true;
  const stuck = await cancelled.hibernation.resume("term");
  assert.equal(stuck.ok ? 0 : stuck.status, 409);
  assert.match(stuck.ok ? "" : stuck.error,
    /^The task changed while it was resuming, and Terminal task could not be closed \(tmux: no server running\)\. Its agent may still be running: close that terminal\.$/);
  assert.deepEqual(cancelled.closed, ["Terminal task"]);
  const task = cancelled.registry.getTask("term")!;
  assert.equal(task.status, "cancelled", "a cancelled task is not overwritten");
  assert.equal(task.sessionId, null);
});

test("a failed terminal Resume whose agent outlives its closed terminal keeps the launch recorded", async (t) => {
  const f = terminalFleet(checkout("terminal-outlives-close"), { appears: false });
  t.after(() => f.tasks.stopMissionSessionClosures());
  assert.equal((await f.hibernation.hibernate(f.old)).ok, true);
  // The launch's guard claims its lease, and the agent survives its terminal being closed.
  f.controls.live = true;
  f.controls.closeEnds = false;

  const first = await f.hibernation.resume("term");
  assert.match(first.ok ? "" : first.error,
    /did not reopen the conversation.*and the agent it started was still running 0 seconds after Terminal task closed\. Stop that agent, then Retry/);
  assert.deepEqual(f.closed, ["Terminal task"], "its terminal was closed");
  const recorded = f.registry.getTask("term")!.hibernation!.failure!;
  assert.equal(recorded.launch?.leaseId, "lease-1", "a closed terminal is not taken as proof the launch ended");
  assert.equal(db.getTask("term")?.hibernation?.failure?.launch?.leaseId, "lease-1", "durably");

  // Retry closes it again; while its lease is still held, nothing is launched beside it.
  const blocked = await f.hibernation.resume("term");
  assert.match(blocked.ok ? "" : blocked.error, /an earlier attempt started in Terminal task may still be running\. Close that terminal, then Retry/);
  assert.equal(f.spawned.length, 1, "no second agent on the conversation");
  assert.equal(f.prepared.length, 1);

  // Once it ends, Retry launches and binds the agent it started.
  f.controls.closeEnds = true;
  f.controls.appear = true;
  const retried = await f.hibernation.resume("term");
  assert.equal(retried.ok, true, retried.ok ? "" : retried.error);
  assert.equal(f.spawned.length, 2);
  assert.equal(f.registry.getTask("term")?.sessionId, f.fresh);
});

test("a session opened on the conversation by something other than the resume is never given the task", async (t) => {
  // Only the hand-opened session appears: the launch is undone and the task stays hibernated.
  const alone = terminalFleet(checkout("terminal-competitor"), { appears: false, competitor: true });
  t.after(() => alone.tasks.stopMissionSessionClosures());
  assert.equal((await alone.hibernation.hibernate(alone.old)).ok, true);
  const refused = await alone.hibernation.resume("term");
  assert.match(refused.ok ? "" : refused.error, /opened in "work" by something other than this resume/);
  const hand = alone.registry.snapshot().sessions.find((s) => s.id.startsWith("proc-hand-"))!;
  assert.equal(hand.agentSessionId, "conv-t", "it really did hold the conversation");
  assert.equal(hand.task ?? null, null, "and was not given the task");
  assert.equal(alone.registry.getTask("term")?.status, "hibernated");
  assert.equal(alone.registry.getTask("term")?.sessionId, null);
  assert.deepEqual(alone.closed, ["Terminal task"], "the launch's own terminal is closed");

  // Both appear: the launch is proven, but a second process holds the conversation, so the
  // task is bound to neither and the launch is undone rather than left running beside it.
  const both = terminalFleet(checkout("terminal-competitor-both"), { competitor: true });
  t.after(() => both.tasks.stopMissionSessionClosures());
  assert.equal((await both.hibernation.hibernate(both.old)).ok, true);
  const raced = await both.hibernation.resume("term");
  assert.match(raced.ok ? "" : raced.error, /by something other than this resume/);
  assert.equal(both.registry.getTask("term")?.status, "hibernated");
  assert.equal(both.registry.getTask("term")?.sessionId, null);
  assert.equal(both.registry.getSession(both.fresh)?.task ?? null, null);
  assert.deepEqual(both.closed, ["Terminal task"]);
});

test("a terminal Resume rechecks every live session before binding, including one already in the checkout", async (t) => {
  // A session that was already working in the checkout when the launch began - so the watch
  // never counted it - switches to the hibernated conversation while the launch comes up.
  const f = terminalFleet(checkout("terminal-switcher"), { switcher: true });
  t.after(() => f.tasks.stopMissionSessionClosures());
  const switcher = `proc-switch-terminal-switcher`;
  assert.equal(f.registry.getSession(switcher)?.agentSessionId, "conv-other");
  assert.equal((await f.hibernation.hibernate(f.old)).ok, true);

  const raced = await f.hibernation.resume("term");
  assert.match(raced.ok ? "" : raced.error, /its conversation was opened in "work" by something other than this resume/);
  assert.equal(f.registry.getSession(switcher)?.agentSessionId, "conv-t", "the switcher really did take the conversation");
  assert.equal(f.registry.getSession(f.fresh)?.agentSessionId, "conv-t", "and the launched agent came up on it too");
  const task = f.registry.getTask("term")!;
  assert.equal(task.status, "hibernated", "the task is bound to neither");
  assert.equal(task.sessionId, null);
  assert.equal(f.registry.getSession(f.fresh)?.task ?? null, null);
  assert.equal(f.registry.getSession(switcher)?.task ?? null, null);
  assert.deepEqual(f.closed, ["Terminal task"], "the launch is undone");
  assert.match(task.hibernation?.failure?.reason ?? "", /by something other than this resume/);
});

test("an Agent SDK Resume rechecks the conversation after waking, and puts the driver back to sleep if it is taken", async (t) => {
  const f = fleet();
  t.after(() => f.tasks.stopMissionSessionClosures());
  const cwd = checkout("sdk-rival");
  const sessionId = await hibernated(f, t, "sdk-rival", cwd);
  const woken = boundTo(fakeHandle(), "conv-sdk-rival");
  // While the driver is starting, a terminal agent opens the same conversation by hand.
  const fake = withFakeDriver(async () => {
    f.registry.applyDiscovery([discovered("proc-rival-sdk", cwd, "%6", 61)]);
    started(f.registry, cwd, "%6", "conv-sdk-rival");
    return woken;
  });
  t.after(fake.restore);

  const raced = await f.hibernation.resume("sdk-rival");
  assert.match(raced.ok ? "" : raced.error, /its conversation was opened in "work" while it was resuming/);
  assert.equal(woken.stopped, true, "the woken driver was stopped again");
  await drain();
  assert.equal(getSdkSession(sessionId)?.status, "hibernated", "its row is resumable later");
  const task = f.registry.getTask("sdk-rival")!;
  assert.equal(task.status, "hibernated");
  assert.equal(task.sessionId, null);
  assert.equal(f.registry.getSession("proc-rival-sdk")?.task ?? null, null);
});

test("a terminal Resume binds the launched agent only if it still holds the conversation after its proof", async (t) => {
  // It switched conversation while its launch proof was being read.
  const switched = terminalFleet(checkout("terminal-proof-switch"), { afterProof: "switch" });
  t.after(() => switched.tasks.stopMissionSessionClosures());
  assert.equal((await switched.hibernation.hibernate(switched.old)).ok, true);
  const left = await switched.hibernation.resume("term");
  assert.match(left.ok ? "" : left.error, /the agent it launched in Terminal task left the conversation before the task could be bound to it/);
  assert.equal(switched.registry.getSession(switched.fresh)?.agentSessionId, "conv-elsewhere");
  assert.equal(switched.registry.getSession(switched.fresh)?.task ?? null, null, "it was not given the task");
  assert.equal(switched.registry.getTask("term")?.status, "hibernated");
  assert.equal(switched.registry.getTask("term")?.sessionId, null);
  assert.deepEqual(switched.closed, ["Terminal task"], "the launch is undone");

  // It exited while its launch proof was being read.
  const exited = terminalFleet(checkout("terminal-proof-exit"), { afterProof: "exit" });
  t.after(() => exited.tasks.stopMissionSessionClosures());
  assert.equal((await exited.hibernation.hibernate(exited.old)).ok, true);
  const gone = await exited.hibernation.resume("term");
  assert.match(gone.ok ? "" : gone.error, /the agent it launched in Terminal task exited before the task could be bound to it/);
  assert.equal(exited.registry.getTask("term")?.status, "hibernated");
  assert.equal(exited.registry.getTask("term")?.sessionId, null);
});

test("an SDK driver that cannot be stopped after a competing opener is reported, and stopped before anything launches again", async (t) => {
  const f = fleet();
  t.after(() => f.tasks.stopMissionSessionClosures());
  const cwd = checkout("sdk-stuck-rival");
  const sessionId = await hibernated(f, t, "sdk-stuck-rival", cwd);
  const woken = boundTo(fakeHandle(), "conv-sdk-stuck-rival");
  const normalStop = woken.stop.bind(woken);
  let refusals = 1;
  woken.stop = async () => {
    if (refusals > 0) {
      refusals--;
      throw new Error("driver refused stop");
    }
    await normalStop();
  };
  const fake = withFakeDriver(async () => {
    f.registry.applyDiscovery([discovered("proc-rival-stuck", cwd, "%6", 62)]);
    started(f.registry, cwd, "%6", "conv-sdk-stuck-rival");
    return woken;
  });
  t.after(fake.restore);

  // A rival opens the conversation while the driver wakes, and the driver will not stop again.
  const first = await f.hibernation.resume("sdk-stuck-rival");
  assert.match(first.ok ? "" : first.error,
    /opened in "work" while it was resuming, and its driver could not be stopped again \(driver refused stop\)\. It may still be running: Retry stops it first/);
  assert.ok(f.supervisor.handleFor(sessionId), "the stray driver is still running");
  assert.equal(f.registry.getTask("sdk-stuck-rival")?.status, "hibernated");
  assert.equal(f.registry.getTask("sdk-stuck-rival")?.sessionId, null);
  assert.match(f.registry.getTask("sdk-stuck-rival")?.hibernation?.failure?.reason ?? "", /could not be stopped again/);

  // Retry stops that driver first; with the rival still holding the conversation, nothing launches.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const second = await f.hibernation.resume("sdk-stuck-rival");
  assert.match(second.ok ? "" : second.error, /its conversation is already open in "work"/);
  assert.equal(woken.stopped, true, "the stray driver was stopped");
  assert.equal(f.supervisor.handleFor(sessionId), null);
  await drain();
  assert.equal(getSdkSession(sessionId)?.status, "hibernated", "its row is resumable");
  assert.equal(fake.calls.length, 1, "no second driver was launched");

  // The rival leaves; once the stopped card has gone, Retry reopens the conversation.
  f.registry.applyDiscovery([]);
  t.mock.timers.tick(9_000);
  await drain();
  t.mock.timers.reset();
  const again = boundTo(fakeHandle(), "conv-sdk-stuck-rival");
  const relaunch = withFakeDriver(async () => again);
  t.after(relaunch.restore);
  const third = await f.hibernation.resume("sdk-stuck-rival");
  assert.equal(third.ok, true, third.ok ? "" : third.error);
  assert.equal(relaunch.calls.length, 1);
  assert.equal(relaunch.calls[0]!.resume, "conv-sdk-stuck-rival");
  assert.equal(f.registry.getTask("sdk-stuck-rival")?.sessionId, sessionId);
});

test("a checkout replaced while the agent starts is never given the task, for both runtimes", async (t) => {
  // Terminal: the launch is undone.
  const term = terminalFleet(checkout("terminal-replaced-mid-launch"), { replaceDuringLaunch: true });
  t.after(() => term.tasks.stopMissionSessionClosures());
  assert.equal((await term.hibernation.hibernate(term.old)).ok, true);
  const refused = await term.hibernation.resume("term");
  assert.match(refused.ok ? "" : refused.error, /is not the one it was hibernated in/);
  assert.equal(term.registry.getSession(term.fresh)?.agentSessionId, "conv-t", "the launched agent did come up");
  assert.equal(term.registry.getSession(term.fresh)?.task ?? null, null, "but was not given the task");
  assert.equal(term.registry.getTask("term")?.status, "hibernated");
  assert.equal(term.registry.getTask("term")?.sessionId, null);
  assert.deepEqual(term.closed, ["Terminal task"], "and its launch is undone");

  // Agent SDK: the woken driver goes back to sleep.
  const f = fleet();
  t.after(() => f.tasks.stopMissionSessionClosures());
  const cwd = checkout("sdk-replaced-mid-launch");
  const sessionId = await hibernated(f, t, "sdk-replaced-mid-launch", cwd);
  const woken = fakeHandle();
  const fake = withFakeDriver(async () => {
    replaceCheckout(cwd);
    return woken;
  });
  t.after(fake.restore);
  const sdk = await f.hibernation.resume("sdk-replaced-mid-launch");
  assert.match(sdk.ok ? "" : sdk.error, /is not the one it was hibernated in/);
  assert.equal(woken.stopped, true, "the woken driver was stopped again");
  await drain();
  assert.equal(getSdkSession(sessionId)?.status, "hibernated");
  assert.equal(f.registry.getTask("sdk-replaced-mid-launch")?.status, "hibernated");
  assert.equal(f.registry.getTask("sdk-replaced-mid-launch")?.sessionId, null);
});

test("an Agent SDK Resume rechecks the checkout after its driver confirms the conversation", async (t) => {
  const f = fleet();
  t.after(() => f.tasks.stopMissionSessionClosures());
  const cwd = checkout("sdk-replaced-while-confirming");
  const sessionId = await hibernated(f, t, "sdk-replaced-while-confirming", cwd);
  const woken = boundTo(fakeHandle(), "conv-sdk-replaced-while-confirming");
  const fake = withFakeDriver(async () => woken);
  t.after(fake.restore);
  // The driver starts in the right checkout and does reopen the saved conversation, but the
  // checkout is replaced while the manager is still waiting for that report.
  const confirm = f.supervisor.reportedConversation.bind(f.supervisor);
  f.supervisor.reportedConversation = async (id, timeoutMs) => {
    replaceCheckout(cwd);
    return confirm(id, timeoutMs);
  };

  const refused = await f.hibernation.resume("sdk-replaced-while-confirming");
  assert.match(refused.ok ? "" : refused.error, /is not the one it was hibernated in/);
  assert.equal(woken.stopped, true, "the woken driver was put back to sleep");
  await drain();
  assert.equal(getSdkSession(sessionId)?.status, "hibernated", "its row is resumable later");
  const task = f.registry.getTask("sdk-replaced-while-confirming")!;
  assert.equal(task.status, "hibernated", "the task was not bound in the replaced checkout");
  assert.equal(task.sessionId, null);
  assert.match(task.hibernation?.failure?.reason ?? "", /is not the one it was hibernated in/);
});

test("an Agent SDK Resume rereads the task after its driver confirms, and never revives or overwrites it", async (t) => {
  for (const change of ["deleted", "cancelled"] as const) {
    const f = fleet();
    t.after(() => f.tasks.stopMissionSessionClosures());
    const id = `sdk-task-${change}-while-confirming`;
    await hibernated(f, t, id, checkout(id));
    const woken = boundTo(fakeHandle(), `conv-${id}`);
    const fake = withFakeDriver(async () => woken);
    // The driver does reopen the saved conversation, but the task changes while the manager
    // is still waiting for that report.
    const confirm = f.supervisor.reportedConversation.bind(f.supervisor);
    f.supervisor.reportedConversation = async (sessionId, timeoutMs) => {
      if (change === "deleted") f.registry.removeTask(id);
      else f.registry.upsertTask({ ...f.registry.getTask(id)!, status: "cancelled", hibernation: null });
      return confirm(sessionId, timeoutMs);
    };
    const refused = await f.hibernation.resume(id);
    fake.restore();
    assert.equal(refused.ok, false, change);
    assert.equal(refused.ok ? 0 : refused.status, 409);
    assert.match(refused.ok ? "" : refused.error, /The task changed while it was resuming/);
    assert.equal(woken.stopped, true, `the woken driver of a ${change} task is stopped`);
    if (change === "deleted") {
      assert.equal(f.registry.getTask(id), undefined, "a deleted task is not recreated");
      assert.equal(db.getTask(id), undefined, "nor written back");
    } else {
      assert.equal(f.registry.getTask(id)?.status, "cancelled", "a cancelled task is not overwritten as running");
      assert.equal(f.registry.getTask(id)?.sessionId, null);
    }
  }
});

test("an Agent SDK driver that moves to another conversation after reporting the saved one is never bound", async (t) => {
  const f = fleet();
  t.after(() => f.tasks.stopMissionSessionClosures());
  const id = "sdk-moves-after-confirming";
  const sessionId = await hibernated(f, t, id, checkout(id));
  const woken = boundTo(fakeHandle(), `conv-${id}`);
  const fake = withFakeDriver(async () => woken);
  t.after(fake.restore);
  // It reports reopening the saved conversation, then binds another before the task is bound.
  const confirm = f.supervisor.reportedConversation.bind(f.supervisor);
  f.supervisor.reportedConversation = async (session, timeoutMs) => {
    const reported = await confirm(session, timeoutMs);
    woken.push({ kind: "bound", agentSessionId: "conv-moved", transcriptPath: null, modelId: null, pid: null });
    await drain();
    return reported;
  };
  const refused = await f.hibernation.resume(id);
  assert.match(refused.ok ? "" : refused.error, /its driver moved to conversation conv-moved before the task could be bound to it/);
  assert.equal(woken.stopped, true, "the driver is put back to sleep");
  await drain();
  assert.equal(getSdkSession(sessionId)?.status, "hibernated");
  const task = f.registry.getTask(id)!;
  assert.equal(task.status, "hibernated", "the task is not bound to another conversation");
  assert.equal(task.sessionId, null);
  assert.equal(task.hibernation?.agentSessionId, `conv-${id}`);
});

test("an Agent SDK driver that exits after reopening the conversation is never bound, and Retry reopens it", async (t) => {
  const f = fleet();
  t.after(() => f.tasks.stopMissionSessionClosures());
  const id = "sdk-exits-after-confirming";
  const sessionId = await hibernated(f, t, id, checkout(id));
  const woken = boundTo(fakeHandle(), `conv-${id}`);
  const first = withFakeDriver(async () => woken);
  // The driver does report the saved conversation, then ends before the task is bound to it.
  const confirm = f.supervisor.reportedConversation.bind(f.supervisor);
  f.supervisor.reportedConversation = async (session, timeoutMs) => {
    const reported = await confirm(session, timeoutMs);
    woken.push({ kind: "exited", reason: "crashed", resumable: true });
    await drain();
    return reported;
  };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const refused = await f.hibernation.resume(id);
  first.restore();
  f.supervisor.reportedConversation = confirm;
  assert.match(refused.ok ? "" : refused.error, /its agent exited after reopening the conversation, before the task could be bound to it/);
  const parked = f.registry.getTask(id)!;
  assert.equal(parked.status, "hibernated", "the task is not marked running on a stopped session");
  assert.equal(parked.sessionId, null);
  await drain();
  assert.equal(getSdkSession(sessionId)?.status, "hibernated", "and its conversation stays resumable");
  // Its stopped card leaves, and Retry reopens the same conversation under the same session.
  t.mock.timers.tick(9_000);
  await drain();
  t.mock.timers.reset();
  assert.equal(f.registry.getSession(sessionId), undefined);
  const again = boundTo(fakeHandle(), `conv-${id}`);
  const second = withFakeDriver(async () => again);
  const retried = await f.hibernation.resume(id);
  second.restore();
  assert.equal(retried.ok, true, retried.ok ? "" : retried.error);
  assert.equal(f.registry.getTask(id)?.status, "running");
  assert.equal(f.registry.getTask(id)?.sessionId, sessionId);
});

test("Hibernate is refused for the priority session before anything stops", async (t) => {
  const f = fleet();
  t.after(() => f.tasks.stopMissionSessionClosures());
  const handle = fakeHandle();
  const fake = withFakeDriver(async () => handle);
  t.after(fake.restore);
  const { sessionId } = await idleTask(f, handle, "priority", checkout("priority"));
  let priority: string | null = sessionId;
  const hibernation = new HibernationManager(f.registry, f.supervisor, {
    confirmMs: 300,
    pause: { releaseNow: () => null, state: () => ({ priority: priority ? { sessionId: priority, since: 0 } : null }) },
  });

  const refused = await hibernation.hibernate(sessionId);
  assert.equal(refused.ok ? 0 : refused.status, 409);
  assert.match(refused.ok ? "" : refused.error, /It is the priority session\. End priority before hibernating it\./);
  assert.equal(handle.stopped, false, "its agent keeps running");
  const task = f.registry.getTask("priority")!;
  assert.equal(task.status, "running");
  assert.equal(task.sessionId, sessionId);
  assert.equal(task.hibernation ?? null, null);

  // Another session holding priority does not stand in its way.
  priority = "sdk:someone-else";
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const parked = await hibernation.hibernate(sessionId);
  assert.equal(parked.ok, true, parked.ok ? "" : parked.error);
  await drain();
  t.mock.timers.tick(9_000);
  await drain();
  t.mock.timers.reset();
  assert.equal(f.registry.getTask("priority")?.status, "hibernated");
});

test("a launch Resume could not close stays recorded through later failures until it is gone", async (t) => {
  const cwd = checkout("terminal-unclosed-then-moved");
  const f = terminalFleet(cwd, { appears: false, closeFailures: 2 });
  t.after(() => f.tasks.stopMissionSessionClosures());
  assert.equal((await f.hibernation.hibernate(f.old)).ok, true);
  const first = await f.hibernation.resume("term");
  assert.match(first.ok ? "" : first.error, /could not be closed/);
  assert.equal(f.registry.getTask("term")?.hibernation?.failure?.launch?.leaseId, "lease-1");
  f.controls.live = true;

  // A later Retry fails on something else first - the checkout is gone - and the launch that
  // may still be running stays recorded, durably.
  const aside = `${cwd}-aside`;
  renameSync(cwd, aside);
  const missing = await f.hibernation.resume("term");
  assert.match(missing.ok ? "" : missing.error, /no longer exists/);
  const kept = f.registry.getTask("term")!.hibernation!.failure!;
  assert.match(kept.reason, /no longer exists/, "the newer reason is shown");
  assert.equal(kept.launch?.leaseId, "lease-1", "and the unclosed launch is still recorded");
  assert.equal(db.getTask("term")?.hibernation?.failure?.launch?.leaseId, "lease-1", "durably");

  // With the checkout back, Retry still refuses to launch beside it while it cannot be closed.
  renameSync(aside, cwd);
  const blocked = await f.hibernation.resume("term");
  assert.match(blocked.ok ? "" : blocked.error, /an earlier attempt started in Terminal task may still be running/);
  assert.equal(f.spawned.length, 1, "nothing was launched beside it");

  // Once it closes, the record is let go of and Retry launches.
  f.controls.appear = true;
  const retried = await f.hibernation.resume("term");
  assert.equal(retried.ok, true, retried.ok ? "" : retried.error);
  assert.equal(f.spawned.length, 2);
  assert.equal(f.registry.getTask("term")?.sessionId, f.fresh);
});

test("a recorded launch confirmed gone is let go of, so a later failure does not carry it", async (t) => {
  const f = terminalFleet(checkout("terminal-unclosed-then-gone"), { appears: false, closeFailures: 1 });
  t.after(() => f.tasks.stopMissionSessionClosures());
  assert.equal((await f.hibernation.hibernate(f.old)).ok, true);
  assert.equal((await f.hibernation.resume("term")).ok, false);
  assert.equal(f.registry.getTask("term")?.hibernation?.failure?.launch?.leaseId, "lease-1");

  // The recorded launch is already gone; this attempt's own launch closes cleanly but never
  // reopens the conversation.
  const again = await f.hibernation.resume("term");
  assert.match(again.ok ? "" : again.error, /did not reopen the conversation/);
  assert.equal(f.spawned.length, 2, "a gone launch does not block a new one");
  assert.equal(f.registry.getTask("term")?.hibernation?.failure?.launch ?? null, null, "and is no longer recorded");
  assert.equal(db.getTask("term")?.hibernation?.failure?.launch ?? null, null);
});

test("a terminal hibernation that cannot stop or prepare says why and keeps the work", async (t) => {
  const stuck = terminalFleet(checkout("terminal-stuck"), { stopFails: true });
  t.after(() => stuck.tasks.stopMissionSessionClosures());
  const refused = await stuck.hibernation.hibernate(stuck.old);
  assert.match(refused.ok ? "" : refused.error, /still running: the pane refused/);
  assert.equal(stuck.registry.getTask("term")?.status, "running");
  assert.equal(stuck.registry.getTask("term")?.sessionId, stuck.old);

  const unprepared = terminalFleet(checkout("terminal-unprepared"), { prepareFails: "the managed resume guard is not built" });
  t.after(() => unprepared.tasks.stopMissionSessionClosures());
  assert.equal((await unprepared.hibernation.hibernate(unprepared.old)).ok, true);
  const failed = await unprepared.hibernation.resume("term");
  assert.match(failed.ok ? "" : failed.error, /managed resume guard is not built/);
  assert.equal(unprepared.spawned.length, 0, "nothing is launched without a prepared resume");
  assert.equal(unprepared.registry.getTask("term")?.status, "hibernated");
});

test("Resume refuses while the hibernated session's own agent is still running, and Retry works once it exits", async (t) => {
  // The terminal agent outlived its Hibernate: a stop that has not finished, or Mission Control
  // stopping between recording the hibernation and stopping the agent, after which the agent
  // is rediscovered under the same session id.
  const cwd = checkout("terminal-survivor");
  const f = terminalFleet(cwd, { survives: true });
  t.after(() => f.tasks.stopMissionSessionClosures());
  // Hibernate does not report success for a stop it could not confirm.
  const incomplete = await f.hibernation.hibernate(f.old);
  assert.match(incomplete.ok ? "" : incomplete.error,
    /asked its agent in "work" to stop, but it had not exited after 10 seconds and may still be running and using memory/);
  assert.equal(f.registry.getSession(f.old)?.state, "idle", "the original agent is still live");
  // The task stays hibernated - never back on a process about to exit - with the reason on it.
  assert.equal(f.registry.getTask("term")?.status, "hibernated");
  assert.match(f.registry.getTask("term")?.hibernation?.failure?.reason ?? "", /had not exited/);

  const refused = await f.hibernation.resume("term");
  assert.match(refused.ok ? "" : refused.error,
    /its original agent in "work" is still running: it has not exited since it was hibernated\. Stop that session, or wait for it to exit, then Retry/);
  assert.equal(f.prepared.length, 0, "nothing was prepared");
  assert.equal(f.spawned.length, 0, "and no second process was launched onto its conversation");
  assert.equal(f.registry.getTask("term")?.status, "hibernated");
  assert.equal(f.registry.getTask("term")?.sessionId, null, "the task is not bound to it either");
  assert.match(f.registry.getTask("term")?.hibernation?.failure?.reason ?? "", /still running/);

  // The original agent exits; Retry now reopens the conversation in a new agent.
  f.registry.applyDiscovery([]);
  assert.equal(f.registry.getSession(f.old)?.state, "exited");
  const retried = await f.hibernation.resume("term");
  assert.equal(retried.ok, true, retried.ok ? "" : retried.error);
  assert.equal(f.spawned.length, 1);
  assert.equal(f.registry.getTask("term")?.sessionId, f.fresh);
});

test("Resume refuses to open a conversation that is already open somewhere else", async (t) => {
  const cwd = checkout("terminal-open");
  const f = terminalFleet(cwd);
  t.after(() => f.tasks.stopMissionSessionClosures());
  assert.equal((await f.hibernation.hibernate(f.old)).ok, true);
  // Resumed by hand in another terminal while the task slept.
  f.registry.applyDiscovery([discovered("proc-hand", cwd, "%3", 3)]);
  started(f.registry, cwd, "%3", "conv-t");
  const refused = await f.hibernation.resume("term");
  assert.match(refused.ok ? "" : refused.error, /already open/);
  assert.equal(f.spawned.length, 0);
  assert.equal(f.registry.getTask("term")?.status, "hibernated");
});

// ---- through the production stop path, and the open-workflow refusal ----------------------

test("a terminal Hibernate through the production stop path ends the real agent process and keeps the worktree's changes", async (t) => {
  const { spawn, execFileSync } = await import("node:child_process");
  const { readFileSync, writeFileSync } = await import("node:fs");
  // A real checkout with an edited tracked file and an untracked one.
  const cwd = checkout("terminal-real-stop");
  const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base");
  writeFileSync(join(cwd, "tracked.txt"), "committed\n");
  git("add", "tracked.txt");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "tracked");
  writeFileSync(join(cwd, "tracked.txt"), "edited, not committed\n");
  writeFileSync(join(cwd, "untracked.txt"), "new, not committed\n");
  const before = git("status", "--porcelain");
  assert.match(before, /M tracked\.txt/);
  assert.match(before, /\?\? untracked\.txt/);

  // A real process standing in for the terminal agent, discovered with no multiplexer pane,
  // so `kill` signals only it and touches no terminal on this machine.
  const agent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => {
    if (agent.exitCode === null && agent.signalCode === null) agent.kill("SIGKILL");
  });
  const exited = new Promise<NodeJS.Signals | null>((resolve) => agent.once("exit", (_code, signal) => resolve(signal)));
  const pid = agent.pid!;

  const registry = new Registry();
  const tasks = new TaskManager(registry);
  t.after(() => tasks.stopMissionSessionClosures());
  // No terminal deps injected: `stop` is the production `requestSessionStop` -> `kill`.
  const hibernation = new HibernationManager(registry, null);
  const id = `proc-real-${pid}`;
  registry.applyDiscovery([{ ...discovered(id, cwd, "%9", pid), pid, terminals: [] } as Discovered]);
  for (const event of ["SessionStart", "Stop"]) {
    registry.applyHook({ agent: "claude", event, sessionId: "conv-real-stop", cwd, transcriptPath: null, env: {} } as never);
  }
  const session = registry.getSession(id)!;
  assert.equal(session.state, "idle");
  assert.equal(session.agentSessionId, "conv-real-stop");
  assert.equal(session.pid, pid);
  registry.upsertTask(mkTask({ id: "real-stop", status: "running", sessionId: id, worktreePath: cwd, repoRoot: cwd }));

  const result = await hibernation.hibernate(id);
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  assert.equal(await exited, "SIGTERM", "the agent process was ended by the stop Kill uses");

  // The sweep then finds it gone and the card leaves; the task is not failed.
  registry.applyDiscovery([]);
  registry.emit("event", { type: "session_remove", id });
  const task = registry.getTask("real-stop")!;
  assert.equal(task.status, "hibernated");
  assert.equal(task.worktreePath, cwd);
  assert.equal(task.hibernation?.runtime, "terminal");
  assert.equal(task.hibernation?.agentSessionId, "conv-real-stop");
  // And every uncommitted change is exactly where it was.
  assert.equal(readFileSync(join(cwd, "tracked.txt"), "utf8"), "edited, not committed\n");
  assert.equal(readFileSync(join(cwd, "untracked.txt"), "utf8"), "new, not committed\n");
  assert.equal(git("status", "--porcelain"), before);
});

test("Hibernate is refused while a workflow run is open, leaving the agent, the task and its blocker alone", async (t) => {
  const handle = fakeHandle();
  const fake = withFakeDriver(async () => handle);
  t.after(fake.restore);
  const f = fleet();
  t.after(() => f.tasks.stopMissionSessionClosures());
  const { sessionId } = await idleTask(f, handle, "open-run", checkout("open-run"));
  assert.equal(f.registry.reportBlocker(sessionId, {
    kind: "dependency", reason: "Waiting on the review", waitingOn: "the reviewer", resumeWhen: "it lands",
    referenceUrl: null, details: null,
  }).ok, true);

  // A real workflow store holding a run on this session that has not finished.
  const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
  const { FIXTURE_RUN_INTENT } = await import("./helpers/workflow-run-intent.ts");
  const graph = JSON.stringify({
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      { id: "end", kind: "end", outcome: "Complete", position: { x: 100, y: 0 } },
    ],
    edges: [{ id: "end", source: "session", sourcePort: "submitted", target: "end", targetPort: "terminal" }],
  });
  const defaults = JSON.stringify({ triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 3 });
  db.openDb().prepare(
    `INSERT OR IGNORE INTO workflow_definitions (id, name, normalized_name, description, draft_graph_json,
       completion_policy_json, binding_defaults_json, draft_revision, current_version_id, archived_at, created_at, updated_at)
     VALUES ('w-hib', 'Hibernation guard', 'hibernation guard', '', ?, '{"kind":"none"}', ?, 1, 'v-hib', NULL, 1, 1)`,
  ).run(graph, defaults);
  db.openDb().prepare(
    `INSERT OR IGNORE INTO workflow_versions (id, workflow_id, version, source_draft_revision, graph_json,
       completion_policy_json, binding_defaults_json, published_at) VALUES ('v-hib', 'w-hib', 1, 1, ?, '{"kind":"none"}', ?, 1)`,
  ).run(graph, defaults);
  const workflows = new WorkflowManager(f.registry);
  const session = f.registry.getSession(sessionId)!;
  const binding = workflows.store.insertBinding({
    id: "binding-open-run", workflowVersionId: "v-hib", noteKey: "conv-open-run", sessionId,
    sessionAgent: "claude", sessionName: session.name, sessionCwd: session.cwd, sessionRepoRoot: session.repoRoot,
    triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 3, now: 1,
  });
  workflows.store.createInitialSubmission(
    { id: "run-open", binding, intent: FIXTURE_RUN_INTENT, triggerSource: "manual", triggerKey: "hibernation:open", now: 2 },
    { id: "submission-open", triggerSource: "manual", triggerKey: "hibernation:open", context: {}, evidence: {}, now: 2 },
  );
  workflows.store.setRunState("run-open", "running", "persona_review", null, 3);
  assert.ok(workflows.runs().some((run) => run.sessionId === sessionId && run.status === "running"));

  const hibernation = new HibernationManager(f.registry, f.supervisor, { workflows });
  const refused = await hibernation.hibernate(sessionId);
  assert.deepEqual(refused.ok ? null : { status: refused.status, error: refused.error },
    { status: 409, error: "A workflow run is in progress for it. Let the run finish first." });
  assert.equal(handle.stopped, false, "the agent was not stopped");
  assert.ok(f.supervisor.handleFor(sessionId), "its driver is still running");
  const task = f.registry.getTask("open-run")!;
  assert.equal(task.status, "running");
  assert.equal(task.sessionId, sessionId);
  assert.equal(task.hibernation ?? null, null);
  assert.equal(f.registry.getSession(sessionId)?.blocker?.reason, "Waiting on the review", "its blocker stands");
});

// ---- the checkout a conversation is reopened in ------------------------------------------

test("a terminal task with no saved worktree path resumes in the checkout its conversation ran in", async (t) => {
  const cwd = checkout("terminal-no-worktree-path");
  const f = terminalFleet(cwd);
  t.after(() => f.tasks.stopMissionSessionClosures());
  f.registry.upsertTask({ ...f.registry.getTask("term")!, worktreePath: null });
  assert.equal((await f.hibernation.hibernate(f.old)).ok, true);
  assert.equal(f.registry.getTask("term")?.hibernation?.checkout?.path, cwd, "the session's own checkout is recorded");
  const resumed = await f.hibernation.resume("term");
  assert.equal(resumed.ok, true, resumed.ok ? "" : resumed.error);
  assert.deepEqual(f.prepared.map((p) => p.cwd), [cwd]);
  assert.equal(f.registry.getTask("term")?.sessionId, f.fresh);
});

test("Hibernate is refused before anything stops when the session's checkout cannot be read", async (t) => {
  const cwd = join(home, "worktrees", "never-created");
  const f = terminalFleet(cwd);
  t.after(() => f.tasks.stopMissionSessionClosures());
  const refused = await f.hibernation.hibernate(f.old);
  assert.match(refused.ok ? "" : refused.error, /could not read its checkout .*never-created, so it could not reopen the conversation there/);
  assert.deepEqual(f.stopped, [], "the agent was not stopped");
  assert.equal(f.registry.getTask("term")?.status, "running");
  assert.equal(f.registry.getTask("term")?.sessionId, f.old);
});

test("Resume refuses a different checkout standing at the saved path, for both runtimes, before launching anything", async (t) => {
  const { writeFileSync: write } = await import("node:fs");
  const replace = (dir: string) => {
    replaceCheckout(dir);
    write(join(dir, "README.md"), "some other checkout\n");
  };

  // Agent SDK.
  const f = fleet();
  t.after(() => f.tasks.stopMissionSessionClosures());
  const sdkCwd = checkout("replaced-sdk");
  await hibernated(f, t, "replaced-sdk", sdkCwd);
  replace(sdkCwd);
  const launches = withFakeDriver(async () => fakeHandle());
  t.after(launches.restore);
  const sdk = await f.hibernation.resume("replaced-sdk");
  assert.match(sdk.ok ? "" : sdk.error, /is not the one it was hibernated in/);
  assert.equal(launches.calls.length, 0, "no driver was launched into it");
  assert.equal(f.registry.getTask("replaced-sdk")?.status, "hibernated");
  assert.match(f.registry.getTask("replaced-sdk")?.hibernation?.failure?.reason ?? "", /another directory now stands at its path/);

  // Terminal.
  const termCwd = checkout("replaced-terminal");
  const term = terminalFleet(termCwd);
  t.after(() => term.tasks.stopMissionSessionClosures());
  assert.equal((await term.hibernation.hibernate(term.old)).ok, true);
  replace(termCwd);
  const refused = await term.hibernation.resume("term");
  assert.match(refused.ok ? "" : refused.error, /is not the one it was hibernated in/);
  assert.equal(term.prepared.length, 0, "nothing was prepared");
  assert.equal(term.spawned.length, 0, "nor launched");
  assert.equal(term.registry.getTask("term")?.status, "hibernated");
  assert.equal(term.registry.getTask("term")?.sessionId, null);
});
