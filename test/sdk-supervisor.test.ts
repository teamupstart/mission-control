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

const { openDb, workCycleFor, openTaskSessionClosure, getTaskSessionClosure, clearTaskSessionClosure, getTask } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { RESTART_CONTINUATION_PROMPT, SdkSupervisor } = await import(
  "../src/server/sdk/supervisor.ts"
);
const { CAPACITY_CONTINUATION_PROMPT, CAPACITY_RETRY_MAX_ATTEMPTS, capacityRetryPlan } = await import(
  "../src/server/sdk/capacity-retry.ts"
);
const { getSdkSession, listSdkSessions, upsertSdkSession, getSdkSessionProcess } = await import(
  "../src/server/sdk/store.ts"
);
const { HARNESSES } = await import("../src/server/harness/index.ts");
const { sessionScoutCredentialLocator } = await import("../src/server/scouts/submission-auth.ts");
const { claimHumanEcho, claimInjectionEcho, originOf, reserveInjection } = await import("../src/server/injections.ts");
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

test("a retired mission's failed SDK stop stays owed and rejects follow-up until the driver leaves", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
  const handle = fakeHandle();
  const normalStop = handle.stop;
  handle.stop = async () => { throw new Error("driver refused stop"); };
  const fake = withFakeDriver(async () => handle);
  t.after(fake.restore);
  const registry = new Registry();
  const supervisor = new SdkSupervisor(registry);
  const tasks = new TaskManager(registry, undefined, supervisor);
  t.after(() => tasks.stopMissionSessionClosures());
  const session = await supervisor.start(START);
  const taskId = "retired-sdk-mission";
  t.after(() => clearTaskSessionClosure(taskId));
  registry.upsertTask(mkTask({
    id: taskId, sessionId: session.id, status: "done", completedAt: Date.now() - 180_000,
  }));
  openTaskSessionClosure(taskId, session.id, Date.now() - 180_000, Date.now() + 60_000);
  registry.applyDiscovery([]);
  const removed: number[] = [];
  registry.subscribe((event) => {
    if (event.type === "session_remove" && event.id === session.id) removed.push(Date.now());
  });
  await tasks.sweepMissionSessionClosures();
  handle.push({ kind: "state", state: "working", activity: "late driver event" });
  await drain();
  assert.equal(registry.getSession(session.id)?.state, "exited", "driver events cannot undo retirement");
  t.mock.timers.tick(9_000);
  await drain();
  await tasks.sweepMissionSessionClosures();
  assert.equal(removed.length, 1);
  assert.ok(removed[0]! - registry.getTask(taskId)!.completedAt! <= 240_000);
  assert.equal(registry.getSession(session.id), undefined);
  assert.equal(supervisor.handleFor(session.id), handle, "a rejected stop still has a real runtime");
  assert.ok(getTaskSessionClosure(taskId), "card removal cannot discard an unconfirmed SDK cleanup");
  assert.match(registry.getTask(taskId)?.automaticCleanup?.detail ?? "", /cleanup is still unconfirmed/);
  await assert.rejects(supervisor.send(session.id, { text: "late follow-up" }), /no live driver/);
  assert.equal(handle.sent.length, 0);

  handle.stop = normalStop;
  await tasks.sweepMissionSessionClosures();
  await drain();
  await tasks.sweepMissionSessionClosures();
  assert.equal(handle.stopped, true, "cleanup retries the driver after its card was removed");
  assert.equal(supervisor.handleFor(session.id), null);
  assert.equal(getTaskSessionClosure(taskId), null);
  assert.equal(registry.getTask(taskId)?.status, "done");
});

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
    answersRequests: true,
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
    answersRequests: true,
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

test("a resident's measured native limit is persisted and replayed by a fresh supervisor", async t => {
  const { ResidentProfileRevisionSchema, residentLaunchInput } = await import("../src/shared/residents.ts");
  const residents = await import("../src/server/residents/store.ts");
  const settings = ResidentProfileRevisionSchema.parse({ identity: { name: "Native backstop" }, persona: { personaId: "p" }, execution: { agent: "codex", model: "test-model" } });
  residents.createResidentProfile({ id: "native-profile", settings, at: 1 });
  residents.reserveResidentRun({ id: "native-run", profileId: "native-profile", profileRevision: 1, taskId: "native-task", launchRequestId: "native-request", launchInput: residentLaunchInput("/repo", ""), repoSpelling: "/repo", persona: { personaId: "p", name: "P", guidanceMarkdown: "" }, runInstructions: "", at: 1 });
  const first = Object.assign(fakeHandle(), { residentCompactionTokenLimit: 180880 });
  const second = Object.assign(fakeHandle(), { residentCompactionTokenLimit: 180880 });
  const handles = [first, second];
  const fake = withFakeCodexDriver(async () => handles.shift()!);
  t.after(fake.restore);
  const registry = new Registry();
  registry.upsertTask(mkTask({ id: "native-task", kind: "resident", status: "running", agent: "codex" }));
  const original = new SdkSupervisor(registry);
  const session = await original.start({ ...START, agent: "codex", model: "test-model", taskId: "native-task" });
  first.push({ kind: "bound", agentSessionId: "native-thread", transcriptPath: null, modelId: "test-model", pid: null });
  await drain();
  assert.equal(fake.calls[0]?.residentCompaction?.tokenLimit, undefined);
  assert.equal(getSdkSession(session.id)?.residentCompactionTokenLimit, 180880);
  residents.markResidentRunLaunched("native-run", null);
  await original.stopAll();
  const restored = new SdkSupervisor(new Registry());
  t.after(() => restored.stopAll());
  await restored.restore();
  assert.equal(fake.calls[1]?.resume, "native-thread");
  assert.deepEqual(fake.calls[1]?.residentCompaction, { threshold: 70, tokenLimit: 180880 });
  assert.equal(getSdkSession(session.id)?.residentCompactionTokenLimit, 180880);
  assert.equal(residents.getResidentRun("native-run")?.run.endedAt, null);
});

test("a task's advisor pin is kept on the driver row and replayed by a restore", async t => {
  const first = fakeHandle();
  const handles = [first, fakeHandle()];
  const fake = withFakeDriver(async () => handles.shift()!);
  t.after(fake.restore);
  const original = new SdkSupervisor(new Registry());
  const session = await original.start({ ...START, cwd: "/wt/advisor-pin", advisorModel: "opus" });
  assert.equal(fake.calls[0]?.advisorModel, "opus");
  first.push({ kind: "bound", agentSessionId: "advisor-pin-thread", transcriptPath: null, modelId: null, pid: null });
  await drain();
  assert.equal(getSdkSession(session.id)?.advisorModel, "opus");
  await original.stopAll();

  const restored = new SdkSupervisor(new Registry());
  t.after(() => restored.stopAll());
  await restored.restore();
  const relaunch = fake.calls.slice(1).find((call) => call.resume === "advisor-pin-thread");
  assert.ok(relaunch, "the suspended row should have been resumed");
  assert.equal(relaunch.advisorModel, "opus", "a restart renders the flag layer the first launch did");
  assert.equal(getSdkSession(session.id)?.advisorModel, "opus");

  // An omitted pin writes NULL, which is Inherit - every row from before the column existed.
  const inheritHandle = fakeHandle();
  const inherit = withFakeDriver(async () => inheritHandle);
  t.after(inherit.restore);
  const plainSupervisor = new SdkSupervisor(new Registry());
  t.after(() => plainSupervisor.stopAll());
  const plain = await plainSupervisor.start({ ...START, cwd: "/wt/advisor-inherit" });
  assert.equal(getSdkSession(plain.id)?.advisorModel, null);
});

test("the supervisor persists the observed child lifetime after the stream ends and clears it on replacement", async (t) => {
  const handle = fakeHandle();
  let pid: number | null = 41001;
  Object.defineProperty(handle, "recoveryProcessId", { get: () => pid });
  const fake = withFakeDriver(async () => handle);
  t.after(fake.restore);
  const registry = new Registry();
  let scans = 0;
  const supervisor = new SdkSupervisor(registry, { processSnapshot: async () => {
    scans++;
    return { processes: [{ pid: pid!, ppid: 1, tty: null, startRaw: "fixture", startMs: pid! * 100,
      command: "fixture", agent: null, agentNative: false }], unknownReason: null, cwdScopePids: [], completedCollectorPids: [] };
  } });
  const session = await supervisor.start(START);
  await drain();
  assert.deepEqual(getSdkSessionProcess(session.id), { pid: 41001, startMs: 4100100 });
  const initialScans = scans;
  for (let i = 0; i < 10; i++) handle.push({ kind: "state", state: "working", activity: "token" });
  await drain();
  assert.equal(scans, initialScans, "activity does not scan the process fleet per event");
  pid = null;
  handle.push({ kind: "state", state: "idle", activity: null });
  await drain();
  assert.equal(getSdkSessionProcess(session.id), null, "an unknown replacement cannot use stale absence proof");
  pid = 41002;
  handle.push({ kind: "bound", agentSessionId: "replacement", transcriptPath: null, modelId: null, pid });
  await drain();
  handle.end();
  await drain();
  assert.equal(supervisor.handleFor(session.id), null);
  assert.equal(getSdkSession(session.id)?.status, "exited");
  assert.deepEqual(getSdkSessionProcess(session.id), { pid: 41002, startMs: 4100200 });
  upsertSdkSession({ id: session.id, agent: "claude", agentSessionId: "replacement", cwd: START.cwd,
    taskId: null, model: null, effort: null, permissionMode: null, status: "starting", turnInProgress: false });
  assert.equal(getSdkSessionProcess(session.id), null, "a restored handle must establish its own lifetime");
});

test("the SDK supervisor persists macOS start and command identity without retaining secret argv", {skip: process.platform !== 'darwin'}, async (t) => {
  const {darwinCheckIdentity} = await import('../scripts/darwin-process-identity.mjs');
  const handle = fakeHandle();
  const pid = 41003;
  Object.defineProperty(handle, 'recoveryProcessId', {get: () => pid});
  const fake = withFakeDriver(async () => handle);
  t.after(fake.restore);
  const startRaw = 'Tue Nov 3 10:00:00 2026';
  const command = '/fixture/sdk-driver --private SECRET';
  const supervisor = new SdkSupervisor(new Registry(), {processSnapshot: async () => ({
    processes: [{pid, ppid: 1, tty: null, startRaw, startMs: Date.parse(startRaw), command, agent: null, agentNative: false}],
    unknownReason: null, cwdScopePids: [], completedCollectorPids: [],
  })});
  t.after(() => supervisor.stopAll());
  const session = await supervisor.start(START);
  await drain();
  handle.end();
  await drain();
  const saved = getSdkSessionProcess(session.id);
  assert.deepEqual(saved, {pid, startMs: Date.parse(startRaw), darwinIdentity: darwinCheckIdentity(`${startRaw} ${command}`)});
  assert.doesNotMatch(JSON.stringify(saved), /SECRET|sdk-driver/);
});

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
    const firstLocator = fake.calls[0]?.mcp?.env.MISSION_SCOUT_SESSION_LOCATOR;
    const secondLocator = fake.calls[1]?.mcp?.env.MISSION_SCOUT_SESSION_LOCATOR;
    assert.equal(firstLocator, sessionScoutCredentialLocator(first.id));
    assert.equal(secondLocator, sessionScoutCredentialLocator(second.id));
    assert.notEqual(firstLocator, secondLocator, "same-checkout launches get separate private locators");

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

// ---- one Goal revision per human follow-up through `send` ----
//
// The launch is revision one. A follow-up reaches the Goal by the acknowledgement and by the
// prompt hook's echo of the same text, and exactly one of them may open revision two.

type HookEvent = Parameters<InstanceType<typeof Registry>["applyHook"]>[0];

async function boundFollowUpSession(conversation: string) {
  const handle = fakeHandle();
  const fake = withFakeDriver(async () => handle);
  const registry = new Registry();
  const supervisor = new SdkSupervisor(registry);
  const session = await supervisor.start(START);
  handle.push({ kind: "bound", agentSessionId: conversation, transcriptPath: null, modelId: null, pid: null });
  await waitFor(() => registry.getGoal(session.id)?.prompt === START.prompt);
  handle.push({ kind: "turn_done", usage: null });
  await waitFor(() => getSdkSession(session.id)?.turnInProgress === false);
  const echo = (prompt: string) => registry.applyHook({
    agent: "claude",
    event: "UserPromptSubmit",
    sessionId: conversation,
    cwd: START.cwd,
    transcriptPath: null,
    env: {},
    prompt,
  } as HookEvent);
  const follow = (text: string) => supervisor.send(session.id, { text }, undefined, { prompt: text, noteKey: conversation });
  return { handle, fake, registry, supervisor, session, echo, follow };
}

for (const order of ["before", "after"] as const) {
  test(`a human follow-up echoed ${order} its acknowledgement opens one revision`, async (t) => {
    const f = await boundFollowUpSession(`agent-follow-up-echo-${order}`);
    t.after(f.fake.restore);
    const text = `cover the echo ${order} the acknowledgement`;
    if (order === "before") {
      f.handle.send = async (turn) => {
        f.handle.sent.push(turn);
        f.echo(turn.text);
        return "started";
      };
    }
    const capture = t.mock.method(f.registry, "captureAcceptedPrompt");
    assert.equal(await f.follow(text), "started");
    if (order === "after") f.echo(text);
    assert.equal(f.registry.getGoal(f.session.id)?.promptRevision, 2);
    assert.equal(f.registry.getGoal(f.session.id)?.prompt, text);
    assert.equal(capture.mock.callCount(), 1, "one door captured, the other was skipped");
  });
}

for (const order of ["before", "after"] as const) {
  test(`a reshaped echo matched only by its reshaped prompt is absorbed ${order} the acknowledgement`, async (t) => {
    const f = await boundFollowUpSession(`agent-follow-up-reshaped-${order}`);
    t.after(f.fake.restore);
    const text = `cover the reshaped echo ${order} the acknowledgement`;
    // What the hook reports is the sent text with its spaces turned into line breaks and runs.
    // The submitted text is only trimmed, so it fingerprints differently from what was sent;
    // Claude's grammar collapses whitespace, so the reshaped prompt is the one that matches.
    const reported = text.split(" ").join("\n   ");
    assert.notEqual(reported.trim(), text, "the submitted text alone cannot match");
    if (order === "before") {
      f.handle.send = async (turn) => {
        f.handle.sent.push(turn);
        f.echo(reported);
        return "started";
      };
    }
    const capture = t.mock.method(f.registry, "captureAcceptedPrompt");
    assert.equal(await f.follow(text), "started");
    if (order === "after") f.echo(reported);
    assert.equal(f.registry.getGoal(f.session.id)?.promptRevision, 2, "no second revision");
    assert.equal(capture.mock.callCount(), 1, "one door captured, the other was skipped");
  });
}

test("an early echo whose turn completes before the acknowledgement opens one revision", async (t) => {
  const f = await boundFollowUpSession("agent-follow-up-turn-ends-first");
  t.after(f.fake.restore);
  const text = "a quick follow-up the agent finishes before the ack";
  f.handle.send = async (turn) => {
    f.handle.sent.push(turn);
    f.echo(turn.text);
    // The pump delivers the whole turn, start to Stop, before `send` resolves.
    f.registry.applyDriverEvent(f.session.id, { kind: "state", state: "working", activity: null });
    f.registry.applyDriverEvent(f.session.id, { kind: "turn_done", usage: null });
    return "started";
  };
  const before = f.registry.getSession(f.session.id)?.workCycle?.generation ?? 0;
  const capture = t.mock.method(f.registry, "captureAcceptedPrompt");
  assert.equal(await f.follow(text), "started");
  assert.equal(f.registry.getSession(f.session.id)?.workCycle?.generation, before + 1, "the turn completed");
  assert.equal(f.registry.getGoal(f.session.id)?.promptRevision, 2);
  assert.equal(capture.mock.callCount(), 1, "the acknowledgement did not capture it again");
});

test("an early echo whose capture throws is recorded by the acknowledgement, once", async (t) => {
  const f = await boundFollowUpSession("agent-follow-up-capture-throws");
  t.after(f.fake.restore);
  const text = "the hook's Goal write fails";
  const original = Registry.prototype.captureAcceptedPrompt;
  let threw = false;
  t.mock.method(f.registry, "captureAcceptedPrompt", function (
    this: InstanceType<typeof Registry>,
    ...args: Parameters<typeof original>
  ) {
    if (!threw) {
      threw = true;
      throw new Error("goal write failed");
    }
    return original.apply(this, args);
  });
  f.handle.send = async (turn) => {
    f.handle.sent.push(turn);
    assert.throws(() => f.echo(turn.text), /goal write failed/);
    return "started";
  };
  assert.equal(await f.follow(text), "started");
  assert.ok(threw);
  assert.equal(f.registry.getGoal(f.session.id)?.promptRevision, 2);
  assert.equal(f.registry.getGoal(f.session.id)?.prompt, text);
});

for (const failure of ["throws", "returns null"] as const) {
  test(`an acknowledgement whose capture ${failure} leaves the turn for its echo, once`, async (t) => {
    const f = await boundFollowUpSession(`agent-follow-up-ack-${failure === "throws" ? "throws" : "null"}`);
    t.after(f.fake.restore);
    const text = `the acknowledgement's Goal capture ${failure}`;
    const original = Registry.prototype.captureAcceptedPrompt;
    let failed = false;
    t.mock.method(f.registry, "captureAcceptedPrompt", function (
      this: InstanceType<typeof Registry>,
      ...args: Parameters<typeof original>
    ) {
      if (!failed) {
        failed = true;
        // A throw is a failed write; null is the registry refusing the prompt. Either way
        // `captureGoalBestEffort` answers false, and the entry must stay for the echo.
        if (failure === "throws") throw new Error("goal write failed");
        return null;
      }
      return original.apply(this, args);
    });
    assert.equal(await f.follow(text), "started", "a failed Goal capture never fails the send");
    assert.ok(failed, "the acknowledgement's capture was the one that failed");
    assert.equal(f.registry.getGoal(f.session.id)?.promptRevision, 1, "nothing recorded yet");
    f.echo(text);
    assert.equal(f.registry.getGoal(f.session.id)?.promptRevision, 2);
    assert.equal(f.registry.getGoal(f.session.id)?.prompt, text);
  });
}

test("a steered follow-up echoed after the running turn ends opens one revision", async (t) => {
  const f = await boundFollowUpSession("agent-follow-up-steered");
  t.after(f.fake.restore);
  const text = "fold this into the next turn";
  // The registry has not seen the turn start yet, so the send is stamped as an idle one; the
  // driver knows better and queues it. Only its `steered` answer keeps the expectation alive
  // past the running turn, and Claude echoes a queued turn only after that turn's Stop.
  assert.equal(f.registry.getSession(f.session.id)?.workCycle?.active ?? false, false);
  f.handle.send = async (turn) => {
    f.handle.sent.push(turn);
    return "steered";
  };
  const capture = t.mock.method(f.registry, "captureAcceptedPrompt");
  assert.equal(await f.follow(text), "steered");
  assert.equal(f.registry.getGoal(f.session.id)?.promptRevision, 2, "the acknowledgement captured it");
  const before = f.registry.getSession(f.session.id)?.workCycle?.generation ?? 0;
  f.handle.push({ kind: "state", state: "working", activity: null });
  f.handle.push({ kind: "turn_done", usage: null });
  await waitFor(() => (f.registry.getSession(f.session.id)?.workCycle?.generation ?? 0) === before + 1);

  f.echo(text);
  assert.equal(capture.mock.callCount(), 1, "the dequeued echo answered skip");
  assert.equal(f.registry.getGoal(f.session.id)?.promptRevision, 2);
});

test("a steered follow-up whose running turn completes before the acknowledgement opens one revision", async (t) => {
  const f = await boundFollowUpSession("agent-follow-up-steered-late-ack");
  t.after(f.fake.restore);
  const text = "queued behind a turn that ends before the ack";
  assert.equal(f.registry.getSession(f.session.id)?.workCycle?.active ?? false, false,
    "the registry has not seen the running turn, so the send is stamped as idle");
  f.handle.send = async (turn) => {
    f.handle.sent.push(turn);
    // The driver queues the follow-up, and the turn ahead of it completes before `send`
    // resolves with that answer.
    f.registry.applyDriverEvent(f.session.id, { kind: "state", state: "working", activity: null });
    f.registry.applyDriverEvent(f.session.id, { kind: "turn_done", usage: null });
    return "steered";
  };
  const capture = t.mock.method(f.registry, "captureAcceptedPrompt");
  assert.equal(await f.follow(text), "steered");
  assert.equal(f.registry.getGoal(f.session.id)?.promptRevision, 2, "the acknowledgement captured it");

  // Claude dequeues it and its hook reports it.
  f.echo(text);
  assert.equal(capture.mock.callCount(), 1, "the echo answered skip");
  assert.equal(f.registry.getGoal(f.session.id)?.promptRevision, 2);
});

test("a retype after a failed early hook capture is still recorded when its own acknowledgement fails", async (t) => {
  const f = await boundFollowUpSession("agent-follow-up-spent-echo");
  t.after(f.fake.restore);
  const text = "say it once, then again";
  const original = Registry.prototype.captureAcceptedPrompt;
  let calls = 0;
  // Call 1 is the first send's early hook capture and call 3 the retype's acknowledgement:
  // both return null. Calls 2 and 4 are real.
  t.mock.method(f.registry, "captureAcceptedPrompt", function (
    this: InstanceType<typeof Registry>,
    ...args: Parameters<typeof original>
  ) {
    calls++;
    if (calls === 1 || calls === 3) return null;
    return original.apply(this, args);
  });
  f.handle.send = async (turn) => {
    f.handle.sent.push(turn);
    if (calls === 0) f.echo(turn.text);
    return "started";
  };
  await f.follow(text);
  assert.equal(f.registry.getGoal(f.session.id)?.promptRevision, 2, "the acknowledgement recorded the first send");

  // The person sends the same words again, before the first send's turn has ended.
  await f.follow(text);
  assert.equal(f.registry.getGoal(f.session.id)?.promptRevision, 2, "the retype's acknowledgement failed to record it");
  f.echo(text);
  assert.equal(calls, 4, "the retype's echo was not mistaken for the first send's");
  assert.equal(f.registry.getGoal(f.session.id)?.promptRevision, 3, "the retype is heard");
});

test("a daemon packet with a pending follow-up's text is checked for authorship first", async (t) => {
  const f = await boundFollowUpSession("agent-follow-up-daemon-same-text");
  t.after(f.fake.restore);
  const text = "rerun the failing check";
  const original = Registry.prototype.captureAcceptedPrompt;
  let failed = false;
  t.mock.method(f.registry, "captureAcceptedPrompt", function (
    this: InstanceType<typeof Registry>,
    ...args: Parameters<typeof original>
  ) {
    if (!failed) {
      failed = true;
      return null; // the follow-up's acknowledgement could not record it
    }
    return original.apply(this, args);
  });
  await f.follow(text);
  assert.equal(f.registry.getGoal(f.session.id)?.promptRevision, 1, "the follow-up is waiting for its echo");

  // Mission Control types the same words into the session, and that delivery echoes first.
  reserveInjection(f.session.id, text, "workflow");
  f.echo(text);
  assert.equal(f.registry.getGoal(f.session.id)?.promptRevision, 1, "the daemon's packet never opens the human revision");

  // The human follow-up's own echo still finds its entry and records it.
  f.echo(text);
  assert.equal(f.registry.getGoal(f.session.id)?.promptRevision, 2);
});

test("a driver refusal releases the follow-up's expectation", async (t) => {
  const f = await boundFollowUpSession("agent-follow-up-refused");
  t.after(f.fake.restore);
  const text = "the driver says no";
  f.handle.send = async () => {
    throw new Error("driver refused");
  };
  await assert.rejects(f.follow(text), /driver refused/);
  assert.equal(claimHumanEcho(f.session.id, "agent-follow-up-refused", text).kind, "none");
  assert.equal(f.registry.getGoal(f.session.id)?.promptRevision, 1);
});

test("an early echo followed by a driver refusal opens one revision", async (t) => {
  const f = await boundFollowUpSession("agent-follow-up-echo-refused");
  t.after(f.fake.restore);
  const text = "echoed, then refused";
  f.handle.send = async (turn) => {
    f.echo(turn.text);
    throw new Error("driver refused");
  };
  await assert.rejects(f.follow(text), /driver refused/);
  assert.equal(f.registry.getGoal(f.session.id)?.promptRevision, 2);
  assert.equal(f.registry.getGoal(f.session.id)?.prompt, text);
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

for (const when of ["before", "after"] as const) {
  test(`a launch-window follow-up acknowledged ${when} the bind opens one revision with its echo`, async (t) => {
    const handle = fakeHandle();
    const fake = withFakeDriver(async () => handle);
    t.after(fake.restore);
    const registry = new Registry();
    const supervisor = new SdkSupervisor(registry);
    const session = await supervisor.start(START);
    const conversation = `agent-launch-window-echo-${when}`;
    const text = `a launch-window follow-up acknowledged ${when} the bind`;
    const bind = async () => {
      handle.push({ kind: "bound", agentSessionId: conversation, transcriptPath: null, modelId: null, pid: null });
      await waitFor(() => registry.getSession(session.id)?.agentSessionId === conversation);
    };
    // The caller computed its key before the bind, so it names the launch generation.
    const follow = () => supervisor.send(session.id, { text }, undefined, { prompt: text, noteKey: session.id });
    if (when === "after") await bind();
    await follow();
    if (when === "before") await bind();
    await waitFor(() => registry.getGoal(session.id)?.promptRevision === 2);
    const capture = t.mock.method(registry, "captureAcceptedPrompt");

    registry.applyHook({
      agent: "claude", event: "UserPromptSubmit", sessionId: conversation, cwd: START.cwd,
      transcriptPath: null, env: {}, prompt: text,
    } as HookEvent);
    assert.equal(capture.mock.callCount(), 0, "the follow-up's echo answered skip");
    assert.equal(registry.getGoal(session.id)?.promptRevision, 2);
    assert.equal(registry.getGoal(session.id)?.prompt, text);
  });
}

test("an in-flight launch-window follow-up echoed before its acknowledgement opens one revision", async (t) => {
  const handle = fakeHandle();
  let acknowledge!: () => void;
  const held = new Promise<void>((resolve) => (acknowledge = resolve));
  handle.send = async (turn) => {
    handle.sent.push(turn);
    await held;
    return "started";
  };
  const fake = withFakeDriver(async () => handle);
  t.after(fake.restore);
  const registry = new Registry();
  const supervisor = new SdkSupervisor(registry);
  const session = await supervisor.start(START);
  const conversation = "agent-launch-window-early-echo";
  const text = "a launch-window follow-up whose echo beats its acknowledgement";
  // Registered under the session id, because the conversation has not bound yet.
  const sending = supervisor.send(session.id, { text }, undefined, { prompt: text, noteKey: session.id });
  await waitFor(() => handle.sent.length === 1);

  // The conversation binds while the send is still in flight, which re-keys the follow-up
  // and records the launch prompt as revision one.
  handle.push({ kind: "bound", agentSessionId: conversation, transcriptPath: null, modelId: null, pid: null });
  await waitFor(() => registry.getGoal(session.id)?.promptRevision === 1);
  const capture = t.mock.method(registry, "captureAcceptedPrompt");

  // The agent reports the follow-up before the driver's acknowledgement resolves.
  registry.applyHook({
    agent: "claude", event: "UserPromptSubmit", sessionId: conversation, cwd: START.cwd,
    transcriptPath: null, env: {}, prompt: text,
  } as HookEvent);
  assert.equal(registry.getGoal(session.id)?.promptRevision, 2, "the hook door captured it");

  acknowledge();
  await sending;
  assert.equal(capture.mock.callCount(), 1, "the acknowledgement saw the hook's capture and did not repeat it");
  assert.equal(registry.getGoal(session.id)?.promptRevision, 2);
  assert.equal(registry.getGoal(session.id)?.prompt, text);
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

test("a prompt queued before mission completion cannot reach the concluded SDK driver", async (t) => {
  const handle = fakeHandle();
  const fake = withFakeDriver(async () => handle);
  t.after(fake.restore);
  const supervisor = new SdkSupervisor(new Registry());
  const session = await supervisor.start(START);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  handle.send = async (turn) => { handle.sent.push(turn); await held; return "started"; };
  const first = supervisor.send(session.id, { text: "accepted work" });
  await waitFor(() => handle.sent.length === 1);
  const queued = supervisor.send(session.id, { text: "queued follow-up" });
  const rejected = assert.rejects(queued, /no live driver/);
  openTaskSessionClosure("queued-mission", session.id, Date.now(), Date.now() + 240_000);
  t.after(() => clearTaskSessionClosure("queued-mission"));
  release();
  await first;
  await rejected;
  assert.deepEqual(handle.sent, [{ text: "accepted work" }]);
  await supervisor.stop(session.id);
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

test("restore carries durable task attribution through session telemetry", async (t) => {
  const { setTelemetryConfig } = await import("../src/server/telemetry/config.ts");
  const { registerBuiltinTelemetry } = await import("../src/server/telemetry/service.ts");
  const { attachSessionTelemetry, observeUsageRecorded, resetSessionTelemetryForTesting } =
    await import("../src/server/telemetry/sessions.ts");
  registerBuiltinTelemetry();
  resetSessionTelemetryForTesting();
  assert.equal(setTelemetryConfig({ enabled: true }).ok, true);
  const handle = fakeHandle();
  const fake = withFakeDriver(async () => handle);
  const registry = new Registry();
  registry.upsertTask(mkTask({
    id: "task-restore-telemetry", kind: "ship", status: "running",
    sessionId: "sdk:restore-telemetry", extraRepos: [{
      repoRoot: "/repo/secondary", worktreePath: null, branch: null, provider: null,
      worktreeLeaseId: null, baseSha: null, prUrl: null, prState: null, mergedAt: null,
    }],
  }));
  const detach = attachSessionTelemetry(registry);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    upsertSdkSession({
      id: "sdk:restore-telemetry", agent: "claude", agentSessionId: "restored-conversation",
      cwd: "/wt/restore-telemetry", taskId: "task-restore-telemetry", model: null,
      effort: null, permissionMode: null, status: "suspended", turnInProgress: false,
    });
    const supervisor = new SdkSupervisor(registry);
    await supervisor.restore();
    handle.push({ kind: "state", state: "working", activity: null });
    handle.push({ kind: "turn_done", usage: null });
    await drain();
    observeUsageRecorded({
      identity: "restored-usage", usageOrigin: "authoring", costBasis: "reported",
      modelId: "claude-sonnet-4-6", input: 1, output: 2, reasoningOutput: 0,
      cacheRead: 0, cacheWrite: 0, costUsd: 0.01, sessionId: "sdk:restore-telemetry",
    });
    handle.push({ kind: "exited", reason: "done", resumable: false });
    handle.end();
    await drain();
    t.mock.timers.tick(9_000);
    const rows = openDb().prepare("SELECT name, facts_json, refs_json FROM telemetry_journal").all();
    const events = rows.map((row) => ({
      name: row.name, facts: JSON.parse(String(row.facts_json)), refs: JSON.parse(String(row.refs_json)),
    })).filter((row) => row.refs.session_id === "sdk:restore-telemetry");
    for (const name of ["mission.session.started", "mission.session.segment.opened",
      "mission.session.turn.finished", "mission.usage.recorded", "mission.session.ended"]) {
      const found = events.filter((row) => row.name === name);
      assert.ok(found.length > 0, `${name} was captured`);
      assert.ok(found.every((row) => row.refs.task_id === "task-restore-telemetry"), `${name} retains the durable task`);
    }
    const started = events.find((row) => row.name === "mission.session.started")!;
    assert.equal(started.facts.origin, "restored");
    assert.equal(started.facts.task_kind, "ship");
    assert.equal(started.facts.repo_count, 2);
    assert.equal(events.find((row) => row.name === "mission.session.ended")?.facts.ended_while_work_open, true);
  } finally {
    handle.end();
    detach();
    fake.restore();
    setTelemetryConfig({ enabled: false });
    resetSessionTelemetryForTesting();
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
        MISSION_SCOUT_SESSION_LOCATOR: sessionScoutCredentialLocator("sdk:restore-1"),
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
        MISSION_SCOUT_SESSION_LOCATOR: sessionScoutCredentialLocator("sdk:restore-pipeline"),
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

test("a cleared Codex replacement conversation survives its old task cancellation and stays durably idle", async () => {
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
    const registry = new Registry();
    const supervisor = new SdkSupervisor(registry);
    const taskId = "task-before-clear";
    registry.upsertTask(mkTask({ id: taskId, status: "running", sessionId: null }));
    const session = await supervisor.start({ ...START, agent: "codex", taskId });
    registry.upsertTask({ ...getTask(taskId)!, sessionId: session.id });
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
    assert.equal(getTask(taskId)?.status, "cancelled");
    assert.equal(getTask(taskId)?.sessionId, null);

    await supervisor.stopAll();
    const next = new SdkSupervisor(new Registry());
    await next.restore();
    assert.equal(next.handleFor(session.id), restored, "the replacement conversation remains available after the old task was cancelled");
    assert.deepEqual(restored.sent, []);
    await next.stopAll();
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
    assert.equal(session.configuredModel, "old-model");
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

    // A late binding still describes the old turn, not the configured restart model.
    first.push({ kind: "bound", agentSessionId: "agent-rebound", transcriptPath: null, modelId: "old-model", pid: null });
    await waitFor(() => getSdkSession(session.id)?.agentSessionId === "agent-rebound");

    // The driver accepted first, and only then was the row written - so a change the live
    // session refused (Codex refuses a sandbox its thread cannot move to) never becomes a
    // promise a restart would keep.
    const row = getSdkSession(session.id)!;
    assert.equal(row.permissionMode, "acceptEdits");
    assert.equal(row.effort, "xhigh");
    assert.equal(row.model, "new-model");
    assert.equal(registry.getSession(session.id)?.configuredModel, "new-model");
    assert.equal(registry.getSession(session.id)?.meta?.modelId, "old-model", "selection does not rewrite the running turn");
    first.setModel = async () => { throw new Error("model unavailable"); };
    await assert.rejects(supervisor.setModel(session.id, "refused-model"), /model unavailable/);
    assert.equal(getSdkSession(session.id)?.model, "new-model");
    assert.equal(registry.getSession(session.id)?.configuredModel, "new-model");
    await assert.rejects(supervisor.setModel(session.id, "gpt-6-astra"), /not available/);

    // Now the restart, for real: a new process is a fresh supervisor AND a fresh registry
    // over the same store, which is the only thing that survives. Reusing the old registry
    // would hit the duplicate-registration refusal and prove nothing about restore.
    await supervisor.stopAll(50);
    const restoredRegistry = new Registry();
    await new SdkSupervisor(restoredRegistry).restore();
    assert.equal(restoredRegistry.getSession(session.id)?.configuredModel, "new-model");
    const relaunch = fake.calls.at(-1)!;
    assert.equal(relaunch.resume, "agent-rebound", "the latest conversation binding");
    assert.equal(relaunch.permissionMode, "acceptEdits");
    assert.equal(relaunch.effort, "xhigh");
    assert.equal(relaunch.model, "new-model");
  } finally {
    fake.restore();
  }
});

for (const scenario of ["restored", "rollback refused", "previous unknown"] as const) {
  test(`a model persistence failure is compensated or disclosed: ${scenario}`, async () => {
    const previous = scenario === "previous unknown" ? null : "old-model";
    let rollbackUnavailable = scenario === "rollback refused";
    let liveModel = previous;
    const changes: string[] = [];
    const first = fakeHandle();
    first.setModel = async (model) => {
      changes.push(model);
      if (rollbackUnavailable && model === previous) throw new Error("rollback unavailable");
      liveModel = model;
    };
    const handles = [first, fakeHandle()];
    const fake = withFakeDriver(async () => handles.shift()!);
    const registry = new Registry();
    const supervisor = new SdkSupervisor(registry);
    try {
      const session = await supervisor.start({ ...START, model: previous });
      first.push({ kind: "bound", agentSessionId: "model-write-failure", transcriptPath: null, modelId: previous, pid: null });
      await waitFor(() => getSdkSession(session.id)?.agentSessionId === "model-write-failure");
      const published: string[] = [];
      registry.subscribe((event) => {
        if (event.type === "session_upsert" && event.session.configuredModel) published.push(event.session.configuredModel);
      });
      openDb().exec(`CREATE TEMP TRIGGER reject_model_write BEFORE UPDATE OF model ON sdk_sessions
        WHEN NEW.model = 'new-model' BEGIN SELECT RAISE(FAIL, 'disk full'); END;`);
      await assert.rejects(supervisor.setModel(session.id, "new-model"), scenario === "restored"
        ? /could not be saved.*previous model was restored/i
        : /changed.*could not be saved.*restart/i);
      assert.equal(getSdkSession(session.id)?.model, previous, "the failed write leaves the restart model intact");
      const expected = scenario === "restored" ? previous : "new-model";
      assert.equal(liveModel, expected, "driver and visible selection must agree after the failed write");
      assert.equal(registry.getSession(session.id)?.configuredModel, expected);
      assert.deepEqual(changes, previous ? ["new-model", previous] : ["new-model"]);
      assert.equal(published.includes("new-model"), scenario !== "restored", "only a partial acceptance publishes the new model");
      // A retry must still compensate to what restart will load, even though the
      // published runtime selection now contains the unsaved model.
      await assert.rejects(supervisor.setModel(session.id, "new-model"), scenario === "restored"
        ? /could not be saved.*previous model was restored/i
        : /changed.*could not be saved.*restart/i);
      assert.equal(getSdkSession(session.id)?.model, previous);
      assert.equal(liveModel, expected);
      assert.equal(registry.getSession(session.id)?.configuredModel, expected);
      assert.deepEqual(changes, previous ? ["new-model", previous, "new-model", previous] : ["new-model", "new-model"]);
      if (scenario === "rollback refused") {
        rollbackUnavailable = false;
        await assert.rejects(supervisor.setModel(session.id, "new-model"), /previous model was restored/i);
        assert.equal(liveModel, previous);
        assert.equal(registry.getSession(session.id)?.configuredModel, previous, "successful recovery replaces the previously published unsaved choice");
      }
      openDb().exec("DROP TRIGGER reject_model_write");
      await supervisor.stopAll(50);
      await new SdkSupervisor(new Registry()).restore();
      assert.equal(fake.calls.at(-1)?.model, previous, "restart matches compensation, or the explicit partial-acceptance warning");
    } finally {
      openDb().exec("DROP TRIGGER IF EXISTS reject_model_write");
      fake.restore();
    }
  });
}

test("a matching nonterminal hook cannot revive an SDK card while stop is in progress", async (t) => {
  const handle = fakeHandle();
  const normalStop = handle.stop;
  let releaseStop!: () => void;
  const heldStop = new Promise<void>((resolve) => { releaseStop = resolve; });
  handle.stop = async () => { await heldStop; await normalStop(); };
  const fake = withFakeDriver(async () => handle);
  t.after(fake.restore);
  const registry = new Registry();
  const supervisor = new SdkSupervisor(registry);
  const session = await supervisor.start(START);
  t.after(async () => { releaseStop(); await supervisor.stop(session.id); });
  handle.push({ kind: "bound", agentSessionId: "native-stopping", transcriptPath: null, modelId: null, pid: null });
  handle.push({ kind: "turn_done", usage: null });
  await drain();

  assert.equal(supervisor.requestStop(session.id), true);
  assert.equal(registry.getSession(session.id)?.state, "stopping");
  registry.applyHook({ agent: "claude", event: "Stop", sessionId: "native-stopping",
    transcriptPath: null, cwd: START.cwd, env: {} });
  assert.equal(registry.getSession(session.id)?.state, "stopping", "a matching idle hook cannot undo an accepted stop");
  assert.equal(supervisor.handleFor(session.id), handle, "the driver has not finished closing");
  assert.equal(getSdkSession(session.id)?.status, "running", "final closure has not been persisted yet");

  releaseStop();
  await supervisor.stop(session.id);
  assert.equal(registry.getSession(session.id)?.state, "exited");
  assert.equal(getSdkSession(session.id)?.status, "exited");
  assert.equal(supervisor.handleFor(session.id), null);
});

for (const ending of ["driver exit", "explicit stop"] as const) {
  test(`matching SessionEnd preserves the SDK owner; ${ending} stays closed across restarts`, async (t) => {
    const handle = fakeHandle();
    const fake = withFakeDriver(async () => handle);
    t.after(fake.restore);
    const registry = new Registry();
    const supervisor = new SdkSupervisor(registry);
    const session = await supervisor.start(START);
    handle.push({ kind: "bound", agentSessionId: "native-closure", transcriptPath: null, modelId: null, pid: null });
    handle.push({ kind: "turn_done", usage: null });
    await drain();
    const hook = { agent: "claude" as const, event: "SessionEnd", sessionId: "native-closure", transcriptPath: null, cwd: START.cwd, env: {}, reason: "clear" };
    registry.applyHook(hook);
    assert.equal(registry.getSession(session.id)?.state, "idle", "a query/context hook cannot close the reusable driver");
    assert.equal(getSdkSession(session.id)?.status, "running");
    await supervisor.send(session.id, { text: "follow-up after context end" });
    assert.equal(handle.sent.at(-1)?.text, "follow-up after context end");
    if (ending === "explicit stop") await supervisor.stop(session.id);
    else {
      handle.push({ kind: "exited", reason: "final exit", resumable: true });
      handle.end();
    }
    await drain();
    assert.equal(getSdkSession(session.id)?.status, "exited");
    registry.applyHook({ ...hook, event: "Stop" });
    assert.equal(registry.getSession(session.id)?.state, "exited", "late hooks cannot revive a closing card");
    for (let restart = 0; restart < 2; restart++) {
      const next = new Registry();
      await new SdkSupervisor(next).restore();
      assert.equal(next.getSession(session.id), undefined);
    }
    assert.equal(fake.calls.length, 1, "closed drivers are never relaunched");
  });
}

for (const { scenario, status, pointer, reused, retire, turnInProgress } of [
  { scenario: "cancelled detached idle", status: "cancelled", pointer: null, retire: true, turnInProgress: false },
  { scenario: "cancelled detached interrupted", status: "cancelled", pointer: null, retire: true, turnInProgress: true },
  { scenario: "cancelled replaced", status: "cancelled", pointer: "sdk:replacement", retire: true, turnInProgress: false },
  { scenario: "cancelled reused", status: "cancelled", pointer: null, reused: true, turnInProgress: false },
  { scenario: "cancelled attached", status: "cancelled", pointer: "sdk:ownership-restore", turnInProgress: false },
  { scenario: "done detached", status: "done", pointer: null, turnInProgress: false },
  { scenario: "done retained", status: "done", pointer: "sdk:ownership-restore", turnInProgress: false },
] satisfies Array<{ scenario: string; status: "cancelled" | "done"; pointer: string | null;
  reused?: boolean; retire?: boolean; turnInProgress: boolean }>) {
  test(`restore reconciles ownership: ${scenario}`, async (t) => {
    const fake = withFakeDriver(async () => fakeHandle());
    t.after(fake.restore);
    const id = "sdk:ownership-restore";
    const taskId = "original-owner";
    const registry = new Registry();
    registry.upsertTask(mkTask({ id: taskId, kind: "chat", status, sessionId: pointer }));
    if (reused) registry.upsertTask(mkTask({ id: "new-owner", status: "running", sessionId: id }));
    upsertSdkSession({ id, agent: "claude", agentSessionId: "native-ownership", cwd: START.cwd, taskId,
      model: null, effort: null, permissionMode: null, status: "suspended", turnInProgress });
    for (let restart = 0; restart < 2; restart++) {
      // Deliberately use a fresh Registry: durable ownership must not depend on cached tasks.
      const next = new Registry();
      const supervisor = new SdkSupervisor(next);
      await supervisor.restore();
      await supervisor.restore();
      if (retire) {
        assert.equal(fake.calls.length, 0);
        assert.equal(getSdkSession(id)?.status, "exited");
        assert.equal(getSdkSession(id)?.turnInProgress, false);
        assert.equal(next.getSession(id)?.state, restart === 0 ? "exited" : undefined);
      } else {
        assert.equal(fake.calls.length, restart + 1);
        assert.ok(supervisor.handleFor(id));
        await supervisor.stopAll();
      }
    }
    const task = getTask(taskId)!;
    assert.equal(task.status, status);
    assert.equal(task.sessionId, pointer);
  });
}

// A provider at capacity ends the turn with the work half done. Reporting that as a completed
// turn is what sent a workflow review after an unfinished Codex turn and then a repair round
// straight into the same outage. The supervisor holds the turn open and retries instead.
const CAPACITY = { kind: "capacity" as const, message: "Selected model is at capacity. Please try a different model." };

async function startWorking(t: import("node:test").TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const handle = fakeHandle();
  const fake = withFakeDriver(async () => handle);
  t.after(fake.restore);
  const registry = new Registry();
  const supervisor = new SdkSupervisor(registry);
  const session = await supervisor.start(START);
  handle.push({ kind: "state", state: "working", activity: null });
  await drain();
  const sentBefore = handle.sent.length;
  const continuations = () =>
    handle.sent.slice(sentBefore).filter((turn) => turn.text === CAPACITY_CONTINUATION_PROMPT).length;
  return { handle, registry, supervisor, session, continuations };
}

test("a capacity failure holds the turn open and retries with progressive backoff", async (t) => {
  const { handle, registry, session, continuations } = await startWorking(t);
  const generation = registry.getSession(session.id)?.workCycle?.generation;

  handle.push({ kind: "turn_done", usage: null, failure: CAPACITY });
  await drain();
  let card = registry.getSession(session.id);
  assert.equal(card?.state, "working", "the card does not go idle on unfinished work");
  assert.equal(card?.activity, "Model at capacity - retrying in 15s (attempt 1 of 8)");
  assert.equal(card?.workCycle?.active, true, "the work cycle is not completed");
  assert.equal(card?.workCycle?.generation, generation);
  assert.equal(getSdkSession(session.id)?.turnInProgress, true, "a restart would continue the work");

  t.mock.timers.tick(14_999);
  await drain();
  assert.equal(continuations(), 0, "nothing is sent before the backoff elapses");
  t.mock.timers.tick(1);
  await drain();
  assert.equal(continuations(), 1, "the continuation is sent after 15 seconds");
  assert.equal(originOf(session.id, CAPACITY_CONTINUATION_PROMPT), "harness", "the retry is not the operator's words");

  handle.push({ kind: "state", state: "working", activity: null });
  handle.push({ kind: "turn_done", usage: null, failure: CAPACITY });
  await drain();
  assert.equal(registry.getSession(session.id)?.activity, "Model at capacity - retrying in 30s (attempt 2 of 8)");
  t.mock.timers.tick(29_999);
  await drain();
  assert.equal(continuations(), 1);
  t.mock.timers.tick(1);
  await drain();
  assert.equal(continuations(), 2, "the second wait is twice the first");

  handle.push({ kind: "state", state: "working", activity: null });
  handle.push({ kind: "turn_done", usage: null });
  await drain();
  card = registry.getSession(session.id);
  assert.equal(card?.state, "idle", "a turn that finishes settles the card as usual");
  assert.equal(card?.workCycle?.active, false);
  assert.equal(getSdkSession(session.id)?.turnInProgress, false);

  handle.push({ kind: "state", state: "working", activity: null });
  handle.push({ kind: "turn_done", usage: null, failure: CAPACITY });
  await drain();
  assert.equal(
    registry.getSession(session.id)?.activity,
    "Model at capacity - retrying in 15s (attempt 1 of 8)",
    "a successful turn resets the backoff",
  );
});

test("a message delivered during the backoff replaces the retry", async (t) => {
  const { handle, registry, supervisor, session, continuations } = await startWorking(t);
  handle.push({ kind: "turn_done", usage: null, failure: CAPACITY });
  await drain();

  assert.equal(await supervisor.send(session.id, { text: "carry on with the tests" }), "started");
  t.mock.timers.tick(capacityRetryPlan(1)!.delayMs);
  await drain();
  assert.equal(continuations(), 0, "the delivered message already resumed the work");
  handle.push({ kind: "turn_done", usage: null });
  await drain();
  assert.equal(registry.getSession(session.id)?.state, "idle");
});

test("an interrupt during the backoff cancels the retry and settles the turn", async (t) => {
  const { handle, registry, supervisor, session, continuations } = await startWorking(t);
  handle.push({ kind: "turn_done", usage: null, failure: CAPACITY });
  await drain();

  assert.equal(await supervisor.interrupt(session.id), "interrupted", "the waiting retry was the running work");
  assert.equal(registry.getSession(session.id)?.state, "idle");
  assert.equal(registry.getSession(session.id)?.workCycle?.active, false);
  assert.equal(getSdkSession(session.id)?.turnInProgress, false);
  t.mock.timers.tick(capacityRetryPlan(1)!.delayMs);
  await drain();
  assert.equal(continuations(), 0);
});

test("a model that stays at capacity is reported as a finished turn once the attempts run out", async (t) => {
  const { handle, registry, session, continuations } = await startWorking(t);
  for (let attempt = 1; attempt <= CAPACITY_RETRY_MAX_ATTEMPTS; attempt++) {
    handle.push({ kind: "turn_done", usage: null, failure: CAPACITY });
    await drain();
    assert.equal(registry.getSession(session.id)?.state, "working");
    t.mock.timers.tick(capacityRetryPlan(attempt)!.delayMs);
    await drain();
    assert.equal(continuations(), attempt);
    handle.push({ kind: "state", state: "working", activity: null });
  }
  handle.push({ kind: "turn_done", usage: null, failure: CAPACITY });
  await drain();
  assert.equal(registry.getSession(session.id)?.state, "idle", "the session is not held busy for ever");
  assert.equal(registry.getSession(session.id)?.workCycle?.active, false);
  assert.equal(getSdkSession(session.id)?.turnInProgress, false);
});

test("a retry that finds the driver already busy leaves that turn to settle the card", async (t) => {
  const { handle, registry, session, continuations } = await startWorking(t);
  handle.push({ kind: "turn_done", usage: null, failure: CAPACITY });
  await drain();
  handle.sendIfIdle = async () => null;

  t.mock.timers.tick(capacityRetryPlan(1)!.delayMs);
  await drain();
  assert.equal(continuations(), 0);
  assert.equal(originOf(session.id, CAPACITY_CONTINUATION_PROMPT), undefined, "the unsent retry claims no authorship");
  assert.equal(registry.getSession(session.id)?.state, "working", "the running turn still owns the card");

  handle.push({ kind: "turn_done", usage: null });
  await drain();
  assert.equal(registry.getSession(session.id)?.state, "idle");
  assert.equal(getSdkSession(session.id)?.turnInProgress, false);
});

test("a retry the driver refuses settles the card and claims no authorship", async (t) => {
  const { handle, registry, session, continuations } = await startWorking(t);
  handle.push({ kind: "turn_done", usage: null, failure: CAPACITY });
  await drain();
  assert.equal(getSdkSession(session.id)?.turnInProgress, true);
  handle.sendIfIdle = async () => {
    throw new Error("driver refused the turn");
  };

  t.mock.timers.tick(capacityRetryPlan(1)!.delayMs);
  await drain();
  assert.equal(continuations(), 0);
  assert.equal(originOf(session.id, CAPACITY_CONTINUATION_PROMPT), undefined, "the refused retry claims no authorship");
  const card = registry.getSession(session.id);
  assert.equal(card?.state, "idle", "nothing will finish the turn, so it is reported finished");
  assert.equal(card?.workCycle?.active, false);
  assert.equal(getSdkSession(session.id)?.turnInProgress, false, "a restart owes no continuation");
});

/** Every state and work cycle the card was published with, from now on. */
function watchCard(registry: InstanceType<typeof Registry>, id: string) {
  const seen: Array<{ state: string; active?: boolean; generation?: number }> = [];
  registry.subscribe((event: ServerEvent) => {
    if (event.type !== "session_upsert" || event.session.id !== id) return;
    seen.push({
      state: event.session.state,
      active: event.session.workCycle?.active,
      generation: event.session.workCycle?.generation,
    });
  });
  return seen;
}

for (const rebind of ["after", "before"] as const) {
  test(`clearing context during the backoff completes the old turn only once the clear lands (rebind ${rebind} it resolves)`, async (t) => {
    const { handle, registry, supervisor, session, continuations } = await startWorking(t);
    handle.push({ kind: "turn_done", usage: null, failure: CAPACITY });
    await drain();
    const oldConversation = registry.getSession(session.id)!.agentSessionId ?? session.id;
    const before = workCycleFor(oldConversation)!;
    assert.equal(before.active, true);
    const duringClear: Array<{ state?: string; active?: boolean }> = [];
    handle.clearContext = async () => {
      duringClear.push({
        state: registry.getSession(session.id)?.state,
        active: workCycleFor(oldConversation)?.active,
      });
      if (rebind === "before") {
        // The replacement's identity reaches the card before the clear call resolves.
        handle.push({
          kind: "bound",
          agentSessionId: "replacement-conversation",
          transcriptPath: null,
          modelId: null,
          pid: null,
          cleared: true,
        });
        await drain();
      }
    };

    assert.equal(await supervisor.clearContext(session.id), true);
    assert.deepEqual(duringClear, [{ state: "working", active: true }], "nothing is reported finished before the clear lands");
    if (rebind === "after") {
      handle.push({
        kind: "bound",
        agentSessionId: "replacement-conversation",
        transcriptPath: null,
        modelId: null,
        pid: null,
        cleared: true,
      });
      await drain();
    }
    const after = workCycleFor(oldConversation)!;
    assert.equal(after.active, false, "the old conversation's turn is completed");
    assert.equal(after.generation, before.generation + 1);
    assert.equal(workCycleFor("replacement-conversation")?.active ?? false, false, "the replacement has no work to complete");
    assert.equal(registry.getSession(session.id)?.state, "idle");
    assert.equal(getSdkSession(session.id)?.turnInProgress, false);
    t.mock.timers.tick(capacityRetryPlan(1)!.delayMs);
    await drain();
    assert.equal(continuations(), 0, "the wiped conversation is not continued");
  });
}

test("stopping the session during the backoff sends no retry, even while the stop drains", async (t) => {
  const { handle, registry, supervisor, session, continuations } = await startWorking(t);
  handle.push({ kind: "turn_done", usage: null, failure: CAPACITY });
  await drain();
  const generation = registry.getSession(session.id)?.workCycle?.generation;
  // A driver that takes longer to exit than the backoff: teardown has not run yet when the
  // timer is due, so only the stop itself can have cancelled the retry.
  let finishStop = (): void => {};
  handle.stop = () => new Promise<void>((resolve) => {
    finishStop = () => {
      handle.stopped = true;
      handle.push({ kind: "exited", reason: "stopped", resumable: true });
      resolve();
    };
  });

  assert.equal(supervisor.requestStop(session.id), true);
  t.mock.timers.tick(capacityRetryPlan(1)!.delayMs);
  await drain();
  assert.equal(continuations(), 0, "a stopping session is not continued");
  const card = registry.getSession(session.id);
  assert.equal(card?.workCycle?.active, true, "the unfinished turn is not reported complete by a stop");
  assert.equal(card?.workCycle?.generation, generation);

  finishStop();
  await drain();
  assert.equal(handle.stopped, true);
  assert.equal(supervisor.handleFor(session.id), null);
});

// A control that set the retry aside and then failed leaves the session live with its work
// unfinished. Without the retry nothing would ever continue or settle that turn.
test("a refused clear during the backoff never reports the turn finished, and keeps the retry", async (t) => {
  const { handle, registry, supervisor, session, continuations } = await startWorking(t);
  handle.push({ kind: "turn_done", usage: null, failure: CAPACITY });
  await drain();
  const generation = registry.getSession(session.id)?.workCycle?.generation;
  const published = watchCard(registry, session.id);
  handle.clearContext = async () => {
    throw new Error("driver refused the clear");
  };

  await assert.rejects(supervisor.clearContext(session.id), /driver refused the clear/);
  assert.deepEqual(
    published.filter((card) => card.state === "idle" || card.active === false || card.generation !== generation),
    [],
    "no idle card or completed cycle was ever published for a listener to act on",
  );
  const card = registry.getSession(session.id);
  assert.equal(card?.state, "working");
  assert.equal(card?.workCycle?.active, true);
  assert.equal(card?.workCycle?.generation, generation);
  assert.equal(getSdkSession(session.id)?.turnInProgress, true);
  t.mock.timers.tick(capacityRetryPlan(1)!.delayMs);
  await drain();
  assert.equal(continuations(), 1, "the unfinished work is still continued");
});

test("a refused stop during the backoff puts the retry back", async (t) => {
  const { handle, registry, supervisor, session, continuations } = await startWorking(t);
  handle.push({ kind: "turn_done", usage: null, failure: CAPACITY });
  await drain();
  handle.stop = async () => {
    throw new Error("driver refused stop");
  };

  assert.equal(supervisor.requestStop(session.id), true);
  await drain();
  assert.equal(supervisor.handleFor(session.id), handle, "the driver is still live");
  assert.equal(registry.getSession(session.id)?.state, "working");
  assert.equal(getSdkSession(session.id)?.turnInProgress, true);
  t.mock.timers.tick(capacityRetryPlan(1)!.delayMs);
  await drain();
  assert.equal(continuations(), 1, "the live session still continues its work");
});

test("a refused interrupt during the backoff puts the retry back", async (t) => {
  const { handle, registry, supervisor, session, continuations } = await startWorking(t);
  handle.push({ kind: "turn_done", usage: null, failure: CAPACITY });
  await drain();
  handle.interrupt = async () => {
    throw new Error("driver refused the interrupt");
  };

  await assert.rejects(supervisor.interrupt(session.id), /driver refused the interrupt/);
  assert.equal(registry.getSession(session.id)?.state, "working");
  assert.equal(registry.getSession(session.id)?.workCycle?.active, true);
  t.mock.timers.tick(capacityRetryPlan(1)!.delayMs);
  await drain();
  assert.equal(continuations(), 1);
});

test("a capacity failure with a queued turn keeps the cycle open until that turn ends", async (t) => {
  const { handle, registry, supervisor, session, continuations } = await startWorking(t);
  handle.send = async (turn) => {
    handle.sent.push(turn);
    return "queued";
  };
  assert.equal(await supervisor.send(session.id, { text: "and then run the tests" }), "queued");
  const generation = registry.getSession(session.id)?.workCycle?.generation;
  const published = watchCard(registry, session.id);
  const usage = { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, modelId: "claude-test", costUsd: null };

  handle.push({ kind: "turn_done", usage, failure: CAPACITY });
  await drain();
  assert.deepEqual(
    published.filter((card) => card.state === "idle" || card.active === false || card.generation !== generation),
    [],
    "no completion is published while the queued turn still has the unfinished work",
  );
  assert.equal(registry.getSession(session.id)?.state, "working");
  assert.equal(registry.getSession(session.id)?.workCycle?.active, true);
  assert.equal(getSdkSession(session.id)?.turnInProgress, true);
  t.mock.timers.tick(capacityRetryPlan(1)!.delayMs);
  await drain();
  assert.equal(continuations(), 0, "the queued turn is the retry");

  handle.push({ kind: "turn_done", usage: null });
  await drain();
  const card = registry.getSession(session.id);
  assert.equal(card?.state, "idle", "the queued turn's completion settles the card");
  assert.equal(card?.workCycle?.active, false);
  assert.equal(card?.workCycle?.generation, generation! + 1);
});
