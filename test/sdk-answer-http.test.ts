import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
const { mkTask } = await import("./helpers/session-fixture.ts");
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
  return {
    answered,
    stopped,
    modes,
    handleFor() {
      return {};
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
    taskLiveness: () => null,
  } as unknown as SdkSupervisor & {
    answered: typeof answered;
    stopped: string[];
    modes: string[];
  };
}

function mkApp(
  registry: Registry_,
  supervisor: SdkSupervisor,
  handoffDeps?: Parameters<typeof buildApp>[10],
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
    // No handle left: there is nothing to rebind to, so this is the same dead end the
    // spawn-failure path reaches and it takes the same exit.
    handleFor: () => null,
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
