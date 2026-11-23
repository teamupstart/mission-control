// Work unit id, Phase 3: the unhashed `work_unit_id` span attribute.
//
// The claims are about what reaches a backend, so the oracles are the journal a capture wrote
// and the spans the real projection engine built for each lane. What is under test:
//
//  - one raw value in every lane, never `mission.ref.work_unit_id`, and only a well-formed id;
//  - capture reads the session's launch record (Phase 2) and never the flag or the task, so a
//    span carries exactly what the agent carries - from the first event on, before a task is
//    bound, across a switch of the preview and across a reused agent;
//  - a span that reports a launch attempt carries that attempt's decision.
//
// See docs/work-units.md, "Telemetry", and docs/observability.md, "Work unit id".
import { MISSION_TEST_MCP_DEPS } from "./helpers/mission-mcp-deps.ts";
import { mkSession, mkTask } from "./helpers/session-fixture.ts";
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session, Task } from "../src/shared/types.ts";
import type { SdkSessionHandle } from "../src/server/harness/types.ts";
import type { TracesBatchPayload } from "../src/server/telemetry/projection.ts";

const home = mkdtempSync(join(tmpdir(), "mission-telemetry-work-unit-"));
// Set before importing anything that resolves the state dir.
process.env.HARNESS_HOME = join(home, "state");

const { closeDb, openDb, upsertTask } = await import("../src/server/db.ts");
const { applyFeatureFlagIntent } = await import("../src/server/feature-flags/index.ts");
const { WORK_UNIT_ID_FLAG_ID } = await import("../src/shared/feature-flag-registry.ts");
const { setTelemetryConfig } = await import("../src/server/telemetry/config.ts");
const { captureTelemetry } = await import("../src/server/telemetry/capture.ts");
const { runProjectionPass } = await import("../src/server/telemetry/projection.ts");
const { toReadableSpans } = await import("../src/server/telemetry/otlp.ts");
const { registerBuiltinTelemetry } = await import("../src/server/telemetry/service.ts");
const { attachPrObservationTelemetry, retainPrObservation, recordTelemetryPrMerges } = await import(
  "../src/server/telemetry/pr-observations.ts"
);
const {
  attachSessionTelemetry,
  noteDispatchLaunch,
  observeDispatchFinished,
  observeEffortSelected,
  observeKillRequested,
  observeSessionOperation,
  resetSessionTelemetryForTesting,
  workflowAuthorContext,
} = await import("../src/server/telemetry/sessions.ts");
const { SESSION_KILL_REQUESTED_EVENT } = await import("../src/shared/telemetry-catalog.ts");
const { TELEMETRY_LIMITS } = await import("../src/shared/telemetry.ts");
const { HARNESSES } = await import("../src/server/harness/index.ts");
const { Registry } = await import("../src/server/registry.ts");
const { SdkSupervisor } = await import("../src/server/sdk/supervisor.ts");
const { upsertSdkSession } = await import("../src/server/sdk/store.ts");

registerBuiltinTelemetry();

after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

const WU_A = "wu_01JD00000000000000000000AA";
const WU_B = "wu_01JD00000000000000000000BB";
const HUMAN = { kind: "human", origin: "dashboard", basis: "app_context" } as const;

beforeEach(() => {
  const d = openDb();
  for (const table of [
    "telemetry_journal",
    "telemetry_source_identities",
    "telemetry_projection_state",
    "telemetry_series",
    "telemetry_contexts",
    "telemetry_resources",
    "telemetry_gaps",
    "telemetry_batches",
    "telemetry_pr_observations",
    "telemetry_source_state",
  ]) {
    d.exec(`DELETE FROM ${table}`);
  }
  d.exec("DELETE FROM app_config");
  resetSessionTelemetryForTesting();
  // Both exporting lanes, so a projection pass builds a batch for each.
  assert.equal(setTelemetryConfig({
    enabled: true,
    user: { enabled: true, endpoint: "http://127.0.0.1:14318" },
    product: { enabled: true, endpoint: "http://127.0.0.1:14319" },
  }).ok, true);
});

function preview(enabled: boolean): void {
  assert.equal(applyFeatureFlagIntent({ kind: "flag", id: WORK_UNIT_ID_FLAG_ID, enabled }).ok, true);
}

/** Every journal row for `name`, in capture order. */
function journal(name: string): Array<{ facts: Record<string, unknown>; refs: Record<string, string> }> {
  return (openDb()
    .prepare("SELECT facts_json, refs_json FROM telemetry_journal WHERE name = ? ORDER BY seq")
    .all(name) as Array<{ facts_json: string; refs_json: string }>)
    .map((r) => ({ facts: JSON.parse(r.facts_json), refs: JSON.parse(r.refs_json) }));
}

/** The work unit each row of `name` carries, in order; null where it carries none. */
function workUnits(name: string): Array<string | null> {
  return journal(name).map((row) => row.refs.work_unit_id ?? null);
}

function exportedSpans(profile: "user" | "product"): TracesBatchPayload["spans"] {
  return (openDb()
    .prepare("SELECT payload_json FROM telemetry_batches WHERE profile = ? AND signal = 'traces'")
    .all(profile) as Array<{ payload_json: string }>)
    .flatMap((row) => (JSON.parse(row.payload_json) as TracesBatchPayload).spans);
}

function traceBatches(profile: "user" | "product"): TracesBatchPayload[] {
  return (openDb()
    .prepare("SELECT payload_json FROM telemetry_batches WHERE profile = ? AND signal = 'traces'")
    .all(profile) as Array<{ payload_json: string }>)
    .map((row) => JSON.parse(row.payload_json) as TracesBatchPayload);
}

/**
 * The Registry's event stream, plus the one optional read the observer makes for a task
 * outcome: a live session by id, for its launch record.
 */
class FakeHost {
  private listeners: Array<(e: never) => void> = [];
  readonly tasks = new Map<string, Task>();
  readonly sessions = new Map<string, Session>();
  subscribe(fn: (e: never) => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }
  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }
  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }
  upsert(session: Session): void {
    this.sessions.set(session.id, session);
    this.emit({ type: "session_upsert", session });
  }
  remove(id: string): void {
    this.sessions.delete(id);
    this.emit({ type: "session_remove", id });
  }
  task(task: Task): void {
    this.tasks.set(task.id, task);
    this.emit({ type: "task_upsert", task });
  }
  private emit(event: Record<string, unknown>): void {
    for (const listener of this.listeners.slice()) listener(event as never);
  }
}

function attachedHost(t: { after(fn: () => void): void }): FakeHost {
  const host = new FakeHost();
  t.after(attachSessionTelemetry(host as never));
  return host;
}

function idleHandle(): SdkSessionHandle {
  let release: (() => void) | null = null;
  return {
    events: {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<never>>((resolve) => {
          release = () => resolve({ done: true, value: undefined as never });
        }),
      }),
    },
    send: async () => "started" as const,
    sendIfIdle: async () => "started" as const,
    interrupt: async () => {},
    answer: async () => {},
    setPermissionMode: null,
    setEffort: null,
    setModel: null,
    clearContext: null,
    stop: async () => {
      release?.();
    },
  } as unknown as SdkSessionHandle;
}

// ---- the projection: one raw value in every lane ----

test("the same span reaches both lanes with the same raw work_unit_id, never hashed", () => {
  observeKillRequested({
    session: mkSession({ id: "sdk:projected", launchWorkUnitId: WU_A }),
    taskId: "task-projected",
    outcome: "accepted",
    actor: HUMAN,
  });
  runProjectionPass();

  const user = exportedSpans("user").filter((s) => s.name === "mission.session.kill");
  const product = exportedSpans("product").filter((s) => s.name === "mission.session.kill");
  assert.equal(user.length, 1);
  assert.equal(product.length, 1);
  assert.equal(user[0]!.attributes.work_unit_id, WU_A, "the raw id, under its own name");
  assert.equal(product[0]!.attributes.work_unit_id, WU_A, "identical in the other lane");
  // The ordinary refs stay per-destination hashes, so the two lanes still cannot be joined on them.
  assert.equal(typeof user[0]!.attributes["mission.ref.session_id"], "string");
  assert.notEqual(user[0]!.attributes["mission.ref.session_id"], product[0]!.attributes["mission.ref.session_id"]);
  for (const span of [...user, ...product]) {
    assert.equal("mission.ref.work_unit_id" in span.attributes, false, "never in hashed form");
    assert.equal(span.attributes["mission.event.version"], 1, "no event version moved");
  }
  // And it survives the OTLP conversion the exporter sends.
  const readable = traceBatches("product").flatMap(toReadableSpans).find((s) => s.name === "mission.session.kill");
  assert.equal(readable?.attributes.work_unit_id, WU_A);
});

test("one query on the raw id finds the spans of a plan's session and its phase's session in every lane", (t) => {
  const registry = new Registry();
  t.after(attachSessionTelemetry(registry));
  // A plan task and the phase task its session created share one work unit (Phase 1); each runs
  // in its own session, launched with that id. A third, unrelated piece of work has another.
  for (const [taskId, sessionId, workUnitId] of [
    ["task-plan", "sdk:plan", WU_A],
    ["task-phase", "sdk:phase", WU_A],
    ["task-other", "sdk:other", WU_B],
  ] as const) {
    noteDispatchLaunch(taskId, `/wt/${taskId}`);
    registry.registerSdkSession({ id: sessionId, agent: "claude", name: taskId, cwd: `/wt/${taskId}`, launchWorkUnitId: workUnitId });
    observeSessionOperation({ session: registry.getSession(sessionId)!, operation: "send", outcome: "delivered", actor: HUMAN });
    registry.upsertTask(mkTask({ id: taskId, workUnitId, status: "done", outcome: "ok", sessionId }));
  }
  runProjectionPass();

  for (const profile of ["user", "product"] as const) {
    const spans = exportedSpans(profile);
    // The query a person runs: the raw attribute, nothing else.
    const matched = spans.filter((s) => s.attributes.work_unit_id === WU_A);
    const sessions = new Set(matched.map((s) => s.attributes["mission.ref.session_id"]));
    assert.equal(sessions.size, 2, `${profile}: both sessions of the work unit are found`);
    assert.deepEqual(
      [...new Set(matched.map((s) => s.name))].sort(),
      ["mission.session.operation", "mission.session.segment", "mission.session.start", "mission.task.outcome"],
      `${profile}: every kind of span the two sessions emitted`,
    );
    // And nothing of the other piece of work.
    const other = spans.filter((s) => s.attributes.work_unit_id === WU_B);
    assert.ok(other.length > 0);
    for (const span of other) assert.equal(sessions.has(span.attributes["mission.ref.session_id"]), false);
    // Exactly the spans of those two sessions: everything they emitted carries the id.
    const ofSessions = spans.filter((s) => sessions.has(s.attributes["mission.ref.session_id"]));
    assert.equal(ofSessions.length, matched.length, `${profile}: no span of either session is missed`);
  }
});

test("a malformed id is dropped rather than hashed, and a span without one is unchanged", () => {
  captureTelemetry({
    event: SESSION_KILL_REQUESTED_EVENT,
    source: { kind: "mission.session", id: "kill:malformed", revision: 1 },
    facts: { agent: "claude", runtime: "sdk", outcome: "accepted", actor_basis: "owner" },
    refs: { session_id: "sdk:malformed", work_unit_id: "wu_not-a-ulid" },
  });
  observeKillRequested({
    session: mkSession({ id: "sdk:none", launchWorkUnitId: null }),
    outcome: "accepted",
    actor: HUMAN,
  });
  runProjectionPass();

  const spans = exportedSpans("user").filter((s) => s.name === "mission.session.kill");
  assert.equal(spans.length, 2);
  for (const span of spans) {
    assert.deepEqual(Object.keys(span.attributes).filter((key) => key.includes("work_unit")), []);
    assert.equal(typeof span.attributes["mission.ref.session_id"], "string", "the other refs are as before");
  }
  assert.equal(journal("mission.session.kill.requested")[1]!.refs.work_unit_id, undefined,
    "a session with no launch record stores nothing");
});

// ---- capture: from the session's launch record, from the first event ----

test("a launched session's spans carry its record from the first event, before any task is bound", (t) => {
  const registry = new Registry();
  t.after(attachSessionTelemetry(registry));

  // A dispatch: the launch intent supplies task identity, the task does not point here yet.
  noteDispatchLaunch("task-dispatched", "/wt/dispatched");
  registry.registerSdkSession({ id: "sdk:dispatched", agent: "claude", name: "d", cwd: "/wt/dispatched", launchWorkUnitId: WU_A });
  // A runtime transfer target: newly registered, announced with no task identity at all.
  registry.registerSdkSession({ id: "sdk:transfer", agent: "claude", name: "t", cwd: "/wt/transfer", launchWorkUnitId: WU_B });

  const starts = journal("mission.session.started");
  assert.deepEqual(starts.map((row) => [row.facts.origin, row.refs.task_id ?? null, row.refs.work_unit_id]), [
    ["dispatch", "task-dispatched", WU_A],
    ["discovered", null, WU_B],
  ]);
  // The first segment is captured with the start, and carries it too.
  assert.deepEqual(workUnits("mission.session.segment.opened"), [WU_A, WU_B]);

  // Effort and operation spans between the first event and the task binding.
  const live = registry.getSession("sdk:dispatched")!;
  assert.equal(registry.getTask("task-dispatched"), undefined, "no task is bound to it yet");
  observeEffortSelected({ session: live, requested: "high", outcome: "accepted", applies: "next_turn", actor: HUMAN });
  observeSessionOperation({ session: live, operation: "send", outcome: "delivered", actor: HUMAN });
  observeSessionOperation({ session: registry.getSession("sdk:transfer")!, operation: "interrupt", outcome: "delivered", actor: HUMAN });
  assert.deepEqual(workUnits("mission.session.effort.selected"), [WU_A]);
  assert.deepEqual(workUnits("mission.session.operation"), [WU_A, WU_B]);
});

test("discovered, resident and flag-off sessions carry nothing, whatever their task holds", (t) => {
  const host = attachedHost(t);
  // A pane Mission Control did not start.
  host.upsert(mkSession({ id: "proc:discovered", cwd: "/wt/discovered" }));
  // A resident's run: its task has no id (D6), and its launch has no record.
  noteDispatchLaunch("task-resident", "/wt/resident");
  host.tasks.set("task-resident", mkTask({ id: "task-resident", kind: "resident", workUnitId: null }));
  host.upsert(mkSession({ id: "sdk:resident", cwd: "/wt/resident", launchWorkUnitId: null }));
  // An agent started with the preview off: its task HAS an id, its environment does not.
  noteDispatchLaunch("task-off", "/wt/off");
  host.tasks.set("task-off", mkTask({ id: "task-off", workUnitId: WU_A }));
  host.upsert(mkSession({ id: "sdk:off", cwd: "/wt/off", launchWorkUnitId: null }));
  host.upsert(mkSession({ id: "sdk:off", cwd: "/wt/off", launchWorkUnitId: null, state: "working" }));
  host.upsert(mkSession({ id: "sdk:off", cwd: "/wt/off", launchWorkUnitId: null, state: "idle" }));
  host.remove("sdk:off");
  host.task(mkTask({ id: "task-off", workUnitId: WU_A, status: "done", outcome: "shipped", sessionId: "sdk:off" }));

  for (const name of [
    "mission.session.started",
    "mission.session.segment.opened",
    "mission.session.turn.finished",
    "mission.session.ended",
    "mission.task.outcome",
  ]) {
    assert.ok(journal(name).length > 0, `${name} was captured`);
    assert.deepEqual(workUnits(name).filter(Boolean), [], `${name} carries no work unit`);
  }
});

test("turn, end and task outcome carry the record; a task of another unit, or none, gets nothing", (t) => {
  const host = attachedHost(t);
  noteDispatchLaunch("task-a", "/wt/a");
  host.tasks.set("task-a", mkTask({ id: "task-a", workUnitId: WU_A }));
  const base = { id: "sdk:a", cwd: "/wt/a", launchWorkUnitId: WU_A } as const;
  host.upsert(mkSession({ ...base }));
  host.upsert(mkSession({ ...base, state: "working" }));
  host.upsert(mkSession({ ...base, state: "idle" }));
  assert.deepEqual(workUnits("mission.session.turn.finished"), [WU_A]);

  // A task outcome while its task points to this session: the record, read through the host.
  host.task(mkTask({ id: "task-a", workUnitId: WU_A, status: "done", outcome: "ok", sessionId: "sdk:a" }));
  // A task whose own id differs carries nothing: the agent does not carry ITS id.
  host.task(mkTask({ id: "task-other", workUnitId: WU_B, status: "done", outcome: "ok", sessionId: "sdk:a" }));
  // A task that points to no session carries nothing.
  host.task(mkTask({ id: "task-unbound", workUnitId: WU_A, status: "cancelled", sessionId: null }));
  assert.deepEqual(workUnits("mission.task.outcome"), [WU_A, null, null]);

  // The session leaves; its end span carries the record, and a task that settles afterwards
  // still reads what the session it points to held.
  host.remove("sdk:a");
  assert.deepEqual(workUnits("mission.session.ended"), [WU_A]);
  host.task(mkTask({ id: "task-late", workUnitId: WU_A, status: "failed", sessionId: "sdk:a" }));
  assert.equal(workUnits("mission.task.outcome").at(-1), WU_A);
});

test("a task settling long after its session left keeps the id, past any number of departures and a restart", (t) => {
  let host = attachedHost(t);
  // The session whose task settles late leaves FIRST; then far more sessions than any in-memory
  // bound would hold leave after it. Ids alternate, so a value read from the wrong session shows.
  const idOf = (i: number) => (i % 2 === 0 ? WU_A : WU_B);
  const departures = 600;
  for (let i = 0; i < departures; i += 1) {
    host.upsert(mkSession({ id: `sdk:ended-${i}`, cwd: `/wt/ended-${i}`, launchWorkUnitId: idOf(i) }));
    host.remove(`sdk:ended-${i}`);
  }
  const settle = (i: number, task = `task-ended-${i}`) =>
    host.task(mkTask({ id: task, workUnitId: idOf(i), status: "failed", sessionId: `sdk:ended-${i}` }));
  settle(0);
  settle(1);
  settle(departures - 1);
  assert.deepEqual(workUnits("mission.task.outcome"), [idOf(0), idOf(1), idOf(departures - 1)]);

  // A daemon restart: every in-memory observation is gone and the database is reopened.
  resetSessionTelemetryForTesting();
  closeDb();
  openDb();
  host = attachedHost(t);
  settle(2);
  settle(3);
  assert.deepEqual(workUnits("mission.task.outcome").slice(3), [idOf(2), idOf(3)]);

  // Found by the query a person runs: the raw id on the exported span. A pass is bounded, so
  // drain the whole journal.
  while (runProjectionPass().consumed > 0) { /* drain */ }
  const outcomes = exportedSpans("user").filter((s) => s.name === "mission.task.outcome");
  assert.deepEqual(
    outcomes.map((s) => s.attributes.work_unit_id ?? null),
    [idOf(0), idOf(1), idOf(departures - 1), idOf(2), idOf(3)],
    "every late outcome is found by its own raw id",
  );
});

test("the two documented limits: past the retention, or across a consent change, a late outcome carries no id", (t) => {
  let now = 1_700_000_000_000;
  t.mock.method(Date, "now", () => now);
  const host = attachedHost(t);
  for (const id of ["sdk:expired", "sdk:kept", "sdk:consent"]) {
    host.upsert(mkSession({ id, cwd: `/wt/${id}`, launchWorkUnitId: WU_A }));
    host.remove(id);
  }
  const settle = (sessionId: string) =>
    host.task(mkTask({ id: `task-${sessionId}`, workUnitId: WU_A, status: "failed", sessionId }));

  // Just inside the retention the id is still there; just past it, it is gone - and nothing else
  // is put in its place.
  now += TELEMETRY_LIMITS.reducerStateRetentionMs - 1;
  settle("sdk:kept");
  now += 2;
  settle("sdk:expired");
  assert.deepEqual(workUnits("mission.task.outcome"), [WU_A, null]);

  // A consent cycle wipes every source checkpoint, the mirror among them.
  now = 1_700_000_000_000;
  assert.equal(setTelemetryConfig({ enabled: false }).ok, true);
  assert.equal(setTelemetryConfig({ enabled: true }).ok, true);
  settle("sdk:consent");
  assert.deepEqual(workUnits("mission.task.outcome").slice(2), [null]);
  assert.equal(journal("mission.task.outcome").at(-1)?.refs.session_id, "sdk:consent", "the outcome is still exported");
});

test("the retention counts from when a session was last seen: at removal, and daily while it runs unchanged", (t) => {
  const DAY = 24 * 60 * 60 * 1000;
  let now = 1_700_000_000_000;
  t.mock.method(Date, "now", () => now);
  let host = attachedHost(t);
  // Two sessions keep one unchanged record for 29 days. One is removed then; the other is never
  // seen leaving, as when the daemon stops without observing it.
  for (const id of ["sdk:long-removed", "sdk:long-crashed"]) {
    host.upsert(mkSession({ id, cwd: `/wt/${id}`, launchWorkUnitId: WU_A }));
  }
  for (let day = 1; day <= 29; day += 1) {
    now += DAY;
    for (const id of ["sdk:long-removed", "sdk:long-crashed"]) {
      host.upsert(mkSession({ id, cwd: `/wt/${id}`, launchWorkUnitId: WU_A, state: day % 2 ? "working" : "idle" }));
    }
  }
  host.remove("sdk:long-removed");
  // A restart, then the tasks settle 29 days later: 58 days after the record last CHANGED, and
  // inside the retention counted from when each session was last seen.
  resetSessionTelemetryForTesting();
  closeDb();
  openDb();
  host = attachedHost(t);
  now += 29 * DAY;
  for (const id of ["sdk:long-removed", "sdk:long-crashed"]) {
    host.task(mkTask({ id: `task-${id}`, workUnitId: WU_A, status: "failed", sessionId: id }));
  }
  assert.deepEqual(workUnits("mission.task.outcome"), [WU_A, WU_A]);
});

test("removal alone renews the retention, before any daily refresh is due", (t) => {
  const HOUR = 60 * 60 * 1000;
  let now = 1_700_000_000_000;
  t.mock.method(Date, "now", () => now);
  let host = attachedHost(t);
  host.upsert(mkSession({ id: "sdk:short", cwd: "/wt/short", launchWorkUnitId: WU_A }));
  // Removed 23 hours later: no daily refresh has fallen due, so only removal can renew it.
  now += 23 * HOUR;
  host.remove("sdk:short");
  resetSessionTelemetryForTesting();
  host = attachedHost(t);
  // Past 30 days from the first sight, inside 30 days from the removal.
  now += TELEMETRY_LIMITS.reducerStateRetentionMs - 22 * HOUR;
  host.task(mkTask({ id: "task-short", workUnitId: WU_A, status: "failed", sessionId: "sdk:short" }));
  assert.deepEqual(workUnits("mission.task.outcome"), [WU_A]);
});

test("a refused write of a new id withdraws the old one, so a late outcome never reads an id from an earlier process", (t) => {
  let host = attachedHost(t);
  host.upsert(mkSession({ id: "sdk:refused", cwd: "/wt/refused", launchWorkUnitId: WU_A }));
  // From here the store refuses every write of WU_B's row (a budget refusal, say); deletes work.
  openDb().exec(`CREATE TEMP TRIGGER refuse_mirror BEFORE UPDATE ON telemetry_source_state
    WHEN NEW.state_json LIKE '%${WU_B}%' BEGIN SELECT RAISE(ABORT, 'scripted refusal'); END`);
  openDb().exec(`CREATE TEMP TRIGGER refuse_mirror_insert BEFORE INSERT ON telemetry_source_state
    WHEN NEW.state_json LIKE '%${WU_B}%' BEGIN SELECT RAISE(ABORT, 'scripted refusal'); END`);
  t.after(() => openDb().exec("DROP TRIGGER IF EXISTS refuse_mirror; DROP TRIGGER IF EXISTS refuse_mirror_insert"));
  // A resume that started the agent with another work unit, then the session leaves.
  host.upsert(mkSession({ id: "sdk:refused", cwd: "/wt/refused", launchWorkUnitId: WU_B }));
  host.remove("sdk:refused");
  resetSessionTelemetryForTesting();
  host = attachedHost(t);
  // A task of the EARLIER process's work unit settles late: the mirror no longer holds WU_A.
  host.task(mkTask({ id: "task-refused-old", workUnitId: WU_A, status: "failed", sessionId: "sdk:refused" }));
  assert.deepEqual(workUnits("mission.task.outcome"), [null]);
  assert.equal(openDb().prepare(
    "SELECT COUNT(*) AS n FROM telemetry_source_state WHERE namespace = 'mission.session.launch-record' AND id = 'sdk:refused'",
  ).get()?.n, 0, "the stale row is gone");
});

test("a mirror write that failed is retried on the next observation, not a day later", (t) => {
  let host = attachedHost(t);
  const refuse = (on: boolean) => openDb().exec(on
    ? `CREATE TEMP TRIGGER refuse_retry BEFORE INSERT ON telemetry_source_state
        WHEN NEW.id = 'sdk:retry' BEGIN SELECT RAISE(ABORT, 'scripted refusal'); END`
    : "DROP TRIGGER IF EXISTS refuse_retry");
  t.after(() => refuse(false));
  refuse(true);
  host.upsert(mkSession({ id: "sdk:retry", cwd: "/wt/retry", launchWorkUnitId: WU_A }));
  // Storage recovers; the same unchanged record is observed again, minutes later.
  refuse(false);
  host.upsert(mkSession({ id: "sdk:retry", cwd: "/wt/retry", launchWorkUnitId: WU_A, state: "working" }));
  // The daemon stops without seeing the session leave, then restarts.
  resetSessionTelemetryForTesting();
  host = attachedHost(t);
  host.task(mkTask({ id: "task-retry", workUnitId: WU_A, status: "failed", sessionId: "sdk:retry" }));
  assert.deepEqual(workUnits("mission.task.outcome"), [WU_A]);
});

test("a session whose mirror could be neither replaced nor withdrawn is never read for attribution", (t) => {
  const host = attachedHost(t);
  host.upsert(mkSession({ id: "sdk:unsettled", cwd: "/wt/unsettled", launchWorkUnitId: WU_A }));
  // From here storage refuses to write WU_B's row AND to delete the old one.
  openDb().exec(`CREATE TEMP TRIGGER refuse_write_b BEFORE UPDATE ON telemetry_source_state
    WHEN NEW.state_json LIKE '%${WU_B}%' BEGIN SELECT RAISE(ABORT, 'scripted refusal'); END`);
  openDb().exec(`CREATE TEMP TRIGGER refuse_delete BEFORE DELETE ON telemetry_source_state
    WHEN OLD.id = 'sdk:unsettled' BEGIN SELECT RAISE(ABORT, 'scripted refusal'); END`);
  t.after(() => openDb().exec("DROP TRIGGER IF EXISTS refuse_write_b; DROP TRIGGER IF EXISTS refuse_delete"));
  host.upsert(mkSession({ id: "sdk:unsettled", cwd: "/wt/unsettled", launchWorkUnitId: WU_B }));
  host.remove("sdk:unsettled");
  // The stale WU_A row is still stored, and is not read: the late outcome claims nothing.
  assert.equal((openDb().prepare(
    "SELECT state_json FROM telemetry_source_state WHERE namespace = 'mission.session.launch-record' AND id = 'sdk:unsettled'",
  ).get() as { state_json: string } | undefined)?.state_json.includes(WU_A), true, "the stale row could not be removed");
  host.task(mkTask({ id: "task-unsettled-old", workUnitId: WU_A, status: "failed", sessionId: "sdk:unsettled" }));
  assert.deepEqual(workUnits("mission.task.outcome"), [null]);
});

test("nothing is mirrored while collection is off, so a later opt-in cannot attribute from the gap", (t) => {
  const host = attachedHost(t);
  const mirrored = () => (openDb().prepare(
    "SELECT COUNT(*) AS n FROM telemetry_source_state WHERE namespace = 'mission.session.launch-record'",
  ).get() as { n: number }).n;
  assert.equal(setTelemetryConfig({ enabled: false }).ok, true);
  // A whole session life while collection is off: first sight, an unchanged refresh, removal.
  host.upsert(mkSession({ id: "sdk:gap", cwd: "/wt/gap", launchWorkUnitId: WU_A }));
  host.upsert(mkSession({ id: "sdk:gap", cwd: "/wt/gap", launchWorkUnitId: WU_A, state: "working" }));
  host.remove("sdk:gap");
  assert.equal(mirrored(), 0, "no work unit id is written into telemetry state while collection is off");
  // Collection comes back; the task settles. Nothing from the gap attributes it.
  assert.equal(setTelemetryConfig({ enabled: true }).ok, true);
  host.task(mkTask({ id: "task-gap", workUnitId: WU_A, status: "failed", sessionId: "sdk:gap" }));
  assert.deepEqual(workUnits("mission.task.outcome"), [null]);
  assert.equal(mirrored(), 0);
  // And a session observed after the opt-in is mirrored as usual.
  host.upsert(mkSession({ id: "sdk:after", cwd: "/wt/after", launchWorkUnitId: WU_A }));
  assert.equal(mirrored(), 1);
});

test("a session relaunched without a record overwrites what it held, so a late outcome claims nothing", (t) => {
  let host = attachedHost(t);
  host.upsert(mkSession({ id: "sdk:relaunched", cwd: "/wt/relaunched", launchWorkUnitId: WU_A }));
  host.remove("sdk:relaunched");
  // The next process sees it again, started with the preview off.
  resetSessionTelemetryForTesting();
  host = attachedHost(t);
  host.upsert(mkSession({ id: "sdk:relaunched", cwd: "/wt/relaunched", launchWorkUnitId: null }));
  host.remove("sdk:relaunched");
  // And a live resume that drops the record does the same.
  host.upsert(mkSession({ id: "sdk:resumed", cwd: "/wt/resumed", launchWorkUnitId: WU_A }));
  host.upsert(mkSession({ id: "sdk:resumed", cwd: "/wt/resumed", launchWorkUnitId: null }));
  host.remove("sdk:resumed");
  resetSessionTelemetryForTesting();
  host = attachedHost(t);
  host.task(mkTask({ id: "task-relaunched", workUnitId: WU_A, status: "failed", sessionId: "sdk:relaunched" }));
  host.task(mkTask({ id: "task-resumed", workUnitId: WU_A, status: "failed", sessionId: "sdk:resumed" }));
  assert.deepEqual(workUnits("mission.task.outcome"), [null, null]);
});

test("a reused agent with no record tags nothing, and a resume that changes the record is followed", (t) => {
  const host = attachedHost(t);
  // An agent started with no work unit, then handed a task that has one (assign allows it).
  host.upsert(mkSession({ id: "sdk:reused", cwd: "/wt/reused", launchWorkUnitId: null }));
  const reused = mkSession({ id: "sdk:reused", cwd: "/wt/reused", launchWorkUnitId: null });
  host.task(mkTask({ id: "task-typed", workUnitId: WU_A, status: "running", sessionId: "sdk:reused" }));
  observeSessionOperation({ session: reused, operation: "send", outcome: "delivered", actor: HUMAN });
  host.task(mkTask({ id: "task-typed", workUnitId: WU_A, status: "done", outcome: "ok", sessionId: "sdk:reused" }));
  assert.deepEqual(workUnits("mission.session.operation"), [null]);
  assert.deepEqual(workUnits("mission.task.outcome"), [null]);

  // A managed resume that succeeded replaced the record: every span from then on follows it.
  host.upsert(mkSession({ id: "sdk:reused", cwd: "/wt/reused", launchWorkUnitId: WU_B, state: "working" }));
  host.upsert(mkSession({ id: "sdk:reused", cwd: "/wt/reused", launchWorkUnitId: WU_B, state: "idle" }));
  assert.deepEqual(workUnits("mission.session.turn.finished"), [WU_B]);
  assert.equal(workflowAuthorContext("sdk:reused").refs.work_unit_id, WU_B, "the workflow author context follows it");
});

// ---- a switch of the preview, across restores ----

test("a restore decides once: its spans keep that decision across a switch, and change only at the next start", async (t) => {
  let failRestore = false;
  const real = HARNESSES.claude.sdk;
  HARNESSES.claude.sdk = {
    answersRequests: true,
    launch: async () => {
      if (failRestore) throw new Error("scripted: restore failed");
      return idleHandle();
    },
  };
  t.after(() => {
    HARNESSES.claude.sdk = real;
    preview(false);
  });

  const task = mkTask({ id: "task-restore", workUnitId: WU_A, status: "running", sessionId: "sdk:restore" });
  upsertTask(task);
  const row = () => upsertSdkSession({
    id: "sdk:restore", agent: "claude", agentSessionId: "restore-conversation", cwd: "/wt/restore",
    taskId: task.id, model: null, effort: null, permissionMode: null, status: "suspended", turnInProgress: false,
  });
  /** One daemon boot: a fresh registry, a fresh observer, the supervisor's restore pass. */
  const boot = async (whileRunning: (registry: InstanceType<typeof Registry>) => void = () => {}) => {
    resetSessionTelemetryForTesting();
    row();
    const registry = new Registry();
    const detach = attachSessionTelemetry(registry);
    const supervisor = new SdkSupervisor(registry, MISSION_TEST_MCP_DEPS);
    await supervisor.restore();
    whileRunning(registry);
    await supervisor.stop("sdk:restore").catch(() => {});
    detach();
  };
  const send = (registry: InstanceType<typeof Registry>) => {
    const live = registry.getSession("sdk:restore");
    assert.ok(live, "the restored session is live");
    observeSessionOperation({ session: live, operation: "send", outcome: "delivered", actor: HUMAN });
  };

  // Started with the preview on; switched off while it runs. The agent keeps its variable, so
  // its spans keep the attribute.
  preview(true);
  await boot((registry) => {
    send(registry);
    preview(false);
    send(registry);
  });
  assert.deepEqual(workUnits("mission.session.restore.finished"), [WU_A]);
  assert.deepEqual(workUnits("mission.session.started"), [WU_A], "the start span has the restored agent's id");
  assert.deepEqual(workUnits("mission.session.operation"), [WU_A, WU_A], "a switch in flight changes nothing");

  // The next start, with the preview off: the attribute is gone. Switched on while it runs: it
  // gains none until its next start.
  await boot((registry) => {
    send(registry);
    preview(true);
    send(registry);
  });
  // A session has one start forever (it dedupes on the session id), so this boot's first span
  // is its segment: a new observation interval, read from the record this restore installed.
  assert.deepEqual(workUnits("mission.session.restore.finished"), [WU_A, null]);
  assert.equal(journal("mission.session.started").length, 1);
  assert.deepEqual(workUnits("mission.session.segment.opened"), [WU_A, null]);
  assert.deepEqual(workUnits("mission.session.operation").slice(-2), [null, null]);

  // And the start after that, with the preview on, gains it.
  await boot(send);
  assert.deepEqual(workUnits("mission.session.segment.opened").slice(-1), [WU_A]);
  assert.deepEqual(workUnits("mission.session.operation").slice(-1), [WU_A]);

  // A restore that FAILS still reports an attempt, carrying that attempt's decision.
  failRestore = true;
  await boot();
  const last = journal("mission.session.restore.finished").at(-1)!;
  assert.equal(last.facts.outcome, "failed");
  assert.equal(last.refs.work_unit_id, WU_A, "no agent started, and the attempt still names its decision");
});

test("a restore whose work unit lookup throws fails that row alone, reports no id, and the next row still restores", async (t) => {
  const real = HARNESSES.claude.sdk;
  HARNESSES.claude.sdk = { answersRequests: true, launch: async () => idleHandle() };
  t.after(() => {
    HARNESSES.claude.sdk = real;
    preview(false);
  });
  preview(true);
  for (const id of ["broken", "healthy"]) {
    upsertTask(mkTask({ id: `task-${id}`, workUnitId: WU_A, status: "running", sessionId: `sdk:${id}` }));
    upsertSdkSession({
      id: `sdk:${id}`, agent: "claude", agentSessionId: `conversation-${id}`, cwd: `/wt/${id}`,
      taskId: `task-${id}`, model: null, effort: null, permissionMode: null, status: "suspended", turnInProgress: false,
    });
  }
  const registry = new Registry();
  t.after(attachSessionTelemetry(registry));
  const supervisor = new SdkSupervisor(registry, MISSION_TEST_MCP_DEPS);
  // The decision's owner lookup reads storage; make it throw for one row only.
  const decide = supervisor as unknown as { restoreWorkUnitId(row: { id: string }): string | null };
  const original = decide.restoreWorkUnitId.bind(supervisor);
  t.mock.method(decide, "restoreWorkUnitId", (row: { id: string }) => {
    if (row.id === "sdk:broken") throw new Error("scripted: storage read failed");
    return original(row);
  });
  await supervisor.restore();
  await supervisor.stop("sdk:healthy").catch(() => {});

  const byRow = Object.fromEntries(journal("mission.session.restore.finished")
    .map((r) => [r.refs.session_id, [r.facts.outcome, r.refs.work_unit_id ?? null]]));
  assert.deepEqual(byRow["sdk:broken"], ["failed", null], "the failed row is reported, with no guessed id");
  assert.deepEqual(byRow["sdk:healthy"], ["succeeded", WU_A], "the next row was not aborted");
});

// ---- launch attempts and frozen attribution ----

test("a dispatch span carries the launch's decision whatever its outcome", () => {
  const facts = {
    agent: "claude", runtime: "sdk", taskKind: "ship", resolvedModel: null, resolvedEffort: null,
    resolutionSource: "harness", repoCount: 1,
  } as const;
  observeDispatchFinished({ taskId: "task-failed", ...facts, outcome: "failed", workUnitId: WU_A });
  observeDispatchFinished({ taskId: "task-superseded", ...facts, outcome: "superseded", workUnitId: WU_A });
  observeDispatchFinished({ taskId: "task-off", ...facts, outcome: "launched", sessionId: "sdk:x", workUnitId: null });
  assert.deepEqual(workUnits("mission.dispatch.finished"), [WU_A, WU_A, null]);
});

test("the registry's PR link freezes the linking session's record, which a late merge keeps after the session is gone", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const registry = new Registry();
  t.after(attachPrObservationTelemetry(registry));
  registry.registerSdkSession({ id: "sdk:linked", agent: "claude", name: "l", cwd: "/wt/linked", launchWorkUnitId: WU_A });
  registry.registerSdkSession({ id: "sdk:unrecorded", agent: "claude", name: "u", cwd: "/wt/unrecorded", launchWorkUnitId: null });
  registry.upsertTask(mkTask({ id: "task-linked", workUnitId: WU_A, status: "running", sessionId: "sdk:linked", repoRoot: "/repo" }));
  registry.upsertTask(mkTask({ id: "task-unrecorded", workUnitId: WU_A, status: "running", sessionId: "sdk:unrecorded", repoRoot: "/repo" }));

  // The Registry's own announcement, the one the daemon subscribes to.
  const linked = "https://github.com/example/repo/pull/21";
  const unrecorded = "https://github.com/example/repo/pull/22";
  registry.emit("task_pr_linked", { taskId: "task-linked", repoRoot: "/repo", prUrl: linked, observedAt: 1_000 });
  registry.emit("task_pr_linked", { taskId: "task-unrecorded", repoRoot: "/repo", prUrl: unrecorded, observedAt: 1_000 });

  // The linking session leaves for good before the merge is observed.
  registry.applyDriverEvent("sdk:linked", { kind: "exited", reason: "done", resumable: false });
  t.mock.timers.tick(10 * 60_000);
  assert.equal(registry.getSession("sdk:linked"), undefined, "the session is gone");

  recordTelemetryPrMerges(new Map([[linked, 5_000], [unrecorded, 5_000]]), () => false, 6_000);
  const rows = journal("mission.pr.observed").map((r) => [r.facts.fact, r.facts.delivery, r.refs.work_unit_id ?? null]);
  assert.deepEqual(rows, [
    ["associated_existing", "live", WU_A],
    // An agent started without the variable: its task's id is not what it emits.
    ["associated_existing", "live", null],
    ["merged", "late", WU_A],
    ["merged", "late", null],
  ]);
});

test("a pull request fact carries the work unit frozen at association, also when the merge is late", () => {
  const prUrl = "https://github.com/example/repo/pull/7";
  retainPrObservation({
    taskId: "task-pr", taskKind: "ship", repoRoot: "/repo", primaryRepoRoot: "/repo", prUrl,
    sessionId: "sdk:pr", workUnitId: WU_A, creationVerified: false, now: 1_000,
  });
  retainPrObservation({
    taskId: "task-pr-none", taskKind: "ship", repoRoot: "/repo", primaryRepoRoot: "/repo",
    prUrl: "https://github.com/example/repo/pull/8", sessionId: "sdk:pr", creationVerified: false, now: 1_000,
  });
  // Weeks later, with the session long gone.
  recordTelemetryPrMerges(new Map([[prUrl, 5_000]]), () => false, 6_000);
  const rows = journal("mission.pr.observed");
  assert.deepEqual(rows.map((r) => [r.facts.fact, r.facts.delivery, r.refs.work_unit_id ?? null]), [
    ["associated_existing", "live", WU_A],
    ["associated_existing", "live", null],
    ["merged", "late", WU_A],
  ]);
});
