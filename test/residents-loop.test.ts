import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { ServerEvent, Session } from "../src/shared/types.ts";
import { ResidentProfileRevisionSchema, type ResidentLoopSettings } from "../src/shared/residents.ts";
import { residentWakeMarker } from "../src/shared/resident-turn.ts";
import { mkSession, mkTask, mkTaskSummary, meta } from "./helpers/session-fixture.ts";
import { openDb } from "../src/server/db.ts";
import * as store from "../src/server/residents/store.ts";
import * as state from "../src/server/residents/loop-store.ts";
import { ResidentLoop } from "../src/server/residents/loop.ts";
import type { TurnDelivered } from "../src/server/registry.ts";
import type { SessionMessages } from "../src/server/harness/index.ts";
import { scheduleResidentIteration } from "../src/mcp/resident-pacing.ts";

const loops: ResidentLoop[] = [];
beforeEach(() => openDb().exec("DELETE FROM resident_runs; DELETE FROM resident_profile_revisions; DELETE FROM resident_profiles; DELETE FROM sdk_sessions; DELETE FROM usage_ledger;"));
afterEach(async () => { for (const loop of loops.splice(0)) await loop.stop(); });
const flush = () => delay(15);

function fixture(options: Partial<ResidentLoopSettings> = {}, launched = true) {
  let now = 1_800_000_000_000;
  const settings = ResidentProfileRevisionSchema.parse({ identity: { name: "Watcher" }, persona: { personaId: "p" }, loop: options });
  store.createResidentProfile({ id: "profile", settings, at: now });
  store.reserveResidentRun({ id: "run", profileId: "profile", profileRevision: 1, taskId: "task", launchRequestId: "request",
    launchInput: { version: 1, repoRoot: "/repo", instructions: "" }, repoSpelling: "/repo", persona: { personaId: "p", name: "Observer", guidanceMarkdown: "Observe" }, runInstructions: "", at: now });
  if (launched) store.markResidentRunLaunched("run", null, now);
  let session = mkSession({ id: "sdk:resident", runtime: "sdk", state: "idle", terminals: [], task: mkTaskSummary({ id: "task", kind: "resident" }),
    workCycle: { logicalKey: "native", generation: 1, active: false, completedAt: now, updatedAt: now }, meta: meta({ contextPct: 5 }) });
  const listeners = new Set<(event: ServerEvent) => void>();
  const humans = new Set<(event: TurnDelivered) => void>();
  const calls: string[] = [];
  let send: "accept" | "null" | "gate_throw" | "driver_throw" = "accept";
  let compact = async () => { calls.push("compact"); session = { ...session, workCycle: { ...session.workCycle!, generation: session.workCycle!.generation + 1 } }; return 5; };
  let transcript = "";
  let unreadable = false;
  let refreshedContext: number | null = null;
  const registry = {
    subscribe: (fn: (e: ServerEvent) => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    onTurnDelivered: (fn: (event: TurnDelivered) => void) => { humans.add(fn); return () => { humans.delete(fn); }; },
    getTask: () => mkTask({ id: "task", sessionId: session.id, kind: "resident" }),
    getSession: () => session,
    upsertResidentRun: (run: NonNullable<ReturnType<typeof import("../src/shared/residents.ts").residentRunSummary>>) => { for (const fn of listeners) fn({ type: "resident_run_upsert", run }); },
  };
  const deps = { registry, refreshSession: () => {
    if (refreshedContext !== null) session = { ...session, meta: meta({ contextPct: refreshedContext }) };
  }, now: () => now, messages: () => ({ path: "/fixture", read: {
    size: () => transcript.length,
    after: (_path: string, offset: number) => {
      if (unreadable) throw new Error("unreadable");
      return { messages: transcript.slice(offset) ? [{ role: "user", text: transcript.slice(offset), ts: now }] : [], end: transcript.length, atEnd: true };
    },
  } } as unknown as SessionMessages), sdk: {
    compact: async () => compact(),
    sendWhenIdle: async (_id: string, turn: { text: string }, before?: () => string | null) => {
      if (send === "gate_throw") throw new Error("gate");
      if (before?.() || send === "null") return null;
      calls.push(turn.text);
      if (send === "driver_throw") throw new Error("lost acknowledgement");
      session = { ...session, state: "working", workCycle: { ...session.workCycle!, active: true, generation: session.workCycle!.generation + 1, completedAt: null } };
      transcript += turn.text;
      return "started" as const;
    },
  } };
  function loop() { const value = new ResidentLoop(deps); loops.push(value); value.start(); return value; }
  const emit = () => { for (const fn of listeners) fn({ type: "session_upsert", session }); };
  return { loop, calls, settings, get session() { return session; }, get now() { return now; }, advance: (ms: number) => { now += ms; },
    run: () => store.getResidentRun("run")!.run, rows: () => openDb().prepare("SELECT * FROM resident_iterations ORDER BY seq").all() as unknown as state.ResidentIteration[],
    setSend: (value: typeof send) => { send = value; }, setCompact: (fn: typeof compact) => { compact = fn; },
    refreshContext: (value: number) => { refreshedContext = value; },
    patch: (value: Partial<Session>) => { session = { ...session, ...value }; emit(); },
    complete: (generation = session.workCycle!.generation) => { session = { ...session, state: "idle", workCycle: { ...session.workCycle!, generation, active: false, completedAt: now, updatedAt: now } }; emit(); },
    human: () => { session = { ...session, state: "working", workCycle: { ...session.workCycle!, active: true, generation: session.workCycle!.generation + 1 } }; for (const fn of humans) fn({ sessionId: session.id, turnId: "human", deliveredAt: now }); emit(); },
    transcript: (text: string) => { transcript = text; }, unreadable: () => { unreadable = true; },
  };
}

test("defaults, launch evidence, and one-time adoption keep pending, failed and ended runs uncounted", async () => {
  const f = fixture({}, false);
  assert.equal(f.run().iteration, 0); assert.equal(f.rows().length, 0);
  store.adoptResidentLaunch("run", f.now); assert.equal(f.run().iteration, 0);
  store.markResidentRunFailed("run", "never started", f.now);
  store.adoptResidentLaunch("run", f.now); assert.equal(f.rows().length, 0);
  openDb().prepare("UPDATE resident_runs SET launch_state = 'launched', ended_at = NULL, loop_state = 'waiting' WHERE id = 'run'").run();
  const loop = f.loop(); await flush(); await loop.stop(); f.loop(); await flush();
  assert.equal(f.run().iteration, 1); assert.equal(f.run().lastSeq, 1); assert.equal(f.rows()[0]!.trigger, "launch");
  assert.equal(f.run().settings.loop.iterationCap, 200); assert.equal(f.run().settings.loop.spendCapUsd, 20);
  store.endResidentRun("run", f.now);
  openDb().exec("DELETE FROM resident_iterations; UPDATE resident_runs SET iteration = 0, last_seq = 0;");
  store.adoptResidentLaunch("run", f.now); assert.equal(f.rows().length, 0);
});

test("completion is consumed once, one-shot pacing uses completion time, duplicate ends cannot overwrite it", async () => {
  const f = fixture(); const loop = f.loop(); await flush();
  assert.equal(f.run().nextWakeAt, f.now + 300_000);
  await loop.runNow("run");
  loop.schedule(f.session, { callId: "first", delaySeconds: 1200, reason: "wait for deployment" });
  f.advance(40_000); f.complete(); await flush();
  assert.equal(f.run().nextWakeAt, f.now + 1_200_000); assert.equal(f.run().wakeReason, "wait for deployment");
  const due = f.run().nextWakeAt; f.advance(10_000); f.complete(); await flush(); assert.equal(f.run().nextWakeAt, due);
  await loop.runNow("run"); f.complete(); await flush();
  assert.equal(f.run().nextWakeAt, f.now + 300_000); assert.equal(f.run().iteration, 3);
  assert.equal(f.calls.length, 2); assert.deepEqual(f.rows().map(r => r.seq), [1, 2, 3]);
});

test("last new intent wins, clamp applies, replay cannot undo a newer request, and receipts outlive retention", async () => {
  const f = fixture(); const loop = f.loop(); await flush(); await loop.runNow("run");
  const first = loop.schedule(f.session, { callId: "a", delaySeconds: 0, reason: "early" }); assert.equal(first.delaySeconds, 60);
  const second = loop.schedule(f.session, { callId: "b", delaySeconds: 999999, reason: "late" }); assert.equal(second.delaySeconds, 3600);
  assert.deepEqual(loop.schedule(f.session, { callId: "a", delaySeconds: 0, reason: "early" }), first);
  f.complete(); await flush(); const due = f.run().nextWakeAt; assert.equal(due, f.now + 3_600_000);
  await loop.stop(); f.advance(8 * state.RESIDENT_DAY_MS); state.pruneResidentLoop(f.now);
  assert.deepEqual(state.paceResident("run", { callId: "a", delaySeconds: 0, reason: "early" }, 2, f.now), first);
  assert.equal(f.run().nextWakeAt, due);
  const late = state.paceResident("run", { callId: "c", delaySeconds: 120, reason: "new" }, 2, f.now);
  assert.equal(late.pending, false); assert.equal(f.run().nextWakeAt, f.now + 120_000);
  store.endResidentRun("run", f.now); assert.equal(openDb().prepare("SELECT * FROM resident_pacing_calls").all().length, 0);
});

test("pending pacing survives restart and continuation under a later generation", async () => {
  const f = fixture(); const first = f.loop(); await flush(); await first.runNow("run");
  first.schedule(f.session, { callId: "restart", delaySeconds: 1200, reason: "pending" }); await first.stop();
  f.advance(1000); f.loop(); f.complete(4); await flush(); assert.equal(f.run().nextWakeAt, f.now + 1_200_000);
});

test("human precedence cancels pacing and uses a fresh default cadence; needs-you clears requests and pauses", async () => {
  const f = fixture(); const loop = f.loop(); await flush();
  loop.schedule(f.session, { callId: "late", delaySeconds: 60, reason: "old" });
  f.human(); await flush(); assert.equal(f.run().nextWakeAt, null); await assert.rejects(loop.runNow("run"), /human message or active turn/); assert.equal(f.calls.length, 0);
  f.complete(); await flush(); assert.equal(f.run().nextWakeAt, f.now + 300_000);
  f.human(); loop.schedule(f.session, { callId: "human", delaySeconds: 600, reason: "new" }); f.complete(); await flush();
  assert.equal(f.run().nextWakeAt, f.now + 600_000);
  f.patch({ state: "awaiting_input" }); await flush(); assert.equal(f.run().loopState, "paused");
  assert.throws(() => loop.schedule(f.session, { callId: "paused", delaySeconds: 60, reason: "" }), /needs-you/);
  assert.throws(() => loop.resume("run"), /Resolve/);
});

test("manual compaction finishes below threshold before sending and never counts as an iteration", async () => {
  const f = fixture(); const loop = f.loop(); await flush(); f.patch({ meta: meta({ contextPct: 80 }) });
  await loop.runNow("run"); assert.equal(f.calls[0], "compact"); assert.match(f.calls[1]!, /mission-resident:run:2/);
  assert.equal(f.run().iteration, 2); assert.equal(f.rows().length, 2);
});

for (const threshold of [70, 45]) test(`context threshold ${threshold}%: compact at the boundary, not just below, before sending`, async () => {
  const f = fixture({ contextThreshold: threshold }); const loop = f.loop(); await flush();
  f.patch({ meta: meta({ contextPct: threshold - 0.01 }) });
  await loop.runNow("run");
  assert.equal(f.calls.length, 1, "just below the threshold sends without compaction");
  assert.match(f.calls[0]!, /mission-resident:run:2/);
  assert.equal(f.run().iteration, 2);
  f.complete(); await flush();

  let finishCompaction!: (pct: number) => void;
  const compacted = new Promise<number>(resolve => { finishCompaction = resolve; });
  f.setCompact(async () => { f.calls.push("compact"); return compacted; });
  f.patch({ meta: meta({ contextPct: threshold }) });
  const wake = loop.runNow("run");
  await flush();
  assert.deepEqual(f.calls.slice(1), ["compact"], "at the threshold, sending waits for compaction");
  assert.equal(f.run().loopState, "compacting");
  assert.equal(f.run().iteration, 2);
  assert.equal(f.rows().length, 2, "compaction does not claim an iteration");

  finishCompaction(threshold - 0.01);
  await wake;
  assert.equal(f.calls.length, 3);
  assert.match(f.calls[2]!, /mission-resident:run:3/);
  assert.equal(f.run().iteration, 3);
  assert.equal(f.rows().length, 3);
});

test("an overdue wake refreshes context after restore before deciding whether to compact", async () => {
  const f = fixture(); const first = f.loop(); await flush(); await first.stop();
  f.patch({ meta: null });
  f.refreshContext(80);
  f.advance(301_000);
  f.loop(); await flush();
  assert.equal(f.calls[0], "compact");
  assert.match(f.calls[1]!, /mission-resident:run:2/);
  assert.equal(f.run().iteration, 2);
});

test("compaction without measured headroom pauses, and a human arriving during compaction prevents the wake", async () => {
  const f = fixture(); const loop = f.loop(); await flush(); f.patch({ meta: meta({ contextPct: 80 }) });
  f.setCompact(async () => 80); await loop.runNow("run"); assert.equal(f.calls.length, 0); assert.equal(f.run().loopState, "paused");
  loop.resume("run"); f.setCompact(async () => { f.human(); return 5; }); await loop.runNow("run");
  assert.equal(f.calls.length, 0); assert.notEqual(f.run().loopState, "compacting"); assert.equal(f.run().iteration, 1);
});

for (const outcome of ["null", "gate_throw", "driver_throw"] as const) test(`${outcome}: each delivery settles conservatively and sequence numbers are never reused`, async () => {
  const f = fixture(); const loop = f.loop(); await flush(); f.setSend(outcome); await loop.runNow("run");
  assert.equal(f.rows()[1]!.delivery, outcome === "driver_throw" ? "unconfirmed" : "released");
  assert.equal(f.run().iteration, outcome === "driver_throw" ? 2 : 1);
  f.setSend("accept"); await loop.runNow("run"); assert.equal(f.rows()[2]!.seq, 3); assert.equal(f.rows()[2]!.delivery, "sent");
});

for (const evidence of ["marker", "before_offset", "human", "continuation", "unreadable", "null"] as const) test(`restart reconciles ${evidence} evidence before retention, without resending`, async () => {
  const f = fixture(); const marker = residentWakeMarker("run", 2) + "\nContinue";
  const offset = evidence === "before_offset" ? marker.length : evidence === "null" ? null : 0;
  state.completeResidentGeneration("run", 1, f.now);
  state.claimResidentWake("run", "loop", offset, f.now);
  assert.throws(() => openDb().prepare("INSERT INTO resident_iterations (run_id,seq,trigger,delivery,claimed_at) VALUES ('run',3,'loop','claimed',?)").run(f.now), /UNIQUE/);
  f.transcript(evidence === "marker" || evidence === "before_offset" ? marker : "unrelated user turn");
  if (evidence === "unreadable") f.unreadable();
  f.advance(8 * state.RESIDENT_DAY_MS);
  const loop = f.loop(); await flush(); await loop.stop();
  // An overdue confirmed completion may legitimately arm the next generation. Hold it for this reconciliation assertion.
  assert.equal(f.run().iteration, 2); assert.equal(f.run().lastSeq, 2);
  if (evidence === "marker") assert.equal(f.rows().length, 0);
  else { assert.equal(f.rows()[0]!.delivery, "unconfirmed"); assert.equal(f.run().pauseReason, "wake delivery unconfirmed"); }
  assert.equal(f.calls.length, 0);
});

test("an overdue scheduled wake is rearmed once; stopping and ending prevent any further turn", async () => {
  const f = fixture(); const loop = f.loop(); await flush(); await loop.stop(); f.advance(301_000);
  const restarted = f.loop(); await flush(); assert.equal(f.calls.length, 1);
  f.complete(); await flush(); store.endResidentRun("run", f.now); await restarted.stop(); f.advance(301_000); f.loop(); await flush();
  assert.equal(f.calls.length, 1); assert.throws(() => state.claimResidentWake("run", "loop", null, f.now), /ended/);
  assert.throws(() => restarted.resume("run"), /ended/);
});

test("ending with a claim reconciles its evidence without pausing or rearming the ended run", async () => {
  const f = fixture(); state.claimResidentWake("run", "loop", 0, f.now); store.endResidentRun("run", f.now);
  f.loop(); await flush(); assert.equal(f.run().loopState, "ended"); assert.equal(f.run().nextWakeAt, null); assert.equal(f.calls.length, 0);
});

for (const action of ["resume", "runNow"] as const) test(`uncertain delivery survives repeated restarts until ${action} allocates a new sequence`, async () => {
  const f = fixture(); state.claimResidentWake("run", "loop", null, f.now);
  const first = f.loop(); await flush(); await first.stop();
  const second = f.loop(); await flush();
  assert.equal(f.run().iteration, 2); assert.equal(f.run().lastSeq, 2);
  assert.equal(f.run().loopState, "paused"); assert.equal(f.calls.length, 0);
  if (action === "resume") {
    second.resume("run"); await second.stop(); f.advance(301_000); f.loop(); await flush();
  } else await second.runNow("run");
  assert.deepEqual(f.rows().map(row => [row.seq, row.delivery]), [[1, "sent"], [2, "unconfirmed"], [3, "sent"]]);
  assert.equal(f.run().iteration, 3); assert.equal(f.calls.length, 1);
});

test("retention preserves counters and old unresolved claims while removing only settled expiring evidence", () => {
  const f = fixture();
  const released = state.claimResidentWake("run", "loop", 0, f.now)!; state.settleResidentClaim(released, "released", f.now);
  const unresolved = state.claimResidentWake("run", "loop", 0, f.now)!;
  f.advance(8 * state.RESIDENT_DAY_MS);
  const countBefore = state.residentGuardrail(f.run(), f.now);
  state.pruneResidentLoop(f.now);
  assert.deepEqual(f.rows().map(row => [row.seq, row.delivery]), [[unresolved.seq, "claimed"]]);
  assert.equal(f.run().iteration, 1); assert.equal(f.run().lastSeq, 3);
  assert.equal(state.residentGuardrail(f.run(), f.now), countBefore);
});

test("rolling iteration window excludes the exact boundary, includes uncertainty, and ignores releases", async () => {
  const f = fixture({ iterationCap: 2 }); const loop = f.loop(); await flush();
  f.advance(1); const uncertain = state.claimResidentWake("run", "loop", 0, f.now)!; state.settleResidentClaim(uncertain, "unconfirmed", f.now);
  assert.throws(() => loop.resume("run"), /Iteration guardrail.*Resume after/);
  f.advance(state.RESIDENT_DAY_MS - 1); assert.equal(state.residentGuardrail(f.run(), f.now), null);
  loop.resume("run"); const released = state.claimResidentWake("run", "run_now", 0, f.now)!; state.settleResidentClaim(released, "released", f.now);
  assert.equal(state.residentGuardrail(f.run(), f.now), null); assert.equal(f.run().iteration, 2); assert.equal(f.run().lastSeq, 3);
  f.advance(1); assert.equal(state.residentGuardrail(f.run(), f.now), null);
});

test("200 counted turns fill the default cap and a pinned profile remains unchanged after editing and restart", async () => {
  const f = fixture();
  for (let seq = 2; seq <= 200; seq++) openDb().prepare("INSERT INTO resident_iterations (run_id,seq,trigger,delivery,claimed_at) VALUES ('run',?,'loop','sent',?)").run(seq, f.now);
  const edited = ResidentProfileRevisionSchema.parse({ ...f.settings, loop: { delaySeconds: 1, iterationCap: null, spendCapUsd: null, contextThreshold: 90 } });
  store.updateResidentProfile({ id: "profile", expectedRevision: 1, settings: edited, at: f.now });
  const loop = f.loop(); await flush(); await loop.runNow("run");
  assert.equal(f.run().settings.loop.delaySeconds, 300); assert.equal(f.run().settings.loop.iterationCap, 200);
  assert.equal(f.run().loopState, "paused"); assert.equal(f.calls.length, 0);
});

test("MCP timeout, late commit, replay, and new intent retain their distinct outcomes", async () => {
  const f = fixture(); const loop = f.loop(); await flush(); await loop.runNow("run");
  const keepAlive = delay(100);
  let commit!: () => void;
  const unknown = await scheduleResidentIteration({ callId: "timeout", delaySeconds: 1200 }, async (body) => new Promise<Response>((resolve) => {
    commit = () => resolve(Response.json(loop.schedule(f.session, body as Parameters<typeof loop.schedule>[1])));
  }), 10);
  assert.equal("code" in unknown && unknown.code, "outcome_unknown"); assert.equal(unknown.callId, "timeout");
  f.advance(5000); commit(); await flush(); f.complete(); await flush(); const due = f.run().nextWakeAt;
  assert.equal(due, f.now + 1_200_000); f.advance(5000);
  const post = async (body: unknown) => Response.json(loop.schedule(f.session, body as Parameters<typeof loop.schedule>[1]));
  await scheduleResidentIteration({ callId: "timeout", delaySeconds: 1200 }, post); assert.equal(f.run().nextWakeAt, due);
  await scheduleResidentIteration({ callId: "new", delaySeconds: 1200 }, post); assert.equal(f.run().nextWakeAt, f.now + 1_200_000);
  const untyped = await scheduleResidentIteration({ callId: "500", delaySeconds: 90 }, async body => { loop.schedule(f.session, body as Parameters<typeof loop.schedule>[1]); return Response.json({ error: "lost" }, { status: 500 }); });
  assert.equal("code" in untyped && untyped.code, "outcome_unknown"); const committed = f.run().nextWakeAt;
  f.advance(1000); await scheduleResidentIteration({ callId: "500", delaySeconds: 90 }, post); assert.equal(f.run().nextWakeAt, committed);
  await keepAlive;
});

test("a non-answering transport or body has a bounded unknown result; typed refusals record nothing", async () => {
  const f = fixture(); const loop = f.loop(); await flush(); await loop.runNow("run");
  const alive = delay(100);
  for (const post of [async () => new Promise<Response>(() => {}), async () => new Response(new ReadableStream({ start() {} }))]) {
    const result = await scheduleResidentIteration({ delaySeconds: 1200 }, post, 10); assert.equal("code" in result && result.code, "outcome_unknown");
  }
  f.complete(); await flush(); assert.equal(f.run().nextWakeAt, f.now + 300_000);
  for (const post of [async () => Response.json({ code: "not_recorded", error: "paused" }, { status: 409 }), async () => { throw new Error("connect", { cause: { code: "ECONNREFUSED" } }); }]) {
    const result = await scheduleResidentIteration({ delaySeconds: 60 }, post); assert.equal("code" in result && result.code, "not_recorded");
  }
  assert.equal(openDb().prepare("SELECT * FROM resident_pacing_calls").all().length, 0); await alive;
});
