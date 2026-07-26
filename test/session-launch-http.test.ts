import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/server/routes.ts";
import type { Registry } from "../src/server/registry.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { TaskManager } from "../src/server/tasks.ts";
import type { QueueManager } from "../src/server/queue.ts";
import { mkSession, mkMuxHandle, mkTask } from "./helpers/session-fixture.ts";

// What is at stake: this route spawns a process on the daemon's host, so the entire
// question is what a request is allowed to influence. The answer has to be "which of two
// argvs, and which registered backend" and nothing else - both fields are closed enums and
// the daemon composes the command line itself. A free-text command here, or a shell read
// out of the checkout, would be remote code execution behind a button labelled "Terminal".
//
// The second thing pinned here is the agent payload's refusal. `agentLaunchAction` decides
// whether a session is focused or handed off, the browser reads it to shape the button, and
// this route reads it to refuse a request that disagrees. If the daemon simply did what it
// was told, a stale tab - or anyone with curl - could put a second agent process on one
// conversation file, which the harnesses do not arbitrate.
//
// The SUCCESS path is deliberately not driven through HTTP: it would open a real terminal
// window on whoever is running the tests. `terminal-target-contract.test.ts` drives the
// same call with injected deps and asserts the exact argv instead.

const PANED = mkSession({ id: "paned" });
const EMBEDDED = mkSession({
  id: "embedded",
  runtime: "sdk",
  terminals: [],
  agentSessionId: "agent-7",
  cwd: "/wt/embedded",
});
const NO_ID = mkSession({ id: "noid", runtime: "sdk", terminals: [], agentSessionId: null });
const NO_CWD = mkSession({ id: "nocwd", runtime: "sdk", terminals: [], cwd: null });
const EXITED = mkSession({ id: "exited", state: "exited" });
const EXITED_UNCERTAIN = mkSession({
  id: "exited-uncertain",
  name: "Uncertain resume",
  state: "exited",
});

const SESSIONS = new Map([
  [PANED.id, PANED],
  [EMBEDDED.id, EMBEDDED],
  [NO_ID.id, NO_ID],
  [NO_CWD.id, NO_CWD],
  [EXITED.id, EXITED],
  [EXITED_UNCERTAIN.id, EXITED_UNCERTAIN],
]);
const UNCERTAIN_TASK = mkTask({
  id: "task-uncertain",
  status: "running",
  sessionId: EXITED_UNCERTAIN.id,
});
const TASKS = new Map([[UNCERTAIN_TASK.id, UNCERTAIN_TASK]]);

const registry = {
  getSession: (id: string) => SESSIONS.get(id),
  listTasks: () => [...TASKS.values()],
  getTask: (id: string) => TASKS.get(id),
  upsertTask: (task: typeof UNCERTAIN_TASK) => TASKS.set(task.id, task),
} as unknown as Registry;

const launched: Array<{ backend: string; argv: readonly string[] }> = [];
const app = buildApp(
  registry,
  {} as unknown as ReviewManager,
  {
    settleAfterFailedHandoff: () => assert.fail("an uncertain launch may have succeeded"),
  } as unknown as TaskManager,
  {} as unknown as QueueManager,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  async (backend, spec) => {
    launched.push({ backend, argv: spec.argv });
    if (spec.name === EXITED_UNCERTAIN.name) {
      return {
        ok: false,
        label: backend,
        homeName: "Uncertain resume-abc123",
        error: `${backend} did not report back - the window may still be opening`,
        status: 504,
      };
    }
    return { ok: true, label: backend, homeName: "resumed", status: 200 };
  },
);

const HEADERS = { host: "127.0.0.1:7317", "content-type": "application/json" };

async function launch(id: string, body: unknown): Promise<Response> {
  return app.request(`/api/sessions/${id}/launch`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
}

test("the backend is a registered id, never a command", async () => {
  // The closed enum is the whole containment story for this field. Anything that resolves
  // to a path, or to nothing, has to be rejected by the schema before a spawn is reached.
  for (const backend of ["", "xterm", "/bin/sh", "tmux; rm -rf /", null, undefined, 7]) {
    const res = await launch("embedded", { backend, payload: "shell" });
    assert.equal(res.status, 400, `${JSON.stringify(backend)} must not be accepted`);
  }
});

test("the payload is one of two words, so a request never names a command", async () => {
  // The operator picks between two daemon-owned actions; they never supply an argv. A
  // payload the enum does not know is the shape a command-injection attempt would take.
  for (const payload of ["", "bash", "shell; id", null, { cmd: "sh" }]) {
    const res = await launch("embedded", { backend: "tmux", payload });
    assert.equal(res.status, 400, `${JSON.stringify(payload)} must not be accepted`);
  }
});

test("an unknown session is a 404, before the body is even considered", async () => {
  const res = await launch("ghost", { backend: "tmux", payload: "shell" });
  assert.equal(res.status, 404);
});

test("a session with no checkout is refused, and says so", async () => {
  // `Session.cwd` is genuinely nullable - discovery could not read the process cwd and no
  // pane reported a path. There is nowhere to open a terminal, and the sentence has to say
  // that rather than leaving the operator with a dead button.
  const res = await launch("nocwd", { backend: "tmux", payload: "shell" });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.match(body.error, /checkout/);
});

test("resuming a session that already has a pane is refused, and names focus instead", async () => {
  // THE one this route exists to enforce. Spawning `--resume` beside a live pane puts a
  // second process on one conversation file. The refusal names the action that does work,
  // rather than doing something the operator did not ask for.
  const res = await launch("paned", { backend: "tmux", payload: "agent" });
  assert.equal(res.status, 409);
  const body = (await res.json()) as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.match(body.error, /focus/);
});

test("an embedded session awaiting its conversation id cannot be handed off", async () => {
  // Nothing to resume FROM. Launching anyway would start a fresh agent wearing this
  // session's card, which is worse than refusing.
  const res = await launch("noid", { backend: "tmux", payload: "agent" });
  assert.equal(res.status, 409);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /conversation id/);
});

test("an exited session resumes through the selected backend despite stale pane handles", async () => {
  launched.length = 0;
  const res = await launch("exited", { backend: "tmux", payload: "agent" });
  assert.equal(res.status, 200);
  assert.equal(launched.length, 1);
  assert.equal(launched[0]?.backend, "tmux");
  assert.match(launched[0]?.argv.join(" ") ?? "", /--resume/);

  const repeated = await launch("exited", { backend: "ghostty", payload: "agent" });
  assert.equal(repeated.status, 409);
  assert.match(((await repeated.json()) as { error: string }).error, /already being resumed/);
  assert.equal(launched.length, 1, "a lingering card must not reopen one conversation twice");
});

test("an uncertain exited-session resume keeps the terminal resource name", async () => {
  const res = await launch("exited-uncertain", { backend: "tmux", payload: "agent" });

  assert.equal(res.status, 504);
  assert.equal(TASKS.get(UNCERTAIN_TASK.id)?.sessionId, null);
  assert.equal(TASKS.get(UNCERTAIN_TASK.id)?.homeName, "Uncertain resume-abc123");
});

// The shell arm's asymmetry - a shell is not the agent's conversation, so having a pane
// says nothing about whether you may open one - is asserted in
// `session-launch-predicate.test.ts`, against the predicate this route consults.
//
// It is NOT asserted here, and that is a scar rather than an oversight. Driving
// `{ payload: "shell" }` through this route with a valid session reaches the real
// `launchTerminal`, and on a developer machine with tmux installed it does exactly what it
// is supposed to: it created a live tmux session named after the fixture and raised a
// terminal window, during `npm test`. Every refusal this file pins is reachable without
// spawning anything, so nothing here may take a request past the last refusal.

test("a paned session with a second handle is still one session to focus", async () => {
  // A session can hold a multiplexer handle AND an emulator handle. Both mean "there is a
  // pane", so the verdict must not depend on which one discovery reported first.
  const both = mkSession({ id: "both", terminals: [mkMuxHandle({ session: "s", paneId: "%9" })] });
  SESSIONS.set(both.id, both);
  const res = await launch("both", { backend: "tmux", payload: "agent" });
  assert.equal(res.status, 409);
  SESSIONS.delete(both.id);
});

test("the terminal catalog answers without spawning anything", async () => {
  // A GET, and it must be safe to call on every conversation pane mount - the browser does
  // exactly that. It reports rows whatever this machine has installed, including
  // unavailable ones, because an empty list cannot distinguish "none" from "did not look".
  const res = await app.request("/api/terminal-targets", { headers: { host: "127.0.0.1:7317" } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { targets: { id: string; unavailable: string | null }[] };
  assert.ok(Array.isArray(body.targets));
  assert.ok(body.targets.length > 0, "every registered backend gets a row");
  for (const target of body.targets) {
    // A sentence or null, never a boolean: the two failures it distinguishes have
    // different fixes.
    assert.ok(target.unavailable === null || target.unavailable.length > 0);
  }
});
