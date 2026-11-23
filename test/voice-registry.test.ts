import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent, Session, Task } from "../src/shared/types.ts";
import {
  ResidentProfileRevisionSchema,
  type ResidentProfile,
  type ResidentRunSummary,
} from "../src/shared/residents.ts";
import type { SpokenName } from "../src/shared/voice-names.ts";
import { mkSession, mkTask, mkTaskSummary } from "./helpers/session-fixture.ts";

// The voice name registry (contract C): who can be addressed, computed from the daemon's own
// catalogs and kept current by their frames. A resident is listed while its profile is live and
// reads running while it has an open run; a task with a call sign reads running while a live
// session runs it, hibernated while hibernated, and otherwise not running - for 24 hours, or until
// another agent takes its name. The last tests run it against the real Registry, to pin the
// frames a window receives.

const home = mkdtempSync(join(tmpdir(), "mission-voice-registry-"));
process.env.HARNESS_HOME = home;

const { VoiceNameRegistry, VOICE_NAME_RETENTION_MS, computeVoiceRoster, wireVoiceNameEvents } = await import("../src/server/voice/names.ts");
const { VoiceStateStore } = await import("../src/server/voice/state.ts");
const { Registry } = await import("../src/server/registry.ts");
const flags = await import("../src/server/feature-flags/index.ts");
const { VOICE_CONFIG_DEFAULTS } = await import("../src/shared/voice.ts");

after(() => rmSync(home, { recursive: true, force: true }));

const HOUR = 60 * 60 * 1000;

function profile(id: string, identity: { name: string; description?: string; referenceName?: string }, colorId = "teal"): ResidentProfile {
  const settings = ResidentProfileRevisionSchema.parse({
    identity,
    persona: { personaId: "builtin:fleet-triage" },
    board: { colorId },
    execution: { agent: "codex" },
  });
  return { id, name: identity.name, revision: 1, archivedAt: null, createdAt: 1, updatedAt: 1, settings };
}

function run(profileId: string, taskId: string, createdAt = 1): ResidentRunSummary {
  return {
    id: `run-${taskId}`, profileId, profileRevision: 1, taskId, launchState: "launched", personaName: null,
    compaction: { betweenIterations: true, nativeBackstop: false },
    loopState: "waiting", iteration: 1, lastSeq: 1, nextWakeAt: null, consumedGeneration: null,
    pauseReason: null, wakeReason: null, runRequestedAt: null,
    settings: profile(profileId, { name: "pinned" }).settings, createdAt,
  };
}

/** A task that was launched once and carries a call sign. */
function callSignTask(id: string, callSign: string, over: Partial<Task> = {}): Task {
  return mkTask({ id, title: `Task ${id}`, callSign, status: "running", dispatchedAt: 10, sessionId: `s-${id}`, ...over });
}

function liveSession(id: string, taskId: string, over: Partial<Session> = {}): Session {
  return mkSession({ id, state: "idle", task: mkTaskSummary({ id: taskId }), ...over });
}

/** The Registry's catalogs and frames, in memory: what the name registry reads. */
class Sources {
  readonly profiles = new Map<string, ResidentProfile>();
  readonly runs = new Map<string, ResidentRunSummary>();
  readonly tasks = new Map<string, Task>();
  readonly sessions = new Map<string, Session>();
  private readonly listeners = new Set<(event: ServerEvent) => void>();
  listResidentProfiles() { return [...this.profiles.values()]; }
  listResidentRuns() { return [...this.runs.values()]; }
  listTasks() { return [...this.tasks.values()]; }
  liveSessions() { return [...this.sessions.values()].filter((session) => session.state !== "exited"); }
  subscribe(fn: (event: ServerEvent) => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit(event: ServerEvent) { for (const listener of this.listeners) listener(event); }
  upsertProfile(p: ResidentProfile) { this.profiles.set(p.id, p); this.emit({ type: "resident_profile_upsert", profile: p }); }
  removeProfile(id: string) { this.profiles.delete(id); this.emit({ type: "resident_profile_remove", id }); }
  upsertRun(r: ResidentRunSummary) { this.runs.set(r.id, r); this.emit({ type: "resident_run_upsert", run: r }); }
  removeRun(id: string) { this.runs.delete(id); this.emit({ type: "resident_run_remove", id }); }
  upsertTask(t: Task) { this.tasks.set(t.id, t); this.emit({ type: "task_upsert", task: t }); }
  removeTask(id: string) { this.tasks.delete(id); this.emit({ type: "task_remove", id }); }
  upsertSession(s: Session) { this.sessions.set(s.id, s); this.emit({ type: "session_upsert", session: s }); }
  removeSession(id: string) { this.sessions.delete(id); this.emit({ type: "session_remove", id }); }
}

function harness(opts: { enabled?: boolean; stored?: (id: string) => boolean } = {}) {
  const sources = new Sources();
  const clock = { now: 1_000_000 };
  const timers: { fn: () => void; ms: number }[] = [];
  const flag = { on: opts.enabled ?? true };
  const names = new VoiceNameRegistry(sources, {
    now: () => clock.now,
    enabled: () => flag.on,
    taskStored: opts.stored ?? (() => true),
    setTimer: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearTimer: (handle) => { const at = timers.indexOf(handle as (typeof timers)[number]); if (at >= 0) timers.splice(at, 1); },
  });
  const changes: SpokenName[][] = [];
  names.onChange((roster) => changes.push([...roster]));
  names.start();
  return { sources, names, clock, timers, flag, changes };
}

const brief = (roster: readonly SpokenName[]) => roster.map((entry) => `${entry.key} ${entry.name} ${entry.state}`);

test("a resident is listed by its reference name, else its profile name, and reads running while it has an open run", () => {
  const { sources, names, changes } = harness();
  sources.upsertProfile(profile("p-steve", { name: "Release Captain", description: "Cuts\n  the release", referenceName: "Steve" }));
  sources.upsertProfile(profile("p-carol", { name: "Carol" }, "violet"));
  assert.deepEqual(brief(names.roster()), ["resident:p-carol Carol not-running", "resident:p-steve Steve not-running"]);
  const steve = names.roster().find((entry) => entry.key === "resident:p-steve")!;
  assert.deepEqual(
    { kind: steve.kind, role: steve.role, colorId: steve.colorId, agent: steve.agent, taskId: steve.taskId, sessionId: steve.sessionId },
    { kind: "resident", role: "Cuts the release", colorId: "teal", agent: "codex", taskId: null, sessionId: null },
  );

  // Launch: an open run makes it running, and its session is named once one runs the run's task.
  sources.upsertRun(run("p-steve", "t-steve"));
  let entry = names.roster().find((e) => e.key === "resident:p-steve")!;
  assert.deepEqual([entry.state, entry.taskId, entry.sessionId], ["running", "t-steve", null]);
  sources.upsertSession(liveSession("s-steve", "t-steve"));
  entry = names.roster().find((e) => e.key === "resident:p-steve")!;
  assert.equal(entry.sessionId, "s-steve");

  // Stop: the run leaves the collection, and the resident stays on the roster, not running.
  sources.removeRun("run-t-steve");
  entry = names.roster().find((e) => e.key === "resident:p-steve")!;
  assert.deepEqual([entry.state, entry.taskId], ["not-running", null]);

  // Archived: the profile leaves the live catalog, and the roster with it.
  sources.removeProfile("p-steve");
  assert.deepEqual(brief(names.roster()), ["resident:p-carol Carol not-running"]);
  assert.ok(changes.length >= 5, "every change reached the listeners");
});

test("a call sign set by update lists the task, and taking it off removes it", () => {
  const { sources, names, changes } = harness();
  const task = callSignTask("t-1", "Alice", { callSign: null });
  sources.upsertTask(task);
  sources.upsertSession(liveSession("s-t-1", "t-1"));
  assert.deepEqual(names.roster(), []);
  sources.upsertTask({ ...task, callSign: "Alice" });
  assert.deepEqual(names.roster(), [{
    key: "task:t-1", name: "Alice", kind: "session", taskId: "t-1", sessionId: "s-t-1",
    role: "Task t-1", colorId: null, agent: "claude", state: "running",
  }]);
  sources.upsertTask({ ...task, callSign: "Alyce" });
  assert.deepEqual(brief(names.roster()), ["task:t-1 Alyce running"]);
  sources.upsertTask({ ...task, callSign: null });
  assert.deepEqual(names.roster(), []);
  assert.deepEqual(changes.map(brief), [["task:t-1 Alice running"], ["task:t-1 Alyce running"], []]);
});

test("a task in the backlog, or one that never launched, answers to nothing yet", () => {
  const { sources, names } = harness();
  sources.upsertTask(callSignTask("t-b", "Bea", { status: "backlog", dispatchedAt: null, sessionId: null }));
  sources.upsertTask(callSignTask("t-c", "Cy", { status: "cancelled", dispatchedAt: null, sessionId: null }));
  sources.upsertTask(callSignTask("t-r", "Rex", { kind: "resident" }));
  assert.deepEqual(names.roster(), []);
});

test("a session that exits leaves its task not running, and the name leaves 24 hours after", () => {
  const { sources, names, clock, timers } = harness();
  sources.upsertTask(callSignTask("t-1", "Alice"));
  sources.upsertSession(liveSession("s-t-1", "t-1"));
  assert.deepEqual(brief(names.roster()), ["task:t-1 Alice running"]);

  sources.upsertSession(liveSession("s-t-1", "t-1", { state: "exited" }));
  const stoppedAt = clock.now;
  const entry = names.roster()[0]!;
  assert.deepEqual([entry.state, entry.sessionId], ["not-running", "s-t-1"], "the last session is kept for a follow-up");
  assert.equal(timers.length, 1, "a timer is set for the name's expiry");
  assert.equal(timers[0]!.ms, VOICE_NAME_RETENTION_MS);

  clock.now = stoppedAt + VOICE_NAME_RETENTION_MS - 1;
  sources.upsertSession(mkSession({ id: "other", state: "idle", task: null }));
  assert.deepEqual(brief(names.roster()), ["task:t-1 Alice not-running"], "still listed a moment before its day is up");
  clock.now = stoppedAt + VOICE_NAME_RETENTION_MS;
  timers.at(-1)!.fn();
  assert.deepEqual(names.roster(), [], "the timer removes it once 24 hours have passed");
});

test("a finished task counts its 24 hours from when it completed", () => {
  const { sources, names, clock } = harness();
  sources.upsertTask(callSignTask("t-done", "Otto", { status: "done", completedAt: clock.now - 23 * HOUR, sessionId: null }));
  assert.deepEqual(brief(names.roster()), ["task:t-done Otto not-running"]);
  sources.upsertTask(callSignTask("t-old", "Ada", { status: "failed", completedAt: clock.now - 25 * HOUR, sessionId: null }));
  assert.deepEqual(brief(names.roster()), ["task:t-done Otto not-running"], "a day past completion is gone");
});

test("a restart keeps a finished task's 24 hours but starts a still-open stopped task's clock again", () => {
  const { sources, names, clock } = harness();
  const stoppedAt = clock.now;
  sources.upsertTask(callSignTask("t-open", "Otto", { status: "running", sessionId: null }));
  sources.upsertTask(callSignTask("t-done", "Ada", { status: "done", completedAt: stoppedAt, sessionId: null }));
  assert.deepEqual(brief(names.roster()), ["task:t-done Ada not-running", "task:t-open Otto not-running"]);
  names.stop();

  // The daemon restarts 20 hours later: a new registry over the same rows, with no memory.
  clock.now = stoppedAt + 20 * HOUR;
  const restarted = new VoiceNameRegistry(sources, { now: () => clock.now, enabled: () => true, taskStored: () => true, setTimer: () => null, clearTimer: () => {} });
  restarted.start();
  assert.deepEqual(brief(restarted.roster()), ["task:t-done Ada not-running", "task:t-open Otto not-running"]);

  // 30 hours after both stopped: the finished task's stored completion time has run out, while the
  // open task's 24 hours count from the restart, so it is still listed.
  clock.now = stoppedAt + 30 * HOUR;
  restarted.refresh();
  assert.deepEqual(brief(restarted.roster()), ["task:t-open Otto not-running"]);
  clock.now = stoppedAt + 44 * HOUR;
  restarted.refresh();
  assert.deepEqual(brief(restarted.roster()), [], "24 hours after the restart it leaves too");
  restarted.stop();
});

test("a hibernated task reads hibernated, never expires, and reads running again when resumed", () => {
  const { sources, names, clock } = harness();
  sources.upsertTask(callSignTask("t-h", "Hazel", { status: "hibernated" }));
  assert.deepEqual(brief(names.roster()), ["task:t-h Hazel hibernated"]);
  clock.now += 30 * 24 * HOUR;
  sources.upsertTask(callSignTask("t-h", "Hazel", { status: "hibernated", updatedAt: 2 }));
  assert.deepEqual(brief(names.roster()), ["task:t-h Hazel hibernated"]);
  sources.upsertTask(callSignTask("t-h", "Hazel", { status: "running" }));
  sources.upsertSession(liveSession("s-h", "t-h"));
  assert.deepEqual(brief(names.roster()), ["task:t-h Hazel running"]);
});

test("a stopped task's name leaves at once when another agent takes it", () => {
  const { sources, names, clock } = harness();
  sources.upsertTask(callSignTask("t-old", "Alice", { status: "done", completedAt: clock.now - HOUR, sessionId: null }));
  assert.deepEqual(brief(names.roster()), ["task:t-old Alice not-running"]);

  // A running task with the same name, spelled differently, takes it.
  sources.upsertTask(callSignTask("t-new", "alice"));
  sources.upsertSession(liveSession("s-t-new", "t-new"));
  assert.deepEqual(brief(names.roster()), ["task:t-new alice running"]);

  // A resident that answers to the name takes it from a stopped task too.
  sources.upsertTask(callSignTask("t-sage", "Sage", { status: "done", completedAt: clock.now - HOUR, sessionId: null }));
  assert.ok(brief(names.roster()).includes("task:t-sage Sage not-running"));
  sources.upsertProfile(profile("p-r", { name: "Release Captain", referenceName: "Sage" }));
  assert.deepEqual(brief(names.roster()), ["resident:p-r Sage not-running", "task:t-new alice running"]);

  // Of two stopped tasks, the one that stopped later keeps the name.
  sources.upsertTask(callSignTask("t-x1", "Max", { status: "done", completedAt: clock.now - 3 * HOUR, sessionId: null }));
  sources.upsertTask(callSignTask("t-x2", "Max", { status: "done", completedAt: clock.now - 2 * HOUR, sessionId: null }));
  assert.ok(brief(names.roster()).includes("task:t-x2 Max not-running"));
  assert.ok(!brief(names.roster()).includes("task:t-x1 Max not-running"));
});

test("a task the Registry evicts from memory keeps its name for its day, and a deleted one leaves at once", () => {
  const stored = new Set(["t-evicted"]);
  const { sources, names, clock } = harness({ stored: (id) => stored.has(id) });
  sources.upsertTask(callSignTask("t-evicted", "Otto", { status: "done", completedAt: clock.now - HOUR, sessionId: null }));
  sources.upsertTask(callSignTask("t-deleted", "Ada", { status: "done", completedAt: clock.now - HOUR, sessionId: null }));
  sources.removeTask("t-evicted");
  sources.removeTask("t-deleted");
  assert.deepEqual(brief(names.roster()), ["task:t-evicted Otto not-running"]);
  clock.now += 24 * HOUR;
  sources.upsertSession(mkSession({ id: "nudge", state: "idle", task: null }));
  assert.deepEqual(names.roster(), [], "the evicted task's day ends like any other");
});

test("with the flag off frames only mark the roster stale, and a read computes it", () => {
  const { sources, names, changes, flag, timers } = harness({ enabled: false });
  sources.upsertTask(callSignTask("t-1", "Alice", { status: "done", completedAt: 999_000, sessionId: null }));
  assert.deepEqual(changes, [], "nothing is published while voice is off");
  assert.equal(timers.length, 0);
  assert.deepEqual(brief(names.roster()), ["task:t-1 Alice not-running"], "a read still answers");
  flag.on = true;
  sources.upsertTask(callSignTask("t-2", "Bea"));
  sources.upsertSession(liveSession("s-t-2", "t-2"));
  assert.deepEqual(changes.map(brief).at(-1), ["task:t-1 Alice not-running", "task:t-2 Bea running"]);
});

test("a session frame that changes neither its liveness nor its task does not recompute", () => {
  const { sources, names, changes } = harness();
  sources.upsertTask(callSignTask("t-1", "Alice"));
  sources.upsertSession(liveSession("s-t-1", "t-1"));
  const before = changes.length;
  let reads = 0;
  const list = sources.listTasks.bind(sources);
  sources.listTasks = () => { reads++; return list(); };
  sources.upsertSession(liveSession("s-t-1", "t-1", { state: "working" }));
  sources.upsertSession(liveSession("s-t-1", "t-1", { state: "idle" }));
  assert.equal(reads, 0);
  assert.equal(changes.length, before);
  assert.equal(names.roster().length, 1);
});

test("residents come first, then sessions, each by name", () => {
  const result = computeVoiceRoster({
    profiles: [profile("p-z", { name: "Zed" }), profile("p-a", { name: "amber" })],
    runs: [run("p-z", "t-old", 1), run("p-z", "t-new", 2)],
    tasks: [callSignTask("t-2", "bravo"), callSignTask("t-1", "Alpha")],
    liveSessions: [liveSession("s-1", "t-1"), liveSession("s-2", "t-2"), liveSession("s-z", "t-new")],
    stoppedAt: () => 0,
    now: 0,
  });
  assert.deepEqual(result.roster.map((entry) => entry.name), ["amber", "Zed", "Alpha", "bravo"]);
  assert.equal(result.roster[1]!.taskId, "t-new", "the newest open run is the one that answers");
  assert.equal(result.roster[1]!.sessionId, "s-z");
  assert.equal(result.nextExpiry, null, "nothing stopped, nothing expires");
});

// ---- against the real Registry ----

test("the Registry carries a call sign on the session's task and publishes the roster as voice_roster", () => {
  flags.applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: true });
  try {
    const registry = new Registry();
    const events: ServerEvent[] = [];
    registry.subscribe((event) => events.push(event));
    const store = new VoiceStateStore({ now: () => Date.now(), enabled: flags.featureEnabled, config: () => VOICE_CONFIG_DEFAULTS });
    const names = new VoiceNameRegistry(registry, { now: () => Date.now(), enabled: () => flags.featureEnabled("voice"), taskStored: () => true });
    const stop = wireVoiceNameEvents(names, (roster) => registry.emitVoiceRoster(roster), store);
    try {
      registry.upsertTask(mkTask({ id: "t-alice", title: "Fix the parser", callSign: "Alice", status: "running", dispatchedAt: 5, sessionId: "sdk:alice" }));
      const session = registry.registerSdkSession({
        id: "sdk:alice", agent: "claude", name: "parser", cwd: home, repoRoot: home, agentSessionId: "agent:alice",
      });
      assert.equal(session.task?.callSign, "Alice", "the session's task summary carries the call sign");
      const rosters = events.flatMap((event) => (event.type === "voice_roster" ? [event.roster] : []));
      assert.deepEqual(rosters.map(brief), [["task:t-alice Alice not-running"], ["task:t-alice Alice running"]]);
      assert.equal(rosters.at(-1)![0]!.sessionId, "sdk:alice");
      assert.deepEqual(brief(store.state().roster), ["task:t-alice Alice running"], "the voice state reads the same roster");

      // A frame that restates the roster is dropped.
      const count = events.length;
      registry.emitVoiceRoster(names.roster());
      assert.equal(events.length, count);

      // A task without a call sign moves nothing.
      registry.upsertTask(mkTask({ id: "t-plain", status: "running", dispatchedAt: 5 }));
      assert.equal(events.filter((event) => event.type === "voice_roster").length, 2);
    } finally {
      stop();
    }
  } finally {
    flags.applyFeatureFlagIntent({ kind: "flag", id: "voice", enabled: false });
  }
});

test("with the voice flag off the Registry sends no voice_roster frame", () => {
  const registry = new Registry();
  const events: ServerEvent[] = [];
  registry.subscribe((event) => events.push(event));
  registry.emitVoiceRoster([]);
  assert.deepEqual(events.filter((event) => event.type === "voice_roster"), []);
  assert.equal(registry.snapshot().voice, undefined, "the snapshot has no voice state either");
});
