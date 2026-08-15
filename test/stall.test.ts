import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_STALL_THRESHOLDS,
  detectStall,
  detectStalls,
  type StallThresholds,
} from "../src/shared/stall.ts";
import type {
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
    runtime: "terminal",
    // Stall detection covers every session on the machine, invited or not.
    foremanInvite: null,
    nameSource: "process",
    state: "working" as SessionState,
    cwd: null,
    gitBranch: null,
    gitRoot: null,
    repoRoot: null,
    pid: 1,
    tty: null,
    permissionMode: null,
    terminals: [],
    agentSessionId: null,
    transcriptPath: null,
    instrumented: true,
    stateConfirmed: true,
    hooksSeen: true,
    activity: null,
    startedAt: null,
    firstSeen: 0,
    lastSeen: 0,
    lastActivity: null,
    pendingReviews: 0,
    task: null,
    prUrl: null,
    prNumber: null,
    prState: null,
    prChecks: null,
    meta: null,
    effortBaselineReady: false,
    note: null,
    cost: null,
    goal: null,
    queue: null,
    pendingTurns: [],
    orphanedQueue: null,
    inspector: null,
    pipeline: null,
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
  return {
    id: "t",
    title: "T",
    fullTitle: "T",
    kind: "ship",
    status: "running",
    outcome: null,
    outcomeUrl: null,
    scheduleId: null,
    scheduleOccurrenceId: null,
    scheduledFor: null,
    ensemble: null,
    repoPrs: [],
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
