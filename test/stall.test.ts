import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_STALL_THRESHOLDS,
  detectStall,
  detectStalls,
  trackParked,
  type StallThresholds,
} from "../src/shared/stall.ts";
import type {
  NmRunSummary,
  Session,
  SessionNoteSummary,
  SessionQueueSummary,
  SessionState,
  TaskSummary,
} from "../src/shared/types.ts";

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
    paneDialog: null,
    ...over,
  };
}

function mkNote(over: Partial<SessionNoteSummary> = {}): SessionNoteSummary {
  return {
    purpose: null,
    brief: null,
    recommendation: null,
    disposition: "escalated",
    lastAction: null,
    handledMarker: null,
    updatedAt: 0,
    ...over,
  };
}

function mkQueue(over: Partial<SessionQueueSummary> = {}): SessionQueueSummary {
  return {
    openCount: 0,
    totalCount: 0,
    inFlightState: null,
    inFlightIntent: null,
    round: 0,
    blockingGaps: 0,
    verifiedCount: 0,
    escalatedCount: 0,
    drained: false,
    wrapupAskedAt: null,
    wrapupAnswered: false,
    updatedAt: 0,
    ...over,
  };
}

function mkTask(over: Partial<TaskSummary> = {}): TaskSummary {
  return { id: "t", title: "T", kind: "ship", status: "running", outcome: null, outcomeUrl: null, ...over };
}

/** A parked gate with no agent driving it: state must not be starting/working. */
function mkGate(over: Partial<NmRunSummary> = {}): NmRunSummary {
  return {
    id: "r",
    status: "running",
    branch: "b",
    startedAt: null,
    endedAt: null,
    awaitingAgent: null,
    findingsSummary: null,
    gateStep: "review",
    gateSummary: null,
    gateRisk: null,
    steps: [],
    activeSteps: [],
    findings: [],
    outcome: null,
    ...over,
  };
}

const TH = DEFAULT_STALL_THRESHOLDS;
const MIN = 60_000;
const one = (s: Session, now: number, th: StallThresholds = TH) => detectStall(s, [s], now, th);

// ---- not stuck ----

test("a session that just reported is not stuck", () => {
  const s = mkSession({ state: "working", lastActivity: 100 * MIN });
  assert.equal(one(s, 100 * MIN + 30_000), null);
});

test("an exited session is never stuck, however long it has been quiet", () => {
  const s = mkSession({ state: "exited", lastActivity: 0, note: mkNote({ updatedAt: 0 }) });
  assert.equal(one(s, 999 * MIN), null);
});

test("a FINISHED session is not stuck - idle forever with no open work is done, not stalled", () => {
  // The regression a plain idle-timeout would cause: every session that ever
  // completed anything eventually reads as stuck.
  const s = mkSession({ state: "idle", lastActivity: 0, task: mkTask({ status: "done" }) });
  assert.equal(one(s, 999 * MIN), null);
});

test("an idle session with no task and no queue is not stuck", () => {
  const s = mkSession({ state: "idle", lastActivity: 0 });
  assert.equal(one(s, 999 * MIN), null);
});

test("an UNINSTRUMENTED session is never silence-stuck - lastActivity is not a usable clock", () => {
  // No hooks means no lastActivity to measure, so every one of them would trip.
  const s = mkSession({ instrumented: false, state: "working", lastActivity: null, firstSeen: 0 });
  assert.equal(one(s, 999 * MIN), null);
});

test("a session working via a live no-mistakes run is not stuck - the run is confirmed progress", () => {
  // Instrumented, so it clears the clock guard and genuinely exercises the
  // runInFlight path: the agent backgrounded a run and reports idle, but a live
  // process is still driving it. Open work too, so unfinished-work would fire if
  // reportBucket did not rank the run above idle.
  const s = mkSession({
    instrumented: true,
    state: "idle",
    lastActivity: 0,
    nomistakes: mkGate({ gateStep: null, awaitingAgent: null }),
    task: mkTask({ status: "running" }),
  });
  assert.equal(one(s, 999 * MIN), null);
});

// ---- silent-working ----

test("working but silent past the threshold is stuck", () => {
  const s = mkSession({ state: "working", lastActivity: 0, activity: "running Bash" });
  const stall = one(s, TH.workingMs);
  assert.equal(stall?.kind, "silent-working");
  assert.equal(stall?.sessionId, "s");
  assert.match(stall!.reason, /working but silent for 10m/);
  assert.match(stall!.reason, /running Bash/);
});

test("silent-working is exclusive of the threshold boundary minus a tick", () => {
  const s = mkSession({ state: "working", lastActivity: 0 });
  assert.equal(one(s, TH.workingMs - 1), null);
  assert.equal(one(s, TH.workingMs)?.kind, "silent-working");
});

test("with no lastActivity, silence is measured from firstSeen", () => {
  const s = mkSession({ state: "working", lastActivity: null, firstSeen: 5 * MIN });
  assert.equal(one(s, 5 * MIN + TH.workingMs - 1), null);
  assert.equal(one(s, 5 * MIN + TH.workingMs)?.kind, "silent-working");
});

// ---- unfinished-work ----

test("idle past the threshold with a RUNNING task is stuck", () => {
  const s = mkSession({ state: "idle", lastActivity: 0, task: mkTask({ status: "running" }) });
  const stall = one(s, TH.unfinishedMs);
  assert.equal(stall?.kind, "unfinished-work");
  assert.match(stall!.reason, /idle 20m with work unfinished/);
});

test("idle past the threshold with an un-drained queue is stuck", () => {
  const s = mkSession({
    state: "idle",
    lastActivity: 0,
    queue: mkQueue({ openCount: 2, drained: false }),
  });
  assert.equal(one(s, TH.unfinishedMs)?.kind, "unfinished-work");
});

test("a DRAINED queue is finished work, not unfinished", () => {
  const s = mkSession({
    state: "idle",
    lastActivity: 0,
    queue: mkQueue({ openCount: 0, drained: true }),
  });
  assert.equal(one(s, 999 * MIN), null);
});

test("unfinished-work waits longer than silent-working - it is the more inferential rule", () => {
  assert.ok(TH.unfinishedMs > TH.workingMs);
  const s = mkSession({ state: "idle", lastActivity: 0, task: mkTask({ status: "running" }) });
  assert.equal(one(s, TH.workingMs), null);
});

// ---- escalated ----

test("an unanswered escalation past the threshold is stuck", () => {
  const s = mkSession({ state: "idle", note: mkNote({ disposition: "escalated", updatedAt: 0 }) });
  const stall = one(s, TH.escalationMs);
  assert.equal(stall?.kind, "escalated");
  assert.match(stall!.reason, /escalated to you 5m ago, still unanswered/);
});

test("an ANSWERED note never stalls, however old", () => {
  const s = mkSession({ state: "idle", note: mkNote({ disposition: "answered", updatedAt: 0 }) });
  assert.equal(one(s, 999 * MIN), null);
});

test("escalation age is measured from the note, not from session activity", () => {
  // Session chattering away; the escalation is what is old.
  const s = mkSession({
    state: "working",
    lastActivity: 100 * MIN,
    note: mkNote({ disposition: "escalated", updatedAt: 90 * MIN }),
  });
  assert.equal(one(s, 90 * MIN + TH.escalationMs)?.kind, "escalated");
});

// ---- gate-parked ----
//
// Timed from when the gate was first SEEN parked (trackParked), never from the
// session's own quiet clock: an agent can background an `axi run` that parks a gate
// long after its last hook event, and a hookless session has no usable clock at all.

/** The watcher's record, as if the gate had been seen parked at `at`. */
const parkedAt = (id: string, at: number) => new Map([[id, at]]);

test("a gate parked past the threshold with no agent driving it is stuck", () => {
  const s = mkSession({ state: "idle", lastActivity: 0, nomistakes: mkGate() });
  const stall = detectStall(s, [s], TH.gateMs, TH, parkedAt("s", 0));
  assert.equal(stall?.kind, "gate-parked");
  assert.match(stall!.reason, /gate parked at review for 5m/);
});

test("a gate is timed from when it PARKED, not from the session's last hook event", () => {
  // The failure this rules out: a session quiet since 10:00 whose agent backgrounds a
  // run that parks at 10:30 was reported as "parked for 31m" one minute later.
  const s = mkSession({ state: "idle", lastActivity: 0, nomistakes: mkGate() });
  const justParked = detectStall(s, [s], 30 * MIN + 60_000, TH, parkedAt("s", 30 * MIN));
  assert.equal(justParked, null);

  const later = detectStall(s, [s], 30 * MIN + TH.gateMs, TH, parkedAt("s", 30 * MIN));
  assert.match(later!.reason, /for 5m/);
  assert.equal(later!.forMs, TH.gateMs);
});

test("a gate nobody has seen park yet is not stuck, however old the session is", () => {
  // A hookless session has a null lastActivity, so the old clock fell back to
  // firstSeen - the session's whole lifetime - and flagged it the instant it parked.
  const s = mkSession({ state: "idle", instrumented: false, firstSeen: 0, nomistakes: mkGate() });
  assert.equal(detectStall(s, [s], 999 * MIN, TH, new Map()), null);
  assert.equal(one(s, 999 * MIN), null); // no record supplied at all
});

test("trackParked dates a gate from first sight and holds it across polls", () => {
  const s = mkSession({ state: "idle", nomistakes: mkGate() });
  const first = trackParked(null, [s], 10 * MIN);
  assert.equal(first.get("s"), 10 * MIN);
  assert.equal(trackParked(first, [s], 20 * MIN).get("s"), 10 * MIN);
});

test("trackParked restarts the clock when a gate is answered and parks again", () => {
  // Otherwise the second park inherits the first one's age and is stuck on arrival.
  const parked = mkSession({ state: "idle", nomistakes: mkGate() });
  const answered = mkSession({ state: "idle", nomistakes: null });
  const first = trackParked(null, [parked], 10 * MIN);
  const cleared = trackParked(first, [answered], 20 * MIN);
  assert.equal(cleared.size, 0);
  assert.equal(trackParked(cleared, [parked], 30 * MIN).get("s"), 30 * MIN);
});

test("a gate the agent is still driving is not stuck", () => {
  const s = mkSession({ state: "working", lastActivity: 0, nomistakes: mkGate() });
  // Not tracked either - trackParked only records gates that need a human.
  assert.equal(trackParked(null, [s], 0).size, 0);
  assert.equal(one(s, 999 * MIN)?.kind, "silent-working"); // silent, but not gate-parked
});

test("a gate a SIBLING session is driving is not a gate stall", () => {
  const parked = mkSession({ id: "a", state: "idle", lastActivity: 0, nomistakes: mkGate() });
  const sibling = mkSession({ id: "b", state: "working", lastActivity: 0, nomistakes: mkGate() });
  const both = [parked, sibling];
  assert.equal(trackParked(null, both, 0).size, 0);
  const stall = detectStall(parked, both, 999 * MIN, TH, parkedAt("a", 0));
  assert.notEqual(stall?.kind, "gate-parked");
});

// ---- precedence + aggregation ----

test("a session with several causes reports ONE stall, the most explicit", () => {
  const s = mkSession({
    state: "working",
    lastActivity: 0,
    note: mkNote({ disposition: "escalated", updatedAt: 0 }),
    nomistakes: mkGate(),
  });
  const stall = one(s, 999 * MIN);
  assert.equal(stall?.kind, "escalated");
});

test("detectStalls returns at most one entry per session and skips healthy ones", () => {
  const stuck = mkSession({ id: "a", state: "working", lastActivity: 0 });
  const fine = mkSession({ id: "b", state: "working", lastActivity: 100 * MIN });
  const done = mkSession({ id: "c", state: "idle", lastActivity: 0, task: mkTask({ status: "done" }) });
  const stalls = detectStalls([stuck, fine, done], 100 * MIN + 30_000);
  assert.deepEqual(
    stalls.map((x) => x.sessionId),
    ["a"],
  );
});

test("forMs reports how long it has been stuck", () => {
  const s = mkSession({ state: "working", lastActivity: 0 });
  assert.equal(one(s, 42 * MIN)?.forMs, 42 * MIN);
});
