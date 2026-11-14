import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { ServerEvent, Session } from "../src/shared/types.ts";
import { residentRunSummary, ResidentProfileRevisionSchema, type ResidentLoopSettings } from "../src/shared/residents.ts";
import { foldAttention } from "../src/web/lib/attention.ts";
import { residentWakeMarker } from "../src/shared/resident-turn.ts";
import { mkSession, mkTask, mkTaskSummary, meta } from "./helpers/session-fixture.ts";
import { openDb } from "../src/server/db.ts";
import * as store from "../src/server/residents/store.ts";
import * as state from "../src/server/residents/loop-store.ts";
import { ResidentLoop } from "../src/server/residents/loop.ts";
import type { TurnDelivered } from "../src/server/registry.ts";
import type { SessionMessages } from "../src/server/harness/index.ts";
import { scheduleResidentIteration } from "../src/mcp/resident-pacing.ts";
import { CompactionCompletion, CompactionError, compactionStallMs } from "../src/server/harness/compaction.ts";

const loops: ResidentLoop[] = [];
beforeEach(() => openDb().exec("DELETE FROM resident_runs; DELETE FROM resident_profile_revisions; DELETE FROM resident_profiles; DELETE FROM sdk_sessions; DELETE FROM usage_ledger;"));
afterEach(async () => { for (const loop of loops.splice(0)) await loop.stop(); });
const flush = () => delay(15);

test("an observation exception is contained and the next event can schedule normally", t => {
  const pending: Array<() => void> = [];
  t.mock.method(globalThis, "queueMicrotask", (fn: () => void) => pending.push(fn));
  const logged = t.mock.method(console, "error", () => {});
  const f = fixture(); f.loop();
  const failure = t.mock.method(openDb(), "prepare", () => { throw new Error("temporary database failure"); });
  assert.doesNotThrow(() => pending.shift()!());
  failure.mock.restore();
  assert.match(String(logged.mock.calls[0]?.arguments[0]), /resident run run/);
  assert.equal(f.run().nextWakeAt, null);
  f.complete();
  while (pending.length) pending.shift()!();
  assert.equal(f.run().nextWakeAt, f.now + 300_000, "queued bookkeeping is released despite the exception");
  assert.deepEqual(f.calls, []);
});

test("an operator pause stays out of attention while a guardrail pause is owed", () => {
  const f = fixture(); const loop = f.loop();
  const attention = () => foldAttention({ sessions: [f.session], reviews: [], ensembles: [], residentRuns: [residentRunSummary(f.run())!] });
  loop.pause("run");
  assert.equal(attention().total, 0);
  loop.pause("run", "Spend guardrail reached");
  assert.equal(attention().total, 1);
  assert.equal(attention().items[0]?.kind, "session_blocked");
});

test("the inbox draws no row for a stale needs-you hold, while a guardrail pause still gets one", () => {
  // No loop runs here, so nothing can lift the hold first: this isolates the inbox's own filter.
  const f = fixture();
  const attention = () => foldAttention({ sessions: [f.session], reviews: [], ensembles: [], residentRuns: [residentRunSummary(f.run())!] });
  assert.equal(f.session.pendingReviews, 0, "no review is open on the session");
  state.pauseResident("run", "needs-you");
  assert.equal(f.run().loopState, "paused"); assert.equal(f.run().pauseReason, "needs-you");
  assert.equal(attention().total, 0);
  assert.deepEqual(attention().items, [], "no 'Waiting on you: needs-you' row with nothing to answer");
  state.pauseResident("run", "Spend guardrail reached");
  assert.equal(attention().total, 1);
  const row = attention().items[0];
  assert.equal(row?.kind, "session_blocked");
  assert.equal(row?.kind === "session_blocked" ? row.activity : null, "Spend guardrail reached");
});

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
  let onRefresh: (() => void) | null = null;
  const registry = {
    subscribe: (fn: (e: ServerEvent) => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    onTurnDelivered: (fn: (event: TurnDelivered) => void) => { humans.add(fn); return () => { humans.delete(fn); }; },
    getTask: () => mkTask({ id: "task", sessionId: session.id, kind: "resident" }),
    getSession: () => session,
    upsertResidentRun: (run: NonNullable<ReturnType<typeof import("../src/shared/residents.ts").residentRunSummary>>) => { for (const fn of listeners) fn({ type: "resident_run_upsert", run }); },
  };
  const deps = { registry, refreshSession: () => {
    onRefresh?.();
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
    onRefresh: (fn: (() => void) | null) => { onRefresh = fn; },
    patch: (value: Partial<Session>) => { session = { ...session, ...value }; emit(); },
    complete: (generation = session.workCycle!.generation) => { session = { ...session, state: "idle", workCycle: { ...session.workCycle!, generation, active: false, completedAt: now, updatedAt: now } }; emit(); },
    human: (turnId = "human") => { session = { ...session, state: "working", workCycle: { ...session.workCycle!, active: true, generation: session.workCycle!.generation + 1 } }; for (const fn of humans) fn({ sessionId: session.id, turnId, deliveredAt: now }); emit(); },
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

test("Run now on a paused idle session waits for the resume instead of re-waking itself", async t => {
  const f = fixture(); const loop = f.loop(); await flush();
  // Bounded, so a regression fails here instead of starving the event loop for good.
  const forward = globalThis.queueMicrotask.bind(globalThis);
  let enqueued = 0;
  t.mock.method(globalThis, "queueMicrotask", (fn: () => void) => { enqueued++; if (enqueued <= 200) forward(fn); });
  f.patch({ pause: { reason: "operator", phase: "frozen", since: f.now, interrupted: null, stopped: true } });
  assert.equal(await loop.runNow("run"), "queued");
  await flush();
  assert.ok(enqueued < 20, `observation re-woke the run ${enqueued} times`);
  assert.deepEqual(f.calls, [], "nothing is sent into a paused session");
  assert.notEqual(f.run().runRequestedAt, null, "the queued Run now is kept for the resume");
  t.mock.restoreAll();
  f.patch({ pause: null });
  await flush();
  assert.equal(f.calls.length, 1, "lifting the pause sends it");
  assert.equal(f.run().runRequestedAt, null);
});

test("human precedence cancels pacing and uses a fresh default cadence", async () => {
  const f = fixture(); const loop = f.loop(); await flush();
  loop.schedule(f.session, { callId: "late", delaySeconds: 60, reason: "old" });
  f.human(); await flush(); assert.equal(f.run().nextWakeAt, null); assert.equal(await loop.runNow("run"), "queued");
  assert.equal(f.run().runRequestedAt, f.now); loop.cancelRunNow("run"); assert.equal(f.run().runRequestedAt, null); assert.equal(f.calls.length, 0);
  f.complete(); await flush(); assert.equal(f.run().nextWakeAt, f.now + 300_000);
  f.human(); loop.schedule(f.session, { callId: "human", delaySeconds: 600, reason: "new" }); f.complete(); await flush();
  assert.equal(f.run().nextWakeAt, f.now + 600_000);

});

for (const working of [false, true]) test(`resuming an ${working ? "active" : "idle"} resident preserves completion pacing`, async () => {
  const f = fixture(); const loop = f.loop(); await flush();
  loop.schedule(f.session, { callId: "old-delay", delaySeconds: 1200, reason: "old reason" });
  loop.pause("run");
  f.advance(10_000);
  if (working) f.human();
  loop.resume("run");
  assert.equal(f.run().pauseReason, null);
  assert.equal(f.run().wakeReason, null);
  const resumedAt = f.now;
  assert.equal(f.run().nextWakeAt, working ? null : resumedAt + 300_000);
  assert.equal(f.run().loopState, working ? "working" : "waiting");
  f.advance(5_000); f.complete(); await flush();
  assert.equal(f.run().nextWakeAt, (working ? f.now : resumedAt) + 300_000,
    "an active turn starts its cadence on completion; an already consumed turn cannot move the resumed wake");
  assert.equal(f.run().iteration, 1);
  assert.equal(f.calls.length, 0, "resuming never sends immediately or counts a human turn");
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

for (const evidence of ["marker", "marker_prefix", "before_offset", "human", "continuation", "unreadable", "null"] as const) test(`restart reconciles ${evidence} evidence before retention, without resending`, async () => {
  const f = fixture({ prompt: "Recorded loop prompt" }); const marker = residentWakeMarker("run", 2) + "\n" + f.settings.loop.prompt;
  const offset = evidence === "before_offset" ? marker.length : evidence === "null" ? null : 0;
  state.completeResidentGeneration("run", 1, f.now);
  state.claimResidentWake("run", "loop", offset, f.now);
  assert.throws(() => openDb().prepare("INSERT INTO resident_iterations (run_id,seq,trigger,delivery,claimed_at) VALUES ('run',3,'loop','claimed',?)").run(f.now), /UNIQUE/);
  f.transcript(evidence === "marker" || evidence === "before_offset" ? marker
    : evidence === "marker_prefix" ? residentWakeMarker("run", 2) + "\nPlease review this saved wake marker." : "unrelated user turn");
  if (evidence === "unreadable") f.unreadable();
  f.advance(8 * state.RESIDENT_DAY_MS);
  const loop = f.loop(); await flush(); await loop.stop();
  // An overdue confirmed completion may legitimately arm the next generation. Hold it for this reconciliation assertion.
  assert.equal(f.run().iteration, 2); assert.equal(f.run().lastSeq, 2);
  if (evidence === "marker") assert.equal(f.rows().length, 0);
  else { assert.equal(f.run().pauseReason, "wake delivery unconfirmed"); assert.equal(f.rows()[0]!.delivery, "unconfirmed"); }
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

for (const contextPct of [null, NaN, Infinity, -1]) test(`unmeasured context (${contextPct}) pauses before any wake claim, then measured context can resume`, async () => {
  const f = fixture(); const loop = f.loop(); await flush();
  f.patch({ meta: meta({ contextPct }) });
  await loop.runNow("run");
  assert.equal(f.run().loopState, "paused");
  assert.match(f.run().pauseReason!, /context.*measur/i);
  assert.equal(f.calls.length, 0);
  assert.equal(f.rows().length, 1, "no wake was claimed");
  f.refreshContext(5);
  await loop.runNow("run");
  assert.equal(f.calls.length, 1);
  assert.equal(f.run().iteration, 2);
});

for (const hold of [{ pendingReviews: 1 }, { state: "awaiting_input" as const }, { paneDialog: { options: [], highlighted: 0 } }]) test(`human request holds overdue wakes without pausing: ${JSON.stringify(hold)}`, async () => {
  const f = fixture(); const loop = f.loop(); await flush();
  const due = f.run().nextWakeAt;
  f.patch(hold); await flush();
  assert.equal(f.run().loopState, "waiting");
  assert.equal(f.run().nextWakeAt, due);
  await loop.stop(); f.advance(400_000); f.loop(); await flush();
  assert.equal(f.calls.length, 0);
  f.patch({ pendingReviews: 0, state: "idle", paneDialog: null }); await flush();
  assert.equal(f.calls.length, 1);
});

test("pacing before and during a review survives resolution and completes with the requested delay", async () => {
  const f = fixture(); const loop = f.loop(); await flush(); await loop.runNow("run");
  loop.schedule(f.session, { callId: "before", delaySeconds: 900, reason: "before review" });
  f.patch({ pendingReviews: 2 }); await flush();
  const receipt = loop.schedule(f.session, { callId: "during", delaySeconds: 1200, reason: "during review" });
  assert.equal(receipt.pending, true);
  f.complete(); await flush();
  assert.equal(f.run().nextWakeAt, null);
  f.patch({ pendingReviews: 1 }); await flush(); assert.equal(f.run().nextWakeAt, null);
  f.patch({ pendingReviews: 0 }); await flush();
  assert.equal(f.run().nextWakeAt, f.now + 1_200_000);
  assert.equal(f.run().pauseReason, null);
});

test("operator Pause remains paused after requests resolve and pacing explains how to resume", async () => {
  const f = fixture(); const loop = f.loop(); await flush();
  f.patch({ pendingReviews: 1 }); await flush(); loop.pause("run");
  f.patch({ pendingReviews: 0 }); f.complete(); await flush();
  assert.equal(f.run().loopState, "paused");
  assert.equal(f.run().nextWakeAt, null);
  assert.throws(() => loop.schedule(f.session, { callId: "paused", delaySeconds: 60, reason: "" }), /Resume/);
});

test("detached review continuation preserves pending pacing across restart", async () => {
  const f = fixture(); const loop = f.loop(); await flush(); await loop.runNow("run");
  loop.schedule(f.session, { callId: "before-detach", delaySeconds: 900, reason: "review pacing" });
  f.patch({ pendingReviews: 1 }); await flush(); await loop.stop();
  f.loop(); await flush(); f.patch({ pendingReviews: 0 });
  f.human("review-continuation:resolved"); f.complete(); await flush();
  assert.equal(f.run().nextWakeAt, f.now + 900_000);
});

test("legacy needs-you pauses recover without undoing other pauses", async () => {
  const f = fixture(); state.pauseResident("run", "needs-you");
  f.patch({ pendingReviews: 1 }); const loop = f.loop(); await flush();
  assert.notEqual(f.run().loopState, "paused"); assert.equal(f.calls.length, 0);
  f.patch({ pendingReviews: 0 }); await flush();
  assert.equal(f.run().nextWakeAt, f.now + 300_000);
  loop.pause("run", "Context cannot be measured."); f.complete(); await flush();
  assert.equal(f.run().loopState, "paused");
  assert.throws(() => loop.schedule(f.session, { callId: "guardrail", delaySeconds: 60, reason: "" }), /paused.*Context cannot be measured.*Resume/);
});

test("scheduling directly clears a stale needs-you pause before observation runs", async () => {
  const f = fixture(); state.pauseResident("run", "needs-you");
  const loop = f.loop();
  // Do not yield: startup observation must not clear the pause before schedule sees it.
  assert.equal(f.session.state, "idle");
  assert.equal(f.session.pendingReviews, 0);
  assert.equal(f.run().loopState, "paused");
  assert.equal(f.run().pauseReason, "needs-you");
  assert.equal(f.run().nextWakeAt, null);

  const receipt = loop.schedule(f.session, { callId: "stale-pause", delaySeconds: 900, reason: "reviews resolved" });
  assert.deepEqual(receipt, { callId: "stale-pause", delaySeconds: 900, pending: true, nextWakeAt: null });
  assert.equal(f.run().pauseReason, null);
  assert.notEqual(f.run().loopState, "paused");
  await flush();
  assert.equal(f.run().nextWakeAt, f.now + 900_000);
  assert.equal(f.run().wakeReason, "reviews resolved");
  assert.equal(f.calls.length, 0, "recording pacing does not send an immediate wake");
});

test("pacing during an idle review hold records pending and applies when resolved", async () => {
  const f = fixture(); const loop = f.loop(); await flush();
  f.patch({ pendingReviews: 1 }); await flush();
  const receipt = loop.schedule(f.session, { callId: "idle-held", delaySeconds: 900, reason: "held" });
  assert.equal(receipt.pending, true); assert.equal(receipt.nextWakeAt, null);
  f.patch({ pendingReviews: 0 }); await flush();
  assert.equal(f.run().nextWakeAt, f.now + 900_000);
});

test("a fresh idle pacing call supersedes a held request before observation catches up", async () => {
  const f = fixture(); const loop = f.loop(); await flush();
  f.patch({ pendingReviews: 1 }); await flush();
  loop.schedule(f.session, { callId: "held-old", delaySeconds: 900, reason: "held" });
  f.patch({ pendingReviews: 0 });
  loop.schedule(f.session, { callId: "idle-new", delaySeconds: 600, reason: "new" });
  await flush();
  assert.equal(f.run().nextWakeAt, f.now + 600_000);
  assert.equal(f.run().wakeReason, "new");
});

test("a review without agent pacing uses the profile default after turn completion", async () => {
  const f = fixture(); const loop = f.loop(); await flush(); await loop.runNow("run");
  f.patch({ pendingReviews: 1 }); f.complete(); await flush();
  assert.equal(f.run().nextWakeAt, null);
  f.patch({ pendingReviews: 0 }); await flush();
  assert.equal(f.run().nextWakeAt, f.now + 300_000);
});

test("Run now behind a busy resident queues, lets the turn in progress finish first, then wakes once", async () => {
  const f = fixture(); const loop = f.loop(); await flush();
  f.human(); await flush();
  assert.equal(await loop.runNow("run"), "queued");
  const queuedAt = f.now; f.advance(1000);
  assert.equal(await loop.runNow("run"), "queued", "a second press keeps the first request");
  assert.equal(f.run().runRequestedAt, queuedAt);
  assert.equal(residentRunSummary(f.run())!.runRequestedAt, queuedAt, "every surface reads the queued run from the summary");
  assert.deepEqual(f.calls, [], "the human turn keeps priority");
  f.complete(); await flush();
  assert.equal(f.calls.length, 1); assert.match(f.calls[0]!, /mission-resident:run:2/);
  assert.equal(f.rows()[1]!.trigger, "run_now");
  assert.equal(f.run().runRequestedAt, null);
  f.complete(); await flush();
  assert.equal(f.calls.length, 1, "one queued request is spent by one wake");
  assert.equal(f.run().nextWakeAt, f.now + 300_000, "the ordinary cadence resumes after it");
});

test("a pause drops a queued run, and Run now on a paused busy resident resumes and queues", async () => {
  const f = fixture(); const loop = f.loop(); await flush();
  f.human(); await flush();
  await loop.runNow("run"); loop.pause("run");
  assert.equal(f.run().runRequestedAt, null);
  f.complete(); await flush(); assert.deepEqual(f.calls, []);
  f.human(); await flush();
  assert.equal(await loop.runNow("run"), "queued");
  assert.equal(f.run().loopState, "working"); assert.equal(f.run().pauseReason, null);
  f.complete(); await flush(); assert.equal(f.calls.length, 1);
  assert.throws(() => loop.cancelRunNow("run"), /No queued run to cancel/);
});

test("Run now that meets a human turn starting inside the wake is queued, not dropped", async () => {
  const f = fixture(); const loop = f.loop(); await flush();
  // Idle when Run now checks; a human turn begins by the time the wake refreshes the session.
  f.onRefresh(() => { f.onRefresh(null); f.human(); });
  assert.equal(await loop.runNow("run"), "queued", "the answer reports what actually happened");
  assert.deepEqual(f.calls, []);
  assert.notEqual(f.run().runRequestedAt, null);
  f.complete(); await flush();
  assert.equal(f.calls.length, 1); assert.match(f.calls[0]!, /mission-resident:run:2/);
  assert.equal(f.run().runRequestedAt, null);
});

for (const idleWhileDown of [false, true]) test(`a queued Run now survives a daemon restart and runs exactly once (${idleWhileDown ? "turn finished while down" : "turn finishes after restart"})`, async () => {
  const f = fixture(); const first = f.loop(); await flush();
  f.human(); await flush();
  assert.equal(await first.runNow("run"), "queued");
  await first.stop();
  if (idleWhileDown) f.complete();
  const second = f.loop(); await flush();
  if (!idleWhileDown) { assert.deepEqual(f.calls, [], "still behind the turn in progress"); f.complete(); await flush(); }
  assert.equal(f.calls.length, 1); assert.match(f.calls[0]!, /mission-resident:run:2/);
  assert.equal(f.rows()[1]!.trigger, "run_now");
  assert.equal(f.run().runRequestedAt, null);
  f.complete(); await flush();
  await second.stop(); f.loop(); await flush();
  assert.equal(f.calls.length, 1, "neither the next completion nor another restart repeats it");
});

for (const outcome of ["measured", "failed"] as const) test(`a queued Run now outlives a human turn that preempts its ${outcome} compaction`, async () => {
  const f = fixture(); const loop = f.loop(); await flush();
  f.human(); await flush();
  assert.equal(await loop.runNow("run"), "queued");
  f.patch({ meta: meta({ contextPct: 80 }) });
  // The queued run starts compacting, and a human message lands during it.
  f.setCompact(async () => {
    f.calls.push("compact"); f.human();
    if (outcome === "failed") throw new CompactionError(STALLED);
    return 5;
  });
  f.complete(); await flush();
  assert.deepEqual(f.calls, ["compact"], "the human turn goes first");
  assert.notEqual(f.run().runRequestedAt, null, "the request is put back, not spent");
  assert.equal(f.run().loopState, "working");
  f.setCompact(async () => { f.calls.push("compact"); return 5; });
  f.complete(); await flush();
  assert.match(f.calls.at(-1)!, /mission-resident:run:2/, "the queued run follows the human turn");
  assert.equal(f.run().runRequestedAt, null);
});

test("Run now waits behind an open request for the operator", async () => {
  const f = fixture(); const loop = f.loop(); await flush();
  f.patch({ pendingReviews: 1 }); await flush();
  assert.equal(await loop.runNow("run"), "queued");
  await flush(); assert.deepEqual(f.calls, []);
  f.patch({ pendingReviews: 0 }); await flush();
  assert.equal(f.calls.length, 1);
});

const STALLED = "Compaction made no progress for 10 minutes and was interrupted.";
test("a failed compaction retries on a backoff, pauses once retries are spent, and Resume or a success resets it", async () => {
  const f = fixture(); const loop = f.loop(); await flush(); f.patch({ meta: meta({ contextPct: 80 }) });
  let fail = true;
  f.setCompact(async () => { f.calls.push("compact"); if (fail) throw new CompactionError(STALLED); return 5; });
  for (const [retry, delayMs, wait] of [[1, 60_000, "1m"], [2, 300_000, "5m"], [3, 900_000, "15m"]] as const) {
    await loop.runNow("run");
    assert.equal(f.run().loopState, "waiting", `retry ${retry} waits instead of pausing`);
    assert.equal(f.run().nextWakeAt, f.now + delayMs);
    assert.equal(f.run().wakeReason, `${STALLED} Retrying in ${wait} (retry ${retry} of 3).`);
  }
  await loop.runNow("run");
  assert.equal(f.run().loopState, "paused");
  assert.equal(f.run().pauseReason, `${STALLED} Paused after 4 compaction attempts. Resume to try again.`);
  assert.equal(f.run().iteration, 1, "no failed compaction counts as an iteration");
  assert.deepEqual(f.calls, ["compact", "compact", "compact", "compact"]);
  loop.resume("run");
  await loop.runNow("run");
  assert.match(f.run().wakeReason!, /\(retry 1 of 3\)/, "Resume starts a fresh set of retries");
  fail = false; await loop.runNow("run");
  assert.match(f.calls.at(-1)!, /mission-resident:run:2/, "a measured compaction sends the wake");
  fail = true; f.complete(); f.patch({ meta: meta({ contextPct: 80 }) }); await loop.runNow("run");
  assert.match(f.run().wakeReason!, /\(retry 1 of 3\)/, "a success resets the count");
});

test("each scheduled compaction retry fires on its own at its backoff, with no operator action", async (t) => {
  const f = fixture(); const loop = f.loop(); await flush(); f.patch({ meta: meta({ contextPct: 80 }) }); await flush();
  f.setCompact(async () => { f.calls.push("compact"); throw new CompactionError(STALLED); });
  // From here the loop's own wake timers are driven by hand. `flush` waits on a timer itself,
  // so settling uses immediates, which are not mocked.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
  const elapse = async (ms: number) => { f.advance(ms); t.mock.timers.tick(ms); await settle(); };
  await loop.runNow("run"); await settle();
  assert.deepEqual(f.calls, ["compact"], "the one manual action: the first attempt");
  for (const [delayMs, retry, next] of [[60_000, 1, "Retrying in 5m (retry 2 of 3)."], [300_000, 2, "Retrying in 15m (retry 3 of 3)."]] as const) {
    await elapse(delayMs - 1);
    assert.equal(f.calls.length, retry, `retry ${retry} waits for its full backoff`);
    await elapse(1);
    assert.equal(f.calls.length, retry + 1, `retry ${retry} fires from the loop's own timer`);
    assert.ok(f.run().wakeReason!.endsWith(next));
  }
  await elapse(900_000 - 1);
  assert.equal(f.calls.length, 3);
  await elapse(1);
  assert.equal(f.calls.length, 4, "the last retry fires too");
  assert.equal(f.run().loopState, "paused");
  assert.equal(f.run().pauseReason, `${STALLED} Paused after 4 compaction attempts. Resume to try again.`);
  await elapse(3_600_000);
  assert.equal(f.calls.length, 4, "a paused resident schedules nothing more");
  assert.equal(f.run().iteration, 1);
});

test("a compaction that could not be interrupted pauses at once", async () => {
  const f = fixture(); const loop = f.loop(); await flush(); f.patch({ meta: meta({ contextPct: 80 }) });
  f.setCompact(async () => { throw new CompactionError("Compaction made no progress for 10 minutes and could not be interrupted: gone", false); });
  await loop.runNow("run");
  assert.equal(f.run().loopState, "paused");
  assert.equal(f.run().pauseReason, "Compaction made no progress for 10 minutes and could not be interrupted: gone Resume to try again.");
});

test("a retry waits for the interrupted compaction turn to unwind and counts its delay from that completion", async () => {
  const f = fixture(); const loop = f.loop(); await flush(); f.patch({ meta: meta({ contextPct: 80 }) });
  f.setCompact(async () => {
    // The driver's own `/compact` turn is still closing when the stall rejects.
    f.patch({ state: "working", workCycle: { ...f.session.workCycle!, active: true, generation: f.session.workCycle!.generation + 1, completedAt: null } });
    throw new CompactionError(STALLED);
  });
  await loop.runNow("run");
  assert.equal(f.run().loopState, "waiting", "the compaction's own turn is not mistaken for a human");
  assert.equal(f.run().nextWakeAt, null);
  assert.match(f.run().wakeReason!, /Retrying in 1m/);
  f.advance(5_000); f.complete(); await flush();
  assert.equal(f.run().nextWakeAt, f.now + 60_000, "the backoff, not the 5-minute cadence");
  assert.equal(f.run().wakeReason, `${STALLED} Retrying in 1m (retry 1 of 3).`);
});

test("a human turn delivered during a failing compaction keeps precedence over the retry", async () => {
  const f = fixture(); const loop = f.loop(); await flush(); f.patch({ meta: meta({ contextPct: 80 }) });
  f.setCompact(async () => { f.human(); throw new CompactionError(STALLED); });
  await loop.runNow("run");
  assert.equal(f.run().loopState, "working"); assert.equal(f.run().wakeReason, null);
  f.complete(); await flush();
  assert.equal(f.run().nextWakeAt, f.now + 300_000);
});

test("a stalled compaction interrupts its driver turn and rejects as retryable", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const interrupted: string[] = [];
  const completion = new CompactionCompletion(600_000);
  const stalled = completion.begin(async () => { interrupted.push("interrupt"); completion.finish(); });
  t.mock.timers.tick(600_000);
  await assert.rejects(stalled, (error: unknown) => error instanceof CompactionError && error.retryable &&
    error.message === STALLED);
  assert.deepEqual(interrupted, ["interrupt"], "the interrupted turn's own result cannot replace the stall");
  const refused = completion.begin(async () => { throw new Error("pipe closed"); });
  t.mock.timers.tick(600_000);
  await assert.rejects(refused, (error: unknown) => error instanceof CompactionError && !error.retryable &&
    /could not be interrupted: pipe closed/.test(error.message));
  // An interrupt the hung CLI never acknowledges is bounded too, and not retryable: the
  // `/compact` turn may still be open.
  const silent = completion.begin(() => new Promise<void>(() => {}));
  t.mock.timers.tick(600_000);
  let settled = false;
  const silentRejection = assert.rejects(silent, (error: unknown) => error instanceof CompactionError && !error.retryable &&
    error.message === "Compaction made no progress for 10 minutes and could not be interrupted: the interrupt was not acknowledged")
    .finally(() => { settled = true; });
  t.mock.timers.tick(29_999);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, "the interrupt gets its full 30 seconds");
  t.mock.timers.tick(1);
  await silentRejection;
  const healthy = completion.begin(async () => { throw new Error("never"); });
  completion.observe(494, 1_000_000); completion.finish();
  assert.deepEqual(await healthy, { contextTokens: 494, contextWindow: 1_000_000 });
});

test("the stall bound reads its override and keeps a ten-minute default", () => {
  assert.equal(compactionStallMs(undefined), 600_000);
  assert.equal(compactionStallMs(""), 600_000);
  assert.equal(compactionStallMs("-5"), 600_000);
  assert.equal(compactionStallMs("1.5"), 600_000);
  assert.equal(compactionStallMs("2000"), 2_000);
});
