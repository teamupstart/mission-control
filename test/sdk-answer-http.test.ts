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
  return {
    answered,
    stopped,
    async answer(id: string, requestId: string, answer: SessionRequestAnswer) {
      answered.push({ id, requestId, answer });
      if (over.answer) await over.answer();
    },
    async stop(id: string) {
      stopped.push(id);
    },
    taskLiveness: () => null,
  } as unknown as SdkSupervisor & { answered: typeof answered; stopped: string[] };
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
