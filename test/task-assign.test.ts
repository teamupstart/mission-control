import { test, after } from "node:test";
import { mkTask as baseTask } from "./helpers/session-fixture.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "../src/shared/types.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";

// Throwaway state dir, set before anything reads config - see tasks-db.test.ts.
const home = mkdtempSync(join(tmpdir(), "mission-assign-"));
process.env.HARNESS_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");

after(() => rmSync(home, { recursive: true, force: true }));

/**
 * Assigning a backlog task to an agent that is ALREADY running - what the board's
 * drag-onto-an-idle-agent gesture calls.
 *
 * The refusals are the point. Assign is the one path that types a prompt into a
 * session the harness did not launch, very often the operator's own, so every way it
 * can pick the wrong target has to be a refusal rather than a best effort.
 */

/** The shared task fixture with this file's defaults on top. */
const mkTask = (over: Partial<Task> = {}): Task =>
  baseTask({ ...over });

function mkDiscovered(over: Partial<DiscoveredSession> = {}): DiscoveredSession {
  return {
    syntheticId: "sid",
    agent: "claude",
    name: "agent",
    nameSource: "process",
    cwd: "/repo",
    gitBranch: null,
    gitRoot: "/repo",
    repoRoot: "/repo",
    nomistakesGated: false,
    pid: 1,
    tty: "ttys1",
    wezterm: null,
    tmux: null,
    startedAt: 0,
    ...over,
  };
}

/**
 * A registry holding one IDLE agent in /repo, plus a TaskManager over it.
 *
 * Discovery alone leaves a session `working` (a bare `ps` sweep can't know better), so
 * the agent is driven idle through the same hook a real one fires when it finishes a
 * turn. Without this every case below would stop at the busy check and pass without
 * ever reaching the rule it means to test.
 */
function setup(session: Partial<DiscoveredSession> = {}) {
  const r = new Registry();
  const disc = mkDiscovered(session);
  r.applyDiscovery([disc]);
  r.applyHook({
    event: "Stop",
    sessionId: "agent-1",
    cwd: disc.cwd,
    transcriptPath: null,
    env: {},
  });
  const live = r.snapshot().sessions[0]!;
  assert.equal(live.state, "idle", "fixture must actually be idle");
  return { r, tasks: new TaskManager(r), sessionId: live.id };
}

test("a task that isn't in the backlog is refused", async () => {
  const { r, tasks, sessionId } = setup();
  r.upsertTask(mkTask({ status: "running" }));
  const res = await tasks.assign("t1", sessionId);
  assert.equal(res.ok, false);
  assert.match(res.error!, /not in the backlog/);
});

test("an unknown task or session is refused rather than half-applied", async () => {
  const { r, tasks, sessionId } = setup();
  r.upsertTask(mkTask());
  assert.equal((await tasks.assign("nope", sessionId)).ok, false);
  const res = await tasks.assign("t1", "no-such-session");
  assert.equal(res.ok, false);
  assert.match(res.error!, /no such session/);
  // Neither attempt may have moved the task out of the backlog.
  assert.equal(r.getTask("t1")?.status, "backlog");
});

test("a busy agent is refused - the prompt would land mid-turn", async () => {
  const { r, tasks } = setup();
  r.upsertTask(mkTask());
  // Back to working: the agent picked something up between the hover and the drop,
  // which is exactly the race the server-side re-check exists for.
  r.applyHook({
    event: "UserPromptSubmit",
    sessionId: "agent-1",
    cwd: "/repo",
    transcriptPath: null,
    env: {},
    prompt: "something else",
  });
  const live = r.snapshot().sessions[0]!;
  assert.equal(live.state, "working");
  const res = await tasks.assign("t1", live.id);
  assert.equal(res.ok, false);
  assert.match(res.error!, /drop onto an idle one/);
  assert.equal(r.getTask("t1")?.status, "backlog");
});

test("an agent in a different repo is refused - the one unrecoverable mistake", async () => {
  // Typing a task's intent at an agent sitting in someone else's checkout is not
  // something the operator can undo from the dashboard, so it is never best-efforted.
  const { r, tasks, sessionId } = setup({ repoRoot: "/other", gitRoot: "/other", cwd: "/other" });
  r.upsertTask(mkTask({ repoRoot: "/repo" }));
  const res = await tasks.assign("t1", sessionId);
  assert.equal(res.ok, false);
  assert.match(res.error!, /different repo/);
  assert.equal(r.getTask("t1")?.status, "backlog");
});

test("an agent with no repo at all is refused", async () => {
  const { r, tasks, sessionId } = setup({ repoRoot: null, gitRoot: null, cwd: "/tmp" });
  r.upsertTask(mkTask());
  assert.equal((await tasks.assign("t1", sessionId)).ok, false);
  assert.equal(r.getTask("t1")?.status, "backlog");
});

test("a pane that refuses the prompt leaves the task in the backlog, droppable again", async () => {
  // The fixture session has neither a tmux nor a wezterm handle, so `injectPrompt`
  // refuses before writing anything. That is the case that must not leave a task
  // marked `running` with nothing running it - the operator would see it vanish from
  // the backlog and never start.
  const { r, tasks, sessionId } = setup();
  r.upsertTask(mkTask());
  const res = await tasks.assign("t1", sessionId);
  assert.equal(res.ok, false);
  const after = r.getTask("t1")!;
  assert.equal(after.status, "backlog");
  assert.equal(after.sessionId, null);
  assert.equal(after.dispatchedAt, null);
});

test("an assigned task never claims a worktree - cancel must not remove one", () => {
  // The invariant behind the whole feature: an assigned task borrows an agent that
  // already had a checkout, so it owns no worktree. If `worktreePath` were ever set
  // to the agent's own cwd, cancelling the task would run
  // `git worktree remove --force` over a directory the harness did not create - very
  // possibly the operator's real working copy.
  const r = new Registry();
  r.upsertTask(mkTask({ status: "running", sessionId: "sid", dispatchedAt: 2000 }));
  const t = r.getTask("t1")!;
  assert.equal(t.worktreePath, null);
  assert.equal(t.provider, null);
  // And no tmux session of ours, which is what stops `cancel` killing the agent.
  assert.equal(t.tmuxSession, null);
});

test("a task assigned to a session decorates that session's card, with no worktree to match on", () => {
  // Dispatched tasks correlate to their agent by worktree path. An assigned one has
  // none, so it must correlate by session id instead - otherwise the board would
  // show an agent working with no sign of what it was given.
  const r = new Registry();
  r.applyDiscovery([mkDiscovered()]);
  const id = r.snapshot().sessions[0]!.id;
  r.upsertTask(mkTask({ status: "running", sessionId: id, title: "Wire it up" }));
  const s = r.snapshot().sessions.find((x) => x.id === id);
  assert.equal(s?.task?.id, "t1");
  assert.equal(s?.task?.title, "Wire it up");
});
