import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What is at stake: the supervisor is the only thing that knows an embedded session's
// harness-native id, its checkout and its task belong together. Nothing else can rebuild
// that - there is no process on a tty for a sweep to re-find - so every question this file
// asks is about a card or a task that would otherwise be stranded:
//
//  - a launch that starts a driver and then cannot take ownership must not leak it;
//  - a restart must RESUME rather than restart the conversation, or the agent redoes work;
//  - a resume nothing can honour must still produce a card that goes away, because the
//    task it was running is settled by `session_remove` and by nothing else;
//  - a session WE stopped on the way down is `suspended`, not `exited`, or every clean
//    restart reclaims the worktree of work that was merely interrupted.

const home = mkdtempSync(join(tmpdir(), "mission-sdk-sup-"));
// Set before importing anything that resolves the state dir (see db-isolation.test.ts).
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { SdkSupervisor } = await import("../src/server/sdk/supervisor.ts");
const { getSdkSession, listSdkSessions, upsertSdkSession } = await import(
  "../src/server/sdk/store.ts"
);
const { HARNESSES } = await import("../src/server/harness/index.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { mkTask } = await import("./helpers/session-fixture.ts");

type Handle = import("../src/server/harness/types.ts").SdkSessionHandle;
type SdkEvent = import("../src/server/harness/types.ts").SdkEvent;
type SdkTurn = import("../src/server/harness/types.ts").SdkTurn;
type LaunchOptions = import("../src/server/harness/types.ts").SdkLaunchOptions;
type ServerEvent = import("../src/shared/types.ts").ServerEvent;

after(() => rmSync(home, { recursive: true, force: true }));

beforeEach(() => {
  openDb().exec("DELETE FROM sdk_sessions; DELETE FROM tasks;");
});

type FakeHandle = Handle & {
  push: (e: SdkEvent) => void;
  end: () => void;
  stopped: boolean;
  sent: SdkTurn[];
};

/** A driver whose events the test pushes by hand. */
function fakeHandle(): FakeHandle {
  const queued: SdkEvent[] = [];
  const sent: SdkTurn[] = [];
  let waiting: ((r: IteratorResult<SdkEvent>) => void) | null = null;
  let ended = false;
  const push = (e: SdkEvent): void => {
    const w = waiting;
    if (w) {
      waiting = null;
      w({ value: e, done: false });
      return;
    }
    queued.push(e);
  };
  const end = (): void => {
    ended = true;
    const w = waiting;
    if (w) {
      waiting = null;
      w({ value: undefined as never, done: true });
    }
  };
  const handle = {
    push,
    end,
    sent,
    stopped: false,
    events: {
      async *[Symbol.asyncIterator](): AsyncGenerator<SdkEvent> {
        for (;;) {
          const next = queued.shift();
          if (next) {
            yield next;
            continue;
          }
          if (ended) return;
          const m = await new Promise<IteratorResult<SdkEvent>>((r) => (waiting = r));
          if (m.done) return;
          yield m.value;
        }
      },
    },
    async send(turn: SdkTurn) {
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
  };
  return handle;
}

/** Point Claude's harness slot at a scripted driver for the duration of one test. */
function withFakeDriver(
  launch: (opts: LaunchOptions) => Promise<Handle>,
): { restore: () => void; calls: LaunchOptions[] } {
  const calls: LaunchOptions[] = [];
  const real = HARNESSES.claude.sdk;
  HARNESSES.claude.sdk = {
    launch: (opts) => {
      calls.push(opts);
      return launch(opts);
    },
  };
  return { restore: () => (HARNESSES.claude.sdk = real), calls };
}

const START = {
  agent: "claude" as const,
  name: "Add a toggle",
  cwd: "/wt/one",
  prompt: "add a toggle",
  model: null,
  effort: null,
  permissionMode: null,
  mcp: null,
  taskId: null,
};

const GATED_GIT = {
  branch: "feature/no-mistakes",
  root: "/wt/one",
  repoRoot: "/repo",
  nomistakesGated: true,
};

test("start persists a row, registers the card, and records the binding", async () => {
  const handle = fakeHandle();
  const fake = withFakeDriver(async () => handle);
  try {
    const registry = new Registry();
    const supervisor = new SdkSupervisor(registry);
    const session = await supervisor.start({ ...START, taskId: "task-1" });

    assert.ok(session.id.startsWith("sdk:"), "ids are minted, never derived from a pid");
    assert.equal(session.runtime, "sdk");
    assert.equal(session.name, "Add a toggle");
    // The row is what a restart is cut from, and it exists before the pump can say anything.
    const row = getSdkSession(session.id)!;
    assert.equal(row.status, "starting");
    assert.equal(row.taskId, "task-1");
    assert.equal(row.model, null, "the launch followed Claude's default");
    assert.equal(row.agentSessionId, null);
    assert.equal(row.turnInProgress, true, "turn one is durable before the pump catches up");

    handle.push({
      kind: "bound",
      agentSessionId: "agent-7",
      transcriptPath: null,
      modelId: "actual-model",
      pid: null,
    });
    await waitFor(() => getSdkSession(session.id)?.agentSessionId === "agent-7");
    assert.equal(getSdkSession(session.id)?.status, "running");
    assert.equal(getSdkSession(session.id)?.model, "actual-model");
    // And the card learned the identity the whole file-based read path keys on.
    assert.equal(registry.getSession(session.id)?.agentSessionId, "agent-7");
    assert.equal(registry.getSession(session.id)?.meta?.modelId, "actual-model");
    assert.equal(registry.getSession(session.id)?.hooksSeen, true);

    handle.push({ kind: "turn_done", usage: null });
    await waitFor(() => getSdkSession(session.id)?.turnInProgress === false);
    await supervisor.send(session.id, { text: "one more thing" });
    assert.equal(getSdkSession(session.id)?.turnInProgress, true);
    assert.deepEqual(handle.sent, [{ text: "one more thing" }]);
  } finally {
    fake.restore();
  }
});

test("a completed turn preserves durability while an accepted follow-up remains", async () => {
  const handle = fakeHandle();
  handle.send = async (turn) => {
    handle.sent.push(turn);
    return "queued";
  };
  const fake = withFakeDriver(async () => handle);
  try {
    const registry = new Registry();
    const supervisor = new SdkSupervisor(registry);
    const session = await supervisor.start(START);

    handle.push({ kind: "state", state: "working", activity: null });
    await waitFor(() => registry.getSession(session.id)?.state === "working");
    assert.equal(await supervisor.send(session.id, { text: "follow up" }), "queued");
    handle.push({ kind: "turn_done", usage: null });
    await drain();
    assert.equal(getSdkSession(session.id)?.turnInProgress, true);
    assert.equal(registry.getSession(session.id)?.state, "working");

    handle.push({ kind: "turn_done", usage: null });
    await waitFor(() => getSdkSession(session.id)?.turnInProgress === false);
    assert.equal(registry.getSession(session.id)?.state, "idle");
  } finally {
    fake.restore();
  }
});

test("start registers an SDK checkout's no-mistakes gate immediately", async () => {
  const handle = fakeHandle();
  const fake = withFakeDriver(async () => handle);
  try {
    const registry = new Registry();
    const supervisor = new SdkSupervisor(registry, { gitInfo: () => GATED_GIT });
    const session = await supervisor.start(START);

    assert.equal(session.nomistakesGated, true);
    assert.deepEqual(registry.nomistakesPollCwds(), [START.cwd]);
  } finally {
    fake.restore();
  }
});

test("a driver we cannot take ownership of is stopped, not leaked", async () => {
  const first = fakeHandle();
  const second = fakeHandle();
  const handles = [first, second];
  const fake = withFakeDriver(async () => handles.shift()!);
  try {
    const registry = new Registry();
    const supervisor = new SdkSupervisor(registry);
    const session = await supervisor.start(START);
    // A duplicate id is the only way `adopt` refuses, and it is the one that matters: two
    // handles believing they own one card would leave the loser pumping into a session it
    // does not drive.
    assert.throws(
      () =>
        supervisor.adopt({
          registration: { id: session.id, agent: "claude", name: "dup", cwd: "/wt/one" },
          handle: second,
          durable: { taskId: null, model: null, effort: null, turnInProgress: false },
        }),
      /already registered/,
    );
    await waitFor(() => second.stopped);
  } finally {
    fake.restore();
  }
});

test("an exit evicts the card through the ordinary sequence", async (t) => {
  const handle = fakeHandle();
  const fake = withFakeDriver(async () => handle);
  // Only `setTimeout`, so the eviction's 8s linger can be ticked rather than waited out.
  // `setImmediate` stays real, which is what `drain` below rides on - the event pump is
  // detached and none of this is synchronous.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const registry = new Registry();
    const removed: string[] = [];
    registry.subscribe((e: ServerEvent) => {
      if (e.type === "session_remove") removed.push(e.id);
    });
    const supervisor = new SdkSupervisor(registry);
    const session = await supervisor.start(START);
    handle.push({ kind: "exited", reason: "done", resumable: false });
    handle.end();
    await drain();

    assert.equal(registry.getSession(session.id)?.state, "exited");
    assert.equal(getSdkSession(session.id)?.status, "exited");
    // `session_remove` is the durable signal two subscribers settle state on, and it comes
    // from the shared eviction after a linger - never from a teardown of this class's own.
    assert.deepEqual(removed, []);
    t.mock.timers.tick(9_000);
    assert.deepEqual(removed, [session.id]);
    // Delivery to a session whose driver is gone REJECTS. "Delivered to nobody" is the
    // failure the acked send exists to remove.
    await assert.rejects(() => supervisor.send(session.id, { text: "hi" }), /no live driver/);
  } finally {
    fake.restore();
  }
});

test("restore resumes the same conversation rather than starting a new one", async () => {
  const handle = fakeHandle();
  const fake = withFakeDriver(async () => handle);
  const descriptor = {
    serverName: "mission-control",
    command: "/usr/bin/node",
    args: ["/mission/mcp.mjs"],
    env: { MISSION_CONTROL_URL: "http://127.0.0.1:7317" },
  };
  try {
    upsertSdkSession({
      id: "sdk:restore-1",
      agent: "claude",
      agentSessionId: "agent-42",
      cwd: "/wt/one",
      taskId: null,
      model: "m",
      effort: "high",
      permissionMode: "auto",
      status: "running",
      turnInProgress: false,
    });
    const registry = new Registry();
    const supervisor = new SdkSupervisor(registry, {
      missionMcpDescriptor: async () => descriptor,
      gitInfo: () => GATED_GIT,
    });
    await supervisor.restore();

    assert.equal(fake.calls.length, 1);
    // The identity is what makes this a continuation: the note, queue, goal and work
    // episode are all keyed on it, and a fresh id would strand every one of them.
    assert.equal(fake.calls[0]!.resume, "agent-42");
    // And no prompt, or the agent starts its task over on top of what it already did.
    assert.equal(fake.calls[0]!.prompt, "");
    assert.equal(fake.calls[0]!.model, "m");
    assert.equal(fake.calls[0]!.effort, "high");
    assert.deepEqual(fake.calls[0]!.mcp, descriptor);
    assert.ok(registry.getSession("sdk:restore-1"), "the card is back before the first sweep");
    assert.equal(
      registry.getSession("sdk:restore-1")?.nomistakesGated,
      true,
      "restoration reads the checkout before the first poll",
    );
    // The row keeps the id it is being picked up from - it must not be blanked to `null`
    // and then re-learned, or a crash in that window loses the only thing a resume needs.
    assert.equal(getSdkSession("sdk:restore-1")?.agentSessionId, "agent-42");
    assert.deepEqual(handle.sent, [], "an idle restored session receives no unsolicited turn");
  } finally {
    fake.restore();
  }
});

test("restore automatically continues an interrupted turn without replaying its intent", async () => {
  const handle = fakeHandle();
  const fake = withFakeDriver(async () => handle);
  try {
    upsertSdkSession({
      id: "sdk:continue-1",
      agent: "claude",
      agentSessionId: "agent-interrupted",
      cwd: "/wt/continue",
      taskId: null,
      model: null,
      effort: null,
      permissionMode: null,
      status: "suspended",
      turnInProgress: true,
    });

    await new SdkSupervisor(new Registry()).restore();

    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0]?.resume, "agent-interrupted");
    assert.equal(fake.calls[0]?.prompt, "", "the original task prompt is never replayed");
    assert.equal(handle.sent.length, 1);
    assert.match(handle.sent[0]?.text ?? "", /previous turn was still in progress/i);
    assert.match(handle.sent[0]?.text ?? "", /do not repeat completed work/i);
    assert.equal(getSdkSession("sdk:continue-1")?.turnInProgress, true);

    handle.push({ kind: "turn_done", usage: null });
    await waitFor(() => getSdkSession("sdk:continue-1")?.turnInProgress === false);
  } finally {
    fake.restore();
  }
});

test("a second restart retries unfinished recovery, but completion disarms the next one", async () => {
  upsertSdkSession({
    id: "sdk:continue-again",
    agent: "claude",
    agentSessionId: "agent-retry",
    cwd: "/wt/retry",
    taskId: null,
    model: null,
    effort: null,
    permissionMode: null,
    status: "suspended",
    turnInProgress: true,
  });
  const first = fakeHandle();
  const second = fakeHandle();
  const third = fakeHandle();
  const handles = [first, second, third];
  const fake = withFakeDriver(async () => handles.shift()!);
  try {
    const firstSupervisor = new SdkSupervisor(new Registry());
    await firstSupervisor.restore();
    assert.equal(first.sent.length, 1);
    await firstSupervisor.stopAll();
    assert.equal(getSdkSession("sdk:continue-again")?.turnInProgress, true);

    const secondSupervisor = new SdkSupervisor(new Registry());
    await secondSupervisor.restore();
    assert.equal(second.sent.length, 1, "unfinished recovery is attempted in the new daemon");
    second.push({ kind: "turn_done", usage: null });
    await waitFor(() => getSdkSession("sdk:continue-again")?.turnInProgress === false);
    await secondSupervisor.stopAll();

    const thirdSupervisor = new SdkSupervisor(new Registry());
    await thirdSupervisor.restore();
    assert.deepEqual(third.sent, [], "a completed turn does not receive another continuation");
    await thirdSupervisor.stopAll();
  } finally {
    fake.restore();
  }
});

test("a resume that fails still shows a card and takes it away, so the task settles", async (t) => {
  const fake = withFakeDriver(async () => {
    throw new Error("the CLI refused");
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    upsertSdkSession({
      id: "sdk:restore-2",
      agent: "claude",
      agentSessionId: "agent-9",
      cwd: "/wt/two",
      taskId: null,
      model: null,
      effort: null,
      permissionMode: null,
      status: "running",
      turnInProgress: false,
    });
    const registry = new Registry();
    const removed: string[] = [];
    registry.subscribe((e: ServerEvent) => {
      if (e.type === "session_remove") removed.push(e.id);
    });
    await new SdkSupervisor(registry).restore();

    assert.equal(getSdkSession("sdk:restore-2")?.status, "failed");
    // Registered, then evicted: a row failed quietly in the database leaves the task it was
    // running `running` for ever, because `reconcileTasksBoundTo` fires on `session_remove`
    // and on nothing else.
    assert.equal(registry.getSession("sdk:restore-2")?.state, "exited");
    t.mock.timers.tick(9_000);
    assert.deepEqual(removed, ["sdk:restore-2"]);
  } finally {
    fake.restore();
  }
});

test("a shutdown suspends rather than exits, and a suspended row is resumed", async () => {
  const handle = fakeHandle();
  handle.stop = async () => {
    handle.stopped = true;
    handle.push({ kind: "turn_done", usage: null });
    handle.push({ kind: "exited", reason: "interrupted", resumable: true });
  };
  const fake = withFakeDriver(async () => handle);
  try {
    const registry = new Registry();
    const removed: string[] = [];
    registry.subscribe((event: ServerEvent) => {
      if (event.type === "session_remove") removed.push(event.id);
    });
    const supervisor = new SdkSupervisor(registry);
    const session = await supervisor.start(START);
    handle.push({
      kind: "bound",
      agentSessionId: "agent-5",
      transcriptPath: null,
      modelId: null,
      pid: null,
    });
    await waitFor(() => getSdkSession(session.id)?.status === "running");

    await supervisor.stopAll();
    // The distinction IS resume-on-restart. Recorded as `exited`, a clean restart would be
    // indistinguishable from an agent that finished, and `reconcileOnStartup` would run
    // `git worktree remove --force` over work that was merely interrupted.
    assert.equal(getSdkSession(session.id)?.status, "suspended");
    assert.equal(
      getSdkSession(session.id)?.turnInProgress,
      true,
      "shutdown preserves the unfinished turn for startup recovery",
    );
    assert.equal(supervisor.handleFor(session.id), null);
    assert.notEqual(registry.getSession(session.id)?.state, "exited");
    assert.deepEqual(removed, []);

    const resumed = fakeHandle();
    const again = withFakeDriver(async () => resumed);
    try {
      await new SdkSupervisor(new Registry()).restore();
      assert.equal(again.calls.length, 1, "a suspended session is picked back up");
      assert.equal(again.calls[0]!.resume, "agent-5");
    } finally {
      again.restore();
    }
  } finally {
    fake.restore();
  }
});

test("task liveness answers true or false for an embedded task, and null for any other", async () => {
  const handle = fakeHandle();
  const fake = withFakeDriver(async () => handle);
  try {
    const supervisor = new SdkSupervisor(new Registry());
    // Null is not uncertainty here - it is "this task has no embedded session", so the
    // caller goes on to ask the terminal axis. `homeAlive`'s null (nobody could tell us) is
    // a question this supervisor never has to pose.
    assert.equal(supervisor.taskLiveness("nope"), null);

    const session = await supervisor.start({ ...START, taskId: "task-9" });
    assert.equal(supervisor.taskLiveness("task-9"), true);
    handle.push({ kind: "exited", reason: "done", resumable: false });
    handle.end();
    await waitFor(() => getSdkSession(session.id)?.status === "exited");
    assert.equal(supervisor.taskLiveness("task-9"), false);
  } finally {
    fake.restore();
  }
});

test("a task re-dispatched after a failure is answered by its newest row", async () => {
  const supervisor = new SdkSupervisor(new Registry());
  upsertSdkSession(
    { id: "sdk:old", agent: "claude", agentSessionId: null, cwd: "/wt", taskId: "t", model: null, effort: null, permissionMode: null, status: "failed", turnInProgress: false },
    1_000,
  );
  upsertSdkSession(
    { id: "sdk:new", agent: "claude", agentSessionId: null, cwd: "/wt", taskId: "t", model: null, effort: null, permissionMode: null, status: "running", turnInProgress: false },
    2_000,
  );
  assert.equal(listSdkSessions().length, 2);
  assert.equal(supervisor.taskLiveness("t"), true);
});

test("live controls reach the handle and persist what restart will reuse", async () => {
  const handle = fakeHandle();
  const modes: string[] = [];
  const efforts: string[] = [];
  handle.setPermissionMode = async (mode) => void modes.push(mode);
  handle.setEffort = async (effort) => void efforts.push(effort);
  const fake = withFakeDriver(async () => handle);
  try {
    const supervisor = new SdkSupervisor(new Registry());
    const session = await supervisor.start(START);
    await supervisor.setPermissionMode(session.id, "acceptEdits");
    await supervisor.setEffort(session.id, "xhigh");
    assert.deepEqual(modes, ["acceptEdits"]);
    assert.deepEqual(efforts, ["xhigh"]);
    assert.equal(getSdkSession(session.id)?.permissionMode, "acceptEdits");
    assert.equal(getSdkSession(session.id)?.effort, "xhigh");
  } finally {
    fake.restore();
  }
});

test("a cleared replacement conversation is durably idle", async () => {
  const handle = fakeHandle();
  handle.clearContext = async () => {
    handle.push({
      kind: "bound",
      agentSessionId: "agent-cleared",
      transcriptPath: null,
      modelId: null,
      pid: null,
      cleared: true,
    });
  };
  const restored = fakeHandle();
  const handles = [handle, restored];
  const fake = withFakeDriver(async () => handles.shift()!);
  try {
    const supervisor = new SdkSupervisor(new Registry());
    const session = await supervisor.start(START);
    handle.push({
      kind: "bound",
      agentSessionId: "agent-original",
      transcriptPath: null,
      modelId: null,
      pid: null,
    });
    await waitFor(() => getSdkSession(session.id)?.agentSessionId === "agent-original");

    assert.equal(await supervisor.clearContext(session.id), true);
    await waitFor(() => getSdkSession(session.id)?.agentSessionId === "agent-cleared");
    assert.equal(getSdkSession(session.id)?.turnInProgress, false);

    await supervisor.stopAll();
    await new SdkSupervisor(new Registry()).restore();
    assert.deepEqual(restored.sent, []);
  } finally {
    fake.restore();
  }
});

/** Poll until `check` holds. The event pump is detached, so nothing here is synchronous. */
async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for the supervisor");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Let the detached pump run, without a clock.
 *
 * `setImmediate` rather than `setTimeout`, so this works in the tests that mock timers to
 * tick the eviction linger: a few macrotask turns is all the pump needs to consume a queued
 * event, and waiting on a mocked `setTimeout` would simply never resolve.
 */
async function drain(turns = 10): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r));
}

test("a dispatch interrupted mid-launch is COMPLETED on restart, not failed", async () => {
  // The window is real and narrow: `start()` persists the row and registers the card, and
  // `dispatchEmbedded` records `running` plus the session id only after that returns. A
  // daemon that died between the two comes back to a `dispatching` task whose conversation
  // exists on disk and whose driver `restore()` is about to resume - so failing it would
  // leave a live agent working under a failed row nothing can settle.
  //
  // The terminal path's reason for failing a `dispatching` task does not apply here: the
  // intent is turn ONE, delivered by the launch itself, so there is no pasted prompt whose
  // landing a restart cannot confirm.
  upsertSdkSession({
    id: "sdk:midflight",
    agent: "claude",
    agentSessionId: "agent-mid",
    cwd: "/wt/mid",
    taskId: "task-mid",
    model: null,
    effort: null,
    permissionMode: null,
    status: "running",
    turnInProgress: false,
  });
  const registry = new Registry();
  registry.upsertTask(
    mkTask({
      id: "task-mid",
      status: "dispatching",
      repoRoot: "/repo",
      worktreePath: "/wt/mid",
      sessionId: null,
    }),
  );
  const supervisor = new SdkSupervisor(registry);
  assert.equal(supervisor.taskLiveness("task-mid"), true);
  // The id is what finishes the dispatch - liveness alone cannot bind anything.
  assert.equal(supervisor.liveSessionForTask("task-mid"), "sdk:midflight");

  new TaskManager(registry, undefined, supervisor);
  await waitFor(() => registry.getTask("task-mid")?.status !== "dispatching");
  const t = registry.getTask("task-mid")!;
  assert.equal(t.status, "running");
  // Bound to the session `restore()` is about to bring back, so `applyDriverBinding` finds
  // the task when the resumed driver reports its identity.
  assert.equal(t.sessionId, "sdk:midflight");
  assert.equal(t.error, null);
});

test("a dead embedded row still fails an interrupted dispatch", async () => {
  // The other half: liveness false means no agent is coming back, so the honest outcome is
  // the ordinary interrupted-dispatch failure rather than a `running` task with nothing
  // behind it.
  upsertSdkSession({
    id: "sdk:deadmid",
    agent: "claude",
    agentSessionId: "agent-dead",
    cwd: "/wt/dead",
    taskId: "task-dead",
    model: null,
    effort: null,
    permissionMode: null,
    status: "exited",
    turnInProgress: false,
  });
  const registry = new Registry();
  registry.upsertTask(
    mkTask({ id: "task-dead", status: "dispatching", repoRoot: "/repo", worktreePath: "/wt/dead" }),
  );
  const supervisor = new SdkSupervisor(registry);
  assert.equal(supervisor.liveSessionForTask("task-dead"), null);
  assert.equal(supervisor.taskLiveness("task-dead"), false);
});

test("a control accepted while idle is re-asserted after a restart", async () => {
  // Inspector findings r2/r4 on #260 read the driver in isolation and concluded that a
  // same-sandbox mode change lives only in the handle's in-memory config, so a restart
  // before the next turn silently reverts it. It does not, and this is the guard that says
  // so in the repository rather than in a reply: the CARD's observed value is deliberately
  // left alone until the harness confirms the change, but the DURABLE ROW is written on a
  // different path, and `resume` relaunches from that row.
  //
  // Both halves are asserted, because either alone would pass while the feature was broken:
  // the column has to move, AND the relaunched driver has to be handed what the column says.
  const first = fakeHandle();
  const accepted: string[] = [];
  first.setPermissionMode = async (mode) => void accepted.push(`mode:${mode}`);
  first.setEffort = async (effort) => void accepted.push(`effort:${effort}`);
  first.setModel = async (model) => void accepted.push(`model:${model}`);

  const second = fakeHandle();
  const fake = withFakeDriver(async () => (accepted.length ? second : first));
  try {
    const registry = new Registry();
    const supervisor = new SdkSupervisor(registry);
    const session = await supervisor.start({ ...START, model: "old-model", effort: "low" });
    // A binding is what makes the row resumable at all.
    first.push({
      kind: "bound",
      agentSessionId: "agent-x",
      transcriptPath: null,
      modelId: "old-model",
      pid: null,
    });
    await new Promise((r) => setTimeout(r, 5));

    await supervisor.setPermissionMode(session.id, "acceptEdits");
    await supervisor.setEffort(session.id, "xhigh");
    await supervisor.setModel(session.id, "new-model");
    assert.deepEqual(accepted, ["mode:acceptEdits", "effort:xhigh", "model:new-model"]);

    // The driver accepted first, and only then was the row written - so a change the live
    // session refused (Codex refuses a sandbox its thread cannot move to) never becomes a
    // promise a restart would keep.
    const row = getSdkSession(session.id)!;
    assert.equal(row.permissionMode, "acceptEdits");
    assert.equal(row.effort, "xhigh");
    assert.equal(row.model, "new-model");

    // Now the restart, for real: a new process is a fresh supervisor AND a fresh registry
    // over the same store, which is the only thing that survives. Reusing the old registry
    // would hit the duplicate-registration refusal and prove nothing about restore.
    await supervisor.stopAll(50);
    await new SdkSupervisor(new Registry()).restore();
    const relaunch = fake.calls.at(-1)!;
    assert.equal(relaunch.resume, "agent-x", "the same conversation, not a new one");
    assert.equal(relaunch.permissionMode, "acceptEdits");
    assert.equal(relaunch.effort, "xhigh");
    assert.equal(relaunch.model, "new-model");
  } finally {
    fake.restore();
  }
});
