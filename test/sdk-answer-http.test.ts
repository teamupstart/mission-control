import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What is at stake: an answer landing on a question nobody was asked.
//
// `/select-option` and `/submit-options` are the two routes that turn a click, a Foreman
// decision or an MCP call into an ANSWER, and both now serve two runtimes. The pane arm
// re-reads a screen and refuses on `optionRowMiss`; the driver arm re-reads the request the
// card was drawn from and refuses on the same rule. What must not differ is anything the
// CALLER sees: `{number, label}` in, 409 and "nothing was selected" out - because the
// dashboard, Foreman and the MCP tool all speak that one grammar, and a second one is how a
// refusal starts reading as a crash.
//
// The handoff route is here for the same reason: it is a mutation whose refusals are all
// state conflicts, and its ordering (clear the task's binding BEFORE stopping the driver) is
// the difference between a task that transfers and a task that silently settles `failed`.

const home = mkdtempSync(join(tmpdir(), "mission-sdk-answer-"));
process.env.HARNESS_HOME = home;

const { buildApp } = await import("../src/server/routes.ts");
const { Registry } = await import("../src/server/registry.ts");
const { driverDialog } = await import("../src/server/sdk/dialog.ts");
const { mkTask, mkMuxHandle } = await import("./helpers/session-fixture.ts");
const { getSdkSession, upsertSdkSession } = await import("../src/server/sdk/store.ts");
const { TaskManager: RealTaskManager } = await import("../src/server/tasks.ts");

type Registry_ = InstanceType<typeof Registry>;
type SessionRequest = import("../src/server/harness/types.ts").SessionRequest;
type SessionRequestAnswer = import("../src/server/harness/types.ts").SessionRequestAnswer;
type SdkSupervisor = import("../src/server/sdk/supervisor.ts").SdkSupervisor;
type ReviewManager = import("../src/server/reviews.ts").ReviewManager;
type TaskManager = import("../src/server/tasks.ts").TaskManager;
type QueueManager = import("../src/server/queue.ts").QueueManager;
type Session = import("../src/shared/types.ts").Session;
type DiscoveredSession = import("../src/server/discovery/correlate.ts").DiscoveredSession;

after(() => rmSync(home, { recursive: true, force: true }));

const HEADERS = { host: "127.0.0.1:7317", "content-type": "application/json" };

const PERMISSION: SessionRequest = {
  id: "req-1",
  kind: "permission",
  prompt: "Claude wants to run `rm -rf build`",
  options: [
    { number: 1, label: "Yes" },
    { number: 2, label: "No" },
  ],
};

const FORM: SessionRequest = {
  id: "req-2",
  kind: "question",
  prompt: "Claude has some questions.",
  options: [],
  questions: [
    {
      question: "Which linter?",
      options: [
        { number: 1, label: "biome" },
        { number: 2, label: "eslint" },
      ],
    },
    {
      question: "Which checks?",
      multiSelect: true,
      options: [
        { number: 1, label: "types" },
        { number: 2, label: "tests" },
      ],
    },
  ],
};

/** Records what reached the driver, and can be made to refuse. */
function fakeSupervisor(over: { answer?: () => Promise<void> } = {}) {
  const answered: { id: string; requestId: string; answer: SessionRequestAnswer }[] = [];
  const stopped: string[] = [];
  const modes: string[] = [];
  const efforts: string[] = [];
  // A real claim set, not a stub: the concurrency test below is only meaningful if the
  // fake refuses a second handoff the way the supervisor does.
  const handingOff = new Set<string>();
  let live = true;
  return {
    answered,
    stopped,
    modes,
    efforts,
    /** Let a test say the driver has already gone, which is what refuses a REPEAT. */
    killDriver: () => (live = false),
    handleFor() {
      return live ? {} : null;
    },
    beginHandoff(id: string) {
      if (handingOff.has(id)) return false;
      handingOff.add(id);
      return true;
    },
    endHandoff(id: string) {
      handingOff.delete(id);
    },
    async answer(id: string, requestId: string, answer: SessionRequestAnswer) {
      answered.push({ id, requestId, answer });
      if (over.answer) await over.answer();
    },
    async stop(id: string) {
      stopped.push(id);
    },
    async setPermissionMode(id: string, mode: string) {
      modes.push(`${id}:${mode}`);
    },
    async setEffort(id: string, effort: string) {
      efforts.push(`${id}:${effort}`);
    },
    taskLiveness: () => null,
  } as unknown as SdkSupervisor & {
    answered: typeof answered;
    stopped: string[];
    modes: string[];
    efforts: string[];
    /** Say the driver has gone, so the live-driver preflight refuses the next handoff. */
    killDriver: () => void;
  };
}

function mkApp(
  registry: Registry_,
  supervisor: SdkSupervisor,
  handoffDeps?: Parameters<typeof buildApp>[10],
  launchSessionTerminal?: Parameters<typeof buildApp>[11],
) {
  return buildApp(
    registry,
    {} as unknown as ReviewManager,
    {} as unknown as TaskManager,
    {} as unknown as QueueManager,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    supervisor,
    handoffDeps,
    launchSessionTerminal,
  );
}

/** A registered embedded session showing `request`. */
function seed(registry: Registry_, request: SessionRequest | null, id = "sdk:one"): Session {
  const session = registry.registerSdkSession({
    id,
    agent: "claude",
    name: "Add a toggle",
    cwd: "/wt/one",
  });
  registry.applyDriverEvent(id, {
    kind: "bound",
    agentSessionId: "agent-1",
    transcriptPath: null,
    pid: null,
  });
  if (request) registry.applyDriverEvent(id, { kind: "request", request });
  return registry.getSession(id) ?? session;
}

test("a driver request is answered through the supervisor, not through a pane", async () => {
  const registry = new Registry();
  seed(registry, PERMISSION);
  const supervisor = fakeSupervisor();
  const res = await mkApp(registry, supervisor).request("/api/sessions/sdk:one/select-option", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ number: 1, label: "Yes" }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(supervisor.answered, [
    { id: "sdk:one", requestId: "req-1", answer: { kind: "option", number: 1, label: "Yes" } },
  ]);
});

test("a label that no longer matches is a 409, and nothing reaches the driver", async () => {
  const registry = new Registry();
  seed(registry, PERMISSION);
  const supervisor = fakeSupervisor();
  const res = await mkApp(registry, supervisor).request("/api/sessions/sdk:one/select-option", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ number: 1, label: "No" }),
  });
  // The number is a position on a list the caller may have re-read since; the label is what
  // makes it an answer. Same rule, same 409, same "nothing was selected" as the pane path.
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { error: string }).error, /the screen changed/);
  assert.deepEqual(supervisor.answered, []);
});

test("answering a session with no pending request is refused rather than guessed", async () => {
  const registry = new Registry();
  seed(registry, null);
  const supervisor = fakeSupervisor();
  const res = await mkApp(registry, supervisor).request("/api/sessions/sdk:one/select-option", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ number: 1, label: "Yes" }),
  });
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { error: string }).error, /no pending request/);
});

test("a driver that has moved on refuses, and the refusal reaches the caller as a conflict", async () => {
  const registry = new Registry();
  seed(registry, PERMISSION);
  // The card is one tick stale relative to the handle - the case the route's own check
  // cannot see, and the reason the driver re-checks too.
  const supervisor = fakeSupervisor({
    answer: async () => {
      throw new Error("no pending request req-1 on this session");
    },
  });
  const res = await mkApp(registry, supervisor).request("/api/sessions/sdk:one/select-option", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ number: 1, label: "Yes" }),
  });
  assert.equal(res.status, 409);
});

test("a form is submitted as an answers map, and one row of it answers nothing", async () => {
  const registry = new Registry();
  seed(registry, FORM);
  const supervisor = fakeSupervisor();
  const app = mkApp(registry, supervisor);

  // A form's rows live on its questions, each numbering from 1 - so pressing "row 1" is
  // ambiguous across them, and the route says so rather than picking one.
  const one = await app.request("/api/sessions/sdk:one/select-option", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ number: 1, label: "biome" }),
  });
  assert.equal(one.status, 409);
  assert.match(((await one.json()) as { error: string }).error, /submitted whole/);

  const half = await app.request("/api/sessions/sdk:one/submit-options", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ answers: [{ question: "Which linter?", labels: ["biome"] }] }),
  });
  // Refusing a partial submission is the same call the pane path makes on an "unanswered"
  // banner: sending it would put answers the human never gave under their name.
  assert.equal(half.status, 409);
  // `.length` rather than a deep compare against `[]`, which narrows the array's element
  // type to `never` for the rest of the function.
  assert.equal(supervisor.answered.length, 0);

  const whole = await app.request("/api/sessions/sdk:one/submit-options", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      answers: [
        { question: "Which linter?", labels: ["biome"] },
        { question: "Which checks?", labels: ["types", "tests"] },
      ],
    }),
  });
  assert.equal(whole.status, 200);
  assert.equal(supervisor.answered.length, 1);
  assert.deepEqual(supervisor.answered[0]!.answer, {
    kind: "form",
    answers: [
      { question: "Which linter?", labels: ["biome"] },
      { question: "Which checks?", labels: ["types", "tests"] },
    ],
  });
});

test("the two form bodies are not interchangeable", async () => {
  const registry = new Registry();
  seed(registry, FORM);
  const supervisor = fakeSupervisor();
  const res = await mkApp(registry, supervisor).request("/api/sessions/sdk:one/submit-options", {
    method: "POST",
    headers: HEADERS,
    // Pane rows against a driver form. Coercing them would tick the right-numbered row of
    // the wrong question, which is worse than refusing.
    body: JSON.stringify({ options: [{ number: 1, label: "biome", checked: true }] }),
  });
  assert.equal(res.status, 409);
  assert.deepEqual(supervisor.answered, []);

  // And neither-nor is a schema refusal, not a silent no-op.
  const empty = await mkApp(registry, supervisor).request(
    "/api/sessions/sdk:one/submit-options",
    { method: "POST", headers: HEADERS, body: JSON.stringify({}) },
  );
  assert.equal(empty.status, 400);
});

test("the projection a card renders is what the answer is verified against", () => {
  // One shape, so `activePaneDialog` keeps bucketing the session `needs-you` and the card
  // keeps drawing rows as buttons with no second arm anywhere.
  const dialog = driverDialog(PERMISSION);
  assert.equal(dialog.source, "driver");
  assert.equal(dialog.requestId, "req-1");
  assert.equal(dialog.kind, "permission");
  // No cursor: a driver request has no pre-selected default and no keystroke that could
  // confirm one, and options number from 1 so 0 is no row.
  assert.equal(dialog.highlighted, 0);
  assert.deepEqual(dialog.options.map((o) => o.label), ["Yes", "No"]);
});

test("parallel driver requests stay ordered and promote the next unanswered ask", () => {
  const registry = new Registry();
  seed(registry, PERMISSION);
  registry.applyDriverEvent("sdk:one", { kind: "request", request: FORM });
  assert.equal(registry.getSession("sdk:one")?.paneDialog?.requestId, "req-1");
  registry.applyDriverEvent("sdk:one", { kind: "request_resolved", requestId: "req-1" });
  assert.equal(registry.getSession("sdk:one")?.paneDialog?.requestId, "req-2");
  registry.applyDriverEvent("sdk:one", { kind: "request_resolved", requestId: "req-2" });
  assert.equal(registry.getSession("sdk:one")?.paneDialog, null);
});

test("the handoff clears the task binding BEFORE stopping the driver, so nothing settles", async () => {
  const registry = new Registry();
  const session = seed(registry, null, "sdk:hand");
  registry.upsertTask(
    mkTask({
      id: "task-h",
      status: "running",
      sessionId: "sdk:hand",
      repoRoot: "/repo",
      title: "Add a toggle",
    }),
  );
  const order: string[] = [];
  const supervisor = fakeSupervisor();
  upsertSdkSession({
    id: "sdk:hand",
    agent: "claude",
    agentSessionId: "agent-1",
    cwd: "/wt/one",
    taskId: "task-h",
    model: null,
    effort: null,
    permissionMode: null,
    status: "running",
  });
  const realStop = supervisor.stop.bind(supervisor);
  supervisor.stop = async (id: string) => {
    // `session_remove` is what settles a task, and it comes from the eviction this stop
    // begins. If the binding were still on the task at this instant, a handoff would read
    // as an agent that went away - `failed`, with a merged PR sometimes sitting in the row.
    order.push(`stop:${registry.getTask("task-h")?.sessionId ?? "null"}`);
    await realStop(id);
  };

  const app = mkApp(registry, supervisor, {
    spawn: async (name) => {
      order.push(`spawn:${name}`);
      return `${name}-abc123`;
    },
    waitForSessionAtCwd: async () => ({ ...session, id: "proc:tty:1:2" }) as Session,
    settleTask: () => assert.fail("a handoff that succeeded must not settle its task"),
  });
  const res = await app.request("/api/sessions/sdk:hand/handoff", { method: "POST", headers: HEADERS });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; homeName: string };
  assert.equal(body.ok, true);
  assert.match(body.homeName, /-abc123$/);
  assert.deepEqual(order, ["stop:null", "spawn:Add a toggle"]);

  const task = registry.getTask("task-h")!;
  // Still running, now bound to the terminal successor and holding the home name teardown
  // will need.
  assert.equal(task.status, "running");
  assert.equal(task.sessionId, "proc:tty:1:2");
  assert.equal(task.homeName, body.homeName);
  assert.equal(getSdkSession("sdk:hand")?.taskId, null);
});

test("the embedded agent launcher delegates to handoff instead of launching beside the driver", async () => {
  const registry = new Registry();
  seed(registry, null, "sdk:launch");
  const supervisor = fakeSupervisor();
  const spawned: string[] = [];
  const app = mkApp(
    registry,
    supervisor,
    {
      spawn: async (name) => {
        spawned.push(name);
        return `${name}-abc123`;
      },
      waitForSessionAtCwd: async () => null,
      settleTask: () => assert.fail("a successful handoff settles nothing"),
    },
    async () => assert.fail("an embedded launcher must not call launchTerminal"),
  );

  const res = await app.request("/api/sessions/sdk:launch/launch", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ backend: "ghostty", payload: "agent" }),
  });

  assert.equal(res.status, 200);
  assert.deepEqual(supervisor.stopped, ["sdk:launch"]);
  assert.equal(spawned.length, 1);
  assert.equal(((await res.json()) as { label: string }).label, "default terminal");
});

test("exited resume clears its task binding before launch and survives session removal", async () => {
  const registry = new Registry();
  const tasks = new RealTaskManager(registry);
  const sessionId = "proc:tty1:9:1";
  const cwd = "/wt/exited";
  const discovered: DiscoveredSession = {
    syntheticId: sessionId,
    agent: "claude",
    name: "Exited work",
    nameSource: "tmux",
    cwd,
    gitBranch: "harness/exited",
    gitRoot: cwd,
    repoRoot: "/repo",
    nomistakesGated: false,
    pid: 9,
    tty: "tty1",
    terminals: [mkMuxHandle({ session: "exited", paneId: "%9" })],
    startedAt: 1,
    agentSessionId: "agent-exited",
  };
  registry.applyDiscovery([discovered]);
  registry.upsertTask(
    mkTask({
      id: "task-exited",
      status: "running",
      sessionId,
      repoRoot: "/repo",
      worktreePath: cwd,
    }),
  );
  registry.applyDiscovery([]);

  const app = buildApp(
    registry,
    {} as unknown as ReviewManager,
    tasks,
    {} as unknown as QueueManager,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => {
      assert.equal(registry.getTask("task-exited")?.sessionId, null);
      return { ok: true, label: "tmux", status: 200 };
    },
  );
  const res = await app.request(`/api/sessions/${sessionId}/launch`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ backend: "tmux", payload: "agent" }),
  });

  assert.equal(res.status, 200);
  registry.emit("event", { type: "session_remove", id: sessionId });
  assert.equal(registry.getTask("task-exited")?.status, "running");
  assert.equal(registry.getTask("task-exited")?.sessionId, null);
});

test("a late terminal successor rebinds an unbound running task by its worktree", () => {
  const registry = new Registry();
  registry.upsertTask(
    mkTask({
      id: "task-late",
      status: "running",
      sessionId: null,
      worktreePath: "/wt/late",
      repoRoot: "/repo",
    }),
  );
  new RealTaskManager(registry, undefined, fakeSupervisor());
  registry.applyDiscovery([
    {
      syntheticId: "proc:late:9:1",
      agent: "claude",
      pid: 9,
      tty: "late",
      cwd: "/wt/late",
      name: "late",
      nameSource: "process",
      terminals: [],
      startedAt: 1,
    } as never,
  ]);
  assert.equal(registry.getTask("task-late")?.sessionId, "proc:late:9:1");
});

test("kill and mode controls use the embedded driver", async () => {
  const registry = new Registry();
  seed(registry, null, "sdk:controls");
  const supervisor = fakeSupervisor();
  const app = mkApp(registry, supervisor);
  const mode = await app.request("/api/sessions/sdk:controls/mode", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ mode: "acceptEdits" }),
  });
  assert.equal(mode.status, 200);
  assert.deepEqual(supervisor.modes, ["sdk:controls:acceptEdits"]);
  assert.equal(registry.getSession("sdk:controls")?.permissionMode, "acceptEdits");

  const killed = await app.request("/api/sessions/sdk:controls/kill", {
    method: "POST",
    headers: HEADERS,
  });
  assert.equal(killed.status, 200);
  assert.deepEqual(supervisor.stopped, ["sdk:controls"]);
});

test("scheduled Codex controls wait for rollout observation before changing the card", async () => {
  const rolloutPath = join(home, "codex-controls-rollout.jsonl");
  writeFileSync(
    rolloutPath,
    [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-07-25T12:00:00.000Z",
        payload: {
          id: "thread-1",
          cwd: "/wt/codex",
          timestamp: "2026-07-25T12:00:00.000Z",
        },
      }),
      JSON.stringify({
        type: "turn_context",
        timestamp: "2026-07-25T12:00:01.000Z",
        payload: { model: "gpt-5.6-sol", effort: "high" },
      }),
      "",
    ].join("\n"),
  );
  const registry = new Registry();
  registry.registerSdkSession({
    id: "sdk:codex-controls",
    agent: "codex",
    name: "Codex controls",
    cwd: "/wt/codex",
    permissionMode: "askForApproval",
  });
  registry.applyDriverEvent("sdk:codex-controls", {
    kind: "bound",
    agentSessionId: "thread-1",
    transcriptPath: rolloutPath,
    pid: 123,
  });
  registry.applyRuntimeMeta(
    "sdk:codex-controls",
    {
      modelId: "gpt-5.6-sol",
      contextTokens: 20_000,
      contextWindow: 258_400,
      contextPct: 8,
      longContext: false,
      thinkingLevel: "high",
      effortRevision: "turn-1",
    },
    "transcript",
  );
  const supervisor = fakeSupervisor();
  const app = mkApp(registry, supervisor);

  const mode = await app.request("/api/sessions/sdk:codex-controls/mode", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ mode: "approveForMe" }),
  });
  assert.equal(mode.status, 200);
  assert.deepEqual(supervisor.modes, ["sdk:codex-controls:approveForMe"]);
  assert.equal(registry.getSession("sdk:codex-controls")?.permissionMode, "askForApproval");

  const effort = await app.request("/api/sessions/sdk:codex-controls/effort", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ effort: "max" }),
  });
  assert.equal(effort.status, 200);
  assert.deepEqual(supervisor.efforts, ["sdk:codex-controls:max"]);
  assert.equal(registry.getSession("sdk:codex-controls")?.meta?.thinkingLevel, "high");
});

test("a handoff with no identity to resume from is refused before anything is stopped", async () => {
  const registry = new Registry();
  registry.registerSdkSession({ id: "sdk:new", agent: "claude", name: "n", cwd: "/wt" });
  const supervisor = fakeSupervisor();
  const res = await mkApp(registry, supervisor, {
    spawn: async () => {
      throw new Error("nothing may be spawned");
    },
    waitForSessionAtCwd: async () => null,
    settleTask: () => assert.fail("a refusal before the stop settles nothing"),
  }).request("/api/sessions/sdk:new/handoff", { method: "POST", headers: HEADERS });

  // Launching anyway would start a FRESH agent wearing the card of the one we just killed.
  assert.equal(res.status, 409);
  assert.deepEqual(supervisor.stopped, []);
});

test("a pane-backed session has nothing to hand off", async () => {
  const registry = new Registry();
  registry.applyDiscovery([
    {
      syntheticId: "proc:tty1:9:1",
      agent: "claude",
      pid: 9,
      tty: "tty1",
      cwd: "/wt",
      name: "term",
      nameSource: "process",
      terminals: [],
      startedAt: 1,
    } as never,
  ]);
  const supervisor = fakeSupervisor();
  const res = await mkApp(registry, supervisor).request("/api/sessions/proc:tty1:9:1/handoff", {
    method: "POST",
    headers: HEADERS,
  });
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { error: string }).error, /already runs in a terminal/);
});

test("a turn reaches the driver through /send, and the Send button is not a lie", async () => {
  const registry = new Registry();
  seed(registry, null, "sdk:send");
  const sent: { id: string; text: string }[] = [];
  const supervisor = {
    async send(id: string, turn: { text: string }) {
      sent.push({ id, text: turn.text });
    },
  } as unknown as SdkSupervisor;
  const res = await mkApp(registry, supervisor).request("/api/sessions/sdk:send/send", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ text: "carry on", submit: true }),
  });
  // The card enables Send on `canMessage`, which an embedded session answers yes to. Left
  // on the pane path this route refuses with "no terminal pane to send to" - an enabled
  // button that always fails, which is worse than no button.
  assert.equal(res.status, 200);
  assert.deepEqual(sent, [{ id: "sdk:send", text: "carry on" }]);
});

test("/inject reports a driver refusal as positive evidence that nothing landed", async () => {
  const registry = new Registry();
  seed(registry, null, "sdk:inject");
  const supervisor = {
    async send() {
      throw new Error("no live driver for session sdk:inject");
    },
  } as unknown as SdkSupervisor;
  const res = await mkApp(registry, supervisor).request("/api/sessions/sdk:inject/inject", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ text: "queued work", origin: "foreman" }),
  });
  const body = (await res.json()) as { ok: boolean; pasted: boolean; submitVerified: boolean };
  assert.equal(body.ok, false);
  // `pasted: false` is the ONLY state a caller may retry from, and an acked send makes it
  // the truthful one: the call rejected, so nothing was appended to any composer. The pane
  // path cannot promise that - its delivery is buffer, paste, Enter, and a failure lands
  // anywhere in the middle.
  assert.equal(body.pasted, false);
  assert.equal(body.submitVerified, false);
});

test("a delivered turn is verified, because the harness said so", async () => {
  const registry = new Registry();
  seed(registry, null, "sdk:ok");
  const supervisor = { async send() {} } as unknown as SdkSupervisor;
  const res = await mkApp(registry, supervisor).request("/api/sessions/sdk:ok/inject", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ text: "go", origin: "foreman" }),
  });
  const body = (await res.json()) as { ok: boolean; pasted: boolean; submitVerified: boolean };
  assert.deepEqual(body, { ...body, ok: true, pasted: true, submitVerified: true });
});

test("a handoff that stops the driver and cannot open a terminal settles its task", async () => {
  const registry = new Registry();
  seed(registry, null, "sdk:noterm");
  registry.upsertTask(
    mkTask({
      id: "task-noterm",
      status: "running",
      sessionId: "sdk:noterm",
      repoRoot: "/repo",
      worktreePath: "/wt/one",
      title: "Add a toggle",
    }),
  );
  const supervisor = fakeSupervisor();
  const settled: string[] = [];
  const res = await mkApp(registry, supervisor, {
    spawn: async () => {
      throw new Error("no terminal backend can host a dispatched agent");
    },
    waitForSessionAtCwd: async () => null,
    settleTask: (taskId) => settled.push(taskId),
  }).request("/api/sessions/sdk:noterm/handoff", { method: "POST", headers: HEADERS });

  assert.equal(res.status, 409);
  const body = (await res.json()) as { error: string };
  // The binding was cleared BEFORE the stop, deliberately, so an ordinary transfer does not
  // settle a task that is merely moving. That is exactly why this path has to settle it
  // explicitly: the eviction the stop started matches no task, `rebindTaskAtCwd` will never
  // see a terminal appear in that checkout, and the row would otherwise read `running` with
  // no agent for ever.
  assert.deepEqual(settled, ["task-noterm"]);
  assert.deepEqual(supervisor.stopped, ["sdk:noterm"]);
  // And the operator is told what they are holding: the conversation is intact on disk.
  assert.match(body.error, /worktree kept/);
  assert.match(body.error, /--resume/);
});

test("settling after a failed handoff keeps the worktree and reads a merge as done", async () => {
  // Routed through TaskManager.agentWentAway rather than writing a status here, so this case
  // inherits its rules instead of approximating them. Asserting them from the outside is
  // what stops a second settler being written the next time someone needs one.
  const registry = new Registry();
  const tasks = new RealTaskManager(registry);
  registry.upsertTask(
    mkTask({
      id: "task-settle",
      status: "running",
      sessionId: null,
      repoRoot: "/repo",
      worktreePath: "/wt/settle",
      branch: "harness/settle",
    }),
  );
  tasks.settleAfterFailedHandoff("task-settle");
  const t = registry.getTask("task-settle")!;
  assert.equal(t.status, "failed");
  // Never reclaimed here - freeing a tree is the operator's call, which is the same rule
  // `complete` states as "Mark done must not discard work".
  assert.equal(t.worktreePath, "/wt/settle");
  assert.equal(t.branch, "harness/settle");
  // And a task nothing was running is left alone rather than being moved to a terminal
  // state it never reached.
  registry.upsertTask(mkTask({ id: "task-backlog", status: "backlog", repoRoot: "/repo" }));
  tasks.settleAfterFailedHandoff("task-backlog");
  assert.equal(registry.getTask("task-backlog")?.status, "backlog");
  tasks.settleAfterFailedHandoff("no-such-task");
});

test("a stop that fails with the driver still alive puts the binding back", async () => {
  const registry = new Registry();
  seed(registry, null, "sdk:stopfail");
  registry.upsertTask(
    mkTask({
      id: "task-stopfail",
      status: "running",
      sessionId: "sdk:stopfail",
      repoRoot: "/repo",
      worktreePath: "/wt/one",
      title: "Add a toggle",
    }),
  );
  upsertSdkSession({
    id: "sdk:stopfail",
    agent: "claude",
    agentSessionId: "agent-1",
    cwd: "/wt/one",
    taskId: "task-stopfail",
    model: null,
    effort: null,
    permissionMode: null,
    status: "running",
  });
  const supervisor = {
    async stop() {
      throw new Error("the driver would not close");
    },
    // Still holding the handle: the driver survived its own stop.
    handleFor: () => ({}) as never,
    beginHandoff: () => true,
    endHandoff: () => {},
  } as unknown as SdkSupervisor;

  const res = await mkApp(registry, supervisor, {
    spawn: async () => assert.fail("nothing may be spawned when the stop failed"),
    waitForSessionAtCwd: async () => null,
    settleTask: () => assert.fail("a live driver must be rebound, never settled"),
  }).request("/api/sessions/sdk:stopfail/handoff", { method: "POST", headers: HEADERS });

  assert.equal(res.status, 409);
  // The unbinding happens BEFORE the stop, so a stop that fails has to take it back or the
  // task is stranded - and here the agent may still be working, which is worse than the
  // spawn-failure case.
  assert.equal(registry.getTask("task-stopfail")?.status, "running");
  assert.equal(registry.getTask("task-stopfail")?.sessionId, "sdk:stopfail");
  // The ROW too: `taskLiveness` reads it, so a card restored without the row would leave a
  // live agent whose worktree a restart reclaims.
  assert.equal(getSdkSession("sdk:stopfail")?.taskId, "task-stopfail");
  assert.match(((await res.json()) as { error: string }).error, /still bound to it/);
});

test("a stop that fails with the driver already gone settles instead", async () => {
  const registry = new Registry();
  seed(registry, null, "sdk:stopgone");
  registry.upsertTask(
    mkTask({
      id: "task-stopgone",
      status: "running",
      sessionId: "sdk:stopgone",
      repoRoot: "/repo",
      worktreePath: "/wt/one",
      title: "Add a toggle",
    }),
  );
  const settled: string[] = [];
  const supervisor = {
    async stop() {
      throw new Error("the driver died mid-stop");
    },
    // No handle left once the stop has run, but one BEFORE it - otherwise the preflight
    // would refuse this as a repeat rather than exercising the stop-failure path.
    handleFor: (() => {
      let calls = 0;
      return () => (calls++ === 0 ? ({} as never) : null);
    })(),
    beginHandoff: () => true,
    endHandoff: () => {},
  } as unknown as SdkSupervisor;

  const res = await mkApp(registry, supervisor, {
    spawn: async () => assert.fail("nothing may be spawned when the stop failed"),
    waitForSessionAtCwd: async () => null,
    settleTask: (id) => settled.push(id),
  }).request("/api/sessions/sdk:stopgone/handoff", { method: "POST", headers: HEADERS });

  assert.equal(res.status, 409);
  assert.deepEqual(settled, ["task-stopgone"]);
  assert.match(((await res.json()) as { error: string }).error, /worktree kept/);
});

test("a mixed answer is refused, never silently reconciled", async () => {
  const registry = new Registry();
  seed(registry, FORM);
  const supervisor = fakeSupervisor();
  const res = await mkApp(registry, supervisor).request("/api/sessions/sdk:one/submit-options", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      answers: [
        // Both a chosen row and typed text. The harness takes one string per question, so
        // sending this could only carry one of them - and whichever won, the other is a
        // thing the operator did that the agent never hears about. That is the failure the
        // structured ask replaced, so it must not come back as a silent preference.
        { question: "Which linter?", labels: ["biome"], text: "prettier, actually" },
        { question: "Which checks?", labels: ["types"] },
      ],
    }),
  });
  assert.equal(res.status, 409);
  assert.match(
    ((await res.json()) as { error: string }).error,
    /both a chosen option and custom text/,
  );
  assert.equal(supervisor.answered.length, 0);
});

test("either half on its own still answers", async () => {
  const registry = new Registry();
  seed(registry, FORM);
  const supervisor = fakeSupervisor();
  const res = await mkApp(registry, supervisor).request("/api/sessions/sdk:one/submit-options", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      answers: [
        { question: "Which linter?", labels: [], text: "prettier, actually" },
        { question: "Which checks?", labels: ["types", "tests"] },
      ],
    }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(supervisor.answered[0]!.answer, {
    kind: "form",
    answers: [
      { question: "Which linter?", labels: [], text: "prettier, actually" },
      { question: "Which checks?", labels: ["types", "tests"] },
    ],
  });
});

test("a question answered twice is refused, not last-write-wins", async () => {
  const registry = new Registry();
  seed(registry, FORM);
  const supervisor = fakeSupervisor();
  const res = await mkApp(registry, supervisor).request("/api/sessions/sdk:one/submit-options", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      answers: [
        { question: "Which linter?", labels: ["biome"] },
        // The answers map is keyed by question text, so this would overwrite the entry
        // above - and the completeness check counts DISTINCT questions, so the duplicate
        // sails through it while "Which checks?" goes unanswered and one supplied answer
        // is silently discarded before Claude ever sees the form.
        { question: "Which linter?", labels: ["eslint"] },
      ],
    }),
  });
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { error: string }).error, /answered twice/);
  assert.equal(supervisor.answered.length, 0);
});

test("two concurrent handoffs spawn ONE terminal, and the loser changes nothing", async () => {
  const registry = new Registry();
  const session = seed(registry, null, "sdk:race");
  registry.upsertTask(
    mkTask({
      id: "task-race",
      status: "running",
      sessionId: "sdk:race",
      repoRoot: "/repo",
      worktreePath: "/wt/one",
      title: "Add a toggle",
    }),
  );
  const supervisor = fakeSupervisor();
  const spawned: string[] = [];
  let release = (): void => {};
  const held = new Promise<void>((r) => (release = r));

  const app = mkApp(registry, supervisor, {
    // Hold the first request inside the spawn so the second one overlaps it - which is the
    // only window where two callers can both see a live driver.
    spawn: async (name) => {
      spawned.push(name);
      await held;
      return `${name}-abc123`;
    },
    waitForSessionAtCwd: async () => ({ ...session, id: "proc:tty:1:2" }) as Session,
    settleTask: () => assert.fail("a successful handoff settles nothing"),
  });
  const post = () =>
    app.request("/api/sessions/sdk:race/handoff", { method: "POST", headers: HEADERS });

  const first = post();
  await new Promise((r) => setImmediate(r));
  const second = await post();
  release();
  const firstRes = await first;

  // Two agents continuing ONE conversation in one checkout is the outcome this prevents,
  // and only one of them could ever hold the task binding.
  assert.equal(second.status, 409);
  assert.match(((await second.json()) as { error: string }).error, /already being handed over/);
  assert.equal(firstRes.status, 200);
  assert.deepEqual(spawned, ["Add a toggle"], "exactly one terminal was opened");
  assert.deepEqual(supervisor.stopped, ["sdk:race"], "the driver was stopped once");
});

test("a repeat handoff after a successful one is refused too", async () => {
  const registry = new Registry();
  const session = seed(registry, null, "sdk:again");
  const supervisor = fakeSupervisor();
  const spawned: string[] = [];
  const app = mkApp(registry, supervisor, {
    spawn: async (name) => {
      spawned.push(name);
      return `${name}-abc123`;
    },
    waitForSessionAtCwd: async () => ({ ...session, id: "proc:tty:1:2" }) as Session,
    settleTask: () => {},
  });

  assert.equal(
    (await app.request("/api/sessions/sdk:again/handoff", { method: "POST", headers: HEADERS }))
      .status,
    200,
  );
  // The claim is released once the transfer finishes, so it is the LIVE-DRIVER check that
  // has to refuse this one - a double click, a retry, or the card lingering out its
  // eviction would otherwise stop nothing and spawn a second `claude --resume`.
  supervisor.killDriver();
  const repeat = await app.request("/api/sessions/sdk:again/handoff", {
    method: "POST",
    headers: HEADERS,
  });
  assert.equal(repeat.status, 409);
  assert.match(((await repeat.json()) as { error: string }).error, /no live embedded driver/);
  assert.equal(spawned.length, 1);
});
