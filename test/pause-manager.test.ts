import assert from "node:assert/strict";
import test from "node:test";
import { PAUSED_SESSION_REASON, type PauseState, type SessionPause } from "../src/shared/pause.ts";
import type { StoredPauseState } from "../src/shared/protocol.ts";
import type { ServerEvent, Session } from "../src/shared/types.ts";
import { PauseManager, type PauseRegistry, type ProcessFreezer, type ProcessRef } from "../src/server/pause/manager.ts";

/** A stand-in identity digest per pid: what the real freezer records when it stops one. */
const identityOf = (pid: number): string => pid.toString(16).padStart(64, "0");
const refs = (...pids: number[]): ProcessRef[] => pids.map((pid) => ({ pid, identity: identityOf(pid) }));
const pidsOf = (procs?: readonly { pid: number }[]): number[] => (procs ?? []).map((p) => p.pid);

// What is at stake: pausing stops real processes. A pause that forgets its pids leaves an
// agent frozen forever; a bulk lift that resumes what it did not pause resumes a session the
// operator stopped on purpose; and a restart that drops a record thaws nothing. These drive
// the manager's decisions against a fake registry and a recording freezer.

function session(id: string, state: Session["state"] = "working", extra: Partial<Session> = {}): Session {
  return { id, state, runtime: "terminal", activity: state === "working" ? "Running npm test" : null, pid: 100, ...extra } as Session;
}

class FakeRegistry implements PauseRegistry {
  sessions = new Map<string, Session>();
  pauses = new Map<string, SessionPause | null>();
  resumes = new Map<string, number | null>();
  /** Every write, in order, for the cases where ORDER is the claim. */
  writes: string[] = [];
  fleet: PauseState[] = [];
  private listeners: ((event: ServerEvent) => void)[] = [];
  private observed: (() => void)[] = [];
  swept = false;

  constructor(list: Session[]) {
    for (const s of list) this.sessions.set(s.id, s);
  }
  getSession(id: string) {
    const s = this.sessions.get(id);
    return s ? { ...s, pause: this.pauses.get(id) ?? null } : undefined;
  }
  liveSessions() {
    return [...this.sessions.keys()].map((id) => this.getSession(id)!).filter((s) => s.state !== "exited");
  }
  setSessionPause(id: string, pause: SessionPause | null) {
    this.pauses.set(id, pause);
    this.writes.push(`pause ${id} ${pause?.phase ?? "none"}`);
    return this.sessions.has(id);
  }
  setSessionResumedAt(id: string, at: number | null) {
    this.resumes.set(id, at);
    this.writes.push(`resumed ${id} ${at ?? "none"}`);
  }
  setPauseState(state: PauseState) {
    this.fleet.push(state);
  }
  subscribe(fn: (event: ServerEvent) => void) {
    this.listeners.push(fn);
    return () => {};
  }
  onSessionsObserved(fn: () => void) {
    this.everObserved.push(fn);
    if (this.swept) fn();
    else this.observed.push(fn);
    return () => {};
  }
  sweep() {
    this.swept = true;
    for (const fn of this.observed.splice(0)) fn();
  }
  /** A registry that called its observers again on a later sweep. */
  private everObserved: (() => void)[] = [];
  reobserve() {
    for (const fn of this.everObserved) fn();
  }
  emit(event: ServerEvent) {
    for (const fn of this.listeners) fn(event);
  }
  upsert(id: string, patch: Partial<Session>) {
    this.sessions.set(id, { ...this.sessions.get(id)!, ...patch });
    this.emit({ type: "session_upsert", session: this.getSession(id)! });
  }
}

function recordingFreezer(trees: Record<string, number[]>, refuse: readonly number[] = [], stuck: readonly number[] = []) {
  const stopped: number[][] = [];
  const resumed: number[][] = [];
  const freezer: ProcessFreezer = {
    treeOf: async (s) => refs(...(trees[s.id] ?? [])),
    stop: (procs) => {
      const pids = pidsOf(procs);
      stopped.push(pids);
      return pids.filter((pid) => refuse.includes(pid)).map((pid) => ({ pid, code: "EPERM" }));
    },
    resume: (procs) => {
      const pids = pidsOf(procs);
      resumed.push(pids);
      return pids.filter((pid) => stuck.includes(pid)).map((pid) => ({ pid, code: "EPERM" }));
    },
  };
  return { freezer, stopped, resumed };
}

function memoryStore(initial?: StoredPauseState) {
  let saved = initial;
  return { load: () => saved, save: (state: StoredPauseState) => { saved = structuredClone(state); }, get: () => saved };
}

/** Let queued serialized work run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness(list: Session[], trees: Record<string, number[]>, stored?: StoredPauseState, refuse: readonly number[] = []) {
  const registry = new FakeRegistry(list);
  const { freezer, stopped, resumed } = recordingFreezer(trees, refuse);
  const store = memoryStore(stored);
  const timers: { fn: () => void; ms: number }[] = [];
  const manager = new PauseManager({
    registry,
    freezer,
    store,
    now: () => 1_000_000,
    setTimer: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return t;
    },
    clearTimer: (handle) => {
      const at = timers.indexOf(handle as (typeof timers)[number]);
      if (at >= 0) timers.splice(at, 1);
    },
    log: () => {},
  });
  manager.start();
  registry.sweep();
  return { registry, manager, stopped, resumed, store, timers };
}

test("pause now freezes the whole tree and resume thaws exactly those pids", async () => {
  const { registry, manager, stopped, resumed, store } = harness([session("a")], { a: [10, 11, 12] });
  assert.deepEqual(await manager.pause("a", "now"), { ok: true });
  assert.deepEqual(stopped, [[10, 11, 12]]);
  assert.equal(registry.pauses.get("a")?.phase, "frozen");
  assert.equal(registry.pauses.get("a")?.interrupted, "Running npm test");
  assert.deepEqual(pidsOf(store.get()?.sessions.a?.procs), [10, 11, 12]);
  assert.equal(manager.isHeld("a"), true);
  assert.equal(manager.frozenRefusal("a") !== null, true);

  assert.deepEqual(await manager.resume("a"), { ok: true });
  assert.deepEqual(resumed, [[10, 11, 12]]);
  assert.equal(registry.pauses.get("a"), null);
  assert.equal(manager.isHeld("a"), false);
  assert.deepEqual(store.get()?.sessions, {});
});

test("pause after this turn holds at once and freezes only when the turn ends", async () => {
  const { registry, manager, stopped } = harness([session("a")], { a: [20] });
  await manager.pause("a", "after-turn");
  assert.equal(registry.pauses.get("a")?.phase, "pending");
  assert.equal(manager.isHeld("a"), true, "nothing new may start while it waits");
  assert.equal(manager.frozenRefusal("a"), null, "the running turn may still be answered");
  assert.deepEqual(stopped, []);

  registry.upsert("a", { state: "idle", activity: null });
  await settle();
  await manager.idle();
  assert.deepEqual(stopped, [[20]]);
  assert.equal(registry.pauses.get("a")?.phase, "frozen");
});

test("an agent with nothing to stop stays a hold until its turn ends", async () => {
  // Pi: its driver runs inside the daemon (`sdkDriverStoppable: false`), so there is nothing to retry.
  const { registry, manager, stopped } = harness([session("pi", "working", { runtime: "sdk", agent: "pi" })], {});
  await manager.pause("pi", "now");
  assert.equal(registry.pauses.get("pi")?.phase, "pending", "an in-process driver cannot be frozen mid-turn");
  registry.upsert("pi", { state: "idle" });
  await settle();
  await manager.idle();
  assert.equal(registry.pauses.get("pi")?.phase, "frozen");
  assert.deepEqual(stopped, [], "no pids to signal, but the pause has settled");
});

test("Pause all takes every live session, and its resume leaves a session you paused yourself", async () => {
  const { registry, manager, resumed } = harness(
    [session("a"), session("b", "idle"), session("c", "exited")],
    { a: [1], b: [2], c: [3] },
  );
  await manager.pause("b", "now");
  assert.deepEqual(await manager.pauseFleet({ holdDispatch: true, resumeAt: null }), { ok: true });
  assert.equal(registry.pauses.get("a")?.reason, "fleet");
  assert.equal(registry.pauses.get("b")?.reason, "operator", "an earlier pause keeps its owner");
  assert.equal(registry.pauses.has("c"), false, "an exited session is not paused");
  assert.equal(manager.dispatchHeld(), true);
  assert.notEqual(manager.launchHoldReason(), null);

  await manager.resumeFleet();
  assert.equal(registry.pauses.get("a"), null);
  assert.equal(registry.pauses.get("b")?.reason, "operator");
  assert.deepEqual(resumed, [[1]]);
  assert.equal(manager.dispatchHeld(), false);
  assert.deepEqual(registry.fleet.at(-1), { fleet: null, priority: null });
});

test("Pause all can hold launches or not, and refuses a resume time it cannot honour", async () => {
  const { manager } = harness([session("a")], { a: [1] });
  await manager.pauseFleet({ holdDispatch: false, resumeAt: null });
  assert.equal(manager.dispatchHeld(), false);
  assert.equal((await manager.pauseFleet({ holdDispatch: true, resumeAt: 1_000_000 - 1 })).ok, false);
  assert.equal((await manager.pauseFleet({ holdDispatch: true, resumeAt: 1_000_000 + 8 * 24 * 3600 * 1000 })).ok, false);
});

test("the scheduled resume fires and resumes what Pause all paused", async () => {
  const { registry, manager, timers } = harness([session("a")], { a: [1] });
  await manager.pauseFleet({ holdDispatch: true, resumeAt: 1_000_000 + 60_000 });
  assert.equal(timers.length, 1);
  assert.equal(timers[0]!.ms, 60_000);
  timers[0]!.fn();
  await manager.idle();
  assert.equal(registry.pauses.get("a"), null);
  assert.equal(manager.state().fleet, null);
});

test("priority pauses the others, and ending it resumes only what it paused", async () => {
  const { registry, manager, resumed } = harness(
    [session("p"), session("x"), session("y")],
    { p: [1], x: [2], y: [3] },
  );
  await manager.pause("y", "now");
  assert.deepEqual(await manager.setPriority("p"), { ok: true });
  assert.equal(registry.pauses.get("p") ?? null, null, "the priority session keeps running");
  assert.equal(registry.pauses.get("x")?.reason, "priority");
  assert.equal(registry.pauses.get("y")?.reason, "operator");
  assert.equal(manager.state().priority?.sessionId, "p");
  assert.equal((await manager.pause("p")).ok, false, "the priority session cannot be paused while it is priority");

  await manager.endPriority();
  assert.equal(registry.pauses.get("x"), null);
  assert.equal(registry.pauses.get("y")?.reason, "operator");
  assert.deepEqual(resumed, [[2]]);
});

test("choosing a paused session as priority resumes it, and Pause all is refused meanwhile", async () => {
  const { registry, manager } = harness([session("p"), session("x")], { p: [1], x: [2] });
  await manager.pause("p");
  await manager.setPriority("p");
  assert.equal(registry.pauses.get("p"), null);
  assert.equal(registry.pauses.get("x")?.reason, "priority");

  // Pause all supersedes priority: one Resume all brings everything back.
  await manager.pauseFleet({ holdDispatch: true, resumeAt: null });
  assert.equal(manager.state().priority, null);
  assert.equal(registry.pauses.get("x")?.reason, "fleet");
  assert.equal(registry.pauses.get("p")?.reason, "fleet");
  assert.equal((await manager.setPriority("p")).ok, false);
});

test("a session that leaves is thawed, and priority ends with its session", async () => {
  const { registry, manager, resumed } = harness([session("p"), session("x")], { p: [1], x: [2] });
  await manager.setPriority("p");
  registry.emit({ type: "session_remove", id: "x" });
  await manager.idle();
  assert.deepEqual(resumed, [[2]], "a departed session's stopped pids are continued");

  const second = harness([session("p"), session("x")], { p: [1], x: [2] });
  await second.manager.setPriority("p");
  second.registry.emit({ type: "session_remove", id: "p" });
  await second.manager.idle();
  assert.equal(second.manager.state().priority, null);
  assert.equal(second.registry.pauses.get("x"), null, "its paused sessions resume");
});

test("a release thaws at once, for a stop, kill, interrupt or reset", async () => {
  const { registry, manager, resumed } = harness([session("a")], { a: [7, 8] });
  await manager.pause("a");
  manager.releaseNow("a");
  assert.deepEqual(resumed, [[7, 8]]);
  assert.equal(registry.pauses.get("a"), null);
});

test("a restart re-freezes a restored SDK driver, leaves a still-stopped pane agent alone, and thaws what did not come back", async () => {
  const stored: StoredPauseState = {
    fleet: { since: 1, resumeAt: null, holdDispatch: true },
    priority: null,
    sessions: {
      // Drained at shutdown, so restored as a new process with nothing stopped yet.
      back: { reason: "fleet", phase: "frozen", since: 1, interrupted: "Editing", runtime: "sdk", procs: [], resuming: false },
      // Outlived the daemon still stopped: no rescan, no second SIGSTOP.
      pane: { reason: "fleet", phase: "frozen", since: 1, interrupted: null, runtime: "terminal", procs: refs(7), resuming: false },
      gone: { reason: "fleet", phase: "frozen", since: 1, interrupted: null, runtime: "terminal", procs: refs(6), resuming: false },
    },
    resumed: {},
  };
  const registry = new FakeRegistry([session("back", "idle", { runtime: "sdk" }), session("pane", "idle")]);
  const { freezer, stopped, resumed } = recordingFreezer({ back: [5, 50], pane: [7] });
  const manager = new PauseManager({ registry, freezer, store: memoryStore(stored), log: () => {} });
  manager.start();
  assert.equal(registry.pauses.get("back")?.reason, "fleet", "held before the first sweep");
  assert.equal(registry.fleet.at(-1)?.fleet?.holdDispatch, true);
  registry.sweep();
  await manager.idle();
  assert.deepEqual(stopped, [[5, 50]], "only the restored driver is frozen again");
  assert.equal(registry.pauses.get("back")?.interrupted, "Editing", "what it was doing survives the restart");
  assert.equal(registry.pauses.get("pane")?.phase, "frozen", "the pane agent is still paused, untouched");
  assert.deepEqual(resumed, [[6]]);
  assert.equal(registry.pauses.get("gone"), null);
});

test("shutdown thaws SDK children for their drain and leaves pane agents frozen", async () => {
  const { manager, resumed, store } = harness(
    [session("pane"), session("sdk", "working", { runtime: "sdk" })],
    { pane: [1], sdk: [2] },
  );
  await manager.pauseFleet({ holdDispatch: false, resumeAt: null });
  await manager.stop();
  assert.deepEqual(resumed, [[2]]);
  assert.deepEqual(pidsOf(store.get()?.sessions.sdk?.procs), [], "frozen again after the restore, not now");
  assert.equal(store.get()?.sessions.sdk?.phase, "frozen");
  assert.deepEqual(pidsOf(store.get()?.sessions.pane?.procs), [1]);
  assert.equal(manager.frozenRefusal("sdk"), null, "a restored driver's continuation may land");
});

test("choosing a new priority session pauses the old one for it", async () => {
  const { registry, manager } = harness([session("a"), session("b"), session("c")], { a: [1], b: [2], c: [3] });
  await manager.setPriority("a");
  await manager.setPriority("b");
  assert.equal(manager.state().priority?.sessionId, "b");
  assert.equal(registry.pauses.get("b"), null, "the new priority session was resumed");
  assert.equal(registry.pauses.get("a")?.reason, "priority");
  assert.equal(registry.pauses.get("c")?.reason, "priority");
});

test("the hold is published before the process tree is read", async () => {
  // Reading the process table takes a moment. Every automated writer asks `session.pause`, so a
  // hold published only after the freeze would leave that moment open to start the paused turn.
  const registry = new FakeRegistry([session("a")]);
  let release!: (procs: ProcessRef[]) => void;
  const treeRead = new Promise<ProcessRef[]>((resolve) => { release = resolve; });
  const stopped: number[][] = [];
  const manager = new PauseManager({
    registry,
    freezer: { treeOf: () => treeRead, stop: (procs) => (stopped.push(pidsOf(procs)), []), resume: () => [] },
    store: memoryStore(),
    log: () => {},
  });
  manager.start();
  registry.sweep();
  const pausing = manager.pause("a", "now");
  await settle();
  assert.equal(registry.pauses.get("a")?.phase, "pending", "held while the tree is still being read");
  assert.equal(manager.isHeld("a"), true);
  assert.deepEqual(stopped, [], "nothing stopped yet");
  release(refs(30, 31));
  assert.deepEqual(await pausing, { ok: true });
  assert.equal(registry.pauses.get("a")?.phase, "frozen");
  assert.deepEqual(stopped, [[30, 31]]);
});

test("a process that refuses SIGSTOP is never called frozen, and what did stop is continued", async () => {
  const { registry, manager, stopped, resumed } = harness([session("a")], { a: [40, 41, 42] }, undefined, [41]);
  const result = await manager.pause("a", "now");
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /pid 41 \(EPERM\) refused to stop/);
  assert.match(result.ok ? "" : result.error, /may still be running/);
  assert.deepEqual(stopped, [[40, 41, 42]]);
  assert.deepEqual(resumed, [[40, 41, 42]], "the partial freeze is undone");
  assert.equal(registry.pauses.get("a")?.phase, "pending", "held, not frozen");
  assert.equal(manager.isHeld("a"), true, "nothing automated may start a turn meanwhile");
  assert.equal(manager.frozenRefusal("a"), null, "and nothing claims its processes are stopped");
});

test("a bulk pause reports the sessions whose freeze refused, and pauses the rest", async () => {
  const { registry, manager } = harness([session("a"), session("b")], { a: [50], b: [51] }, undefined, [51]);
  const result = await manager.pauseFleet({ holdDispatch: true, resumeAt: null });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /1 session is held without being frozen/);
  assert.equal(registry.pauses.get("a")?.phase, "frozen");
  assert.equal(registry.pauses.get("b")?.phase, "pending");
  assert.equal(manager.state().fleet?.holdDispatch, true, "Pause all still stands");
});

test("a restored driver's re-freeze whose scan fails or finds nothing keeps the saved processes", async () => {
  for (const scan of ["throws", "empty"] as const) {
    const stored: StoredPauseState = {
      fleet: null,
      priority: null,
      sessions: { a: { reason: "operator", phase: "frozen", since: 1, interrupted: "Editing", runtime: "sdk", procs: refs(60, 61), resuming: false } },
      resumed: {},
    };
    const registry = new FakeRegistry([session("a", "idle", { runtime: "sdk" })]);
    const resumed: number[][] = [];
    const manager = new PauseManager({
      registry,
      freezer: {
        treeOf: async () => {
          if (scan === "throws") throw new Error("ps timed out");
          return [];
        },
        stop: () => [],
        resume: (procs) => (resumed.push(pidsOf(procs)), []),
      },
      store: memoryStore(stored),
      log: () => {},
    });
    manager.start();
    registry.sweep();
    await manager.idle();
    // A failed read leaves the freeze incomplete, and so does an empty tree: a restored driver
    // that runs as its own process and was not found has not started yet, so nothing is
    // stopped. Both are pending and retried, and the saved processes stay recorded.
    assert.equal(registry.pauses.get("a")?.phase, "pending", `${scan}: never called frozen over nothing stopped`);
    assert.equal(manager.isHeld("a"), true, `${scan}: still held`);
    await manager.resume("a");
    assert.deepEqual(resumed, [[60, 61]], `${scan}: the resume still continues what was stopped`);
  }
});

test("a re-freeze that finds more of the tree adds it, and a refusal there thaws only the new pids", async () => {
  const stored: StoredPauseState = {
    fleet: null,
    priority: null,
    sessions: { a: { reason: "operator", phase: "frozen", since: 1, interrupted: null, runtime: "sdk", procs: refs(70), resuming: false } },
    resumed: {},
  };
  const registry = new FakeRegistry([session("a", "idle", { runtime: "sdk" })]);
  const { freezer, resumed } = recordingFreezer({ a: [70, 71, 72] }, [72]);
  const manager = new PauseManager({ registry, freezer, store: memoryStore(stored), log: () => {} });
  manager.start();
  registry.sweep();
  await manager.idle();
  assert.deepEqual(resumed, [[71, 72]], "only what this attempt stopped is continued");
  assert.equal(registry.pauses.get("a")?.phase, "pending", "the freeze is incomplete, and is retried");
  await manager.resume("a");
  assert.deepEqual(resumed.at(-1), [70], "the resume continues what the earlier freeze stopped");
});

test("a resume records its time before it clears the pause, and the time survives a restart", async () => {
  const { registry, manager, store } = harness([session("a")], { a: [80] });
  await manager.pause("a");
  registry.writes.length = 0;
  await manager.resume("a");
  assert.deepEqual(registry.writes, ["resumed a 1000000", "pause a none"], "the outbox sees the resume time first");
  assert.equal(store.get()?.resumed.a, 1_000_000);

  // A restarted daemon hands the same time back to the registry before any session appears.
  const after = new FakeRegistry([session("a")]);
  const restarted = new PauseManager({
    registry: after,
    freezer: recordingFreezer({}).freezer,
    store: memoryStore(store.get()),
    now: () => 1_000_000 + 30_000,
    log: () => {},
  });
  restarted.start();
  assert.equal(after.resumes.get("a"), 1_000_000);
});

test("a resume time is forgotten once it can no longer move a deadline", async () => {
  const stored: StoredPauseState = { fleet: null, priority: null, sessions: {}, resumed: { old: 1, recent: 1_000_000 - 1_000 } };
  const registry = new FakeRegistry([]);
  const store = memoryStore(stored);
  const manager = new PauseManager({ registry, freezer: recordingFreezer({}).freezer, store, now: () => 1_000_000, log: () => {} });
  manager.start();
  assert.equal(registry.resumes.get("recent"), 1_000_000 - 1_000);
  assert.equal(registry.resumes.has("old") && registry.resumes.get("old") !== null, false);
});

test("a freeze that keeps failing is retried on a backing-off timer, never on its own publish", async () => {
  // An idle session whose process table cannot be read. Publishing the failed attempt is itself a
  // `session_upsert`; retrying on it would loop on the process table without any new event.
  const registry = new FakeRegistry([session("a", "idle")]);
  let reads = 0;
  const timers: { fn: () => void; ms: number }[] = [];
  const manager = new PauseManager({
    registry,
    freezer: { treeOf: async () => { reads++; throw new Error("ps timed out"); }, stop: () => [], resume: () => [] },
    store: memoryStore(),
    now: () => 1_000_000,
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimer: (handle) => { const at = timers.indexOf(handle as (typeof timers)[number]); if (at >= 0) timers.splice(at, 1); },
    log: () => {},
  });
  manager.start();
  registry.sweep();
  const result = await manager.pause("a", "now");
  assert.equal(result.ok, false);
  for (let i = 0; i < 5; i++) {
    await settle();
    await manager.idle();
  }
  assert.equal(reads, 1, "the failure's own publish did not trigger another read");
  assert.equal(registry.pauses.get("a")?.phase, "pending");
  assert.deepEqual(timers.map((t) => t.ms), [15_000], "one retry, on a timer");

  timers[0]!.fn();
  await manager.idle();
  await settle();
  await manager.idle();
  assert.equal(reads, 2, "the timer is what retries");
  assert.deepEqual(timers.map((t) => t.ms), [30_000], "and the next wait is longer");
});

test("a SIGSTOP refusal is not retried in a loop either", async () => {
  const { manager, stopped, timers } = harness([session("a", "idle")], { a: [44] }, undefined, [44]);
  await manager.pause("a", "now");
  for (let i = 0; i < 5; i++) {
    await settle();
    await manager.idle();
  }
  assert.deepEqual(stopped, [[44]], "one attempt until the retry timer fires");
  assert.equal(timers.length, 1);
});

test("a process that will not continue keeps its session paused, recorded, and resumable", async () => {
  const registry = new FakeRegistry([session("a")]);
  const store = memoryStore();
  let stuck = [91];
  const resumed: number[][] = [];
  const manager = new PauseManager({
    registry,
    freezer: {
      treeOf: async () => refs(90, 91),
      stop: () => [],
      resume: (procs) => {
        const pids = pidsOf(procs);
        resumed.push(pids);
        return pids.filter((pid) => stuck.includes(pid)).map((pid) => ({ pid, code: "EPERM" }));
      },
    },
    store,
    log: () => {},
  });
  manager.start();
  registry.sweep();
  await manager.pause("a");

  const first = await manager.resume("a");
  assert.equal(first.ok, false, "a resume that did not complete is not reported as one");
  assert.match(first.ok ? "" : first.error, /pid 91 \(EPERM\) would not continue/);
  assert.equal(registry.pauses.get("a")?.phase, "frozen", "still shown paused");
  assert.deepEqual(pidsOf(store.get()?.sessions.a?.procs), [91], "only the stuck pid is still recorded");
  assert.equal(manager.isHeld("a"), true);

  stuck = [];
  assert.deepEqual(await manager.resume("a"), { ok: true });
  assert.deepEqual(resumed.at(-1), [91], "pressing Resume again continues what was left");
  assert.equal(registry.pauses.get("a"), null);
});

test("a pause that cannot be saved stops nothing, and a resume that cannot be saved thaws nothing", async () => {
  const registry = new FakeRegistry([session("a")]);
  let failing = true;
  const saved: StoredPauseState[] = [];
  const stopped: number[][] = [];
  const resumed: number[][] = [];
  const manager = new PauseManager({
    registry,
    freezer: { treeOf: async () => refs(12, 13), stop: (procs) => (stopped.push(pidsOf(procs)), []), resume: (procs) => (resumed.push(pidsOf(procs)), []) },
    store: {
      load: () => undefined,
      save: (state) => {
        if (failing) throw new Error("disk full");
        saved.push(structuredClone(state));
      },
    },
    log: () => {},
  });
  manager.start();
  registry.sweep();

  const paused = await manager.pause("a", "now");
  assert.equal(paused.ok, false);
  assert.deepEqual(stopped, [], "a freeze that could not be recorded is not made: no agent can be stranded");
  assert.equal(registry.pauses.get("a") ?? null, null, "and a pause reported as not saved does not stand as a hold either");

  failing = false;
  await manager.resume("a");
  await manager.pause("a", "now");
  assert.deepEqual(stopped, [[12, 13]]);
  failing = true;
  const resume = await manager.resume("a");
  assert.equal(resume.ok, false);
  assert.match(resume.ok ? "" : resume.error, /could not be saved, so nothing was resumed/);
  assert.deepEqual(resumed, [], "nothing thawed that the saved state still says is stopped");
  assert.equal(registry.pauses.get("a")?.phase, "frozen");
});

test("the pids are saved before the first SIGSTOP is sent", async () => {
  const registry = new FakeRegistry([session("a")]);
  const events: string[] = [];
  const manager = new PauseManager({
    registry,
    freezer: { treeOf: async () => refs(21, 22), stop: (procs) => (events.push(`stop ${pidsOf(procs).join(",")}`), []), resume: () => [] },
    store: { load: () => undefined, save: (state) => void events.push(`save ${pidsOf(state.sessions.a?.procs).join(",") || "-"}`) },
    log: () => {},
  });
  manager.start();
  registry.sweep();
  await manager.pause("a", "now");
  const firstStop = events.indexOf("stop 21,22");
  assert.ok(firstStop > 0);
  assert.ok(events.slice(0, firstStop).includes("save 21,22"), `saved with its pids before stopping: ${events.join(" | ")}`);
});

/** A store whose saves can be made to fail on demand, keeping only what was really written. */
function flakyStore(initial?: StoredPauseState) {
  let saved = initial ? structuredClone(initial) : undefined;
  let failNext = 0;
  return {
    load: () => (saved ? structuredClone(saved) : undefined),
    save: (state: StoredPauseState) => {
      if (failNext > 0) {
        failNext--;
        throw new Error("disk full");
      }
      saved = structuredClone(state);
    },
    failSaves: (n: number) => { failNext = n; },
    get: () => saved,
  };
}

test("a SIGCONT that fails and then a save that fails still leave the stuck pid for the next start", async () => {
  // The regression: the resume's intent is saved, SIGCONT refuses one pid, and the save of that
  // outcome fails. The daemon then restarts. The stopped process must still be on record.
  const store = flakyStore();
  const registry = new FakeRegistry([session("a")]);
  let refuse = [91];
  const resumed: number[][] = [];
  const freezer: ProcessFreezer = {
    treeOf: async () => refs(90, 91),
    stop: () => [],
    resume: (procs) => {
      const pids = pidsOf(procs);
      resumed.push(pids);
      return pids.filter((pid) => refuse.includes(pid)).map((pid) => ({ pid, code: "EPERM" }));
    },
  };
  const manager = new PauseManager({ registry, freezer, store, log: () => {} });
  manager.start();
  registry.sweep();
  await manager.pause("a");

  // The intent save succeeds; the outcome save after the refused SIGCONT fails.
  const realSave = store.save;
  let saves = 0;
  store.save = (state) => {
    saves++;
    if (saves === 2) throw new Error("disk full");
    realSave(state);
  };
  const result = await manager.resume("a");
  assert.equal(result.ok, false, "the refused pid is reported");
  const onDisk = store.get()?.sessions.a;
  assert.ok(onDisk, "the record is still on disk");
  assert.ok(pidsOf(onDisk.procs).includes(91), "with the stuck pid");
  assert.equal(onDisk.resuming, true, "as a resume still to finish");

  // Restart, and this time the process continues.
  refuse = [];
  resumed.length = 0;
  const after = new FakeRegistry([session("a", "idle")]);
  const restarted = new PauseManager({ registry: after, freezer, store: memoryStore(store.get()), log: () => {} });
  restarted.start();
  after.sweep();
  await restarted.idle();
  assert.ok(resumed.some((pids) => pids.includes(91)), "the next start continues the stuck pid");
  assert.equal(after.pauses.get("a"), null, "and the session runs freely");
  assert.equal(restarted.isHeld("a"), false);
});

test("a resume whose outcome was never saved is finished after a restart, never frozen again", async () => {
  const store = flakyStore();
  const registry = new FakeRegistry([session("a")]);
  const { freezer, stopped, resumed } = recordingFreezer({ a: [70] });
  const manager = new PauseManager({ registry, freezer, store, log: () => {} });
  manager.start();
  registry.sweep();
  await manager.pause("a");
  assert.deepEqual(stopped, [[70]]);

  // The intent saves; the outcome does not.
  const realSave = store.save;
  let saves = 0;
  store.save = (state) => {
    saves++;
    if (saves >= 2) throw new Error("disk full");
    realSave(state);
  };
  assert.deepEqual(await manager.resume("a"), { ok: true }, "the process did continue");
  assert.equal(store.get()?.sessions.a?.resuming, true, "disk only knows a resume was asked for");

  const after = new FakeRegistry([session("a", "idle")]);
  const restarted = new PauseManager({ registry: after, freezer, store: memoryStore(store.get()), log: () => {} });
  restarted.start();
  after.sweep();
  await restarted.idle();
  assert.deepEqual(stopped, [[70]], "the resumed session is not frozen again");
  assert.deepEqual(resumed.at(-1), [70], "a second SIGCONT, harmless to a running process");
  assert.equal(after.pauses.get("a"), null);
});

test("a release that cannot thaw tells its caller, and keeps the pid recorded", async () => {
  const registry = new FakeRegistry([session("a")]);
  const { freezer } = recordingFreezer({ a: [80, 81] }, [], [81]);
  const store = memoryStore();
  const manager = new PauseManager({ registry, freezer, store, log: () => {} });
  manager.start();
  registry.sweep();
  await manager.pause("a");
  const why = manager.releaseNow("a");
  assert.match(why ?? "", /pid 81 \(EPERM\) would not continue/);
  assert.equal(registry.pauses.get("a")?.phase, "frozen");
  assert.deepEqual(pidsOf(store.get()?.sessions.a?.procs), [81]);
  assert.equal(manager.releaseNow("missing"), null, "a session with no pause has nothing to release");
});

test("a scheduled resume that cannot be saved backs off instead of firing again at once", async () => {
  const store = flakyStore();
  const registry = new FakeRegistry([session("a")]);
  const timers: { fn: () => void; ms: number }[] = [];
  let now = 1_000_000;
  const manager = new PauseManager({
    registry,
    freezer: recordingFreezer({ a: [5] }).freezer,
    store,
    now: () => now,
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimer: (handle) => { const at = timers.indexOf(handle as (typeof timers)[number]); if (at >= 0) timers.splice(at, 1); },
    log: () => {},
  });
  manager.start();
  registry.sweep();
  await manager.pauseFleet({ holdDispatch: true, resumeAt: now + 60_000 });
  assert.deepEqual(timers.map((t) => t.ms), [60_000]);

  now += 60_000;
  store.failSaves(1000);
  const waits: number[] = [];
  for (let i = 0; i < 3; i++) {
    const timer = timers.shift()!;
    timer.fn();
    await manager.idle();
    await settle();
    await manager.idle();
    waits.push(timers[0]!.ms);
  }
  assert.deepEqual(waits, [15_000, 30_000, 60_000], "a backing-off retry, never an immediate one");
  assert.notEqual(manager.state().fleet, null, "Pause all still stands until a resume can be saved");

  store.failSaves(0);
  timers.shift()!.fn();
  await manager.idle();
  await settle();
  await manager.idle();
  assert.equal(manager.state().fleet, null, "and the resume happens once it can");
  assert.equal(registry.pauses.get("a"), null);
});

test("a pid reused while Mission Control was down is never continued after the restart", async () => {
  const { processFreezer, identityDigest } = await import("../src/server/pause/freezer.ts");
  // The pause stopped pid 600 as an agent; the agent exited while the daemon was down, and pid
  // 600 now belongs to an unrelated (stopped) process.
  const stored: StoredPauseState = {
    fleet: null,
    priority: null,
    sessions: {
      gone: {
        reason: "operator", phase: "frozen", since: 1, interrupted: null, runtime: "terminal",
        procs: [{ pid: 600, identity: identityDigest("Mon Nov 14 01:00:00 2026 claude") }], resuming: false,
      },
      back: {
        reason: "operator", phase: "frozen", since: 1, interrupted: null, runtime: "terminal",
        procs: [{ pid: 601, identity: identityDigest("Mon Nov 14 01:00:05 2026 claude") }], resuming: true,
      },
    },
    resumed: {},
  };
  const signalled: [number, string][] = [];
  const freezer = processFreezer({
    sdkDriverPid: () => null,
    signal: (pid, sig) => void signalled.push([pid, sig]),
    identify: (pid) => (pid === 600 ? "Thu Nov 19 09:00:00 2026 /usr/sbin/unrelated" : pid === 601 ? "Thu Nov 19 09:00:01 2026 another" : null),
    exists: () => true,
    daemonPid: 900,
    log: () => {},
  });
  const registry = new FakeRegistry([session("back", "idle")]);
  const manager = new PauseManager({ registry, freezer, store: memoryStore(stored), log: () => {} });
  manager.start();
  registry.sweep();
  await manager.idle();
  assert.deepEqual(signalled, [], "no SIGCONT to a process that only shares the pid");
  assert.equal(manager.isHeld("gone"), false, "the session that did not come back is dropped");
  assert.equal(manager.isHeld("back"), false, "and a resume to finish whose process is gone is finished");
});

test("Resume all with nothing left to resume still saves the release, or keeps Pause all", async () => {
  const store = flakyStore();
  const registry = new FakeRegistry([session("a")]);
  const manager = new PauseManager({ registry, freezer: recordingFreezer({ a: [5] }).freezer, store, log: () => {} });
  manager.start();
  registry.sweep();
  await manager.pauseFleet({ holdDispatch: true, resumeAt: null });
  // Resumed one by one, so Pause all has nothing left to lift - only itself.
  await manager.resume("a");
  assert.notEqual(store.get()?.fleet, null);

  store.failSaves(1);
  const failed = await manager.resumeFleet();
  assert.equal(failed.ok, false, "a release that could not be saved is not reported as done");
  assert.notEqual(manager.state().fleet, null, "Pause all - and its launch hold - still stands");
  assert.equal(manager.launchHoldReason() !== null, true);
  assert.notEqual(store.get()?.fleet, null);

  assert.deepEqual(await manager.resumeFleet(), { ok: true });
  assert.equal(manager.state().fleet, null);
  assert.equal(store.get()?.fleet, null, "saved, so a restart does not bring it back");
});

test("ending a priority that paused nobody still saves the release, or keeps the priority", async () => {
  const store = flakyStore();
  const registry = new FakeRegistry([session("p")]);
  const manager = new PauseManager({ registry, freezer: recordingFreezer({}).freezer, store, log: () => {} });
  manager.start();
  registry.sweep();
  await manager.setPriority("p");
  assert.equal(store.get()?.priority?.sessionId, "p");

  store.failSaves(1);
  const failed = await manager.endPriority();
  assert.equal(failed.ok, false);
  assert.equal(manager.state().priority?.sessionId, "p", "the priority, and its launch hold, still stand");
  assert.equal(store.get()?.priority?.sessionId, "p");

  assert.deepEqual(await manager.endPriority(), { ok: true });
  assert.equal(store.get()?.priority, null);
});

for (const bulk of ["Pause all", "Make priority"] as const) {
  test(`${bulk} holds every target before the first freeze finishes`, async () => {
    const list = bulk === "Pause all" ? [session("a"), session("b"), session("c")] : [session("p"), session("a"), session("b"), session("c")];
    const registry = new FakeRegistry(list);
    let release!: (procs: ProcessRef[]) => void;
    const firstRead = new Promise<ProcessRef[]>((resolve) => { release = resolve; });
    let reads = 0;
    const manager = new PauseManager({
      registry,
      freezer: {
        treeOf: async (s) => (reads++ === 0 ? firstRead : refs(s.id.charCodeAt(0))),
        stop: () => [],
        resume: () => [],
      },
      store: memoryStore(),
      log: () => {},
    });
    manager.start();
    registry.sweep();
    const pausing = bulk === "Pause all"
      ? manager.pauseFleet({ holdDispatch: true, resumeAt: null })
      : manager.setPriority("p");
    await settle();
    // The first session's process table read has not come back; every target is already held.
    for (const id of ["a", "b", "c"]) {
      assert.equal(registry.pauses.get(id)?.phase, "pending", `${id} is held while the first freeze is still reading`);
    }
    release(refs(1));
    await pausing;
    for (const id of ["a", "b", "c"]) assert.equal(registry.pauses.get(id)?.phase, "frozen");
  });
}

test("reconciliation runs once, and a later observation rescans nothing", async () => {
  const stored: StoredPauseState = {
    fleet: { since: 1, resumeAt: null, holdDispatch: true },
    priority: null,
    sessions: {
      pane: { reason: "fleet", phase: "frozen", since: 1, interrupted: null, runtime: "terminal", procs: refs(31), resuming: false },
      sdk: { reason: "fleet", phase: "frozen", since: 1, interrupted: null, runtime: "sdk", procs: [], resuming: false },
    },
    resumed: {},
  };
  const registry = new FakeRegistry([session("pane", "idle"), session("sdk", "idle", { runtime: "sdk" })]);
  let reads = 0;
  const signals: string[] = [];
  const manager = new PauseManager({
    registry,
    freezer: {
      treeOf: async (s) => { reads++; return refs(s.id === "sdk" ? 32 : 31); },
      stop: (procs) => (signals.push(`stop ${pidsOf(procs)}`), []),
      resume: () => [],
    },
    store: memoryStore(stored),
    log: () => {},
  });
  manager.start();
  registry.sweep();
  await manager.idle();
  // Two reads: the freeze, and the one after its stop that confirms the tree started nothing.
  assert.equal(reads, 2, "only the restored SDK driver is read; the still-stopped pane agent is not");
  assert.deepEqual(signals, ["stop 32"]);
  for (let i = 0; i < 3; i++) {
    registry.reobserve();
    await manager.idle();
  }
  assert.equal(reads, 2, "no rescan for the length of the pause");
  assert.deepEqual(signals, ["stop 32"], "and no repeated signals");
});

test("a restored SDK driver given its predecessor's pid is frozen and resumed as itself", async () => {
  const { processFreezer, identityDigest } = await import("../src/server/pause/freezer.ts");
  // The daemon crashed with the SDK child stopped as pid 700. On restart the restored driver
  // happens to be given pid 700 too - a different process with the same number.
  const stored: StoredPauseState = {
    fleet: null,
    priority: null,
    sessions: {
      sdk: {
        reason: "operator", phase: "frozen", since: 1, interrupted: null, runtime: "sdk",
        procs: [{ pid: 700, identity: identityDigest("old driver") }], resuming: false,
      },
    },
    resumed: {},
  };
  const DAEMON = 900;
  const table = [
    { pid: DAEMON, ppid: 1, tty: null, startRaw: "", startMs: 1, command: "daemon", agent: null, agentNative: false },
    { pid: 700, ppid: DAEMON, tty: null, startRaw: "", startMs: 2, command: "claude", agent: null, agentNative: false },
  ];
  const signalled: [number, string][] = [];
  const freezer = processFreezer({
    sdkDriverPid: () => 700,
    snapshot: async () => ({ processes: table, unknownReason: null }),
    signal: (pid, sig) => void signalled.push([pid, sig]),
    identify: (pid) => (pid === 700 ? "new driver" : null),
    exists: () => true,
    daemonPid: DAEMON,
    log: () => {},
  });
  const registry = new FakeRegistry([session("sdk", "idle", { runtime: "sdk" })]);
  const store = memoryStore(stored);
  const manager = new PauseManager({ registry, freezer, store, log: () => {} });
  manager.start();
  registry.sweep();
  await manager.idle();
  assert.deepEqual(signalled, [[700, "SIGSTOP"]], "the restored driver is frozen");
  assert.deepEqual(store.get()?.sessions.sdk?.procs, [{ pid: 700, identity: identityDigest("new driver") }], "recorded as itself, the stale identity replaced");

  assert.deepEqual(await manager.resume("sdk"), { ok: true });
  assert.deepEqual(signalled, [[700, "SIGSTOP"], [700, "SIGCONT"]], "so the resume continues it");
  assert.equal(manager.isHeld("sdk"), false);
});

test("a restored SDK driver whose re-freeze read fails is not called frozen, keeps its saved processes, and is retried", async () => {
  // The daemon crashed with the SDK child stopped; the record still lists that child. On restart
  // the restored driver is a new process, and the first read of its tree fails.
  const stored: StoredPauseState = {
    fleet: null,
    priority: null,
    sessions: {
      sdk: { reason: "operator", phase: "frozen", since: 1, interrupted: "Editing", runtime: "sdk", procs: refs(700), resuming: false },
    },
    resumed: {},
  };
  const registry = new FakeRegistry([session("sdk", "idle", { runtime: "sdk" })]);
  const store = memoryStore(stored);
  const timers: { fn: () => void; ms: number }[] = [];
  let readable = false;
  const stopped: number[][] = [];
  const manager = new PauseManager({
    registry,
    freezer: {
      treeOf: async () => {
        if (!readable) throw new Error("ps timed out");
        return refs(701);
      },
      stop: (procs) => (stopped.push(pidsOf(procs)), []),
      resume: () => [],
    },
    store,
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimer: (handle) => { const at = timers.indexOf(handle as (typeof timers)[number]); if (at >= 0) timers.splice(at, 1); },
    log: () => {},
  });
  manager.start();
  registry.sweep();
  await manager.idle();

  assert.equal(registry.pauses.get("sdk")?.phase, "pending", "not frozen: the new driver was not stopped");
  assert.deepEqual(stopped, []);
  assert.deepEqual(pidsOf(store.get()?.sessions.sdk?.procs), [700], "the saved process is kept for a resume");
  assert.equal(manager.isHeld("sdk"), true, "still held: nothing automated starts a turn");
  assert.deepEqual(timers.map((t) => t.ms), [15_000], "the freeze is retried on the backing-off timer");

  readable = true;
  timers.shift()!.fn();
  await manager.idle();
  assert.deepEqual(stopped, [[701]], "the retry stops the restored driver");
  assert.equal(registry.pauses.get("sdk")?.phase, "frozen");
  assert.equal(registry.pauses.get("sdk")?.interrupted, "Editing", "what it was doing survives");
  assert.deepEqual(pidsOf(store.get()?.sessions.sdk?.procs), [700, 701]);
});

test("a pane freeze a restart interrupted is finished, though its stopped agent still reads as working", async () => {
  // The last daemon saved the pids, sent SIGSTOP, and exited before saving `frozen`. The agent is
  // stopped, so the turn the session still reports will never end: nothing may wait for it.
  const stored: StoredPauseState = {
    fleet: null,
    priority: null,
    sessions: {
      pane: { reason: "operator", phase: "pending", since: 1, interrupted: "Editing", runtime: "terminal", procs: refs(60, 70), resuming: false },
    },
    resumed: {},
  };
  const registry = new FakeRegistry([session("pane", "working")]);
  const store = memoryStore(stored);
  const timers: { fn: () => void; ms: number }[] = [];
  let reads = 0;
  const stopped: number[][] = [];
  const manager = new PauseManager({
    registry,
    freezer: {
      treeOf: async () => {
        reads++;
        if (reads === 1) throw new Error("ps timed out");
        return refs(60, 70, 71);
      },
      stop: (procs) => (stopped.push(pidsOf(procs)), []),
      resume: () => [],
    },
    store,
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimer: (handle) => { const at = timers.indexOf(handle as (typeof timers)[number]); if (at >= 0) timers.splice(at, 1); },
    log: () => {},
  });
  manager.start();
  // Before reconciliation, every write gate already treats the agent as stopped.
  assert.equal(registry.pauses.get("pane")?.stopped, true, "published as stopped, whatever the phase says");
  assert.equal(manager.frozenRefusal("pane"), PAUSED_SESSION_REASON, "the transport gate refuses a write");

  registry.sweep();
  await manager.idle();
  assert.equal(reads, 1, "reconciliation finishes the freeze instead of waiting for the turn to end");
  assert.equal(registry.pauses.get("pane")?.phase, "pending");
  assert.equal(registry.pauses.get("pane")?.stopped, true);
  assert.deepEqual(pidsOf(store.get()?.sessions.pane?.procs), [60, 70], "the stopped pids are kept");
  assert.deepEqual(timers.map((t) => t.ms), [15_000], "the failed read is retried on the timer");

  // The session still reads as working: the retry goes ahead rather than waiting for a turn end.
  timers.shift()!.fn();
  await manager.idle();
  assert.deepEqual(stopped, [[60, 70, 71]]);
  assert.equal(registry.pauses.get("pane")?.phase, "frozen");
  assert.equal(registry.pauses.get("pane")?.interrupted, "Editing", "what it was doing survives");
  assert.deepEqual(pidsOf(store.get()?.sessions.pane?.procs), [60, 70, 71]);
  assert.deepEqual(timers, [], "nothing left to retry");
});

test("an interrupted freeze whose agent the restarted scan cannot find is settled, not left waiting", async () => {
  const stored: StoredPauseState = {
    fleet: null,
    priority: null,
    sessions: {
      pane: { reason: "operator", phase: "pending", since: 1, interrupted: null, runtime: "terminal", procs: refs(60, 70), resuming: false },
    },
    resumed: {},
  };
  const registry = new FakeRegistry([session("pane", "working")]);
  const store = memoryStore(stored);
  const manager = new PauseManager({
    registry,
    freezer: { treeOf: async () => [], stop: () => [], resume: () => [] },
    store,
    log: () => {},
  });
  manager.start();
  registry.sweep();
  await manager.idle();
  assert.equal(registry.pauses.get("pane")?.phase, "frozen", "what was stopped is what is frozen");
  assert.deepEqual(pidsOf(store.get()?.sessions.pane?.procs), [60, 70], "and is still the record of what to continue");
});

test("an after-turn pause with nothing stopped yet still waits for its turn after a restart", async () => {
  const stored: StoredPauseState = {
    fleet: null,
    priority: null,
    sessions: {
      pane: { reason: "operator", phase: "pending", since: 1, interrupted: null, runtime: "terminal", procs: [], resuming: false },
    },
    resumed: {},
  };
  const registry = new FakeRegistry([session("pane", "working")]);
  let reads = 0;
  const manager = new PauseManager({
    registry,
    freezer: { treeOf: async () => (reads++, refs(70)), stop: () => [], resume: () => [] },
    store: memoryStore(stored),
    log: () => {},
  });
  manager.start();
  assert.equal(registry.pauses.get("pane")?.stopped, false, "nothing is stopped, so a menu answer still lands");
  assert.equal(manager.frozenRefusal("pane"), null);
  registry.sweep();
  await manager.idle();
  assert.equal(reads, 0, "its turn is still running");
  assert.equal(registry.pauses.get("pane")?.phase, "pending");
});

test("a pause that takes a session from Pause all but cannot be saved leaves it Pause all's", async () => {
  const registry = new FakeRegistry([session("a", "idle"), session("b", "idle")]);
  const { freezer, resumed } = recordingFreezer({ a: [70], b: [80] });
  const store = flakyStore();
  const manager = new PauseManager({ registry, freezer, store, now: () => 1_000_000, log: () => {} });
  manager.start();
  registry.sweep();
  assert.deepEqual(await manager.pauseFleet({ holdDispatch: true, resumeAt: null }), { ok: true });
  assert.equal(registry.pauses.get("a")?.reason, "fleet");

  store.failSaves(1);
  const result = await manager.pause("a");
  assert.equal(result.ok, false, "the operator is told it was not saved");
  assert.equal(registry.pauses.get("a")?.reason, "fleet", "the published owner is still Pause all");
  assert.equal(store.get()?.sessions.a?.reason, "fleet", "and so is the saved one");

  // Resume all lifts it, as a restart from that saved state would.
  assert.deepEqual(await manager.resumeFleet(), { ok: true });
  assert.equal(registry.pauses.get("a") ?? null, null);
  assert.deepEqual(resumed.flat().sort(), [70, 80]);
});

test("a pause that takes a session from Pause all and is saved keeps it through Resume all", async () => {
  const registry = new FakeRegistry([session("a", "idle"), session("b", "idle")]);
  const { freezer } = recordingFreezer({ a: [70], b: [80] });
  const store = flakyStore();
  const manager = new PauseManager({ registry, freezer, store, now: () => 1_000_000, log: () => {} });
  manager.start();
  registry.sweep();
  await manager.pauseFleet({ holdDispatch: false, resumeAt: null });
  assert.deepEqual(await manager.pause("a"), { ok: true });
  assert.equal(store.get()?.sessions.a?.reason, "operator");
  await manager.resumeFleet();
  assert.equal(registry.pauses.get("a")?.reason, "operator", "a person's own pause outlasts Resume all");
  assert.equal(registry.pauses.get("b") ?? null, null);
});

test("a `now` pause whose freeze failed keeps retrying while its turn runs", async () => {
  // Pausing now is asking for the network to go quiet now; a failed freeze must not quietly
  // become "after this turn" just because the turn is still running when the timer fires.
  const registry = new FakeRegistry([session("w", "working")]);
  const timers: { fn: () => void; ms: number }[] = [];
  let reads = 0;
  const stopped: number[][] = [];
  const manager = new PauseManager({
    registry,
    freezer: {
      treeOf: async () => {
        reads++;
        if (reads === 1) throw new Error("ps timed out");
        return refs(90);
      },
      stop: (procs) => (stopped.push(pidsOf(procs)), []),
      resume: () => [],
    },
    store: memoryStore(),
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimer: (handle) => { const at = timers.indexOf(handle as (typeof timers)[number]); if (at >= 0) timers.splice(at, 1); },
    log: () => {},
  });
  manager.start();
  registry.sweep();
  assert.equal((await manager.pause("w", "now")).ok, false);
  assert.deepEqual(timers.map((t) => t.ms), [15_000]);
  timers.shift()!.fn();
  await manager.idle();
  assert.deepEqual(stopped, [[90]], "the retry froze it mid-turn");
  assert.equal(registry.pauses.get("w")?.phase, "frozen");
});

test("an after-turn pause still waits for its turn rather than retrying into it", async () => {
  const registry = new FakeRegistry([session("w", "working")]);
  const timers: { fn: () => void; ms: number }[] = [];
  let reads = 0;
  const manager = new PauseManager({
    registry,
    freezer: { treeOf: async () => (reads++, refs(90)), stop: () => [], resume: () => [] },
    store: memoryStore(),
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimer: () => {},
    log: () => {},
  });
  manager.start();
  registry.sweep();
  assert.deepEqual(await manager.pause("w", "after-turn"), { ok: true });
  assert.equal(reads, 0);
  assert.equal(registry.pauses.get("w")?.phase, "pending");
});

test("a `now` pause left pending by a failed freeze is frozen at restart, though its turn still reads running", async () => {
  const stored: StoredPauseState = {
    fleet: null,
    priority: null,
    sessions: { w: { reason: "operator", phase: "pending", since: 1, interrupted: null, runtime: "terminal", procs: [], resuming: false, mode: "now" } },
    resumed: {},
  };
  const { stopped, registry } = harness([session("w", "working")], { w: [90] }, stored);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(stopped, [[90]]);
  assert.equal(registry.pauses.get("w")?.phase, "frozen");
});

test("an SDK pid this daemon stopped and could not continue is gated; a restored driver's old pids are not", async () => {
  // A live SDK session: the stop refuses one pid, and the rollback cannot continue the other.
  const registry = new FakeRegistry([session("sdk", "idle", { runtime: "sdk" })]);
  const manager = new PauseManager({
    registry,
    freezer: {
      treeOf: async () => refs(80, 81),
      stop: () => [{ pid: 81, code: "EPERM" }],
      resume: (procs) => procs.filter((p) => p.pid === 80).map((p) => ({ pid: p.pid, code: "EPERM" })),
    },
    store: memoryStore(),
    setTimer: () => ({}),
    clearTimer: () => {},
    log: () => {},
  });
  manager.start();
  registry.sweep();
  await manager.pause("sdk", "now");
  assert.equal(registry.pauses.get("sdk")?.phase, "pending");
  assert.equal(registry.pauses.get("sdk")?.stopped, true, "pid 80 is stopped, so writes are refused");
  assert.equal(manager.frozenRefusal("sdk"), PAUSED_SESSION_REASON);

  // A restored SDK record whose re-freeze read fails: its pids are the previous driver's.
  const restored = new FakeRegistry([session("sdk2", "idle", { runtime: "sdk" })]);
  const later = new PauseManager({
    registry: restored,
    freezer: { treeOf: async () => { throw new Error("ps timed out"); }, stop: () => [], resume: () => [] },
    store: memoryStore({
      fleet: null,
      priority: null,
      sessions: { sdk2: { reason: "operator", phase: "frozen", since: 1, interrupted: null, runtime: "sdk", procs: refs(700), resuming: false } },
      resumed: {},
    }),
    setTimer: () => ({}),
    clearTimer: () => {},
    log: () => {},
  });
  later.start();
  restored.sweep();
  await later.idle();
  assert.equal(restored.pauses.get("sdk2")?.phase, "pending");
  assert.equal(restored.pauses.get("sdk2")?.stopped, false, "the restored driver's continuation still lands");
  assert.equal(later.frozenRefusal("sdk2"), null);
});

test("a freeze rescans after its stop: a spawned child and a pid whose identity changed are both saved and stopped", async () => {
  // Between the snapshot and the SIGSTOP, pid 70 spawned 72, and pid 71 changed identity - it
  // exec'd, or exited and its pid went to another process. The rescan cannot tell those apart,
  // so it treats 71 as a new member like 72: saved with the identity it has now, then stopped.
  const registry = new FakeRegistry([session("t", "working")]);
  const store = memoryStore();
  let reads = 0;
  const stopped: number[][] = [];
  const execd = { pid: 71, identity: "e".repeat(64) };
  const manager = new PauseManager({
    registry,
    freezer: {
      treeOf: async () => {
        reads++;
        return reads === 1 ? refs(70, 71) : [...refs(70), execd, ...refs(72)];
      },
      stop: (procs) => (stopped.push(pidsOf(procs)), []),
      resume: () => [],
    },
    store,
    log: () => {},
  });
  manager.start();
  registry.sweep();
  assert.deepEqual(await manager.pause("t", "now"), { ok: true });
  assert.deepEqual(stopped, [[70, 71], [71, 72]], "the changed pid and the new child are stopped as new members");
  assert.equal(registry.pauses.get("t")?.phase, "frozen");
  const saved = store.get()?.sessions.t?.procs ?? [];
  assert.deepEqual(pidsOf(saved), [70, 71, 72]);
  assert.equal(saved.find((p) => p.pid === 71)?.identity, execd.identity, "recorded as the process it is now");
});

test("a tree that keeps spawning is never called frozen", async () => {
  const registry = new FakeRegistry([session("t", "working")]);
  let next = 100;
  const manager = new PauseManager({
    registry,
    freezer: { treeOf: async () => refs(70, next++), stop: () => [], resume: () => [] },
    store: memoryStore(),
    setTimer: () => ({}),
    clearTimer: () => {},
    log: () => {},
  });
  manager.start();
  registry.sweep();
  const result = await manager.pause("t", "now");
  assert.equal(result.ok, false);
  assert.equal(registry.pauses.get("t")?.phase, "pending");
  assert.equal(registry.pauses.get("t")?.stopped, true, "what it did stop stays gated");
});

test("a restored driver not found yet is retried until it appears; one with no process of its own settles", async () => {
  for (const agent of ["claude", "pi"] as const) {
    const stored: StoredPauseState = {
      fleet: null,
      priority: null,
      sessions: { a: { reason: "operator", phase: "frozen", since: 1, interrupted: null, runtime: "sdk", procs: [], resuming: false } },
      resumed: {},
    };
    const registry = new FakeRegistry([session("a", "idle", { runtime: "sdk", agent })]);
    const timers: { fn: () => void; ms: number }[] = [];
    let started = false;
    const stopped: number[][] = [];
    const manager = new PauseManager({
      registry,
      freezer: { treeOf: async () => (started ? refs(900) : []), stop: (procs) => (stopped.push(pidsOf(procs)), []), resume: () => [] },
      store: memoryStore(stored),
      setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
      clearTimer: (handle) => { const at = timers.indexOf(handle as (typeof timers)[number]); if (at >= 0) timers.splice(at, 1); },
      log: () => {},
    });
    manager.start();
    registry.sweep();
    await manager.idle();
    if (agent === "pi") {
      // Pi's driver runs inside the daemon: an empty tree is the whole answer, held and settled.
      assert.equal(registry.pauses.get("a")?.phase, "frozen", "pi: nothing of its own to stop");
      assert.deepEqual(timers, [], "pi: nothing to retry");
      continue;
    }
    assert.equal(registry.pauses.get("a")?.phase, "pending", "claude: not frozen before its driver appears");
    assert.deepEqual(timers.map((t) => t.ms), [15_000], "claude: read again on the timer");
    started = true;
    timers.shift()!.fn();
    await manager.idle();
    assert.deepEqual(stopped, [[900]], "claude: the driver that appeared is frozen");
    assert.equal(registry.pauses.get("a")?.phase, "frozen");
  }
});

test("a menu question still open is an unfinished turn: an after-turn pause waits for its answer", async () => {
  const registry = new FakeRegistry([session("q", "awaiting_input")]);
  let reads = 0;
  const manager = new PauseManager({
    registry,
    freezer: { treeOf: async () => (reads++, refs(91)), stop: () => [], resume: () => [] },
    store: memoryStore(),
    log: () => {},
  });
  manager.start();
  registry.sweep();
  await manager.idle();
  assert.deepEqual(await manager.pause("q", "after-turn"), { ok: true });
  assert.equal(reads, 0, "not frozen while the operator still has to answer");
  assert.equal(registry.pauses.get("q")?.phase, "pending");
  registry.upsert("q", { state: "idle", activity: null });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await manager.idle();
  assert.equal(registry.pauses.get("q")?.phase, "frozen", "frozen once the turn is over");
});

test("a Pause all or priority that cannot be saved leaves nothing paused and nothing held", async () => {
  const registry = new FakeRegistry([session("a", "idle"), session("b", "idle")]);
  const { freezer, stopped } = recordingFreezer({ a: [70], b: [80] });
  const store = flakyStore();
  const manager = new PauseManager({ registry, freezer, store, now: () => 1_000_000, log: () => {} });
  manager.start();
  registry.sweep();
  // Startup reconciliation saves too; let it, so the failure lands on the bulk pause's save.
  await manager.idle();

  store.failSaves(1);
  assert.equal((await manager.pauseFleet({ holdDispatch: true, resumeAt: null })).ok, false);
  assert.equal(manager.state().fleet, null, "Pause all did not stand");
  assert.equal(manager.launchHoldReason(), null, "and holds no launches");
  assert.equal(registry.pauses.get("a") ?? null, null);
  assert.equal(registry.pauses.get("b") ?? null, null);
  assert.equal(manager.isHeld("a"), false);
  assert.deepEqual(stopped, [], "nothing was frozen");

  store.failSaves(1);
  assert.equal((await manager.setPriority("a")).ok, false);
  assert.equal(manager.state().priority, null, "priority did not stand");
  assert.equal(registry.pauses.get("b") ?? null, null);
  assert.deepEqual(stopped, []);
});

test("a pause of one session that cannot be saved leaves nothing held and nothing frozen", async () => {
  const registry = new FakeRegistry([session("a", "idle")]);
  const { freezer, stopped } = recordingFreezer({ a: [70] });
  const store = flakyStore();
  const manager = new PauseManager({ registry, freezer, store, now: () => 1_000_000, log: () => {} });
  manager.start();
  registry.sweep();
  await manager.idle();

  store.failSaves(1);
  assert.equal((await manager.pause("a", "now")).ok, false, "the operator is told it was not saved");
  assert.equal(manager.isHeld("a"), false, "and it does not stand");
  assert.equal(registry.pauses.get("a") ?? null, null);
  assert.deepEqual(stopped, [], "nothing was frozen");
});

test("making a paused session the priority commits before thawing it: an unsaved change leaves it paused", async () => {
  const registry = new FakeRegistry([session("a", "idle"), session("b", "idle")]);
  const { freezer, resumed } = recordingFreezer({ a: [70], b: [80] });
  const store = flakyStore();
  const manager = new PauseManager({ registry, freezer, store, now: () => 1_000_000, log: () => {} });
  manager.start();
  registry.sweep();
  await manager.idle();
  assert.deepEqual(await manager.pause("a", "now"), { ok: true });

  store.failSaves(1);
  assert.equal((await manager.setPriority("a")).ok, false, "the operator is told it was not saved");
  assert.deepEqual(resumed, [], "nothing was continued before the change could be committed");
  assert.equal(registry.pauses.get("a")?.phase, "frozen", "the session keeps the pause it had");
  assert.equal(store.get()?.sessions.a?.resuming, false, "and its saved record is untouched");
  assert.equal(manager.state().priority, null);
  assert.equal(registry.pauses.get("b") ?? null, null, "nothing else was held for it");

  // Saved, it goes through: the target is continued and the others paused for it.
  assert.deepEqual(await manager.setPriority("a"), { ok: true });
  assert.deepEqual(resumed, [[70]]);
  assert.equal(registry.pauses.get("a") ?? null, null);
  assert.equal(registry.pauses.get("b")?.reason, "priority");
});

test("a priority session that could not be continued is not made the priority", async () => {
  const registry = new FakeRegistry([session("a", "idle"), session("b", "idle")]);
  const { freezer, stopped } = recordingFreezer({ a: [70], b: [80] }, [], [70]);
  const manager = new PauseManager({ registry, freezer, store: memoryStore(), now: () => 1_000_000, log: () => {} });
  manager.start();
  registry.sweep();
  await manager.idle();
  await manager.pause("a", "now");

  const result = await manager.setPriority("a");
  assert.equal(result.ok, false, "pid 70 would not continue");
  assert.equal(manager.state().priority, null, "so no priority stands");
  assert.equal(registry.pauses.get("b") ?? null, null, "and nothing was held or frozen for it");
  assert.deepEqual(stopped, [[70]], "only the original pause ever stopped anything");
});

test("Pause now on a starting SDK session whose driver has no process yet is retried until it appears", async () => {
  const registry = new FakeRegistry([session("s", "starting", { runtime: "sdk", agent: "claude" })]);
  const timers: { fn: () => void; ms: number }[] = [];
  let spawned = false;
  const stopped: number[][] = [];
  const manager = new PauseManager({
    registry,
    freezer: { treeOf: async () => (spawned ? refs(77) : []), stop: (procs) => (stopped.push(pidsOf(procs)), []), resume: () => [] },
    store: memoryStore(),
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimer: (handle) => { const at = timers.indexOf(handle as (typeof timers)[number]); if (at >= 0) timers.splice(at, 1); },
    log: () => {},
  });
  manager.start();
  registry.sweep();
  await manager.idle();
  assert.equal((await manager.pause("s", "now")).ok, false, "not called paused-and-quiet over a driver not yet running");
  assert.equal(registry.pauses.get("s")?.phase, "pending");
  assert.deepEqual(timers.map((t) => t.ms), [15_000]);
  spawned = true;
  timers.shift()!.fn();
  await manager.idle();
  assert.deepEqual(stopped, [[77]], "the driver that appeared is frozen mid-turn");
  assert.equal(registry.pauses.get("s")?.phase, "frozen");
});

test("a frozen SDK record a crash left behind keeps the restored driver's writes open until this daemon stops it", () => {
  const stored: StoredPauseState = {
    fleet: null,
    priority: null,
    sessions: { s: { reason: "operator", phase: "frozen", since: 1, interrupted: null, runtime: "sdk", procs: refs(600), resuming: false } },
    resumed: {},
  };
  const registry = new FakeRegistry([]);
  const manager = new PauseManager({ registry, freezer: { treeOf: async () => [], stop: () => [], resume: () => [] }, store: memoryStore(stored), log: () => {} });
  manager.start();
  // Before reconciliation: pid 600 was the previous driver's, and the restored one is not stopped.
  assert.equal(manager.frozenRefusal("s"), null, "its restart continuation still lands");
  assert.equal(manager.isHeld("s"), true, "while nothing automated starts a turn");
});

test("the stopped state is published before the post-stop rescan is awaited", async () => {
  const registry = new FakeRegistry([session("t", "idle")]);
  let reads = 0;
  let release!: (procs: ProcessRef[]) => void;
  const rescan = new Promise<ProcessRef[]>((resolve) => { release = resolve; });
  const manager = new PauseManager({
    registry,
    freezer: { treeOf: () => (++reads === 1 ? Promise.resolve(refs(40)) : rescan), stop: () => [], resume: () => [] },
    store: memoryStore(),
    log: () => {},
  });
  manager.start();
  registry.sweep();
  await manager.idle();
  const pausing = manager.pause("t", "now");
  await settle();
  await settle();
  assert.equal(reads, 2, "the rescan is in flight");
  assert.equal(registry.pauses.get("t")?.stopped, true, "and the gates already see the tree as stopped");
  release(refs(40));
  assert.deepEqual(await pausing, { ok: true });
});

test("an after-turn pause records when it froze, not only when it was asked for", async () => {
  let clock = 1_000;
  const registry = new FakeRegistry([session("w", "working")]);
  const manager = new PauseManager({
    registry,
    freezer: { treeOf: async () => refs(55), stop: () => [], resume: () => [] },
    store: memoryStore(),
    now: () => clock,
    log: () => {},
  });
  manager.start();
  registry.sweep();
  await manager.idle();
  await manager.pause("w", "after-turn");
  clock = 61_000;
  registry.upsert("w", { state: "idle", activity: null });
  await settle();
  await manager.idle();
  const pause = registry.pauses.get("w");
  assert.equal(pause?.phase, "frozen");
  assert.equal(pause?.since, 1_000, "asked for at the start");
  assert.equal(pause?.frozenAt, 61_000, "frozen when its turn ended");
});

/** A store that fails exactly the saves whose 1-based numbers are given, counted from `arm()`. */
function countingStore(initial?: StoredPauseState) {
  let saved = initial ? structuredClone(initial) : undefined;
  let count = 0;
  let failing = new Set<number>();
  return {
    load: () => (saved ? structuredClone(saved) : undefined),
    save: (state: StoredPauseState) => {
      count += 1;
      if (failing.has(count)) throw new Error("disk full");
      saved = structuredClone(state);
    },
    arm: (fail: number[]) => { count = 0; failing = new Set(fail); },
    count: () => count,
    get: () => saved,
  };
}

test("a pause whose freeze happened is reported as it is when only the final save fails, and that save is retried", async () => {
  const registry = new FakeRegistry([session("a", "idle")]);
  const { freezer, stopped } = recordingFreezer({ a: [70] });
  const store = countingStore();
  const timers: { fn: () => void; ms: number }[] = [];
  const manager = new PauseManager({
    registry,
    freezer,
    store,
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimer: (handle) => { const at = timers.indexOf(handle as (typeof timers)[number]); if (at >= 0) timers.splice(at, 1); },
    log: () => {},
  });
  manager.start();
  registry.sweep();
  await manager.idle();

  // Save 1 is the hold, 2 the pids before SIGSTOP, 3 the settled state.
  store.arm([3]);
  assert.deepEqual(await manager.pause("a", "now"), { ok: true }, "the agent is paused, and the operator is told so");
  assert.deepEqual(stopped, [[70]]);
  assert.equal(registry.pauses.get("a")?.phase, "frozen");
  assert.equal(store.get()?.sessions.a?.phase, "pending", "on disk: the freeze a restart would finish");
  assert.deepEqual(pidsOf(store.get()?.sessions.a?.procs), [70]);
  assert.deepEqual(timers.map((t) => t.ms), [15_000], "the final save is retried");

  timers.shift()!.fn();
  await manager.idle();
  assert.equal(store.get()?.sessions.a?.phase, "frozen", "and lands");
  assert.deepEqual(timers, []);
});

test("a Pause all whose freezes happened is reported as it is when only the final save fails", async () => {
  const registry = new FakeRegistry([session("a", "idle"), session("b", "idle")]);
  const { freezer, stopped } = recordingFreezer({ a: [70], b: [80] });
  const store = countingStore();
  const timers: { fn: () => void; ms: number }[] = [];
  const manager = new PauseManager({
    registry,
    freezer,
    store,
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimer: (handle) => { const at = timers.indexOf(handle as (typeof timers)[number]); if (at >= 0) timers.splice(at, 1); },
    log: () => {},
  });
  manager.start();
  registry.sweep();
  await manager.idle();

  // Save 1 is the holds, 2 and 3 each session's pids before its SIGSTOP, 4 the settled state.
  store.arm([4]);
  assert.deepEqual(await manager.pauseFleet({ holdDispatch: true, resumeAt: null }), { ok: true });
  assert.equal(store.count(), 4);
  assert.deepEqual(stopped, [[70], [80]]);
  assert.notEqual(manager.state().fleet, null, "Pause all stands, as reported");
  assert.deepEqual(timers.map((t) => t.ms), [15_000], "the final save is retried");
  timers.shift()!.fn();
  await manager.idle();
  assert.equal(store.get()?.sessions.b?.phase, "frozen");
});

test("a takeover whose change of owner cannot be saved says the session is still paused", async () => {
  const registry = new FakeRegistry([session("a", "idle")]);
  const { freezer } = recordingFreezer({ a: [70] });
  const store = countingStore();
  const manager = new PauseManager({ registry, freezer, store, log: () => {} });
  manager.start();
  registry.sweep();
  await manager.idle();
  await manager.pauseFleet({ holdDispatch: false, resumeAt: null });
  store.arm([1]);
  const result = await manager.pause("a", "now");
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /is paused, but making it yours could not be saved/);
});

test("a working terminal agent missing from one process read is retried, never settled over", async () => {
  const registry = new FakeRegistry([session("t", "working")]);
  const timers: { fn: () => void; ms: number }[] = [];
  let seen = false;
  const stopped: number[][] = [];
  const manager = new PauseManager({
    registry,
    freezer: { treeOf: async () => (seen ? refs(60, 70) : []), stop: (procs) => (stopped.push(pidsOf(procs)), []), resume: () => [] },
    store: memoryStore(),
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimer: (handle) => { const at = timers.indexOf(handle as (typeof timers)[number]); if (at >= 0) timers.splice(at, 1); },
    log: () => {},
  });
  manager.start();
  registry.sweep();
  await manager.idle();
  const result = await manager.pause("t", "now");
  assert.equal(result.ok, false, "not reported as paused-and-quiet over an agent that was not found");
  assert.equal(registry.pauses.get("t")?.phase, "pending");
  assert.deepEqual(timers.map((t) => t.ms), [15_000], "read again on the timer");
  seen = true;
  timers.shift()!.fn();
  await manager.idle();
  assert.deepEqual(stopped, [[60, 70]]);
  assert.equal(registry.pauses.get("t")?.phase, "frozen");
});

test("an idle agent missing from one process read is retried, never settled over", async () => {
  for (const runtime of ["terminal", "sdk"] as const) {
    const registry = new FakeRegistry([session("i", "idle", { runtime, agent: "claude" })]);
    const timers: { fn: () => void; ms: number }[] = [];
    let seen = false;
    const stopped: number[][] = [];
    const manager = new PauseManager({
      registry,
      freezer: { treeOf: async () => (seen ? refs(88) : []), stop: (procs) => (stopped.push(pidsOf(procs)), []), resume: () => [] },
      store: memoryStore(),
      setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
      clearTimer: (handle) => { const at = timers.indexOf(handle as (typeof timers)[number]); if (at >= 0) timers.splice(at, 1); },
      log: () => {},
    });
    manager.start();
    registry.sweep();
    await manager.idle();
    assert.equal((await manager.pause("i", "now")).ok, false, `${runtime}: not called paused over an agent that was not found`);
    assert.equal(registry.pauses.get("i")?.phase, "pending");
    assert.deepEqual(timers.map((t) => t.ms), [15_000], `${runtime}: read again on the timer`);
    seen = true;
    timers.shift()!.fn();
    await manager.idle();
    assert.deepEqual(stopped, [[88]], `${runtime}: frozen once found`);
    assert.equal(registry.pauses.get("i")?.phase, "frozen");
  }
});

test("a restamped identity that cannot be saved leaves the freeze unsettled until it is", async () => {
  // Pid 71 exec'd between the stop and the settle read. Its new identity must reach the disk
  // before the pause is called frozen, or a restart's resume would skip that stopped process.
  const registry = new FakeRegistry([session("a", "idle")]);
  const store = countingStore();
  const timers: { fn: () => void; ms: number }[] = [];
  const execd = { pid: 71, identity: "e".repeat(64) };
  let reads = 0;
  const manager = new PauseManager({
    registry,
    freezer: { treeOf: async () => (++reads === 1 ? refs(70, 71) : [...refs(70), execd]), stop: () => [], resume: () => [] },
    store,
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimer: (handle) => { const at = timers.indexOf(handle as (typeof timers)[number]); if (at >= 0) timers.splice(at, 1); },
    log: () => {},
  });
  manager.start();
  registry.sweep();
  await manager.idle();

  // Save 1 is the hold, 2 the pids before SIGSTOP, 3 the restamped identity.
  store.arm([3]);
  const result = await manager.pause("a", "now");
  assert.equal(result.ok, false, "not reported frozen over an identity the disk does not have");
  assert.equal(registry.pauses.get("a")?.phase, "pending");
  // The closing save after it carries the new identity, still as an unfinished freeze.
  assert.equal(store.get()?.sessions.a?.phase, "pending", "on disk too, never frozen before the identity landed");
  assert.deepEqual(timers.map((t) => t.ms), [15_000], "and the freeze is retried");

  timers.shift()!.fn();
  await manager.idle();
  assert.equal(registry.pauses.get("a")?.phase, "frozen");
  assert.equal(store.get()?.sessions.a?.procs.find((p) => p.pid === 71)?.identity, execd.identity, "saved as the process it is now");
});

/** A freezer whose SIGCONT refusals can be lifted mid-test. */
function stubbornFreezer(trees: Record<string, number[]>, stuck: Set<number>) {
  const resumed: number[][] = [];
  const freezer: ProcessFreezer = {
    treeOf: async (s) => refs(...(trees[s.id] ?? [])),
    stop: () => [],
    resume: (procs) => {
      resumed.push(pidsOf(procs));
      return procs.filter((p) => stuck.has(p.pid)).map((p) => ({ pid: p.pid, code: "EPERM" }));
    },
  };
  return { freezer, resumed };
}

test("Resume all stays on offer while a session it paused will not continue, and retrying finishes it", async () => {
  const registry = new FakeRegistry([session("a", "idle"), session("b", "idle")]);
  const stuck = new Set([80]);
  const { freezer } = stubbornFreezer({ a: [70], b: [80] }, stuck);
  const manager = new PauseManager({ registry, freezer, store: memoryStore(), log: () => {} });
  manager.start();
  registry.sweep();
  await manager.idle();
  await manager.pauseFleet({ holdDispatch: true, resumeAt: Date.now() + 60_000 });

  const first = await manager.resumeFleet();
  assert.equal(first.ok, false, "pid 80 would not continue");
  assert.notEqual(manager.state().fleet, null, "Pause all still stands, so its banner and Resume all stay");
  assert.equal(manager.state().fleet?.resumeAt, null, "its scheduled resume is not offered again");
  assert.equal(registry.pauses.get("a") ?? null, null, "what did continue is resumed");
  assert.equal(registry.pauses.get("b")?.reason, "fleet", "what would not is still Pause all's");

  stuck.clear();
  assert.deepEqual(await manager.resumeFleet(), { ok: true }, "pressing it again retries the rest");
  assert.equal(manager.state().fleet, null);
  assert.equal(registry.pauses.get("b") ?? null, null);
});

test("End priority stays on offer while a session it paused will not continue", async () => {
  const registry = new FakeRegistry([session("a", "idle"), session("b", "idle")]);
  const stuck = new Set([80]);
  const { freezer } = stubbornFreezer({ a: [70], b: [80] }, stuck);
  const manager = new PauseManager({ registry, freezer, store: memoryStore(), log: () => {} });
  manager.start();
  registry.sweep();
  await manager.idle();
  await manager.setPriority("a");
  assert.equal(registry.pauses.get("b")?.reason, "priority");

  assert.equal((await manager.endPriority()).ok, false);
  assert.equal(manager.state().priority?.sessionId, "a", "priority stands, with End priority");
  stuck.clear();
  assert.deepEqual(await manager.endPriority(), { ok: true });
  assert.equal(manager.state().priority, null);
  assert.equal(registry.pauses.get("b") ?? null, null);
});

test("every save a partial Resume all makes still records Pause all, so a restart keeps its launch hold", async () => {
  const registry = new FakeRegistry([session("a", "idle"), session("b", "idle")]);
  const { freezer } = stubbornFreezer({ a: [70], b: [80] }, new Set([80]));
  const saves: StoredPauseState[] = [];
  const store = { load: () => undefined, save: (state: StoredPauseState) => void saves.push(structuredClone(state)) };
  const manager = new PauseManager({ registry, freezer, store, log: () => {} });
  manager.start();
  registry.sweep();
  await manager.idle();
  await manager.pauseFleet({ holdDispatch: true, resumeAt: null });

  saves.length = 0;
  assert.equal((await manager.resumeFleet()).ok, false, "pid 80 would not continue");
  assert.ok(saves.length > 0);
  assert.ok(saves.every((s) => s.fleet !== null), "no save in between ever cleared Pause all");
  assert.equal(saves.at(-1)?.fleet?.holdDispatch, true, "and its launch hold is on disk");
});
