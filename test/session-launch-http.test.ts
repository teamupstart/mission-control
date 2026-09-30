import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { dirname } from "node:path";
import { transferFixture } from "./helpers/session-transfer-fixture.ts";
import { getSessionTransfer } from "../src/server/session-transfers/store.ts";
import { buildApp } from "../src/server/routes.ts";
import { Registry } from "../src/server/registry.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { TaskManager } from "../src/server/tasks.ts";
import type { QueueManager } from "../src/server/queue.ts";
import { mkSession, mkMuxHandle, mkEmuHandle, mkTask } from "./helpers/session-fixture.ts";
import { launchedArgv } from "./helpers/isolated-launch.ts";
import { MULTIPLEXER_IDS } from "../src/shared/terminal.ts";
import { STATE_DIR } from "../src/server/config.ts";
import { managedResumeFixture } from "./helpers/managed-resume-fixture.ts";
import { TerminalLaunchError } from "../src/server/terminal/launch-error.ts";
await managedResumeFixture(STATE_DIR);

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
// With a measured mode, so the resume assert below can pin that the stored mode rides the
// argv - a session that was running in acceptEdits must not reopen in manual.
const EXITED = mkSession({ id: "exited", state: "exited", permissionMode: "acceptEdits" });
const EXITED_UNCERTAIN = mkSession({
  id: "exited-uncertain",
  name: "Uncertain resume",
  state: "exited",
});
const EXITED_READ_ONLY = mkSession({
  id: "exited-read-only",
  state: "exited",
  workspaceRoot: null,
  workspace: {
    authority: "provider",
    kind: "authoring",
    availability: "missing",
    reportedPath: "/repo/.worktrees/conflicted",
    branch: "plan/conflicted",
    commit: "1".repeat(40),
    commitProvenance: "live_validation",
    commitFrozenAt: 1,
    planSlug: "conflicted",
    attempt: 1,
    providerRevision: 2,
    reason: "identity_conflict",
    capabilities: {
      diff: true,
      files: true,
      write: false,
      comment: false,
      shell: false,
      externalOpen: false,
      manualWorkflow: false,
    },
  },
});

const SESSIONS = new Map([
  [PANED.id, PANED],
  [EMBEDDED.id, EMBEDDED],
  [NO_ID.id, NO_ID],
  [NO_CWD.id, NO_CWD],
  [EXITED.id, EXITED],
  [EXITED_UNCERTAIN.id, EXITED_UNCERTAIN],
  [EXITED_READ_ONLY.id, EXITED_READ_ONLY],
]);
const UNCERTAIN_TASK = mkTask({
  id: "task-uncertain",
  status: "running",
  sessionId: EXITED_UNCERTAIN.id,
});
const TASKS = new Map<string, typeof UNCERTAIN_TASK>();
const adoptedSession: ReturnType<typeof mkSession> | null = null;

// A real subscriber list, not a no-op: the resume claim is released on `session_remove`,
// and a stub that swallowed the subscription would let that release rot untested.
const subscribers: Array<(e: { type: string; id: string }) => void> = [];
const emitSessionRemove = (id: string): void => {
  for (const fn of subscribers) fn({ type: "session_remove", id });
};

const registry = Object.assign(new Registry(), {
  getSession: (id: string) => SESSIONS.get(id),
  listTasks: () => [...TASKS.values()],
  getTask: (id: string) => TASKS.get(id),
  resolveSessionWorkspace: async (id: string) => {
    const session = SESSIONS.get(id);
    return session?.workspace?.authority === "provider"
      ? { root: null, view: session.workspace, repoRoot: "/repo" }
      : { root: session?.cwd ?? null, view: session?.workspace ?? null, repoRoot: "/repo" };
  },
  upsertTask: (task: typeof UNCERTAIN_TASK) => TASKS.set(task.id, task),
  waitForSessionAtCwd: async () => adoptedSession,
  bindTaskToWorkEpisode: () => {},
  subscribe: (fn: (e: { type: string; id: string }) => void) => {
    subscribers.push(fn);
    return () => {};
  },
}) as unknown as Registry;

const launched: Array<{ backend: string; argv: readonly string[] }> = [];
const app = buildApp({
  registry,
  reviews: {} as unknown as ReviewManager,
  tasks: {
    settleAfterFailedHandoff: () => assert.fail("an uncertain launch may have succeeded"),
  } as unknown as TaskManager,
  queues: {} as unknown as QueueManager,
  launchSessionTerminal: async (backend, spec) => {
    launched.push({ backend, argv: spec.argv });
    if (spec.name === "refused-resume") throw new TerminalLaunchError("Ghostty refused the launch", false);
    if (spec.name === "verified-resume") {
      return { ok: true, label: backend, homeName: null,
        terminalResourceId: "emulator:ghostty:resumed-uuid", status: 200 };
    }
    if (spec.name === EXITED_UNCERTAIN.name) {
      return {
        ok: false,
        label: backend,
        homeName: "Uncertain resume-abc123",
        error: `${backend} did not report back - the window may still be opening`,
        status: 504,
      };
    }
    // Mirrors the REAL launcher's per-axis contract: only a multiplexer produces a
    // durable, enumerable home. An emulator tab has none, and a fake that invented one
    // here would hide the very bug this seam exists to catch.
    const durable = MULTIPLEXER_IDS.includes(backend as (typeof MULTIPLEXER_IDS)[number]);
    return { ok: true, label: backend, homeName: durable ? "resumed" : null, status: 200 };
  },
});

const HEADERS = { host: "127.0.0.1:7317", "content-type": "application/json" };

async function launch(id: string, body: unknown): Promise<Response> {
  const previous = process.env.MISSION_CLAUDE_BIN;
  process.env.MISSION_CLAUDE_BIN = process.execPath;
  try {
    return await app.request(`/api/sessions/${id}/launch`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify(body),
    });
  } finally {
    if (previous === undefined) delete process.env.MISSION_CLAUDE_BIN;
    else process.env.MISSION_CLAUDE_BIN = previous;
  }
}

test("a definite resume refusal preserves the backend cause and attempt identity", async () => {
  const refused = mkSession({ id: "refused-resume", name: "refused-resume", state: "exited", agentSessionId: "refused-native" });
  SESSIONS.set(refused.id, refused);
  try {
    const response = await launch(refused.id, { backend: "ghostty", payload: "agent" });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.error, "Ghostty refused the launch. No terminal was started; recheck launch status before trying again.");
    assert.equal(body.launchOutcome, "refused");
    assert.equal(typeof body.resumeLeaseId, "string");
    const recheck = await app.request(`/api/sessions/${refused.id}/launch`, { headers: HEADERS });
    assert.ok((await recheck.json()).attempts.some((attempt: { id: string; state: string }) =>
      attempt.id === body.resumeLeaseId && attempt.state === "revoked"));
    const retry = await launch(refused.id, { backend: "ghostty", payload: "agent" });
    assert.equal(retry.status, 409);
    assert.notEqual((await retry.json()).resumeLeaseId, body.resumeLeaseId, "a definite refusal releases the resume claim");
  } finally { SESSIONS.delete(refused.id); }
});

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
  // What a backend receives is `/bin/sh <wrapper>`; the agent's command line is the wrapper's
  // last statement, which is where these facts now live. See `launchedCommand`.
  const argv = launchedArgv(launched[0]?.argv ?? []);
  assert.equal(
    argv[0],
    process.execPath,
    "the terminal receives the daemon-resolved executable, not a PATH-dependent command",
  );
  // The stored mode rides along - the reopened CLI does not restore it from the
  // conversation, so a bare `--resume` would land the operator back in manual.
  assert.match(argv.join(" "), /--resume agent-1 --permission-mode acceptEdits/);

  const repeated = await launch("exited", { backend: "ghostty", payload: "agent" });
  assert.equal(repeated.status, 409);
  assert.match(((await repeated.json()) as { error: string }).error, /already being resumed/);
  assert.equal(launched.length, 1, "a lingering card must not reopen one conversation twice");
});

test("read-only Pipeline evidence cannot launch either an agent or a shell", async () => {
  launched.length = 0;
  const agent = await launch(EXITED_READ_ONLY.id, { backend: "tmux", payload: "agent" });
  assert.equal(agent.status, 409);
  assert.match(((await agent.json()) as { error: string }).error, /read-only/);

  const shell = await launch(EXITED_READ_ONLY.id, { backend: "tmux", payload: "shell" });
  assert.equal(shell.status, 400);
  assert.match(((await shell.json()) as { error: string }).error, /read-only/);
  assert.equal(launched.length, 0);
});

async function exitedTransfer(t: TestContext, result: { ok: boolean; label: string; homeName: string | null; status: number; error?: string; terminalResourceId?: string }, discover = false) {
  const f = transferFixture(t);
  await f.supervisor.stop(f.source.id);
  let argv: readonly string[] = [];
  const local = buildApp({ registry: f.registry, tasks: f.tasks, workflows: f.workflows, sessionTransfers: f.transfers,
    reviews: {} as ReviewManager, queues: {} as QueueManager,
    handoffDeps: { ...f.deps, waitForSessionAtCwd: async () => discover ? f.discover({ terminals: [mkEmuHandle({ backend: "ghostty", paneId: "resumed-uuid" })] }) : null },
    launchSessionTerminal: async (_backend, spec) => { argv = spec.argv; return result; },
  });
  const prior = process.env.MISSION_CLAUDE_BIN;
  process.env.MISSION_CLAUDE_BIN = process.execPath;
  try {
    const response = await local.request(`/api/sessions/${encodeURIComponent(f.source.id)}/launch`, {
      method: "POST", headers: HEADERS, body: JSON.stringify({ backend: "ghostty", payload: "agent" }),
    });
    return { f, response, argv, app: local };
  } finally {
    if (prior === undefined) delete process.env.MISSION_CLAUDE_BIN;
    else process.env.MISSION_CLAUDE_BIN = prior;
  }
}

test("an uncertain exited-session resume keeps its resource and a durable reservation", async (t) => {
  const { f, response, argv, app } = await exitedTransfer(t, { ok: false, label: "Ghostty", homeName: "Uncertain resume-abc123", status: 504, error: "Window may still open" });
  assert.equal(response.status, 200, "accepted observation is pending, not a failed task");
  assert.ok(launchedArgv(argv).includes("--mcp-config"));
  assert.equal(f.registry.getTask(f.task!.id)?.sessionId, null);
  assert.equal(f.registry.getTask(f.task!.id)?.homeName, "Uncertain resume-abc123");
  const body = await response.json();
  assert.equal(body.transfer.state, "awaiting_successor");
  assert.equal(getSessionTransfer(body.transfer.id)?.facts.launchOutcome, "unknown");
  const repeat = await app.request(`/api/sessions/${encodeURIComponent(f.source.id)}/launch`, {
    method: "POST", headers: HEADERS, body: JSON.stringify({ backend: "ghostty", payload: "agent" }),
  });
  assert.equal(repeat.status, 409, "an exited card with an unbound reserved task cannot bypass the coordinator");
  assert.equal((await repeat.json()).transfer.id, body.transfer.id);
});

test("launch recheck survives source removal, starts nothing, and reclaims only expired unclaimed attempts", async () => {
  const source = mkSession({ id: "recheck-gone", agentSessionId: "recheck-native", name: EXITED_UNCERTAIN.name, state: "exited" });
  SESSIONS.set(source.id, source);
  const before = launched.length;
  assert.equal((await launch(source.id, { backend: "ghostty", payload: "agent" })).status, 504);
  SESSIONS.delete(source.id);
  emitSessionRemove(source.id);
  const response = await app.request(`/api/sessions/${source.id}/launch`, { headers: HEADERS });
  assert.equal(response.status, 200);
  const body = await response.json() as { attempts: Array<{ state: string; deadline: number }> };
  assert.equal(body.attempts[0]?.state, "pending");
  const { recheckManagedResumes, managedResumeRoot } = await import("../src/server/harness/resume.ts");
  const { reconcileResumeLeases } = await import("../src/server/terminal/resume-lease.ts");
  reconcileResumeLeases(managedResumeRoot(), body.attempts[0]!.deadline + 1);
  assert.equal(recheckManagedResumes().find((s) => s.lease.sourceSessionId === source.id)?.state, "revoked");
  assert.equal(launched.length, before + 1);
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

// ---- Inspector follow-ups on PR #269 ----

test("the Terminal button opens a LOGIN shell, because that is what it promises", async () => {
  // The README calls this a login shell, and the difference is one an operator feels
  // immediately rather than a technicality: without `-l`, bash and zsh skip their login
  // startup files, so PATH, version-manager shims and prompt all differ from the terminal
  // that person opens by hand - in a window whose whole purpose is running the same
  // commands they would run there.
  launched.length = 0;
  const res = await launch("paned", { backend: "tmux", payload: "shell" });
  assert.equal(res.status, 200);
  assert.equal(launched.length, 1);
  const argv = launched[0]?.argv ?? [];
  assert.equal(argv.length, 2, `expected <shell> -l, got ${JSON.stringify(argv)}`);
  assert.equal(argv[1], "-l");
  // The shell itself comes from the DAEMON's environment, never from the checkout.
  assert.equal(argv[0], process.env.SHELL || "/bin/sh");
});

test("a resume claim is released when the session is actually removed", () => {
  // The claim has to outlive the launch - it guards the window in which a double-click
  // could start a second agent on one conversation - but it must not outlive the SESSION,
  // or a long-lived daemon accumulates an id per resume forever.
  //
  // Released on the EVENT rather than on the session's absence, and the difference is not
  // academic: a session id is derived from the tty, so a new agent on the same tty brings
  // the same id back. A claim dropped only when the registry stops holding the id would be
  // inherited by that new session and refuse its first resume for good.
  return (async () => {
    const gone = mkSession({ id: "claim-gone", state: "exited" });
    SESSIONS.set(gone.id, gone);
    launched.length = 0;

    assert.equal((await launch(gone.id, { backend: "tmux", payload: "agent" })).status, 200);
    // Still lingering, so the claim stands and a second press is refused.
    assert.equal((await launch(gone.id, { backend: "tmux", payload: "agent" })).status, 409);
    assert.equal(launched.length, 1, "the claim must hold while the old card lingers");

    // Eviction. The registry drops the session and emits this; the claim goes with it.
    emitSessionRemove(gone.id);

    // The same id, back on the same tty as a new session - the case an absence-based
    // prune gets wrong.
    SESSIONS.set(gone.id, mkSession({ id: gone.id, state: "exited", agentSessionId: "new-conversation" }));
    assert.equal(
      (await launch(gone.id, { backend: "tmux", payload: "agent" })).status,
      200,
      "a released claim must not refuse the next session to hold this id",
    );
    assert.equal(launched.length, 2);
    SESSIONS.delete(gone.id);
  })();
});

test("resuming through an emulator replaces the dead home and retains an unknown resource", async (t) => {
  const { f, response } = await exitedTransfer(t, { ok: true, label: "Ghostty", homeName: null, status: 200 });
  assert.equal(response.status, 200);
  const task = f.registry.getTask(f.task!.id)!;
  assert.equal(task.homeName, f.task!.title);
  assert.equal(task.terminalResourceId, null);
  assert.equal(task.sessionId, null);
  assert.equal(task.status, "running");
});

test("resume retains the spawned UUID and binds only a positively discovered recipient", async (t) => {
  for (const matches of [true, false]) {
    const { f, response, argv } = await exitedTransfer(t, { ok: true, label: "Ghostty", homeName: null,
      terminalResourceId: "emulator:ghostty:resumed-uuid", status: 200 }, matches);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(getSessionTransfer(body.transfer.id)?.facts.home?.launchStateHome, dirname(argv[1]!));
    const task = f.registry.getTask(f.task!.id)!;
    assert.equal(task.terminalResourceId, "emulator:ghostty:resumed-uuid");
    assert.equal(task.sessionId, matches ? f.candidate.syntheticId : null);
    assert.deepEqual(task.terminalLaunch, matches ? { resourceId: task.terminalResourceId, sessionId: f.candidate.syntheticId } : null);
  }
});
