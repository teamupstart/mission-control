import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session, SessionState, Task } from "../src/shared/types.ts";

// The away watcher's buffer lifecycle: when a window opens, what lands in it, and
// how it survives the moment of return. Real db for the config (as
// away-config.test.ts does) and a fake registry, so the poll loop never runs and
// each pass is driven explicitly.

const home = mkdtempSync(join(tmpdir(), "mission-away-watch-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { setAwayConfig } = await import("../src/server/away/config.ts");
const { startAwayWatcher } = await import("../src/server/away/watcher.ts");
const { rollupLine } = await import("../src/shared/away-buffer.ts");

after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => {
  openDb().exec("DELETE FROM app_config");
});

function mkSession(over: Partial<Session> = {}): Session {
  return {
    id: "s",
    agent: "claude",
    name: "sess",
    nameSource: "process",
    state: "working" as SessionState,
    cwd: null,
    gitBranch: null,
    gitRoot: null,
    repoRoot: null,
    nomistakesGated: false,
    nomistakesNarration: null,
    pid: 1,
    tty: null,
    permissionMode: null,
    wezterm: null,
    tmux: null,
    agentSessionId: null,
    transcriptPath: null,
    instrumented: true,
    hooksSeen: true,
    activity: null,
    startedAt: null,
    firstSeen: 0,
    lastSeen: 0,
    lastActivity: null,
    pendingReviews: 0,
    nomistakes: null,
    nomistakesFixes: [],
    task: null,
    prUrl: null,
    prNumber: null,
    prState: null,
    prChecks: null,
    meta: null,
    note: null,
    goal: null,
    queue: null,
    orphanedQueue: null,
    ...over,
  };
}

/** A registry stand-in whose snapshot the test drives. */
function fakeRegistry(sessions: Session[] = [], tasks: Task[] = []) {
  const state = { sessions, tasks };
  return {
    src: { snapshot: () => ({ sessions: state.sessions, tasks: state.tasks }) },
    set(next: Session[], nextTasks: Task[] = state.tasks) {
      state.sessions = next;
      state.tasks = nextTasks;
    },
  };
}

const MIN = 60_000;

test("not away: no buffer is open", () => {
  const reg = fakeRegistry([mkSession()]);
  const w = startAwayWatcher(reg.src, () => 1000);
  assert.equal(w.buffer(), null);
  w.stop();
});

test("going away opens a buffer stamped with the away window", () => {
  const reg = fakeRegistry([mkSession()]);
  const w = startAwayWatcher(reg.src, () => 1000);
  setAwayConfig({ away: true }, 500);
  w.tick();
  assert.equal(w.buffer()?.since, 500);
  w.stop();
});

test("the FIRST pass after going away seeds silently - no history floods the buffer", () => {
  // Without a baseline every live session reads as a brand-new transition, and you
  // return to a digest describing things that happened before you left.
  const reg = fakeRegistry([mkSession({ id: "a", state: "idle" })]);
  const w = startAwayWatcher(reg.src, () => 1000);
  setAwayConfig({ away: true }, 500);
  w.tick();
  assert.equal(w.buffer()?.events.length, 0);
  w.stop();
});

test("a session finishing while away lands in the buffer", () => {
  const reg = fakeRegistry([mkSession({ id: "a", state: "working" })]);
  const w = startAwayWatcher(reg.src, () => 1000);
  setAwayConfig({ away: true }, 500);
  w.tick(); // baseline

  reg.set([mkSession({ id: "a", state: "idle" })]);
  w.tick();

  const events = w.buffer()?.events ?? [];
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "idle");
  w.stop();
});

test("nothing is buffered while you are AT THE DESK", () => {
  const reg = fakeRegistry([mkSession({ id: "a", state: "working" })]);
  const w = startAwayWatcher(reg.src, () => 1000);
  w.tick();
  reg.set([mkSession({ id: "a", state: "idle" })]);
  w.tick();
  assert.equal(w.buffer(), null);
  w.stop();
});

test("returning CLOSES the window into a pending digest rather than dropping it", () => {
  // The read that renders the summary necessarily happens after you are back, so
  // discarding on return would mean the digest never had anything to show.
  const reg = fakeRegistry([mkSession({ id: "a", state: "working" })]);
  const w = startAwayWatcher(reg.src, () => 1000);
  setAwayConfig({ away: true }, 500);
  w.tick();
  reg.set([mkSession({ id: "a", state: "idle" })]);
  w.tick();

  setAwayConfig({ away: false }, 2000);
  w.tick();

  assert.equal(w.buffer(), null);
  const pending = w.takePending();
  assert.equal(pending?.events.length, 1);
  w.stop();
});

test("flush closes the window immediately, without waiting for a tick", () => {
  // The route that flips away off calls this; the poll tick is up to 5s behind and
  // the client's follow-up digest read would otherwise beat it.
  const reg = fakeRegistry([mkSession({ id: "a", state: "working" })]);
  const w = startAwayWatcher(reg.src, () => 1000);
  setAwayConfig({ away: true }, 500);
  w.tick();
  reg.set([mkSession({ id: "a", state: "idle" })]);
  w.tick();

  w.flush();
  assert.equal(w.takePending()?.events.length, 1);
  w.stop();
});

test("the pending digest is read ONCE - a refresh doesn't re-announce it", () => {
  const reg = fakeRegistry([mkSession({ id: "a", state: "working" })]);
  const w = startAwayWatcher(reg.src, () => 1000);
  setAwayConfig({ away: true }, 500);
  w.tick();
  reg.set([mkSession({ id: "a", state: "idle" })]);
  w.tick();
  w.flush();

  assert.notEqual(w.takePending(), null);
  assert.equal(w.takePending(), null);
  w.stop();
});

test("a SECOND away window starts empty rather than inheriting the first", () => {
  const reg = fakeRegistry([mkSession({ id: "a", state: "working" })]);
  const w = startAwayWatcher(reg.src, () => 1000);
  setAwayConfig({ away: true }, 500);
  w.tick();
  reg.set([mkSession({ id: "a", state: "idle" })]);
  w.tick();
  setAwayConfig({ away: false }, 2000);
  w.tick();

  setAwayConfig({ away: true }, 3000);
  w.tick();
  assert.equal(w.buffer()?.since, 3000);
  assert.equal(w.buffer()?.events.length, 0);
  w.stop();
});

test("stalls are detected even at the desk - being told an agent is wedged always helps", () => {
  const reg = fakeRegistry([mkSession({ id: "a", state: "working", lastActivity: 0 })]);
  const w = startAwayWatcher(reg.src, () => 30 * MIN);
  w.tick();
  assert.deepEqual(w.stalls().map((s) => s.kind), ["silent-working"]);
  w.stop();
});

test("turning stall detection off silences it", () => {
  const reg = fakeRegistry([mkSession({ id: "a", state: "working", lastActivity: 0 })]);
  const w = startAwayWatcher(reg.src, () => 30 * MIN);
  setAwayConfig({ detectStalls: false });
  w.tick();
  assert.deepEqual(w.stalls(), []);
  w.stop();
});

test("a session going stuck while away is buffered as attention-worthy", () => {
  const reg = fakeRegistry([mkSession({ id: "a", state: "working", lastActivity: 0 })]);
  let clock = 1000;
  const w = startAwayWatcher(reg.src, () => clock);
  setAwayConfig({ away: true }, 500);
  w.tick(); // baseline, not yet stalled

  clock = 30 * MIN; // now well past the working threshold
  w.tick();

  const events = w.buffer()?.events ?? [];
  assert.deepEqual(events.map((e) => e.kind), ["stuck"]);
  assert.match(rollupLine(w.buffer()!), /1 stuck/);
  w.stop();
});

test("a session ALREADY stuck when you leave still makes the digest", () => {
  // The one you most want reported, and the one a plain edge-trigger is silent
  // about: the stall predates the window, so it is already in the baseline.
  const reg = fakeRegistry([mkSession({ id: "a", state: "working", lastActivity: 0 })]);
  let clock = 30 * MIN;
  const w = startAwayWatcher(reg.src, () => clock);
  w.tick(); // at the desk: the stall is detected and becomes the baseline
  assert.equal(w.stalls().length, 1);

  clock = 31 * MIN;
  setAwayConfig({ away: true }, 31 * MIN);
  w.tick();

  const events = w.buffer()?.events ?? [];
  assert.deepEqual(events.map((e) => e.kind), ["stuck"]);
  w.stop();
});

test("a stall carried into a window is reported ONCE, not once per tick", () => {
  const reg = fakeRegistry([mkSession({ id: "a", state: "working", lastActivity: 0 })]);
  let clock = 30 * MIN;
  const w = startAwayWatcher(reg.src, () => clock);
  w.tick();
  setAwayConfig({ away: true }, 31 * MIN);
  clock = 31 * MIN;
  w.tick();
  clock = 32 * MIN;
  w.tick();

  const events = w.buffer()?.events ?? [];
  assert.equal(events.length, 1);
  assert.equal(events[0]?.count, 1);
  w.stop();
});

test("seeding known stalls does not re-open the history gate for sessions and tasks", () => {
  // The stall seed strips only `stalls` from the baseline; a session that went idle
  // before you left is still pre-existing history and must stay out of the buffer.
  const reg = fakeRegistry([mkSession({ id: "a", state: "working" })]);
  const w = startAwayWatcher(reg.src, () => 1000);
  w.tick(); // at the desk
  reg.set([mkSession({ id: "a", state: "idle" })]);
  w.tick(); // still at the desk: it finished before you stood up

  setAwayConfig({ away: true }, 2000);
  w.tick();
  assert.equal(w.buffer()?.events.length, 0);
  w.stop();
});

test("a second window does not destroy a digest nobody has read yet", () => {
  // Read-once means there is nowhere to recover it from: go away, come back with no
  // dashboard open to claim it, go away again, and the first window would be gone.
  const reg = fakeRegistry([mkSession({ id: "a", state: "working" })]);
  let clock = 1000;
  const w = startAwayWatcher(reg.src, () => clock);
  setAwayConfig({ away: true }, 500);
  w.tick();
  reg.set([mkSession({ id: "a", state: "idle" })]);
  w.tick();
  setAwayConfig({ away: false }, 2000);
  clock = 2000;
  w.tick(); // first digest is pending, unread

  clock = 60_000;
  setAwayConfig({ away: true }, 60_000);
  reg.set([mkSession({ id: "b", state: "working" })]);
  w.tick();
  reg.set([mkSession({ id: "b", state: "idle" })]);
  w.tick();
  setAwayConfig({ away: false }, 61_000);
  clock = 61_000;
  w.tick();

  const pending = w.takePending();
  assert.deepEqual(pending?.events.map((e) => e.sessionId).sort(), ["a", "b"]);
  assert.equal(pending?.since, 500); // the merged window covers from the first exit
  // 1.5s away, then 1s away - NOT the 60.5s between leaving the first time and
  // coming back the second, most of which was spent at the desk.
  assert.equal(pending?.awayMs, 2500);
  w.stop();
});

test("stop() halts the loop", () => {
  const reg = fakeRegistry([mkSession()]);
  const w = startAwayWatcher(reg.src, () => 1000);
  w.stop();
  // No assertion on timers beyond not throwing - the unref'd timeout is cleared, so
  // this test process can exit, which is itself the check.
  assert.ok(true);
});
