import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Phase 3's central claim, under test: what was KNOWN about a session while it did the work.
//
// The properties being asserted are not "an event was emitted". They are the ones P2 says a
// dashboard gets wrong when nobody enforces them: a level accepted for the NEXT turn does not
// re-attribute the turn already running; a discovered session's start is not fabricated; a
// kill request and an ending are independent; a restart does not adopt the same session twice;
// and no pane id, tty, path or pull request URL reaches an exported record.
//
// A real database, real capture and the real projection engine - no fixture substituted for
// the pipeline, because every claim here is a claim about what actually got committed.

const home = mkdtempSync(join(tmpdir(), "mission-telemetry-session-"));
// Set before importing anything that resolves the state dir.
process.env.HARNESS_HOME = join(home, "state");

const { closeDb, openDb } = await import("../src/server/db.ts");
const { setTelemetryConfig } = await import("../src/server/telemetry/config.ts");
const { runProjectionPass } = await import("../src/server/telemetry/projection.ts");
const { runRetentionPass } = await import("../src/server/telemetry/retention.ts");
const { usedBytes } = await import("../src/server/telemetry/store.ts");
const { TELEMETRY_LIMITS } = await import("../src/shared/telemetry.ts");
const { registerBuiltinTelemetry } = await import("../src/server/telemetry/service.ts");
const {
  attachSessionTelemetry,
  noteDispatchLaunch,
  noteDispatchStarted,
  noteSessionHandoff,
  noteSessionRestoring,
  noteTaskDeparture,
  observeDispatchFinished,
  observeEffortSelected,
  observeKillRequested,
  observeSessionOperation,
  observeSessionRestore,
  observeUsageRecorded,
  resetSessionTelemetryForTesting,
} = await import("../src/server/telemetry/sessions.ts");
const { TELEMETRY_EVENTS } = await import("../src/shared/telemetry-catalog.ts");
const { MODEL_CATALOG } = await import("../src/shared/model.ts");
import type { MetricsBatchPayload, TracesBatchPayload } from "../src/server/telemetry/projection.ts";

registerBuiltinTelemetry();

after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

const TELEMETRY_TABLES = [
  "telemetry_journal",
  "telemetry_source_identities",
  "telemetry_projection_state",
  "telemetry_series",
  "telemetry_batches",
  "telemetry_delivery",
  "telemetry_destinations",
  "telemetry_secrets",
  "telemetry_gaps",
  "telemetry_contexts",
  "telemetry_resources",
  "telemetry_pr_observations",
  "telemetry_task_outcome_state",
];

beforeEach(() => {
  const d = openDb();
  for (const table of TELEMETRY_TABLES) d.exec(`DELETE FROM ${table}`);
  d.exec("DELETE FROM app_config");
  resetSessionTelemetryForTesting();
  attached = null;
});

/**
 * The Registry's event stream, and nothing else.
 *
 * The observer reads exactly two methods, so this fake IS the contract: if a later change made
 * it reach for a third, this file would stop compiling rather than quietly couple the whole
 * registry graph into a telemetry test.
 */
class FakeHost {
  private listeners: Array<(e: never) => void> = [];
  readonly tasks = new Map<string, unknown>();

  subscribe(fn: (e: never) => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  getTask(id: string): never | undefined {
    return this.tasks.get(id) as never | undefined;
  }

  emit(event: Record<string, unknown>): void {
    // A copy, because a listener may unsubscribe while the list is being walked - which is
    // exactly what the real Registry's own drain guards against.
    const snapshot = this.listeners.slice();
    for (const listener of snapshot) listener(event as never);
  }
}

let attached: FakeHost | null = null;

function host(): FakeHost {
  if (!attached) {
    attached = new FakeHost();
    attachSessionTelemetry(attached as never);
  }
  return attached;
}

function enableLocalOnly(): void {
  const applied = setTelemetryConfig({ enabled: true });
  assert.equal(applied.ok, true);
}

interface JournalRow {
  name: string;
  facts_json: string;
  refs_json: string;
  occurred_at: number;
  source_id: string;
}

function journal(name?: string): Array<{ facts: Record<string, unknown>; refs: Record<string, string>; occurredAt: number; sourceId: string }> {
  const rows = (
    name
      ? openDb()
          .prepare(
            `SELECT name, facts_json, refs_json, occurred_at, source_id FROM telemetry_journal
             WHERE name = ? ORDER BY seq`,
          )
          .all(name)
      : openDb()
          .prepare(
            `SELECT name, facts_json, refs_json, occurred_at, source_id FROM telemetry_journal ORDER BY seq`,
          )
          .all()
  ) as unknown as JournalRow[];
  return rows.map((r) => ({
    facts: JSON.parse(r.facts_json) as Record<string, unknown>,
    refs: JSON.parse(r.refs_json) as Record<string, string>,
    occurredAt: r.occurred_at,
    sourceId: r.source_id,
  }));
}

function session(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "proc:ttys001:4242:1700000000000",
    agent: "claude",
    runtime: "terminal",
    name: "work",
    nameSource: "tmux",
    state: "idle",
    cwd: "/tmp/checkout",
    gitBranch: null,
    gitRoot: null,
    repoRoot: null,
    pid: 4242,
    tty: "ttys001",
    permissionMode: null,
    terminals: [],
    agentSessionId: null,
    transcriptPath: null,
    meta: null,
    pendingEffort: null,
    ...overrides,
  };
}

function upsert(overrides: Record<string, unknown> = {}): void {
  host().emit({ type: "session_upsert", session: session(overrides) });
}

// ---- how a session comes to exist ----

test("opting in first observes an already-published working session at the consent boundary", (t) => {
  let now = 1_000;
  t.mock.method(Date, "now", () => now);
  noteDispatchLaunch("task-before-consent", "/tmp/checkout");
  const working = { state: "working", meta: metaAt("claude-opus-5", "medium") };
  upsert(working);
  assert.equal(journal().length, 0);

  now = 5_000;
  enableLocalOnly();
  upsert(working);
  upsert(working);
  const starts = journal("mission.session.started");
  assert.equal(starts.length, 1);
  assert.equal(starts[0]?.facts.start_observation, "first_observed");
  assert.equal(starts[0]?.occurredAt, 5_000);
  assert.equal(starts[0]?.refs.task_id, undefined, "an unconsented launch is not replayed");
  assert.equal(journal("mission.session.segment.opened").length, 1);

  now = 6_000;
  upsert({ ...working, state: "idle" });
  const [turn] = journal("mission.session.turn.finished");
  assert.equal(turn?.facts.duration_ms, 1_000);
  assert.equal(turn?.facts.observation_bounded, true);
  host().emit({ type: "session_remove", id: session().id });
  const [end] = journal("mission.session.ended");
  assert.equal(end?.facts.observed_ms, 1_000);
  assert.equal(end?.facts.observation_bounded, true);
});

test("re-enabling collection without an intervening publication discards the old turn", (t) => {
  let now = 1_000;
  t.mock.method(Date, "now", () => now);
  enableLocalOnly();
  noteDispatchLaunch("task-1", "/tmp/checkout");
  upsert({ state: "working", meta: metaAt("claude-opus-5", "medium") });
  assert.equal(setTelemetryConfig({ enabled: false }).ok, true);
  now = 5_000;
  enableLocalOnly();
  upsert({ state: "idle", meta: metaAt("claude-opus-5", "medium") });
  assert.equal(journal("mission.session.turn.finished").length, 0, "no turn spans a collection gap");
  const segments = journal("mission.session.segment.opened");
  assert.equal(segments.length, 2);
  assert.notEqual(segments[0]?.refs.segment_id, segments[1]?.refs.segment_id);
  assert.equal(journal("mission.session.started").length, 1, "re-consent does not double-count adoption");
  now = 6_000;
  host().emit({ type: "session_remove", id: session().id });
  assert.equal(journal("mission.session.ended")[0]?.facts.observed_ms, 1_000);
});

test("a discovered session does not fabricate a start it never saw", () => {
  enableLocalOnly();
  upsert();
  const [started] = journal("mission.session.started");
  assert.ok(started);
  assert.equal(started.facts.origin, "discovered");
  // The point of the assertion: an adopted session's real start is unknowable, and reporting
  // it as though capture had been running from the beginning would put it in a
  // complete-from-start cohort it does not belong to.
  assert.equal(started.facts.start_observation, "first_observed");
  assert.equal(started.facts.task_kind, "none", "a personal session is not `chat`");
});

test("an app-owned launch is a dispatch with a witnessed start", () => {
  enableLocalOnly();
  // Recorded BEFORE the session appears, which is the ordering the real dispatcher uses: the
  // session is announced before `dispatch()` gets control back, so an intent recorded
  // afterwards would always lose that race.
  noteDispatchLaunch("task-1", "/tmp/checkout");
  host().tasks.set("task-1", { id: "task-1", kind: "ship", extraRepos: [], sessionId: null } as never);
  upsert();
  const [started] = journal("mission.session.started");
  assert.equal(started?.facts.origin, "dispatch");
  assert.equal(started?.facts.start_observation, "observed_start");
  assert.equal(started?.facts.task_kind, "ship");
  assert.equal(started?.facts.repo_count, 1);
});

test("a restored session is a continuation, not a second adoption", () => {
  enableLocalOnly();
  noteSessionRestoring("sdk:abc", null);
  upsert({ id: "sdk:abc", runtime: "sdk", cwd: "/tmp/elsewhere" });
  const [started] = journal("mission.session.started");
  assert.equal(started?.facts.origin, "restored");
  assert.equal(started?.facts.start_observation, "after_restart");
  // An SDK runtime has no pane at all, which is a different answer from "we could not tell".
  assert.equal(started?.facts.multiplexer, "not_applicable");
  assert.equal(started?.facts.emulator, "not_applicable");
});

test("republishing a session does not start it again", () => {
  enableLocalOnly();
  upsert();
  upsert({ state: "working" });
  upsert({ state: "idle" });
  assert.equal(journal("mission.session.started").length, 1);
});

test("restoration uses its durable task instead of consuming a same-checkout launch intent", () => {
  enableLocalOnly();
  host().tasks.set("restored-task", { id: "restored-task", kind: "ship", extraRepos: [], status: "done" });
  noteDispatchLaunch("new-dispatch", "/tmp/checkout");
  noteSessionRestoring("sdk:restored-task", "restored-task");
  upsert({ id: "sdk:restored-task", runtime: "sdk" });
  host().emit({ type: "session_remove", id: "sdk:restored-task" });
  assert.equal(journal("mission.session.started")[0]?.refs.task_id, "restored-task");
  assert.equal(journal("mission.session.ended")[0]?.facts.ended_while_work_open, false,
    "a terminal task loaded before observation is already settled");
  upsert();
  assert.equal(journal("mission.session.started")[1]?.refs.task_id, "new-dispatch",
    "the actual new launch still consumes its own intent");
});

test("a restored task identity survives an unavailable task row without inventing its kind", () => {
  enableLocalOnly();
  noteSessionRestoring("sdk:missing-task", "missing-task");
  upsert({ id: "sdk:missing-task", runtime: "sdk" });
  const [started] = journal("mission.session.started");
  assert.equal(started?.refs.task_id, "missing-task");
  assert.equal(started?.facts.task_kind, "unknown");
});

test("a daemon restart re-adopting the same session records continuity, not a new session", () => {
  enableLocalOnly();
  upsert();
  assert.equal(journal("mission.session.started").length, 1);

  // The restart. In-memory tracking is gone; the DURABLE dedupe identity is what has to
  // survive, because no in-process guard could.
  closeDb();
  openDb();
  resetSessionTelemetryForTesting();
  attached = null;
  upsert();

  assert.equal(
    journal("mission.session.started").length,
    1,
    "the same proven session must not be counted twice across a restart",
  );
});

// ---- effective versus pending effort ----

for (const scenario of [
  { name: "metadata changes while working", observedAtStart: true, updateState: "working", effort: "high" },
  { name: "metadata changes on completion", observedAtStart: true, updateState: "idle", effort: "high" },
  { name: "quality improves while working", observedAtStart: false, updateState: "working", effort: "medium" },
] as const) {
  test(`a turn retains its starting attribution when ${scenario.name}`, () => {
    enableLocalOnly();
    noteDispatchLaunch("task-snapshot", "/tmp/checkout", { model: "claude-opus-5", effort: "medium" });
    const initial = {
      agentSessionId: "conv-1",
      meta: scenario.observedAtStart ? metaAt("claude-opus-5", "medium") : null,
    };
    upsert(initial);
    upsert({ ...initial, state: "working" });
    const startSegment = journal("mission.session.segment.opened").at(-1)!;

    const updated = {
      agentSessionId: scenario.observedAtStart ? "conv-2" : "conv-1",
      meta: metaAt("claude-opus-5", scenario.effort),
    };
    upsert({ ...updated, state: scenario.updateState });
    upsert({ ...updated, state: "idle" });
    const turns = journal("mission.session.turn.finished");
    assert.equal(turns.length, 1, "repeated completion does not finish a second turn");
    assert.equal(turns[0]?.facts.effort, "medium");
    assert.equal(turns[0]?.facts.quality, scenario.observedAtStart ? "observed" : "launch_resolved");
    assert.equal(turns[0]?.refs.segment_id, startSegment.refs.segment_id);
    assert.equal(turns[0]?.refs.conversation_id, "conv-1");

    // The next turn uses the new observation, rather than retaining the old snapshot.
    upsert({ ...updated, state: "working" });
    upsert({ ...updated, state: "idle" });
    const next = journal("mission.session.turn.finished");
    assert.equal(next.length, 2);
    assert.equal(next[1]?.facts.effort, scenario.effort);
    assert.equal(next[1]?.facts.quality, "observed");
    assert.equal(next[1]?.refs.segment_id, journal("mission.session.segment.opened").at(-1)?.refs.segment_id);
    assert.equal(next[1]?.refs.conversation_id, updated.agentSessionId);
  });
}

test("a session first observed working captures that bounded turn's initial attribution", () => {
  enableLocalOnly();
  upsert({ state: "working", meta: metaAt("claude-opus-5", "medium") });
  const startSegment = journal("mission.session.segment.opened").at(-1)!;
  upsert({ state: "working", meta: metaAt("claude-opus-5", "high") });
  upsert({ state: "idle", meta: metaAt("claude-opus-5", "high") });
  const turns = journal("mission.session.turn.finished");
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.facts.effort, "medium");
  assert.equal(turns[0]?.facts.observation_bounded, true);
  assert.equal(turns[0]?.refs.segment_id, startSegment.refs.segment_id);
});

test("a level accepted for the next turn leaves the running turn on the old one", () => {
  enableLocalOnly();
  // 10:00 - turn A starts on medium.
  upsert({ agentSessionId: "conv-1", meta: metaAt("claude-opus-5", "medium") });
  upsert({ agentSessionId: "conv-1", meta: metaAt("claude-opus-5", "medium"), state: "working" });

  // 10:01 - the operator selects high and the driver accepts it FOR THE NEXT TURN.
  observeEffortSelected({
    session: { id: session().id as string, agent: "claude", runtime: "sdk", agentSessionId: "conv-1" },
    requested: "high",
    outcome: "accepted",
    applies: "next_turn",
    actor: { kind: "human", origin: "dashboard", basis: "app_context" },
  });
  upsert({
    agentSessionId: "conv-1",
    meta: metaAt("claude-opus-5", "medium"),
    state: "working",
    pendingEffort: "high",
  });

  // 10:02 - turn A completes. Its tokens and duration belong to MEDIUM.
  upsert({ agentSessionId: "conv-1", meta: metaAt("claude-opus-5", "medium"), state: "idle", pendingEffort: "high" });

  const [turnA] = journal("mission.session.turn.finished");
  assert.equal(turnA?.facts.effort, "medium", "a next-turn selection must not re-attribute the turn it did not run");
  assert.equal(turnA?.facts.quality, "observed");

  const [selection] = journal("mission.session.effort.selected");
  assert.equal(selection?.facts.applies, "next_turn");
  assert.equal(selection?.facts.outcome, "accepted");

  // 10:03 - turn B REPORTS high. Only now does a segment move.
  const before = journal("mission.session.segment.opened").length;
  upsert({ agentSessionId: "conv-1", meta: metaAt("claude-opus-5", "high") });
  const segments = journal("mission.session.segment.opened");
  assert.equal(segments.length, before + 1);
  assert.equal(segments.at(-1)?.facts.effort, "high");
  assert.equal(segments.at(-1)?.facts.reason, "effort_changed");
});

test("a repeated identical observation refreshes quality and opens no segment", () => {
  enableLocalOnly();
  upsert({ agentSessionId: "conv-1", meta: metaAt("claude-opus-5", "high") });
  const opened = journal("mission.session.segment.opened").length;
  upsert({ agentSessionId: "conv-1", meta: metaAt("claude-opus-5", "high") });
  upsert({ agentSessionId: "conv-1", meta: metaAt("claude-opus-5", "high") });
  assert.equal(
    journal("mission.session.segment.opened").length,
    opened,
    "a segment per metadata poll would make turns-per-segment a fact about the poller",
  );
});

test("a context clear ends the segment rather than carrying the model across", () => {
  enableLocalOnly();
  upsert({ agentSessionId: "conv-1", meta: metaAt("claude-opus-5", "high") });
  upsert({ agentSessionId: "conv-2", meta: metaAt("claude-opus-5", "high") });
  const segments = journal("mission.session.segment.opened");
  assert.equal(segments.at(-1)?.facts.reason, "conversation_rotation");
  assert.notEqual(
    segments.at(-1)?.refs.segment_id,
    segments.at(-2)?.refs.segment_id,
    "a rotated conversation gets its own segment identity",
  );
});

test("a harness that reports no effort stays unknown and is never narrowed to low", () => {
  enableLocalOnly();
  upsert({ agentSessionId: "conv-1", meta: metaAt("some-model", null) });
  const [segment] = journal("mission.session.segment.opened");
  assert.equal(segment?.facts.effort, "unknown");
  assert.equal(segment?.facts.quality, "unknown");
});

test("a native effort outside the shared vocabulary is unsupported, not unknown", () => {
  enableLocalOnly();
  upsert({
    agentSessionId: "conv-1",
    meta: { ...metaAt("some-model", null), nativeEffort: "turbo" },
  });
  const [segment] = journal("mission.session.segment.opened");
  // The two answers are different questions - "this harness has no effort knob" against "we
  // have not read it yet" - and collapsing them loses the only thing that distinguishes them.
  assert.equal(segment?.facts.effort, "unsupported");
  assert.equal(segment?.facts.quality, "unsupported");
});

// ---- dispatch ----

test("a dispatch that fails before resolution reports no model at all", () => {
  enableLocalOnly();
  noteDispatchStarted("task-9");
  observeDispatchFinished({
    taskId: "task-9",
    agent: "claude",
    runtime: "terminal",
    taskKind: "ship",
    resolvedModel: null,
    resolvedEffort: null,
    resolutionSource: "harness",
    repoCount: 1,
    outcome: "failed",
  });
  const [dispatch] = journal("mission.dispatch.finished");
  assert.equal(dispatch?.facts.outcome, "failed");
  assert.equal(dispatch?.facts.resolved_model, "");
  // "Nothing resolved" is a different answer from "the panel default was used", and a preflight
  // refusal must not put a model in the fails-to-launch column it had nothing to do with.
  assert.equal(dispatch?.facts.resolution_source, "harness");
  assert.equal(journal("mission.session.started").length, 0, "a failed launch is not a session");
});

test("two owners reporting one dispatch attempt record it once", () => {
  enableLocalOnly();
  const attempt = {
    taskId: "task-9",
    agent: "claude" as const,
    runtime: "sdk" as const,
    taskKind: "scout" as const,
    resolvedModel: "claude-opus-5",
    resolvedEffort: "high",
    resolutionSource: "kind" as const,
    repoCount: 1,
    outcome: "launched" as const,
  };
  noteDispatchStarted("task-9", 1_000);
  assert.equal(observeDispatchFinished({ ...attempt, now: 2_000 }).kind, "accepted");

  // THE SECOND OWNER. A second hook on the same attempt, or a retried publication of it.
  // `noteDispatchStarted` is deliberately NOT called again, because nothing re-dispatched -
  // so this must resolve to the SAME attempt identity and be refused.
  //
  // The regression this pins: the start marker used to be consumed by the first observation,
  // so the second computed a fresh clock, minted a different id, and was admitted as an extra
  // dispatch. Note the later `now` below - that is exactly the drift that made it look new.
  const second = observeDispatchFinished({ ...attempt, now: 9_000 });
  assert.equal(second.kind, "duplicate", "a second report of one attempt is not a second dispatch");
  assert.equal(journal("mission.dispatch.finished").length, 1);

  // And the duration is still the FIRST report's measurement, not the second's. A duplicate
  // must not be able to restate how long the launch took.
  assert.equal(journal("mission.dispatch.finished")[0]?.facts.duration_ms, 1_000);

  // A genuine RE-dispatch is a new attempt and is admitted, because `dispatch()` marks a new
  // start. Without this the fix above would be indistinguishable from "never record a task's
  // dispatch twice", which would silently lose every retry.
  noteDispatchStarted("task-9", 20_000);
  assert.equal(observeDispatchFinished({ ...attempt, now: 21_000 }).kind, "accepted");
  assert.equal(journal("mission.dispatch.finished").length, 2);
});

// ---- endings ----

test("a kill request is recorded whether or not an ending follows", () => {
  enableLocalOnly();
  upsert();
  observeKillRequested({
    session: { id: session().id as string, agent: "claude", runtime: "terminal" },
    outcome: "accepted",
    actor: { kind: "human", origin: "dashboard", basis: "app_context" },
  });
  assert.equal(journal("mission.session.kill.requested").length, 1);
  // The agent survived it. No ending is invented, because none was observed.
  assert.equal(journal("mission.session.ended").length, 0);
});

test("a provisional exit that is cancelled by rediscovery ends nothing", () => {
  enableLocalOnly();
  upsert();
  // `session_exit` fires first and can be cancelled inside the linger. Counting departures
  // there would report a session as ended and then go on observing it.
  host().emit({ type: "session_exit", session: session({ state: "exited" }) });
  upsert({ state: "idle" });
  assert.equal(journal("mission.session.ended").length, 0);
});

test("durable removal ends the session, once, with the reason it can actually prove", () => {
  enableLocalOnly();
  upsert();
  host().emit({ type: "session_remove", id: session().id });
  host().emit({ type: "session_remove", id: session().id });
  const ended = journal("mission.session.ended");
  assert.equal(ended.length, 1);
  assert.equal(ended[0]?.facts.reason, "unknown", "a vanished session's reason is not guessed at");
  assert.equal(ended[0]?.facts.ended_while_work_open, false);
});

test("a confirmed kill is the ending's reason", () => {
  enableLocalOnly();
  upsert();
  observeKillRequested({
    session: { id: session().id as string, agent: "claude", runtime: "terminal" },
    outcome: "accepted",
    actor: { kind: "human", origin: "dashboard", basis: "app_context" },
  });
  host().emit({ type: "session_remove", id: session().id });
  assert.equal(journal("mission.session.ended")[0]?.facts.reason, "kill_requested");
});

for (const later of ["handoff", "stop_failure", "rediscovery", "expired"] as const) {
  test(`a survived kill request does not mislabel a later ${later} departure`, (t) => {
    let now = 1_000;
    t.mock.method(Date, "now", () => now);
    enableLocalOnly();
    upsert();
    observeKillRequested({
      session: session() as never, outcome: "accepted",
      actor: { kind: "human", origin: "dashboard", basis: "app_context" },
    });
    if (later === "handoff") noteSessionHandoff(session().id as string);
    else if (later === "expired") now += 5 * 60_000;
    else {
      upsert({ state: later === "stop_failure" ? "stopping" : "exited" });
      upsert({ state: "idle" });
    }
    host().emit({ type: "session_remove", id: session().id });
    assert.equal(journal("mission.session.ended")[0]?.facts.reason, later === "handoff" ? "handoff" : "unknown");
    assert.equal(journal("mission.session.kill.requested").length, 1, "the accepted action fact remains");
  });
}

for (const outcome of ["failed", "superseded"] as const) {
  test(`a ${outcome} dispatch cannot donate launch attribution to a retry`, () => {
    enableLocalOnly();
    noteDispatchStarted("task-old", 1_000);
    noteDispatchLaunch("task-old", "/tmp/checkout", { model: "old-model", effort: "low" });
    observeDispatchFinished({
      taskId: "task-old", agent: "claude", runtime: "terminal", taskKind: "ship",
      resolvedModel: "old-model", resolvedEffort: "low", resolutionSource: "task", repoCount: 1, outcome,
    });
    noteDispatchStarted("task-retry", 2_000);
    noteDispatchLaunch("task-retry", "/tmp/checkout", { model: "new-model", effort: "high" });
    upsert();
    assert.equal(journal("mission.session.started")[0]?.refs.task_id, "task-retry");
    const [segment] = journal("mission.session.segment.opened");
    assert.equal(segment?.facts.model_id, "new-model");
    assert.equal(segment?.facts.effort, "high");
  });
}

test("an SDK stop restored before its accepted response cannot mark a later departure", () => {
  enableLocalOnly();
  upsert({ runtime: "sdk", state: "stopping" });
  upsert({ runtime: "sdk", state: "idle" });
  observeKillRequested({
    session: session({ runtime: "sdk" }) as never, outcome: "accepted",
    actor: { kind: "human", origin: "dashboard", basis: "app_context" },
  });
  host().emit({ type: "session_remove", id: session().id });
  assert.equal(journal("mission.session.ended")[0]?.facts.reason, "unknown");
});

test("an accepted SDK stop still awaiting removal retains its kill attribution", () => {
  enableLocalOnly();
  upsert({ runtime: "sdk", state: "stopping" });
  observeKillRequested({
    session: session({ runtime: "sdk" }) as never, outcome: "accepted",
    actor: { kind: "human", origin: "dashboard", basis: "app_context" },
  });
  upsert({ runtime: "sdk", state: "exited" });
  host().emit({ type: "session_remove", id: session().id });
  assert.equal(journal("mission.session.ended")[0]?.facts.reason, "kill_requested");
});

test("a task's prior outcome does not hide open work on a new attempt", () => {
  enableLocalOnly();
  const task = { id: "task-retry", kind: "ship", extraRepos: [], sessionId: null, dispatchedAt: 1_000 };
  host().emit({ type: "task_upsert", task: { ...task, status: "failed" } });
  host().emit({ type: "task_upsert", task: { ...task, status: "dispatching", dispatchedAt: 2_000 } });
  noteDispatchLaunch(task.id, "/tmp/checkout");
  upsert();
  host().emit({ type: "session_remove", id: session().id });
  assert.equal(journal("mission.session.ended")[0]?.facts.ended_while_work_open, true);
  assert.equal(journal("mission.task.outcome").length, 1, "the previous attempt's outcome stays recorded");
});

for (const restart of [false, true]) {
  test(`reopen then cancel before dispatch records a new durable outcome${restart ? " across restart" : ""}`, () => {
    enableLocalOnly();
    const task = {
      id: "task-reopened", kind: "ship", extraRepos: [], sessionId: null,
      dispatchedAt: 1_000, status: "done", completedAt: 2_000, updatedAt: 2_000, outcome: "shipped",
    };
    host().emit({ type: "task_upsert", task });
    host().emit({ type: "task_upsert", task: { ...task, status: "backlog", completedAt: null, updatedAt: 3_000 } });
    if (restart) {
      closeDb();
      resetSessionTelemetryForTesting();
      attached = null;
    }
    const cancelled = { ...task, status: "cancelled", completedAt: 4_000, updatedAt: 4_000 };
    host().emit({ type: "task_upsert", task: cancelled });
    host().emit({ type: "task_upsert", task: { ...cancelled, completedAt: 5_000, updatedAt: 5_000 } });
    const outcomes = journal("mission.task.outcome");
    assert.deepEqual(outcomes.map((row) => row.facts.status), ["done", "cancelled"]);
    assert.notEqual(outcomes[0]?.sourceId, outcomes[1]?.sourceId);
    closeDb();
    resetSessionTelemetryForTesting();
    attached = null;
    host().emit({ type: "task_upsert", task: { ...cancelled, completedAt: 5_000, updatedAt: 5_000 } });
    assert.equal(journal("mission.task.outcome").length, 2, "terminal replay remains deduplicated after restart");
  });
}

test("task observation state is opt-in, charged to the byte budget and expires with dedupe state", (t) => {
  const now = 5_000;
  t.mock.method(Date, "now", () => now);
  const task = { id: "task-window", status: "running", dispatchedAt: 1_000 };
  const count = () => (openDb().prepare("SELECT COUNT(*) AS n FROM telemetry_task_outcome_state").get() as { n: number }).n;
  host().emit({ type: "task_upsert", task });
  assert.equal(count(), 0);
  enableLocalOnly();
  const before = usedBytes(openDb());
  host().emit({ type: "task_upsert", task });
  assert.equal(count(), 1);
  assert.ok(usedBytes(openDb()) > before);
  closeDb();
  openDb();
  assert.equal(count(), 1, "source state survives schema reopening");
  runRetentionPass(now + TELEMETRY_LIMITS.reducerStateRetentionMs + 1);
  assert.equal(count(), 0);
});

test("a refused task outcome retries within its durable interval", () => {
  enableLocalOnly();
  const task = { id: "task-refused", kind: "ship", extraRepos: [], sessionId: null, status: "failed", dispatchedAt: 1_000 };
  noteTaskDeparture(task.id);
  const limits = TELEMETRY_LIMITS as unknown as { maxTotalBytes: number };
  const original = limits.maxTotalBytes;
  limits.maxTotalBytes = 1;
  try {
    host().emit({ type: "task_upsert", task });
    assert.equal(journal("mission.task.outcome").length, 0);
  } finally {
    limits.maxTotalBytes = original;
  }
  host().emit({ type: "task_upsert", task });
  host().emit({ type: "task_upsert", task });
  assert.equal(journal("mission.task.outcome").length, 1);
  assert.equal(journal("mission.task.outcome")[0]?.facts.completion_evidence, "missing");
});

test("an already captured legacy task outcome is adopted without counting it again", async () => {
  enableLocalOnly();
  const { captureTelemetry } = await import("../src/server/telemetry/capture.ts");
  const event = TELEMETRY_EVENTS["mission.task.outcome"];
  assert.ok(event);
  const captured = captureTelemetry({
    event,
    source: { kind: "mission.task", id: "task-legacy:1000", revision: 1 },
    facts: {
      task_kind: "ship", status: "done", completion_evidence: "recorded", repo_count: 1,
      duration_ms: 1_000, observation_bounded: false,
    },
    refs: { task_id: "task-legacy" },
  });
  assert.equal(captured.kind, "accepted");
  host().emit({ type: "task_upsert", task: {
    id: "task-legacy", kind: "ship", extraRepos: [], sessionId: null,
    status: "done", dispatchedAt: 1_000, completedAt: 2_000, outcome: "shipped",
  } });
  assert.equal(journal("mission.task.outcome").length, 1);
});

// ---- task outcomes ----

test("a departed agent's task exports failed AND missing evidence together", () => {
  enableLocalOnly();
  // What `TaskManager.settleAgentGone` does: it settles the row `failed` while documenting
  // that a clean exit cannot be distinguished from a crash.
  noteTaskDeparture("task-4");
  host().emit({
    type: "task_upsert",
    task: { id: "task-4", kind: "ship", status: "failed", extraRepos: [], sessionId: null, outcome: null, dispatchedAt: 1_000 },
  });
  const [outcome] = journal("mission.task.outcome");
  assert.equal(outcome?.facts.status, "failed");
  assert.equal(
    outcome?.facts.completion_evidence,
    "missing",
    "an unknown ending must never be exportable as a measured correctness failure",
  );
});

test("a recorded outcome is evidence; a multi-repo task still counts once", () => {
  enableLocalOnly();
  host().emit({
    type: "task_upsert",
    task: {
      id: "task-5",
      kind: "ship",
      status: "done",
      extraRepos: [{ worktreePath: "/tmp/b" }, { worktreePath: "/tmp/c" }],
      sessionId: null,
      outcome: "shipped",
      dispatchedAt: 1_000,
    },
  });
  // And again, from a second publication of the same terminal row.
  host().emit({
    type: "task_upsert",
    task: {
      id: "task-5",
      kind: "ship",
      status: "done",
      extraRepos: [{ worktreePath: "/tmp/b" }, { worktreePath: "/tmp/c" }],
      sessionId: null,
      outcome: "shipped",
      dispatchedAt: 1_000,
    },
  });
  const outcomes = journal("mission.task.outcome");
  assert.equal(outcomes.length, 1, "one task, one outcome, however many times the row is published");
  assert.equal(outcomes[0]?.facts.completion_evidence, "recorded");
  assert.equal(outcomes[0]?.facts.repo_count, 3);

  runProjectionPass();
  const rows = openDb()
    .prepare(`SELECT dimensions_json, value FROM telemetry_series WHERE instrument = 'mission.task.outcomes'`)
    .all() as unknown as Array<{ dimensions_json: string; value: number }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.value, 1, "a three-repository task must not contribute three completions");
  assert.equal(JSON.parse(rows[0]!.dimensions_json).repo_count, undefined);
});

// ---- usage ----

test("usage model dimensions stay bounded while source and trace attribution retain off-catalog ids", () => {
  // Produce export batches without running a transport or contacting the endpoint.
  assert.equal(setTelemetryConfig({
    enabled: true,
    user: { enabled: true, endpoint: "http://127.0.0.1:14318" },
  }).ok, true);
  const knownModels = [...new Set(Object.values(MODEL_CATALOG).flatMap((models) => models.map((m) => m.id)))];
  const customModels = Array.from({ length: 64 }, (_, i) => `off-catalog-model-${i}`);
  const models = [...knownModels, ...customModels, ""];
  upsert({ agentSessionId: "conv-custom", meta: metaAt(customModels[0]!, "high") });
  for (const usageOrigin of ["authoring", "automation"] as const) {
    for (const modelId of models) {
      const result = observeUsageRecorded({
        identity: `bounded-model:${usageOrigin}:${modelId}`,
        usageOrigin,
        costBasis: "api-equivalent",
        modelId,
        input: 1,
        output: 2,
        reasoningOutput: 3,
        cacheRead: 4,
        cacheWrite: 5,
        costUsd: 0.25,
      });
      assert.equal(result.kind, "accepted");
    }
  }
  while (runProjectionPass().consumed > 0) { /* drain bounded projection slices */ }

  const allowedModels = new Set([...knownModels, "other", "unknown"]);
  for (const profile of ["local", "user"]) {
    for (const [instrument, perRow] of [["mission.usage.tokens", 15], ["mission.usage.cost", 0.25]] as const) {
      const rows = openDb().prepare(
        `SELECT dimensions_json, value FROM telemetry_series WHERE profile = ? AND instrument = ?`,
      ).all(profile, instrument) as Array<{ dimensions_json: string; value: number }>;
      assert.equal(rows.length, allowedModels.size * 2, `${instrument}: model count is bounded per origin`);
      for (const row of rows) {
        const dimensions = JSON.parse(row.dimensions_json) as Record<string, string>;
        assert.ok(allowedModels.has(dimensions.model_id!), `unexpected metric model: ${dimensions.model_id}`);
        assert.ok(["authoring", "automation"].includes(dimensions.usage_origin!));
        if (instrument === "mission.usage.cost") assert.equal(dimensions.cost_basis, "api-equivalent");
        assert.equal(row.value, perRow * (dimensions.model_id === "other" ? customModels.length : 1));
      }
      assert.equal(rows.reduce((sum, row) => sum + row.value, 0), models.length * 2 * perRow);
    }
  }

  const batches = openDb().prepare(
    `SELECT signal, payload_json FROM telemetry_batches WHERE profile = 'user'`,
  ).all() as Array<{ signal: string; payload_json: string }>;
  const usagePoints = batches.filter((batch) => batch.signal === "metrics")
    .flatMap((batch) => (JSON.parse(batch.payload_json) as MetricsBatchPayload).metrics)
    .filter((point) => point.name === "mission.usage.tokens" || point.name === "mission.usage.cost");
  assert.ok(usagePoints.length > 0);
  for (const point of usagePoints) assert.ok(allowedModels.has(point.attributes.model_id!));

  // Bucketing is metric-only: detailed model attribution remains available for joins.
  const rawUsageModels = new Set(journal("mission.usage.recorded").map((row) => row.facts.model_id));
  for (const modelId of customModels) assert.ok(rawUsageModels.has(modelId));
  const spans = batches.filter((batch) => batch.signal === "traces")
    .flatMap((batch) => (JSON.parse(batch.payload_json) as TracesBatchPayload).spans);
  const segment = spans.find((span) => span.name === "mission.session.segment");
  assert.ok(segment);
  assert.equal(segment.attributes["mission.model_id"], customModels[0]);
});

test("canonical usage is counted once, with authoring and automation kept apart", () => {
  enableLocalOnly();
  const row = {
    usageOrigin: "authoring" as const,
    costBasis: "api-equivalent" as const,
    modelId: "gpt-5-codex",
    input: 100,
    output: 20,
    reasoningOutput: 5,
    cacheRead: 10,
    cacheWrite: 0,
    costUsd: 0.25,
  };
  // The SAME ledger identity twice: a re-read rollout, a retried POST, a replayed driver tail.
  assert.equal(observeUsageRecorded({ identity: "conv|m|src|42", ...row }).kind, "accepted");
  assert.equal(observeUsageRecorded({ identity: "conv|m|src|42", ...row }).kind, "duplicate");
  observeUsageRecorded({
    identity: "inspector|run-1|gpt-5-codex",
    ...row,
    usageOrigin: "automation",
  });

  runProjectionPass();
  const tokens = openDb()
    .prepare(
      `SELECT dimensions_json, value FROM telemetry_series
       WHERE instrument = 'mission.usage.tokens' ORDER BY dimensions_key`,
    )
    .all() as unknown as Array<{ dimensions_json: string; value: number }>;
  assert.equal(tokens.length, 2, "authoring and automation are separate series, not one total");
  for (const t of tokens) assert.equal(t.value, 135, "tokens are the ledger's, counted once");
  assert.deepEqual(
    tokens.map((t) => JSON.parse(t.dimensions_json).usage_origin).sort(),
    ["authoring", "automation"],
  );
});

test("an unpriced row contributes no dollars and stays countable as unpriced", () => {
  enableLocalOnly();
  observeUsageRecorded({
    identity: "conv|m|src|7",
    usageOrigin: "authoring",
    costBasis: "api-equivalent",
    modelId: "some-model",
    input: 10,
    output: 1,
    reasoningOutput: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: null,
  });
  const [usage] = journal("mission.usage.recorded");
  assert.equal(usage?.facts.cost_basis, "unpriced");
  assert.equal(usage?.facts.cost_usd, 0);
});

// ---- privacy ----

test("no pane id, tty, path, prompt or title reaches an exported record", () => {
  enableLocalOnly();
  noteDispatchLaunch("task-1", "/tmp/checkout/secret-branch");
  host().tasks.set("task-1", { id: "task-1", kind: "ship", extraRepos: [], sessionId: null } as never);
  upsert({
    name: "a tab title nobody should export",
    terminals: [
      { kind: "multiplexer", backend: "tmux", sessionName: "private", windowName: "w", pane: "%12" },
      { kind: "emulator", backend: "ghostty", windowId: "9", tabTitle: "secret", isActive: true },
    ],
    meta: metaAt("claude-opus-5", "high"),
    agentSessionId: "conv-1",
  });
  observeSessionOperation({
    session: { id: session().id as string, agent: "claude", runtime: "terminal", agentSessionId: "conv-1" },
    operation: "send",
    outcome: "delivered",
    actor: { kind: "human", origin: "dashboard", basis: "app_context" },
  });
  host().emit({ type: "session_remove", id: session().id });

  const facts = journal().map((r) => JSON.stringify(r.facts)).join(" ");
  for (const sentinel of [
    "secret-branch",
    "a tab title nobody should export",
    "%12",
    "ttys001",
    "4242",
    "private",
    "secret",
    "/tmp/checkout",
  ]) {
    assert.ok(!facts.includes(sentinel), `${sentinel} must not appear in an exported fact`);
  }
  // The terminal AXES do travel - a multiplexer type is bounded vocabulary, not operator data.
  const started = journal("mission.session.started")[0];
  assert.equal(started?.facts.multiplexer, "tmux");
  assert.equal(started?.facts.emulator, "ghostty");
});

test("every Phase 3 event refuses a fact its schema never declared", () => {
  // The strict-schema boundary, checked against the entries this phase added rather than
  // assumed from the helper: this is what stops an internal Session or Task being spread into
  // an envelope by a later hook that finds it convenient.
  const phase3 = Object.values(TELEMETRY_EVENTS).filter(
    (e) => e.group === "session_lifecycle" || e.group === "model_effort" ||
      e.group === "task_outcome" || e.group === "pr_outcome",
  );
  assert.ok(phase3.length >= 11, "the phase's entries are registered");
  for (const event of phase3) {
    const parsed = event.facts.safeParse({ cwd: "/tmp/secret" });
    assert.equal(parsed.success, false, `${event.name} admitted an undeclared fact`);
  }
});

// ---- restart ----

for (const [model, effort] of [["claude-opus-5", "high"], ["claude-sonnet-4-6", "medium"]]) {
  test(`the first post-restart segment retains new attribution: ${model}/${effort}`, (t) => {
    enableLocalOnly();
    t.mock.method(Date, "now", () => 10_000);
    upsert({ agentSessionId: "conv-1", meta: metaAt("claude-opus-5", "medium") });
    const [original] = journal("mission.session.segment.opened");
    runProjectionPass();

    closeDb();
    resetSessionTelemetryForTesting();
    attached = null;
    upsert({ agentSessionId: "conv-1", meta: metaAt(model!, effort!) });
    upsert({ agentSessionId: "conv-1", meta: metaAt(model!, effort!) });

    const segments = journal("mission.session.segment.opened");
    assert.equal(segments.length, 2, "re-adoption must not collide with segment 1 before restart");
    assert.deepEqual(segments[0], original, "historical attribution remains immutable");
    assert.equal(segments[1]?.facts.model_id, model);
    assert.equal(segments[1]?.facts.effort, effort);
    assert.notEqual(segments[1]?.refs.segment_id, original?.refs.segment_id);
    assert.equal(journal("mission.session.started").length, 1);
    runProjectionPass();
    runProjectionPass();
    const total = openDb().prepare(
      "SELECT SUM(value) AS value FROM telemetry_series WHERE instrument = 'mission.session.segments'",
    ).get() as { value: number };
    assert.equal(total.value, 2, "both segments contribute once, including after replay");
  });
}

test("the first completed turn after restart has a new identity", (t) => {
  enableLocalOnly();
  t.mock.method(Date, "now", () => 10_000);
  const context = { agentSessionId: "conv-1", meta: metaAt("claude-opus-5", "medium") };
  upsert(context);
  upsert({ ...context, state: "working" });
  upsert(context);
  closeDb();
  resetSessionTelemetryForTesting();
  attached = null;
  upsert(context);
  upsert({ ...context, state: "working" });
  upsert(context);
  const turns = journal("mission.session.turn.finished");
  assert.equal(turns.length, 2);
  assert.notEqual(turns[0]?.sourceId, turns[1]?.sourceId);
  assert.notEqual(turns[0]?.refs.segment_id, turns[1]?.refs.segment_id);
});

test("unrecognized attribution is recorded as unknown instead of a concrete default", () => {
  enableLocalOnly();
  noteDispatchLaunch("future-task", "/tmp/checkout");
  host().tasks.set("future-task", { kind: "future-kind", extraRepos: [] });
  const future = session({ agent: "future-agent", runtime: "future-runtime" });
  upsert(future);
  const [started] = journal("mission.session.started");
  assert.equal(started?.facts.agent, "unknown");
  assert.equal(started?.facts.runtime, "unknown");
  assert.equal(started?.facts.task_kind, "unknown", "unknown kind is different from no task");
  const [segment] = journal("mission.session.segment.opened");
  assert.equal(segment?.facts.agent, "unknown");
  assert.equal(segment?.facts.runtime, "unknown");

  assert.equal(observeDispatchFinished({
    taskId: "future-task", agent: "future-agent", runtime: "future-runtime", taskKind: "future-kind",
    resolvedModel: null, resolvedEffort: "future-effort", resolutionSource: "harness",
    repoCount: 1, outcome: "failed",
  } as never).kind, "accepted");
  const [dispatch] = journal("mission.dispatch.finished");
  assert.equal(dispatch?.facts.agent, "unknown");
  assert.equal(dispatch?.facts.runtime, "unknown");
  assert.equal(dispatch?.facts.task_kind, "unknown");
  assert.equal(dispatch?.facts.resolved_effort, "unknown");

  assert.equal(observeEffortSelected({
    session: future, requested: "future-effort", outcome: "refused", applies: "unknown",
    actor: { kind: "human", origin: "dashboard", basis: "app_context" },
  } as never).kind, "accepted");
  const [selection] = journal("mission.session.effort.selected");
  assert.equal(selection?.facts.requested_effort, "unknown");

  host().emit({ type: "task_upsert", task: {
    id: "future-task", kind: "future-kind", status: "done", outcome: "completed",
    sessionId: future.id, extraRepos: [], dispatchedAt: 1_000,
  } });
  assert.equal(journal("mission.task.outcome")[0]?.facts.task_kind, "unknown");
  runProjectionPass();
  const rows = openDb().prepare(
    "SELECT dimensions_json FROM telemetry_series WHERE instrument = 'mission.dispatches'",
  ).all() as Array<{ dimensions_json: string }>;
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0]!.dimensions_json).agent, "unknown");
});

test("an unrecognized observed effort does not inherit the previous segment's level", () => {
  enableLocalOnly();
  upsert({ meta: metaAt("claude-opus-5", "medium") });
  upsert({ meta: metaAt("claude-opus-5", "future-effort") });
  const segments = journal("mission.session.segment.opened");
  assert.equal(segments.length, 2);
  assert.equal(segments[0]?.facts.effort, "medium");
  assert.equal(segments[1]?.facts.effort, "unknown");
  assert.equal(segments[1]?.facts.quality, "unknown");
});

for (const value of [null, "unsupported"]) {
  test(`resolved effort preserves ${value === null ? "missing" : "unsupported"} attribution`, () => {
    enableLocalOnly();
    const expected = value ?? "unknown";
    assert.equal(observeDispatchFinished({
      taskId: "task-effort", agent: "claude", runtime: "sdk", taskKind: "ship",
      resolvedModel: null, resolvedEffort: value, resolutionSource: "harness",
      repoCount: 1, outcome: "failed",
    }).kind, "accepted");
    assert.equal(journal("mission.dispatch.finished")[0]?.facts.resolved_effort, expected);
  });
}

test("attribution frozen before a restart survives it unchanged", () => {
  enableLocalOnly();
  upsert({ agentSessionId: "conv-1", meta: metaAt("claude-opus-5", "high") });
  const before = journal("mission.session.segment.opened").map((r) => ({ ...r.facts }));
  assert.equal(before.length, 1);

  closeDb();
  openDb();
  runProjectionPass();
  runProjectionPass();

  const after = journal("mission.session.segment.opened").map((r) => ({ ...r.facts }));
  assert.deepEqual(after, before, "a replay re-reads the original facts; it does not recompute them");

  const rows = openDb()
    .prepare(`SELECT value FROM telemetry_series WHERE instrument = 'mission.session.segments'`)
    .all() as unknown as Array<{ value: number }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.value, 1, "a second projection pass must not re-increment a checkpointed event");
});

// ---- helpers ----

function metaAt(modelId: string, thinkingLevel: string | null): Record<string, unknown> {
  return {
    model: modelId,
    modelId,
    longContext: false,
    thinkingLevel,
    thinkingEnabled: null,
    contextPct: null,
    contextTokens: null,
    contextWindow: null,
    source: "statusline",
    updatedAt: 1_700_000_000_000,
  };
}

// ---- launch-resolved provenance, and the work-open relationship ----

test("a harness that never reports effort keeps its launch-resolved choice, at its own quality", () => {
  enableLocalOnly();
  // The dispatcher resolved `high` and the session reports no metadata at all - which is the
  // ordinary case for a harness with no effective-effort readback.
  noteDispatchLaunch("task-7", "/tmp/checkout", { model: "claude-opus-5", effort: "high" });
  host().tasks.set("task-7", { id: "task-7", kind: "ship", extraRepos: [], sessionId: null } as never);
  upsert();
  const [segment] = journal("mission.session.segment.opened");
  assert.equal(segment?.facts.effort, "high");
  // NOT `observed`. "We chose high and cannot confirm it ran" and "high actually ran" are
  // different claims, and only the weaker one is true here.
  assert.equal(segment?.facts.quality, "launch_resolved");
  assert.equal(segment?.facts.model_id, "claude-opus-5");
  assert.equal(segment?.facts.meta_source, "none");
});

test("an observation replaces a launch-resolved value and upgrades its quality", () => {
  enableLocalOnly();
  noteDispatchLaunch("task-7", "/tmp/checkout", { model: "claude-opus-5", effort: "high" });
  host().tasks.set("task-7", { id: "task-7", kind: "ship", extraRepos: [], sessionId: null } as never);
  upsert();
  upsert({ agentSessionId: "conv-1", meta: metaAt("claude-opus-5", "medium") });
  const segments = journal("mission.session.segment.opened");
  assert.equal(segments.at(-1)?.facts.effort, "medium");
  assert.equal(segments.at(-1)?.facts.quality, "observed");
});

test("a session that leaves with its task still open says so; one that does not, does not", () => {
  enableLocalOnly();
  noteDispatchLaunch("task-8", "/tmp/checkout");
  host().tasks.set("task-8", { id: "task-8", kind: "ship", extraRepos: [], sessionId: null } as never);
  upsert();
  host().emit({ type: "session_remove", id: session().id });
  assert.equal(journal("mission.session.ended")[0]?.facts.ended_while_work_open, true);

  // Now the same shape, with the task settled first. The regression this guards is a
  // comparison on the ATTEMPT key - which carries a dispatch time a departing session does not
  // know - reporting every ending as leaving work open.
  resetSessionTelemetryForTesting();
  attached = null;
  openDb().exec("DELETE FROM telemetry_journal; DELETE FROM telemetry_source_identities");
  noteDispatchLaunch("task-8", "/tmp/checkout");
  host().tasks.set("task-8", { id: "task-8", kind: "ship", extraRepos: [], sessionId: null } as never);
  upsert();
  host().emit({
    type: "task_upsert",
    task: { id: "task-8", kind: "ship", status: "done", extraRepos: [], sessionId: null, outcome: "shipped", dispatchedAt: 1_000 },
  });
  host().emit({ type: "session_remove", id: session().id });
  assert.equal(journal("mission.session.ended")[0]?.facts.ended_while_work_open, false);
});

test("two segments opening in the same millisecond are two segments", () => {
  enableLocalOnly();
  // A conversation binding and the first metadata read routinely land in one tick. When the
  // segment identity carried the clock, the second was refused as a duplicate and nothing
  // counted the loss - so the session's first observed model silently never appeared.
  upsert({ agentSessionId: "conv-1", meta: metaAt("claude-opus-5", "medium") });
  upsert({ agentSessionId: "conv-2", meta: metaAt("claude-opus-5", "high") });
  upsert({ agentSessionId: "conv-3", meta: metaAt("gpt-5-codex", "high") });
  const segments = journal("mission.session.segment.opened");
  assert.equal(segments.length, 3);
  assert.equal(new Set(segments.map((s) => s.refs.segment_id)).size, 3);
  assert.deepEqual(
    segments.map((s) => s.facts.effort),
    ["medium", "high", "high"],
  );
});

test("a handoff to a terminal is a handoff, not an unexplained departure", async () => {
  enableLocalOnly();
  const { noteSessionHandoff } = await import("../src/server/telemetry/sessions.ts");
  upsert({ id: "sdk:handoff", runtime: "sdk" });
  // The SDK entry is replaced by a terminal successor under a new id. Without a marker the
  // departure reads `unknown` - indistinguishable from a crash, on the one path where nothing
  // went wrong at all.
  noteSessionHandoff("sdk:handoff");
  host().emit({ type: "session_remove", id: "sdk:handoff" });
  assert.equal(journal("mission.session.ended")[0]?.facts.reason, "handoff");
});

test("a restoration that fails is recorded as an attempt, not as a session", () => {
  enableLocalOnly();
  // A row whose harness this build no longer has cannot be resumed. It is still an attempted
  // restoration - and it never becomes a session, which is why the outcome lives on its own
  // event rather than as a field of `mission.session.started`.
  observeSessionRestore({
    sessionId: "sdk:gone",
    taskId: "task-r",
    agent: "claude",
    outcome: "failed",
    durationMs: 1_200,
    turnInProgress: true,
  });
  const [restore] = journal("mission.session.restore.finished");
  assert.equal(restore?.facts.outcome, "failed");
  assert.equal(restore?.facts.turn_in_progress, true);
  assert.equal(restore?.facts.duration_ms, 1_200);
  assert.equal(journal("mission.session.started").length, 0);
});

test("a signal arriving mid-handshake is interrupted, which is neither success nor failure", () => {
  enableLocalOnly();
  observeSessionRestore({
    sessionId: "sdk:mid",
    taskId: null,
    agent: "claude",
    outcome: "interrupted",
    durationMs: 40,
    turnInProgress: false,
  });
  // Folding this into either bucket would misreport how often restoration actually works.
  assert.equal(journal("mission.session.restore.finished")[0]?.facts.outcome, "interrupted");
});
