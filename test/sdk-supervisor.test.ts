import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What is at stake: the supervisor is the only thing that knows an embedded session's
// harness-native id, its checkout and its task belong together. Terminal discovery
// deliberately excludes the daemon-owned subprocess, so every question this file asks is
// about a card or a task that would otherwise be stranded:
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
const { RESTART_CONTINUATION_PROMPT, SdkSupervisor } = await import(
  "../src/server/sdk/supervisor.ts"
);
const { getSdkSession, listSdkSessions, upsertSdkSession } = await import(
  "../src/server/sdk/store.ts"
);
const { HARNESSES } = await import("../src/server/harness/index.ts");
const { claimInjectionEcho, originOf } = await import("../src/server/injections.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { PIPELINE_CALLER_CREDENTIAL_FILE_ENV } = await import("../src/shared/pipeline.ts");
const { pipelineCredentialFromDescriptor } = await import("./helpers/pipeline-credential.ts");
const { reportBucket } = await import("../src/shared/session.ts");
const { stateDisplay } = await import("../src/web/lib/format.ts");
const { mkTask } = await import("./helpers/session-fixture.ts");

type Handle = import("../src/server/harness/types.ts").SdkSessionHandle;
type SdkEvent = import("../src/server/harness/types.ts").SdkEvent;
type SdkTurn = import("../src/server/harness/types.ts").SdkTurn;
type LaunchOptions = import("../src/server/harness/types.ts").SdkLaunchOptions;
type MissionMcpDescriptor = NonNullable<LaunchOptions["mcp"]>;
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

function withFakeCodexDriver(
  launch: (opts: LaunchOptions) => Promise<Handle>,
): { restore: () => void; calls: LaunchOptions[] } {
  const calls: LaunchOptions[] = [];
  const real = HARNESSES.codex.sdk;
  HARNESSES.codex.sdk = {
    launch: (opts) => {
      calls.push(opts);
      return launch(opts);
    },
  };
  return { restore: () => (HARNESSES.codex.sdk = real), calls };
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

test("Codex SDK sessions carry their synthetic identity into Mission MCP", async () => {
  const firstHandle = fakeHandle();
  const secondHandle = fakeHandle();
  const handles = [firstHandle, secondHandle];
  const fake = withFakeCodexDriver(async () => handles.shift()!);
  const sharedCwd = "/wt/shared-codex";
  const descriptor: MissionMcpDescriptor = {
    serverName: "mission-control",
    command: "/usr/bin/node",
    args: ["/mission/mcp.mjs"],
    env: { MISSION_CONTROL_URL: "http://127.0.0.1:7317" },
  };
  const registry = new Registry();
  const supervisor = new SdkSupervisor(registry);
  try {
    const first = await supervisor.start({
      ...START,
      agent: "codex",
      cwd: sharedCwd,
      mcp: descriptor,
    });
    const second = await supervisor.start({
      ...START,
      agent: "codex",
      cwd: sharedCwd,
      mcp: descriptor,
    });
    const firstIdentity = fake.calls[0]?.mcp?.env.MISSION_SESSION_ID;
    const secondIdentity = fake.calls[1]?.mcp?.env.MISSION_SESSION_ID;

    assert.deepEqual(
      {
        driverIdentities: [firstIdentity, secondIdentity],
        resolvedSecond: registry.findSessionByEnv({}, secondIdentity, sharedCwd)?.id,
      },
      {
        driverIdentities: [first.id, second.id],
        resolvedSecond: second.id,
      },
    );
  } finally {
    await supervisor.stopAll(50);
    firstHandle.end();
    secondHandle.end();
    fake.restore();
  }
});

test("start persists a row, registers the card, and records the binding", async () => {
  const handle = fakeHandle();
  const fake = withFakeDriver(async () => handle);
  try {
    const registry = new Registry();
    const supervisor = new SdkSupervisor(registry);
    const driverPrompt = `${START.prompt}\n\nserver-owned launch context`;
    const session = await supervisor.start({
      ...START,
      prompt: driverPrompt,
      acceptedGoalPrompt: START.prompt,
      taskId: "task-1",
    });

    assert.ok(session.id.startsWith("sdk:"), "ids are minted, never derived from a pid");
    assert.equal(fake.calls[0]?.prompt, driverPrompt, "the driver still receives its full context");
    assert.equal(session.runtime, "sdk");
    assert.equal(session.name, "Add a toggle");
    // The row is what a restart is cut from, and it exists before the pump can say anything.
    const row = getSdkSession(session.id)!;
    assert.equal(row.status, "starting");
    assert.equal(row.taskId, "task-1");
    assert.equal(row.model, null, "the launch followed Claude's default");
    assert.equal(row.agentSessionId, null);
    assert.equal(row.turnInProgress, true, "turn one is durable before the pump catches up");
    assert.equal(registry.getGoal(session.id), null, "the synthetic key never owns turn one");

    handle.push({
      kind: "bound",
      agentSessionId: "agent-7",
      transcriptPath: null,
      modelId: "actual-model",
      pid: null,
    });
    await waitFor(() => getSdkSession(session.id)?.agentSessionId === "agent-7");
    await waitFor(() => registry.getGoal(session.id)?.prompt === START.prompt);
    assert.equal(getSdkSession(session.id)?.status, "running");
    assert.equal(getSdkSession(session.id)?.model, "actual-model");
    // And the card learned the identity the whole file-based read path keys on.
    assert.equal(registry.getSession(session.id)?.agentSessionId, "agent-7");
    assert.equal(registry.getSession(session.id)?.meta?.modelId, "actual-model");
    assert.equal(registry.getSession(session.id)?.hooksSeen, true);
    assert.equal(registry.getGoal(session.id)?.noteKey, "agent-7");
    assert.equal(registry.getSession(session.id)?.goal?.text, "add a toggle");
    const boundFresh = registry.getSession(session.id)!;
    assert.equal(boundFresh.state, "starting", "a fresh launch remains active after binding");
    assert.equal(reportBucket(boundFresh), "working");
    assert.deepEqual(stateDisplay(boundFresh), { label: "starting", tone: "working" });

    handle.push({ kind: "turn_done", usage: null });
    await waitFor(() => getSdkSession(session.id)?.turnInProgress === false);
    await supervisor.send(session.id, { text: "one more thing" });
    assert.equal(getSdkSession(session.id)?.turnInProgress, true);
    assert.deepEqual(handle.sent, [{ text: "one more thing" }]);
    assert.equal(
      registry.getGoal(session.id)?.prompt,
      START.prompt,
      "an untagged automated send does not replace the human Goal",
    );
  } finally {
    fake.restore();
  }
});

test("an embedded session releases its disposable state home when its driver ends", async () => {
  const handle = fakeHandle();
  const fake = withFakeDriver(async () => handle);
  try {
    const registry = new Registry();
    const supervisor = new SdkSupervisor(registry);
    await supervisor.start(START);
    const stateHome = fake.calls[0]?.stateHome;
    assert.ok(stateHome);
    assert.equal(existsSync(stateHome), true);

    handle.end();
    await waitFor(() => !existsSync(stateHome));
  } finally {
    fake.restore();
  }
});

test("an acknowledged human follow-up updates Goal only for its original conversation", async () => {
  const handle = fakeHandle();
  const fake = withFakeDriver(async () => handle);
  try {
    const registry = new Registry();
    const supervisor = new SdkSupervisor(registry);
    const session = await supervisor.start(START);
    handle.push({
      kind: "bound",
      agentSessionId: "agent-goal-follow-up",
      transcriptPath: null,
      modelId: null,
      pid: null,
    });
    await waitFor(() => registry.getGoal(session.id)?.prompt === START.prompt);
    handle.push({ kind: "turn_done", usage: null });
    await waitFor(() => getSdkSession(session.id)?.turnInProgress === false);

    assert.equal(
      await supervisor.send(
        session.id,
        { text: "also cover the ownership race" },
        undefined,
        { prompt: "also cover the ownership race", noteKey: "agent-goal-follow-up" },
      ),
      "started",
    );
    assert.equal(registry.getGoal(session.id)?.prompt, "also cover the ownership race");
    assert.equal(registry.getGoal(session.id)?.promptRevision, 2);

    handle.push({
      kind: "bound",
      agentSessionId: "agent-goal-replacement",
      transcriptPath: null,
      modelId: null,
      pid: null,
      cleared: true,
    });
    await waitFor(
      () => registry.getSession(session.id)?.agentSessionId === "agent-goal-replacement",
    );
    await supervisor.send(
      session.id,
      { text: "stale acknowledged text" },
      undefined,
      { prompt: "stale acknowledged text", noteKey: "agent-goal-follow-up" },
    );
    assert.equal(registry.getGoal(session.id), null, "the replacement key rejected stale text");
  } finally {
    fake.restore();
  }
});

test("accepted launch-window follow-ups wait for the native Goal key in order", async () => {
  const handle = fakeHandle();
  const fake = withFakeDriver(async () => handle);
  try {
    const registry = new Registry();
    const supervisor = new SdkSupervisor(registry);
    const session = await supervisor.start(START);

    await supervisor.send(
      session.id,
      { text: "an early human follow-up" },
      undefined,
      { prompt: "an early human follow-up", noteKey: session.id },
    );
    assert.equal(registry.getGoal(session.id), null, "the synthetic key never receives a Goal");

    handle.push({
      kind: "bound",
      agentSessionId: "agent-launch-window",
      transcriptPath: null,
      modelId: null,
      pid: null,
    });
    await waitFor(() => registry.getGoal(session.id)?.promptRevision === 2);
    const goal = registry.getGoal(session.id);
    assert.equal(goal?.noteKey, "agent-launch-window");
    assert.equal(goal?.objective, START.prompt);
    assert.equal(goal?.prompt, "an early human follow-up");
    assert.deepEqual(goal?.pendingPrompts, [
      { revision: 1, prompt: START.prompt },
      { revision: 2, prompt: "an early human follow-up" },
    ]);
  } finally {
    fake.restore();
  }
});

test("a launch-window acknowledgement survives the first binding race", async () => {
  const handle = fakeHandle();
  let acknowledge!: () => void;
  const held = new Promise<void>((resolve) => (acknowledge = resolve));
  handle.send = async (turn) => {
    handle.sent.push(turn);
    await held;
    return "started";
  };
  const fake = withFakeDriver(async () => handle);
  try {
    const registry = new Registry();
    const supervisor = new SdkSupervisor(registry);
    const session = await supervisor.start(START);
    const sending = supervisor.send(
      session.id,
      { text: "accepted across the binding race" },
      undefined,
      { prompt: "accepted across the binding race", noteKey: session.id },
    );
    await waitFor(() => handle.sent.length === 1);

    handle.push({
      kind: "bound",
      agentSessionId: "agent-bound-during-acknowledgement",
      transcriptPath: null,
      modelId: null,
      pid: null,
    });
    await waitFor(
      () => registry.getSession(session.id)?.agentSessionId
        === "agent-bound-during-acknowledgement",
    );
    acknowledge();
    await sending;

    assert.equal(registry.getGoal(session.id)?.prompt, "accepted across the binding race");
    assert.equal(registry.getGoal(session.id)?.promptRevision, 2);
    assert.equal(registry.getGoal(session.id)?.noteKey, "agent-bound-during-acknowledgement");
  } finally {
    fake.restore();
  }
});

test("a clear before the first binding discards the replaced conversation's Goal", async () => {
  const handle = fakeHandle();
  handle.clearContext = async () => {
    handle.push({
      kind: "bound",
      agentSessionId: "agent-cleared-before-first-bind",
      transcriptPath: null,
      modelId: null,
      pid: null,
      cleared: true,
    });
  };
  const fake = withFakeDriver(async () => handle);
  try {
    const registry = new Registry();
    const supervisor = new SdkSupervisor(registry);
    const session = await supervisor.start(START);

    assert.equal(await supervisor.clearContext(session.id), true);
    await waitFor(
      () => registry.getSession(session.id)?.agentSessionId === "agent-cleared-before-first-bind",
    );
    assert.equal(registry.getGoal(session.id), null, "the discarded launch prompt stayed discarded");

    await supervisor.send(
      session.id,
      { text: "objective for the replacement" },
      undefined,
      {
        prompt: "objective for the replacement",
        noteKey: "agent-cleared-before-first-bind",
      },
    );
    assert.equal(registry.getGoal(session.id)?.prompt, "objective for the replacement");
    assert.equal(registry.getGoal(session.id)?.promptRevision, 1);
  } finally {
    fake.restore();
  }
});

test("a completed turn preserves durability while an accepted follow-up remains", async () => {
  const handle = fakeHandle();
  const intermediateUsage = {
    input: 12,
    output: 3,
    cacheRead: 4,
    cacheWrite: 0,
    modelId: "claude-test",
    costUsd: null,
  };
  handle.send = async (turn) => {
    handle.sent.push(turn);
    return "queued";
  };
  const fake = withFakeDriver(async () => handle);
  try {
    const registry = new Registry();
    const observedCompletions: SdkEvent[] = [];
    const applyDriverEvent = registry.applyDriverEvent.bind(registry);
    registry.applyDriverEvent = (id, event, options) => {
      if (event.kind === "turn_done") observedCompletions.push(event);
      applyDriverEvent(id, event, options);
    };
    const supervisor = new SdkSupervisor(registry);
    const session = await supervisor.start(START);

    handle.push({ kind: "state", state: "working", activity: null });
    await waitFor(() => registry.getSession(session.id)?.state === "working");
    assert.equal(await supervisor.send(session.id, { text: "follow up" }), "queued");
    handle.push({ kind: "turn_done", usage: intermediateUsage });
    await drain();
    assert.equal(getSdkSession(session.id)?.turnInProgress, true);
    assert.equal(registry.getSession(session.id)?.state, "working");
    assert.deepEqual(
      observedCompletions.map((event) => event.kind === "turn_done" && event.usage),
      [intermediateUsage],
      "the intermediate completion reaches every non-idle registry projection",
    );

    handle.push({ kind: "turn_done", usage: null });
    await waitFor(() => getSdkSession(session.id)?.turnInProgress === false);
    assert.equal(registry.getSession(session.id)?.state, "idle");
  } finally {
    fake.restore();
  }
});

test("a follow-up is durably recoverable before the driver can accept it", async () => {
  const handle = fakeHandle();
  const fake = withFakeDriver(async () => handle);
  try {
    const supervisor = new SdkSupervisor(new Registry());
    const session = await supervisor.start(START);
    handle.push({ kind: "turn_done", usage: null });
    await waitFor(() => getSdkSession(session.id)?.turnInProgress === false);

    handle.send = async (turn) => {
      handle.sent.push(turn);
      assert.equal(
        getSdkSession(session.id)?.turnInProgress,
        true,
        "SQLite is marked before the vendor boundary",
      );
      return "started";
    };

    assert.equal(await supervisor.send(session.id, { text: "follow up" }), "started");
    assert.deepEqual(handle.sent, [{ text: "follow up" }]);
  } finally {
    fake.restore();
  }
});

test("a queued send rechecks its target inside session serialization", async () => {
  const handle = fakeHandle();
  const fake = withFakeDriver(async () => handle);
  try {
    const supervisor = new SdkSupervisor(new Registry());
    const session = await supervisor.start(START);
    handle.push({ kind: "turn_done", usage: null });
    await waitFor(() => getSdkSession(session.id)?.turnInProgress === false);

    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    handle.send = async (turn) => {
      handle.sent.push(turn);
      await firstHeld;
      return "started";
    };

    const first = supervisor.send(session.id, { text: "first" });
    await waitFor(() => handle.sent.length === 1);
    let targetChanged = false;
    const second = supervisor.send(
      session.id,
      { text: "stale workflow feedback" },
      () => targetChanged ? "conversation_changed" : null,
    );
    targetChanged = true;
    releaseFirst();

    assert.equal(await first, "started");
    await assert.rejects(second, /conversation_changed/);
    assert.deepEqual(handle.sent, [{ text: "first" }]);
  } finally {
    fake.restore();
  }
});

test("idle-only delivery rolls back its durable reservation when the driver became busy", async () => {
  const handle = fakeHandle();
  const fake = withFakeDriver(async () => handle);
  try {
    const supervisor = new SdkSupervisor(new Registry());
    const session = await supervisor.start(START);
    handle.push({ kind: "turn_done", usage: null });
    await waitFor(() => getSdkSession(session.id)?.turnInProgress === false);
    handle.sendIfIdle = async () => {
      assert.equal(
        getSdkSession(session.id)?.turnInProgress,
        true,
        "the crash-recovery reservation crosses before the adapter check",
      );
      return null;
    };

    assert.equal(
      await supervisor.sendWhenIdle(session.id, { text: "do not steer" }),
      null,
    );
    assert.equal(getSdkSession(session.id)?.turnInProgress, false);
    assert.deepEqual(handle.sent, [], "the driver did not accept an idle-only turn");
  } finally {
    fake.restore();
  }
});

// The other half of the contract the Claude driver broke. A driver that folds a follow-up
// into the running turn owes ONE completion for both messages, and says so by answering
// `steered`. If the supervisor kept its pessimistic reservation anyway, the single
// `turn_done` that ends that turn would leave a completion outstanding for ever: the card
// would never take a driver-sourced idle again (`deferIdle` stays true), the durable row
// would claim a restart owes this conversation a continuation it does not, and every human
// message would be released from the outbox with "the agent became busy before delivery"
// against a session that has been sitting idle for hours. That is exactly what shipped.
test("a steered follow-up leaves no completion outstanding once the turn ends", async () => {
  const handle = fakeHandle();
  const fake = withFakeDriver(async () => handle);
  try {
    const supervisor = new SdkSupervisor(new Registry());
    const session = await supervisor.start(START);
    handle.send = async (turn) => {
      handle.sent.push(turn);
      return "steered" as const;
    };

    assert.equal(
      await supervisor.send(session.id, { text: "and open a PR when it passes" }),
      "steered",
    );
    // One turn absorbed two messages, so one result ends it.
    handle.push({ kind: "turn_done", usage: null });
    await waitFor(() => getSdkSession(session.id)?.turnInProgress === false);

    // The door the outbox knocks on. Before the fix this stayed shut for the session's life.
    assert.equal(
      await supervisor.sendWhenIdle(session.id, { text: "now that you are free" }),
      "started",
    );
    assert.deepEqual(handle.sent.map((t) => t.text), [
      "and open a PR when it passes",
      "now that you are free",
    ]);
  } finally {
    fake.restore();
  }
});

// The durable half of the race above: an idle-only delivery accepted in the gap between a
// `result` and the first frame of a turn the CLI started for itself, which then absorbs it.
//
// The reservation this send makes is retired by that turn's single completion, because the
// turn was never counted separately - the pump only adopts an unobserved turn when nothing is
// outstanding and no send is in flight (`unfinishedTurns === 0 && !acceptingTurns.has(id)`),
// and this send has already made both false. So the sequence ends at zero rather than one,
// and the row does not claim a restart owes this conversation a continuation.
test("a delivery absorbed by a vendor-started turn is retired by that turn's completion", async () => {
  const handle = fakeHandle();
  const fake = withFakeDriver(async () => handle);
  try {
    const supervisor = new SdkSupervisor(new Registry());
    const session = await supervisor.start(START);
    handle.push({ kind: "turn_done", usage: null });
    await waitFor(() => getSdkSession(session.id)?.turnInProgress === false);

    // Accepted: the CLI has begun a follow-up of its own but has not spoken, so the driver
    // has nothing to refuse on.
    assert.equal(
      await supervisor.sendWhenIdle(session.id, { text: "sent into the gap" }),
      "started",
    );
    await waitFor(() => getSdkSession(session.id)?.turnInProgress === true);

    // That turn speaks - and must not be adopted as a SECOND outstanding turn on top of the
    // send's own reservation, or its one completion would leave the count at one for ever.
    handle.push({ kind: "state", state: "working", activity: null });
    handle.push({ kind: "turn_done", usage: null });

    await waitFor(() => getSdkSession(session.id)?.turnInProgress === false);
    assert.equal(
      await supervisor.sendWhenIdle(session.id, { text: "still reachable" }),
      "started",
    );
  } finally {
    fake.restore();
  }
});

test("a rejected follow-up releases only its recovery reservation", async () => {
  const handle = fakeHandle();
  const fake = withFakeDriver(async () => handle);
  try {
    const supervisor = new SdkSupervisor(new Registry());
    const session = await supervisor.start(START);
    handle.send = async () => {
      assert.equal(
        getSdkSession(session.id)?.turnInProgress,
        true,
        "the attempted follow-up is durable while acceptance is pending",
      );
      throw new Error("driver rejected");
    };

    await assert.rejects(
      () => supervisor.send(session.id, { text: "follow up" }),
      /driver rejected/,
    );
    assert.equal(
      getSdkSession(session.id)?.turnInProgress,
      true,
      "the original accepted turn remains recoverable",
    );

    handle.push({ kind: "turn_done", usage: null });
    await waitFor(() => getSdkSession(session.id)?.turnInProgress === false);

    await assert.rejects(
      () => supervisor.send(session.id, { text: "try once more" }),
      /driver rejected/,
    );
    assert.equal(
      getSdkSession(session.id)?.turnInProgress,
      false,
      "a rejected send with no older work does not leave a false recovery latch",
    );
  } finally {
    fake.restore();
  }
});

test("a failed recovery write prevents the driver from accepting the turn", async () => {
  const handle = fakeHandle();
  const fake = withFakeDriver(async () => handle);
  try {
    const supervisor = new SdkSupervisor(new Registry());
    const session = await supervisor.start(START);
    handle.push({ kind: "turn_done", usage: null });
    await waitFor(() => getSdkSession(session.id)?.turnInProgress === false);
    openDb().exec(`
      CREATE TRIGGER reject_sdk_turn_reservation
      BEFORE UPDATE OF turn_in_progress ON sdk_sessions
      WHEN OLD.id = '${session.id}'
      BEGIN
        SELECT RAISE(FAIL, 'reservation refused');
      END;
    `);

    await assert.rejects(
      () => supervisor.send(session.id, { text: "must not be accepted" }),
      /reservation refused/,
    );
    assert.deepEqual(handle.sent, [], "the driver boundary is never crossed");
  } finally {
    openDb().exec("DROP TRIGGER IF EXISTS reject_sdk_turn_reservation");
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

test("restore preparation publishes only readable live rows with stable display identity", () => {
  const registry = new Registry();
  registry.upsertTask(mkTask({
    id: "task-prepared",
    title: "Current durable task title",
    repoRoot: "/repo/main",
    worktreePath: "/repo/main/.worktrees/task-prepared",
    sessionId: "sdk:prepared-live",
    status: "running",
  }));
  upsertSdkSession({
    id: "sdk:prepared-live",
    agent: "claude",
    agentSessionId: "agent-prepared-live",
    cwd: "/repo/main/.worktrees/task-prepared",
    taskId: "task-prepared",
    model: null,
    effort: null,
    permissionMode: null,
    status: "suspended",
    turnInProgress: false,
  }, 100);
  upsertSdkSession({
    id: "sdk:prepared-exited",
    agent: "claude",
    agentSessionId: "agent-prepared-exited",
    cwd: "/repo/main",
    taskId: null,
    model: null,
    effort: null,
    permissionMode: null,
    status: "exited",
    turnInProgress: false,
  }, 200);
  openDb().prepare(
    `INSERT INTO sdk_sessions (
       id, agent, agent_session_id, cwd, task_id, model, effort, permission_mode,
       status, turn_in_progress, display_name, created_at, updated_at
     ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, 0, NULL, ?, ?)`,
  ).run("sdk:prepared-future", "claude", "agent-future", "/repo/future", "paused-v2", 300, 300);

  const supervisor = new SdkSupervisor(registry);
  assert.equal(supervisor.prepareRestore(), 1);
  assert.equal(supervisor.prepareRestore(), 1, "preparation is idempotent and does not republish");
  assert.deepEqual(registry.snapshot().restoringSessions, [{
    id: "sdk:prepared-live",
    agent: "claude",
    name: "Current durable task title",
    cwd: "/repo/main/.worktrees/task-prepared",
    repoRoot: "/repo/main",
    taskId: "task-prepared",
    taskTitle: "Current durable task title",
    createdAt: 100,
  }]);
});

test("shutdown joins an in-flight restore and never launches the next prepared row", async () => {
  for (const [id, createdAt] of [["sdk:shutdown-one", 100], ["sdk:shutdown-two", 200]] as const) {
    upsertSdkSession({
      id,
      agent: "claude",
      agentSessionId: `agent-${id}`,
      cwd: `/wt/${id}`,
      taskId: null,
      model: null,
      effort: null,
      permissionMode: null,
      status: "running",
      turnInProgress: false,
    }, createdAt);
  }
  const handle = fakeHandle();
  let releaseLaunch: ((value: Handle) => void) | null = null;
  const launchHeld = new Promise<Handle>((resolve) => {
    releaseLaunch = resolve;
  });
  const fake = withFakeDriver(() => launchHeld);
  try {
    const registry = new Registry();
    const supervisor = new SdkSupervisor(registry);
    assert.equal(supervisor.prepareRestore(), 2);
    const restoring = supervisor.restore();
    await waitFor(() => fake.calls.length === 1);

    const stopping = supervisor.stopAll(50);
    assert.equal(fake.calls.length, 1, "row two cannot launch after shutdown begins");
    releaseLaunch!(handle);
    await stopping;
    await restoring;

    assert.equal(fake.calls.length, 1);
    assert.equal(handle.stopped, true, "the in-flight handle is stopped before adoption");
    assert.deepEqual(registry.snapshot().restoringSessions, []);
    assert.equal(registry.getSession("sdk:shutdown-one"), undefined);
    assert.equal(registry.getSession("sdk:shutdown-two"), undefined);
  } finally {
    fake.restore();
  }
});

test("shutdown stays bounded while an in-flight restore owns late handle cleanup", async () => {
  upsertSdkSession(
    {
      id: "sdk:shutdown-deadline",
      agent: "claude",
      agentSessionId: "agent-shutdown-deadline",
      cwd: "/wt/shutdown-deadline",
      taskId: null,
      model: null,
      effort: null,
      permissionMode: null,
      status: "running",
      turnInProgress: false,
    },
    100,
  );
  const handle = fakeHandle();
  let releaseLaunch: ((value: Handle) => void) | null = null;
  const launchHeld = new Promise<Handle>((resolve) => {
    releaseLaunch = resolve;
  });
  const fake = withFakeDriver(() => launchHeld);
  try {
    const registry = new Registry();
    const supervisor = new SdkSupervisor(registry);
    supervisor.prepareRestore();
    const restoring = supervisor.restore();
    await waitFor(() => fake.calls.length === 1);

    const stopping = supervisor.stopAll(20);
    const outcome = await Promise.race([
      stopping.then(() => "stopped" as const),
      new Promise<"deadline-missed">((resolve) =>
        setTimeout(() => resolve("deadline-missed"), 200),
      ),
    ]);
    releaseLaunch!(handle);
    await Promise.all([stopping, restoring]);

    assert.equal(outcome, "stopped", "a hung provider handshake cannot hold daemon shutdown");
    assert.equal(handle.stopped, true, "a handle arriving after the deadline is still cleaned");
    assert.deepEqual(registry.snapshot().restoringSessions, []);
    assert.equal(registry.getSession("sdk:shutdown-deadline"), undefined);
  } finally {
    fake.restore();
  }
});

test("shutdown owns a fresh SDK launch already waiting on its provider", async () => {
  const id = "sdk:11111111-2222-4333-8444-555555555555";
  const handle = fakeHandle();
  let releaseLaunch: ((value: Handle) => void) | null = null;
  const launchHeld = new Promise<Handle>((resolve) => {
    releaseLaunch = resolve;
  });
  const fake = withFakeDriver(() => launchHeld);
  try {
    const registry = new Registry();
    const supervisor = new SdkSupervisor(registry);
    const starting = supervisor.start({ ...START, sessionId: id });
    await waitFor(() => fake.calls.length === 1);

    const stopping = supervisor.stopAll(200);
    releaseLaunch!(handle);
    await assert.rejects(starting, /shutting down/);
    await stopping;

    assert.equal(handle.stopped, true);
    assert.equal(registry.getSession(id), undefined);
    assert.equal(getSdkSession(id), null);
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
    assert.deepEqual(fake.calls[0]!.mcp, {
      ...descriptor,
      env: {
        ...descriptor.env,
        MISSION_SESSION_ID: "sdk:restore-1",
      },
    });
    assert.ok(registry.getSession("sdk:restore-1"), "the card is back before the first sweep");
    assert.deepEqual(
      registry.snapshot().restoringSessions,
      [],
      "the real stable id retires its provisional projection after registration",
    );
    assert.equal(
      registry.getSession("sdk:restore-1")?.agentSessionId,
      "agent-42",
      "the first restored frame keeps the durable note key instead of publishing a false conversation change",
    );
    // The row keeps the id it is being picked up from - it must not be blanked to `null`
    // and then re-learned, or a crash in that window loses the only thing a resume needs.
    assert.equal(getSdkSession("sdk:restore-1")?.agentSessionId, "agent-42");
    assert.deepEqual(handle.sent, [], "an idle restored session receives no unsolicited turn");

    handle.push({
      kind: "bound",
      agentSessionId: "agent-42",
      transcriptPath: null,
      modelId: "m",
      pid: null,
    });
    await waitFor(() => registry.getSession("sdk:restore-1")?.stateConfirmed === true);
    const restored = registry.getSession("sdk:restore-1")!;
    assert.equal(restored.state, "idle", "binding confirms the durable idle projection");
    assert.equal(reportBucket(restored), "idle");
    assert.deepEqual(stateDisplay(restored), { label: "idle", tone: "idle" });
    assert.deepEqual(handle.sent, [], "binding an idle restore still sends no turn");
  } finally {
    fake.restore();
  }
});

test("restore preserves a managed Pipeline task's launch-scoped MCP identity", async (t) => {
  const handle = fakeHandle();
  const registry = new Registry();
  let launchAuthorityObserved = false;
  let callerCredential = "";
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = withFakeDriver(async () => {
    assert.deepEqual(registry.managedPipelineLaunch("sdk:restore-pipeline"), {
      taskId: "task-restore-pipeline",
      sessionId: "sdk:restore-pipeline",
      cwd: "/repo/restore-pipeline",
    });
    launchAuthorityObserved = true;
    return handle;
  });
  const descriptor = {
    serverName: "mission-control",
    command: "/usr/bin/node",
    args: ["/mission/mcp.mjs"],
    env: { MISSION_CONTROL_URL: "http://127.0.0.1:7317" },
  };
  try {
    upsertSdkSession({
      id: "sdk:restore-pipeline",
      agent: "claude",
      agentSessionId: "agent-restore-pipeline",
      cwd: "/repo/restore-pipeline",
      taskId: "task-restore-pipeline",
      model: null,
      effort: null,
      permissionMode: null,
      status: "running",
      turnInProgress: false,
    });
    registry.upsertTask(mkTask({
      id: "task-restore-pipeline",
      kind: "pipeline",
      status: "running",
      repoRoot: "/repo/restore-pipeline",
      sessionId: "sdk:restore-pipeline",
      pipelineRun: {
        provider: "ai-conductor",
        repoRoot: "/repo/restore-pipeline",
        slug: "restore-pipeline",
      },
    }));
    const supervisor = new SdkSupervisor(registry, {
      missionMcpDescriptor: async () => descriptor,
      verifyMissionMcpTools: async (tools, scoped) => {
        assert.deepEqual(tools, ["adopt_pipeline_run", "report_pipeline_workspace"]);
        callerCredential = pipelineCredentialFromDescriptor(scoped);
        assert.match(callerCredential, /^[A-Za-z0-9_-]{43}$/);
        return { ok: true };
      },
    });

    await supervisor.restore();

    assert.deepEqual(fake.calls[0]?.mcp, {
      ...descriptor,
      args: [...descriptor.args],
      env: {
        ...descriptor.env,
        [PIPELINE_CALLER_CREDENTIAL_FILE_ENV]:
          fake.calls[0]!.mcp!.env[PIPELINE_CALLER_CREDENTIAL_FILE_ENV]!,
        MISSION_SESSION_ID: "sdk:restore-pipeline",
      },
    });
    assert.equal(launchAuthorityObserved, true);
    assert.equal(registry.getSession("sdk:restore-pipeline")?.pipeline, null);
    assert.equal(registry.managedPipelineLaunch("sdk:restore-pipeline"), null);
    assert.deepEqual(registry.managedPipelineCaller(callerCredential), {
      taskId: "task-restore-pipeline",
      sessionId: "sdk:restore-pipeline",
      cwd: "/repo/restore-pipeline",
      expiresAt: registry.managedPipelineCaller(callerCredential)!.expiresAt,
    });
    handle.push({ kind: "exited", reason: "done", resumable: false });
    handle.end();
    await drain();
    t.mock.timers.tick(9_000);
    assert.equal(registry.managedPipelineCaller(callerCredential), null);
  } finally {
    fake.restore();
  }
});

test("a failed managed Pipeline restore revokes its launch capability", async () => {
  const registry = new Registry();
  let callerCredential = "";
  const fake = withFakeDriver(async (options) => {
    callerCredential = pipelineCredentialFromDescriptor(options.mcp);
    assert.match(callerCredential, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(registry.managedPipelineCaller(callerCredential), {
      taskId: "task-restore-pipeline-failed",
      sessionId: "sdk:restore-pipeline-failed",
      cwd: "/repo/restore-pipeline-failed",
      expiresAt: registry.managedPipelineCaller(callerCredential)!.expiresAt,
    });
    throw new Error("the managed Pipeline resume failed");
  });
  try {
    upsertSdkSession({
      id: "sdk:restore-pipeline-failed",
      agent: "claude",
      agentSessionId: "agent-restore-pipeline-failed",
      cwd: "/repo/restore-pipeline-failed",
      taskId: "task-restore-pipeline-failed",
      model: null,
      effort: null,
      permissionMode: null,
      status: "running",
      turnInProgress: false,
    });
    registry.upsertTask(mkTask({
      id: "task-restore-pipeline-failed",
      kind: "pipeline",
      status: "running",
      repoRoot: "/repo/restore-pipeline-failed",
      sessionId: "sdk:restore-pipeline-failed",
      pipelineRun: {
        provider: "ai-conductor",
        repoRoot: "/repo/restore-pipeline-failed",
        slug: "restore-pipeline-failed",
      },
    }));
    const supervisor = new SdkSupervisor(registry, {
      missionMcpDescriptor: async () => ({
        serverName: "mission-control",
        command: "/usr/bin/node",
        args: ["/mission/mcp.mjs"],
        env: {},
      }),
      verifyMissionMcpTools: async () => ({ ok: true }),
    });

    await supervisor.restore();

    assert.equal(registry.managedPipelineCaller(callerCredential), null);
  } finally {
    fake.restore();
  }
});

test("restore refuses a managed Pipeline host without a current adoption tool", async () => {
  for (const mode of ["missing", "stale"] as const) {
    const id = `sdk:restore-pipeline-${mode}`;
    const taskId = `task-restore-pipeline-${mode}`;
    upsertSdkSession({
      id,
      agent: "claude",
      agentSessionId: `agent-${mode}`,
      cwd: `/repo/restore-pipeline-${mode}`,
      taskId,
      model: null,
      effort: null,
      permissionMode: null,
      status: "running",
      turnInProgress: false,
    });
    const registry = new Registry();
    registry.upsertTask(mkTask({
      id: taskId,
      kind: "pipeline",
      status: "running",
      repoRoot: `/repo/restore-pipeline-${mode}`,
      sessionId: id,
      pipelineRun: {
        provider: "ai-conductor",
        repoRoot: `/repo/restore-pipeline-${mode}`,
        slug: `restore-pipeline-${mode}`,
      },
    }));
    const fake = withFakeDriver(async () => assert.fail("the driver must not launch"));
    try {
      const supervisor = new SdkSupervisor(registry, {
        missionMcpDescriptor: async () => mode === "missing"
          ? null
          : {
              serverName: "mission-control",
              command: "/usr/bin/node",
              args: ["/mission/mcp.mjs"],
              env: {},
            },
        verifyMissionMcpTools: async () => ({
          ok: false,
          reason: "the built bundle does not publish adopt_pipeline_run",
        }),
      });

      await supervisor.restore();

      assert.equal(fake.calls.length, 0, mode);
      assert.equal(getSdkSession(id)?.status, "failed", mode);
      assert.equal(registry.getSession(id)?.state, "exited", mode);
    } finally {
      fake.restore();
    }
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

    const registry = new Registry();
    await new SdkSupervisor(registry).restore();

    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0]?.resume, "agent-interrupted");
    assert.equal(fake.calls[0]?.prompt, "", "the original task prompt is never replayed");
    assert.equal(handle.sent.length, 1);
    assert.match(handle.sent[0]?.text ?? "", /previous turn was still in progress/i);
    assert.match(handle.sent[0]?.text ?? "", /do not repeat completed work/i);
    assert.equal(getSdkSession("sdk:continue-1")?.turnInProgress, true);
    // Authorship, written down at delivery. This send passes no `acceptedGoal`, so the send
    // door itself never seeds a Goal from it - but the agent echoes the text back through its
    // prompt hook moments later, and the only thing that can tell that echo from something
    // the operator typed is this record. Unrecorded, the continuation became the session's
    // ask and was frozen onto the next workflow run as "Original user goal".
    assert.equal(
      originOf("sdk:continue-1", handle.sent[0]?.text ?? ""),
      "harness",
      "the restart continuation must be recorded as the daemon's own turn",
    );
    assert.equal(
      registry.getGoal("sdk:continue-1"),
      null,
      "and it must not have seeded a Goal on the way through",
    );

    handle.push({
      kind: "bound",
      agentSessionId: "agent-interrupted",
      transcriptPath: null,
      modelId: null,
      pid: null,
    });
    await waitFor(() => registry.getSession("sdk:continue-1")?.stateConfirmed === true);
    const restored = registry.getSession("sdk:continue-1")!;
    assert.equal(restored.state, "starting", "an interrupted restore remains active at bind");
    assert.equal(reportBucket(restored), "working");
    assert.deepEqual(stateDisplay(restored), { label: "starting", tone: "working" });

    handle.push({ kind: "turn_done", usage: null });
    await waitFor(() => getSdkSession("sdk:continue-1")?.turnInProgress === false);
  } finally {
    fake.restore();
  }
});

test("the continuation's authorship is on file before the send resolves", async () => {
  // The race the reviewer found, pinned at the one place it can be observed. The driver takes
  // the turn and the agent submits it while `send` is still unresolved, so the prompt hook can
  // reach the daemon first. Authorship written after the await is therefore absent exactly
  // when the echo needs it, and the continuation is captured as the human's Goal - the
  // substitution the record was added to prevent, still reachable through its own path.
  //
  // Asserted from INSIDE the pending send, which is the only vantage point where "too late"
  // and "in time" look different. `test/prompt-authorship.test.ts` carries the other half:
  // that a reserved-but-unconfirmed record does suppress the echo it was bought for.
  const handle = fakeHandle();
  let releaseSend: (() => void) | null = null;
  let originDuringSend: string | undefined = "unobserved";
  handle.send = async (turn: SdkTurn) => {
    handle.sent.push(turn);
    // The driver has the turn. Anything the agent does now races the caller's await.
    originDuringSend = originOf("sdk:continue-inflight", RESTART_CONTINUATION_PROMPT);
    await new Promise<void>((resolve) => (releaseSend = resolve));
    return "started" as const;
  };
  const fake = withFakeDriver(async () => handle);
  try {
    upsertSdkSession({
      id: "sdk:continue-inflight",
      agent: "claude",
      agentSessionId: "agent-inflight",
      cwd: "/wt/inflight",
      taskId: null,
      model: null,
      effort: null,
      permissionMode: null,
      status: "suspended",
      turnInProgress: true,
    });

    const restoring = new SdkSupervisor(new Registry()).restore();
    await waitFor(() => releaseSend !== null);
    assert.equal(
      originDuringSend,
      "harness",
      "the echo's authorship must already be on file while the send is in flight",
    );
    releaseSend!();
    await restoring;

    // And settling the send leaves one delivery owing one echo, not two. A surplus claim
    // would be spent silencing whatever the operator typed next that repeated the text.
    assert.equal(claimInjectionEcho("sdk:continue-inflight", RESTART_CONTINUATION_PROMPT), "harness");
    assert.equal(claimInjectionEcho("sdk:continue-inflight", RESTART_CONTINUATION_PROMPT), undefined);
    // The label outlives the claim: the conversation log still credits the daemon.
    assert.equal(originOf("sdk:continue-inflight", RESTART_CONTINUATION_PROMPT), "harness");
  } finally {
    fake.restore();
  }
});

test("a refused continuation records no authorship, so a later turn keeps its own", async () => {
  // The other half of "only once it landed". A driver that rejects the turn produces nothing
  // anybody will read, and claiming it would leave a fingerprint sitting in the injection
  // registry with nothing behind it - which the goal path reads as "Mission Control typed
  // this". The turn it would then suppress is a LATER one carrying the same text, and the
  // only author who can send that text now is the operator.
  const handle = fakeHandle();
  handle.send = async () => {
    throw new Error("the driver refused the continuation");
  };
  const fake = withFakeDriver(async () => handle);
  try {
    upsertSdkSession({
      id: "sdk:continue-refused",
      agent: "claude",
      agentSessionId: "agent-refused",
      cwd: "/wt/refused",
      taskId: null,
      model: null,
      effort: null,
      permissionMode: null,
      status: "suspended",
      turnInProgress: true,
    });

    const registry = new Registry();
    // Resume swallows the rejection on purpose: the conversation itself DID resume, so this
    // must not take the unresumable eviction path.
    await new SdkSupervisor(registry).restore();

    assert.equal(handle.sent.length, 0, "the driver took nothing");
    assert.equal(
      originOf("sdk:continue-refused", RESTART_CONTINUATION_PROMPT),
      undefined,
      "a refused delivery must leave no authorship record",
    );
    assert.equal(registry.getGoal("sdk:continue-refused"), null);
    // `send` rolls back the slot it reserved for a turn the driver refused, so the durable
    // bit is clear. Asserted to keep the authorship boundary honest about the state it
    // leaves behind rather than assuming a retry it does not arrange.
    assert.equal(getSdkSession("sdk:continue-refused")?.turnInProgress, false);
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

test("an interrupt reaches the driver, and says so when there is no driver to reach", async () => {
  const handle = fakeHandle();
  let interrupts = 0;
  handle.interrupt = async () => void (interrupts += 1);
  const fake = withFakeDriver(async () => handle);
  try {
    const supervisor = new SdkSupervisor(new Registry());
    const session = await supervisor.start(START);
    assert.equal(await supervisor.interrupt(session.id), "interrupted");
    assert.equal(interrupts, 1);
    // The refusal is a NULL rather than a throw, because "there is nothing driving this
    // session" is a fact the route reports as a 500 with a sentence, not an exception - and
    // it is a third answer, distinct from both "stopped a turn" and "found none".
    assert.equal(await supervisor.interrupt("sdk:not-a-session"), null);
    assert.equal(interrupts, 1);
  } finally {
    fake.restore();
  }
});

test("an interrupt that arrives after the turn ended reports finding nothing", async () => {
  // The race the whole gesture has to survive, and the reason this returns an outcome rather
  // than a boolean. A card renders `working` from an SSE frame, so it is always slightly
  // behind; a turn that finishes in the window between the operator's keypress and the
  // request landing leaves the control live and the request legitimate, while there is no
  // longer anything to stop. Both drivers accept a late interrupt without complaint, so the
  // call succeeding says nothing - and the caller's next act (dropping this session's queued
  // messages) is destructive, so it must not run on the strength of it.
  const handle = fakeHandle();
  let interrupts = 0;
  handle.interrupt = async () => void (interrupts += 1);
  const fake = withFakeDriver(async () => handle);
  try {
    const registry = new Registry();
    const supervisor = new SdkSupervisor(registry);
    const session = await supervisor.start(START);
    assert.equal(await supervisor.interrupt(session.id), "interrupted");

    // The launch turn completes on its own.
    handle.push({ kind: "turn_done", usage: null });
    await waitFor(() => getSdkSession(session.id)?.turnInProgress === false);

    assert.equal(await supervisor.interrupt(session.id), "idle");
    // The driver was still asked. It is idempotent, both adapters document tolerating a late
    // interrupt, and asking covers the opposite race - a turn begun in a gap the daemon's own
    // accounting has not caught up with.
    assert.equal(interrupts, 2, "a late interrupt is still delivered, just not claimed");

    // And a new turn makes it a real stop again.
    await supervisor.send(session.id, { text: "another go" });
    assert.equal(await supervisor.interrupt(session.id), "interrupted");
  } finally {
    fake.restore();
  }
});

test("an interrupt is not queued behind the send it exists to cancel", async () => {
  // The whole point, and the thing a `serialize()` here would silently undo: an interrupt
  // that waits for the in-flight delivery to finish arrives after the turn it was meant to
  // stop has already started. `send` is held open below, and the interrupt must land while
  // it is still held - not after.
  const handle = fakeHandle();
  let releaseSend!: () => void;
  const held = new Promise<void>((resolve) => (releaseSend = resolve));
  const order: string[] = [];
  handle.send = async (turn) => {
    order.push("send:start");
    handle.sent.push(turn);
    await held;
    order.push("send:done");
    return "started" as const;
  };
  handle.interrupt = async () => void order.push("interrupt");
  const fake = withFakeDriver(async () => handle);
  try {
    const supervisor = new SdkSupervisor(new Registry());
    const session = await supervisor.start(START);
    const sending = supervisor.send(session.id, { text: "go down the wrong path" });
    await waitFor(() => order.includes("send:start"));

    assert.equal(await supervisor.interrupt(session.id), "interrupted");
    assert.deepEqual(order, ["send:start", "interrupt"], "the interrupt overtook the send");

    releaseSend();
    await sending;
    assert.deepEqual(order, ["send:start", "interrupt", "send:done"]);
  } finally {
    fake.restore();
  }
});

test("the driver's own turn_done reconciles an interrupted turn, with no help from the control", async () => {
  // The finding this phase is built on, pinned. `unfinishedTurns` and `turn_in_progress`
  // look like state the interrupt should clear, and clearing them would double-count: the
  // event pump already retires the turn when the driver reports it finished, which both
  // drivers do after an interrupt. A restart reads exactly these two values, so a
  // hand-reconciled interrupt would have the daemon re-drive the cancelled turn.
  const handle = fakeHandle();
  const fake = withFakeDriver(async () => handle);
  try {
    const registry = new Registry();
    const supervisor = new SdkSupervisor(registry);
    const session = await supervisor.start(START);
    handle.push({ kind: "state", state: "working", activity: null });
    await waitFor(() => registry.getSession(session.id)?.state === "working");
    assert.equal(getSdkSession(session.id)?.turnInProgress, true);

    assert.equal(await supervisor.interrupt(session.id), "interrupted");
    // Nothing yet: the interrupt has been accepted, the driver has not reported back, and
    // the row still honestly says a turn is outstanding.
    assert.equal(getSdkSession(session.id)?.turnInProgress, true);

    handle.push({ kind: "turn_done", usage: null });
    await waitFor(() => getSdkSession(session.id)?.turnInProgress === false);
    await waitFor(() => registry.getSession(session.id)?.state === "idle");

    // And exactly once. A second completion arriving on top of a hand-decremented counter
    // is what would have gone negative; this asserts the counter was only ever the pump's.
    await supervisor.send(session.id, { text: "do the right thing instead" });
    assert.equal(getSdkSession(session.id)?.turnInProgress, true);
    handle.push({ kind: "turn_done", usage: null });
    await waitFor(() => getSdkSession(session.id)?.turnInProgress === false);
  } finally {
    fake.restore();
  }
});

test("a cleared Codex replacement conversation is durably idle", async () => {
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
    handle.push({ kind: "state", state: "idle", activity: null });
  };
  const restored = fakeHandle();
  const handles = [handle, restored];
  const fake = withFakeCodexDriver(async () => handles.shift()!);
  try {
    const supervisor = new SdkSupervisor(new Registry());
    const session = await supervisor.start({ ...START, agent: "codex" });
    handle.push({
      kind: "bound",
      agentSessionId: "agent-original",
      transcriptPath: null,
      modelId: null,
      pid: null,
    });
    handle.push({ kind: "state", state: "working", activity: null });
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

test("a prebound pipeline SDK host restores without a Mission Control worktree", async () => {
  upsertSdkSession({
    id: "sdk:pipeline-midflight",
    agent: "claude",
    agentSessionId: "agent-pipeline-mid",
    cwd: "/repo/pipeline-mid",
    taskId: "task-pipeline-mid",
    model: null,
    effort: null,
    permissionMode: null,
    status: "running",
    turnInProgress: false,
  });
  const registry = new Registry();
  registry.upsertTask(
    mkTask({
      id: "task-pipeline-mid",
      kind: "pipeline",
      status: "dispatching",
      repoRoot: "/repo/pipeline-mid",
      worktreePath: null,
      homeName: null,
      sessionId: null,
      pipelineRun: {
        provider: "ai-conductor",
        repoRoot: "/repo/pipeline-mid",
        slug: "pipeline-midflight",
      },
    }),
  );
  const supervisor = new SdkSupervisor(registry);

  new TaskManager(registry, undefined, supervisor);
  await waitFor(() => registry.getTask("task-pipeline-mid")?.status !== "dispatching");

  const task = registry.getTask("task-pipeline-mid");
  assert.equal(task?.status, "running");
  assert.equal(task?.sessionId, "sdk:pipeline-midflight");
  assert.equal(task?.worktreePath, null);
  assert.equal(task?.homeName, null);
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
