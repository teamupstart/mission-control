/**
 * What is at stake: this plugin runs inside ai-conductor's process, unsupervised, on a
 * release train nobody here controls. Nothing in Mission Control's suite can start conductor
 * to find out how it behaves, and by the time anybody notices it misbehaving it will have
 * been misbehaving inside somebody's engine for a while.
 *
 * So it is exercised here, against a stub emitter shaped exactly like
 * `ConductorEventEmitter` - which is a small enough contract (`on`, `off`, per-type, no
 * wildcard) to reproduce honestly. What that proves is the half that is ours: the batching,
 * the addressing, and the failure posture. What it cannot prove is that conductor calls
 * `start()` at all, which is true today by design - the plugin ships dormant.
 *
 * The claims:
 *
 *  1. It never blocks the bus. Handlers are synchronous and do no I/O.
 *  2. It never throws into the bus, and never complains more than once about anything.
 *  3. It is bounded - a daemon that is not answering costs a fixed amount of memory.
 *  4. It sends the frozen envelope, and nothing else.
 *  5. It refuses to guess which run an event belongs to.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  FORWARDED_EVENT_TYPES,
  createMissionControlVisualizer,
  resolveRun,
} from "../integrations/ai-conductor/mission-control/index.mjs";

const REPO = "/w/demo";
const WORKTREE = "/w/demo/.worktrees/a-feature";

/**
 * A stand-in for `ConductorEventEmitter`.
 *
 * Per-type handler sets and no wildcard, which is the shape that forces the plugin to
 * enumerate what it forwards. `emit` awaits handler results exactly as conductor's does,
 * because that is what makes "handlers must be synchronous" a real constraint rather than a
 * style note - a handler that returned a promise here would show up as a stalled bus.
 */
function stubBus() {
  const handlers = new Map<string, Set<(event: Record<string, unknown>) => unknown>>();
  return {
    on(type: string, handler: (event: Record<string, unknown>) => unknown): void {
      const set = handlers.get(type) ?? new Set();
      set.add(handler);
      handlers.set(type, set);
    },
    off(type: string, handler: (event: Record<string, unknown>) => unknown): void {
      handlers.get(type)?.delete(handler);
    },
    /** Returns what the handlers returned, so a test can assert none of them was async. */
    emit(event: Record<string, unknown>): unknown[] {
      return [...(handlers.get(String(event.type)) ?? [])].map((handler) => handler(event));
    },
    subscribed(): number {
      return [...handlers.values()].reduce((n, set) => n + set.size, 0);
    },
  };
}

/** A `fetch` that records what it was asked to send. */
function recordingFetch(reply: { ok: boolean; status: number } = { ok: true, status: 200 }) {
  const calls: Array<{ url: string; token: string; lines: Record<string, unknown>[] }> = [];
  const fetchImpl = (async (url: unknown, init: unknown) => {
    const request = init as { headers: Record<string, string>; body: string };
    calls.push({
      url: String(url),
      token: request.headers["x-harness-token"] ?? "",
      lines: request.body
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    });
    return { ok: reply.ok, status: reply.status } as Response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

test("it subscribes per event type, because the bus has no wildcard", () => {
  const bus = stubBus();
  const plugin = createMissionControlVisualizer({ worktree: WORKTREE, token: "t" });
  plugin.start(bus);
  assert.equal(bus.subscribed(), FORWARDED_EVENT_TYPES.length);
  assert.ok(FORWARDED_EVENT_TYPES.includes("step_completed"));
  // The kinds conductor does NOT persist are the ones only this path can deliver, so their
  // absence from the list would make the plugin pointless for exactly the events it exists
  // for. Named individually rather than counted, so a regenerated list that quietly lost one
  // fails here.
  for (const unpersisted of ["gate_verdict", "loop_halt", "halt_cleared", "pipeline_closeout"]) {
    assert.ok(FORWARDED_EVENT_TYPES.includes(unpersisted), `${unpersisted} must be forwarded`);
  }
});

test("handlers are synchronous, so the engine's bus never waits on this plugin", () => {
  // `ConductorEventEmitter.emit()` awaits whatever a handler returns. A handler that did its
  // own I/O would therefore put this plugin's network latency on the engine's critical path -
  // which is the one failure mode that would make installing it a bad trade.
  const { fetchImpl } = recordingFetch();
  const bus = stubBus();
  const plugin = createMissionControlVisualizer({ worktree: WORKTREE, token: "t", fetchImpl });
  plugin.start(bus);
  const returned = bus.emit({ type: "step_started", step: "build" });
  assert.deepEqual(returned, [undefined], "a handler must return nothing, not a promise");
  assert.equal(plugin.stats().buffered, 1, "and must have buffered rather than sent");
});

test("a batch carries the frozen envelope, and the events in order", async () => {
  const { calls, fetchImpl } = recordingFetch();
  const bus = stubBus();
  const plugin = createMissionControlVisualizer({
    worktree: WORKTREE,
    token: "the-token",
    url: "http://127.0.0.1:7317/",
    fetchImpl,
  });
  plugin.start(bus);
  bus.emit({ type: "step_started", step: "build" });
  bus.emit({ type: "gate_verdict", step: "build", satisfied: false });
  await plugin.stop();

  assert.equal(calls.length, 1, "two events emitted together should cost one request");
  assert.equal(calls[0]?.url, "http://127.0.0.1:7317/ingest/conductor");
  assert.equal(calls[0]?.token, "the-token");
  assert.deepEqual(calls[0]?.lines, [
    {
      repo: REPO,
      worktree: WORKTREE,
      slug: "a-feature",
      seq: 1,
      event: { type: "step_started", step: "build" },
    },
    {
      repo: REPO,
      worktree: WORKTREE,
      slug: "a-feature",
      seq: 2,
      event: { type: "gate_verdict", step: "build", satisfied: false },
    },
  ]);
});

test("stop flushes what is pending, and unsubscribes", async () => {
  const { calls, fetchImpl } = recordingFetch();
  const bus = stubBus();
  const plugin = createMissionControlVisualizer({ worktree: WORKTREE, token: "t", fetchImpl });
  plugin.start(bus);
  bus.emit({ type: "feature_complete" });
  await plugin.stop();
  assert.equal(calls.length, 1, "a run's last events are owed to the ledger");
  assert.equal(plugin.stats().buffered, 0);
  // A visualizer that stayed subscribed after being stopped would keep a finished run's
  // events flowing into a buffer nothing flushes.
  assert.equal(bus.subscribed(), 0);
  bus.emit({ type: "step_started", step: "build" });
  assert.equal(plugin.stats().buffered, 0);
});

test("a daemon that is not there costs one warning and no exception", async () => {
  const warnings: string[] = [];
  const fetchImpl = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const bus = stubBus();
  const plugin = createMissionControlVisualizer({
    worktree: WORKTREE,
    token: "t",
    fetchImpl,
    warn: (message) => warnings.push(message),
  });
  plugin.start(bus);
  for (let i = 0; i < 20; i += 1) bus.emit({ type: "step_started", step: `s${i}` });
  await plugin.stop();

  assert.equal(warnings.length, 1, "a broken transport must not fill conductor's output");
  assert.match(warnings[0] ?? "", /being retried/);
  assert.equal(plugin.stats().warnings, 1);
  // Kept, not discarded. Everything below is about why that distinction is the whole point.
  assert.equal(plugin.stats().buffered, 20);
});

test("a batch the daemon could not take is retried, not dropped", async () => {
  // The case the file tail cannot rescue. Conductor persists 44 of its 74 event kinds, so
  // for a gate verdict or a halt this plugin is the only record that will ever exist - and a
  // daemon restart is an ordinary event, not an exotic one.
  let down = true;
  const delivered: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: unknown, init: unknown) => {
    if (down) throw new Error("ECONNREFUSED");
    const request = init as { body: string };
    for (const raw of request.body.split("\n").filter((l) => l.trim() !== "")) {
      delivered.push(JSON.parse(raw) as Record<string, unknown>);
    }
    return { ok: true, status: 200 } as Response;
  }) as unknown as typeof fetch;

  const bus = stubBus();
  const plugin = createMissionControlVisualizer({
    worktree: WORKTREE,
    token: "t",
    fetchImpl,
    warn: () => {},
  });
  plugin.start(bus);
  bus.emit({ type: "gate_verdict", step: "build", verdict: "pass" });
  bus.emit({ type: "loop_halt", reason: "manual" });
  // Long enough for the scheduled flush to fire and fail against the closed daemon. Not
  // `stop()`, which would unsubscribe the bus and end the run this test is still in.
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(delivered.length, 0, "nothing reached a daemon that was not there");
  assert.equal(plugin.stats().buffered, 2, "and nothing was thrown away either");

  // The daemon comes back. The events buffered through the outage arrive, in the order the
  // engine emitted them, ahead of the one that arrived after it recovered.
  down = false;
  bus.emit({ type: "halt_cleared" });
  await plugin.stop();
  assert.deepEqual(
    delivered.map((entry) => (entry.event as { type: string }).type),
    ["gate_verdict", "loop_halt", "halt_cleared"],
  );
  assert.equal(plugin.stats().buffered, 0);
});

test("a batch refused as too large is dropped, because retrying it can never work", async () => {
  // The one refusal that must NOT be retried: it will be exactly as large next time, so
  // putting it back would park an undeliverable batch at the head of the queue and block
  // every event behind it for the life of the run.
  const { calls, fetchImpl } = recordingFetch({ ok: false, status: 413 });
  const bus = stubBus();
  const plugin = createMissionControlVisualizer({
    worktree: WORKTREE,
    token: "t",
    fetchImpl,
    warn: () => {},
  });
  plugin.start(bus);
  bus.emit({ type: "step_started", step: "build" });
  await plugin.stop();
  assert.equal(plugin.stats().buffered, 0, "not requeued");
  assert.equal(plugin.stats().dropped, 1, "and counted as dropped rather than silently gone");
  assert.equal(calls.length, 1, "tried once, not forever");
});

test("retrying cannot grow the buffer past its ceiling", async () => {
  // Requeue puts a failed batch BACK, so the ceiling has to be re-applied there too or a
  // daemon that stays down turns a bounded buffer into an unbounded one.
  const fetchImpl = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const bus = stubBus();
  const plugin = createMissionControlVisualizer({
    worktree: WORKTREE,
    token: "t",
    fetchImpl,
    warn: () => {},
  });
  plugin.start(bus);
  for (let i = 0; i < 6000; i += 1) bus.emit({ type: "step_started", step: `s${i}` });
  await plugin.stop();
  assert.ok(plugin.stats().buffered <= 5000, `bounded, got ${plugin.stats().buffered}`);
  assert.ok(plugin.stats().dropped >= 1000);
});

test("a refused token says which of the two fixable things is wrong", async () => {
  const warnings: string[] = [];
  const { fetchImpl } = recordingFetch({ ok: false, status: 401 });
  const bus = stubBus();
  const plugin = createMissionControlVisualizer({
    worktree: WORKTREE,
    token: "wrong",
    fetchImpl,
    warn: (message) => warnings.push(message),
  });
  plugin.start(bus);
  bus.emit({ type: "step_started", step: "build" });
  await plugin.stop();
  // The only diagnosis an operator gets, from a plugin whose posture is otherwise silence.
  assert.match(warnings[0] ?? "", /MISSION_CONTROL_TOKEN/);
  assert.match(warnings[0] ?? "", /token is readable by the user conductor runs as/);
});

test("the buffer is bounded, and it drops the oldest", async () => {
  const warnings: string[] = [];
  // A transport that never settles, which is what a hung daemon looks like from here - and
  // is the case where an unbounded buffer would grow for as long as conductor runs.
  const fetchImpl = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
  const bus = stubBus();
  const plugin = createMissionControlVisualizer({
    worktree: WORKTREE,
    token: "t",
    fetchImpl,
    warn: (message) => warnings.push(message),
  });
  plugin.start(bus);
  for (let i = 0; i < 6000; i += 1) bus.emit({ type: "step_started", step: `s${i}` });
  const stats = plugin.stats();
  assert.ok(stats.buffered <= 5000, `buffered ${stats.buffered} events with a 5000 ceiling`);
  assert.ok(stats.dropped > 0, "and it must say that it dropped some");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /is the Mission Control daemon running/);
});

test("it forwards nothing rather than guessing which repository an event belongs to", async () => {
  const warnings: string[] = [];
  const { calls, fetchImpl } = recordingFetch();
  const bus = stubBus();
  // No pin, a working directory that is not inside a worktree, no MISSION_CONTROL_REPO, and
  // an event that names no feature. This is the daemon entrypoint's shape, and the honest
  // answer is silence: Mission Control drops events for repositories nobody consented to, so
  // a guess would produce a plugin that looks installed and delivers nothing.
  const plugin = createMissionControlVisualizer({
    env: {},
    cwd: "/somewhere/else",
    token: "t",
    fetchImpl,
    warn: (message) => warnings.push(message),
  });
  plugin.start(bus);
  bus.emit({ type: "step_started", step: "build" });
  await plugin.stop();
  assert.equal(calls.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /could not tell which conductor worktree/);
  assert.match(warnings[0] ?? "", /nothing is lost - only delayed/);
});

test("identity resolves from the pin, the working directory, then the event", () => {
  const run = { repo: REPO, worktree: WORKTREE, slug: "a-feature" };
  // 1. The pin wins, and is what a per-feature wiring should set.
  assert.deepEqual(
    resolveRun({ MISSION_CONTROL_WORKTREE: WORKTREE }, "/elsewhere", null),
    run,
  );
  // 2. The working directory, at the worktree and anywhere beneath it - conductor's agents
  //    run from subdirectories of the worktree routinely.
  assert.deepEqual(resolveRun({}, WORKTREE, null), run);
  assert.deepEqual(resolveRun({}, `${WORKTREE}/src/deep/inside`, null), run);
  // 3. A named repository plus a slug the event carries. Three spellings, all conductor's.
  assert.deepEqual(
    resolveRun({ MISSION_CONTROL_REPO: REPO }, "/elsewhere", { slug: "a-feature" }),
    run,
  );
  assert.deepEqual(
    resolveRun({ MISSION_CONTROL_REPO: REPO }, "/elsewhere", { featureSlug: "a-feature" }),
    run,
  );
  assert.deepEqual(
    resolveRun({ MISSION_CONTROL_REPO: REPO }, "/elsewhere", { feature: "a-feature" }),
    run,
  );
  // And nothing at all, which must be null rather than a half-built address.
  assert.equal(resolveRun({}, "/elsewhere", { type: "step_started" }), null);
  assert.equal(resolveRun({ MISSION_CONTROL_REPO: REPO }, "/elsewhere", null), null);
  // A directory that merely LOOKS like one - `.worktrees` has to be the parent, not an
  // ancestor, or an unrelated checkout under a worktree would be addressed as one.
  assert.equal(resolveRun({}, "/w/demo/not-worktrees/a-feature", null), null);
});
