import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_STALL_THRESHOLDS,
  detectStall,
  detectStalls,
  NO_UNPUSHED,
  type StallThresholds,
  type UnpushedByRun,
} from "../src/shared/stall.ts";
import type { UnpushedCommits } from "../src/shared/unpushed.ts";
import type {
  Session,
  SessionNoteSummary,
  SessionQueueSummary,
  SessionState,
  TaskSummary,
} from "../src/shared/types.ts";
import type { WorkflowRunSummary } from "../src/shared/workflow.ts";

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
    workflowId: null,
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

function mkRun(over: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    id: "run",
    bindingId: "binding",
    workflowId: "workflow",
    workflowName: "No-Mistakes Review",
    workflowVersion: 8,
    sessionId: "s",
    noteKey: "note",
    status: "waiting_for_session",
    phase: "persona_feedback",
    round: 2,
    maxRepairRounds: 5,
    activePersonaNames: [],
    failedPersonaCount: 1,
    bypassedPersonaReview: false,
    gate: "none",
    gatePrNumber: null,
    gateHeadShort: null,
    reviewPosture: null,
    uncertainDeliveryCount: 0,
    refusedDeliveryCount: 0,
    updatedAt: 0,
    ...over,
  };
}

const TH = DEFAULT_STALL_THRESHOLDS;
const MIN = 60_000;
const one = (
  s: Session,
  now: number,
  th: StallThresholds = TH,
  runs: WorkflowRunSummary[] = [],
  unpushed: UnpushedByRun = NO_UNPUSHED,
) => detectStall(s, [s], runs, unpushed, now, th);

/** One observation, keyed to the run `mkRun` builds by default. */
const observed = (obs: UnpushedCommits, runId = "run"): UnpushedByRun =>
  new Map([[runId, obs]]);

const AHEAD: UnpushedCommits = {
  state: "ahead",
  commits: 2,
  branch: "fix/thing",
  upstream: "origin/fix/thing",
};

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

// ---- workflow-parked ----
//
// The stranded-session bug: a run parks in `waiting_for_session`, the daemon types the repair
// packet, the agent makes the fix and goes idle - and round N+1 never opens. Every one of
// these sessions reported NO outstanding work before this rule, because a review session's
// task has usually already reached `done` and its queue is empty.

test("idle past the threshold with a run parked in waiting_for_session is stuck", () => {
  const s = mkSession({ state: "idle", lastActivity: 0 });
  const stall = one(s, TH.unfinishedMs, TH, [mkRun()]);
  assert.equal(stall?.kind, "workflow-parked");
  assert.equal(stall?.sessionId, "s");
  // The run, so the alert can deep-link to the control that clears it.
  assert.equal(stall?.workflowRunId, "run");
  assert.match(stall!.reason, /idle 20m - No-Mistakes Review repair round 2 never reopened/);
});

test("a run parked in waiting_for_new_head names the PUSH as the missing step", () => {
  // The shipped No-Mistakes Review parks `inspector_only` findings here, and it clears only
  // when the Inspector poller observes a head on the REMOTE. Fixed-and-committed looks
  // exactly like nothing-done from the daemon's side, so the sentence has to say which.
  const s = mkSession({ state: "idle", lastActivity: 0 });
  const stall = one(s, TH.unfinishedMs, TH, [mkRun({ status: "waiting_for_new_head" })]);
  assert.equal(stall?.kind, "workflow-parked");
  assert.match(stall!.reason, /No-Mistakes Review is waiting for a pushed head/);
  assert.doesNotMatch(stall!.reason, /never reopened/);
});

// ---- workflow-parked: naming the unpushed head ----
//
// "Waiting for a pushed head" describes the wait; it does not say which of the two sessions
// this is. The local count of commits no remote holds is the only thing that separates the
// session that fixed the findings and forgot to push from the one that did nothing, and every
// test below exists to pin ONE direction of that: it may be said when a count supports it,
// and it may never be said otherwise.

test("an unpushed count names the missing step beside the wait", () => {
  const s = mkSession({ state: "idle", lastActivity: 0 });
  const stall = one(
    s,
    TH.unfinishedMs,
    TH,
    [mkRun({ status: "waiting_for_new_head" })],
    observed(AHEAD),
  );
  assert.equal(stall?.kind, "workflow-parked");
  assert.equal(
    stall?.reason,
    "idle 20m - No-Mistakes Review is waiting for a pushed head"
      + " and you have 2 commits that are not pushed",
  );
  // The workflow still gets named. The alert deep-links to the run, and a sentence that had
  // dropped the name would strand a person on a Runs page with nothing to match it against.
  assert.match(stall!.reason, /No-Mistakes Review/);
});

test("one unpushed commit is spoken in the singular", () => {
  const s = mkSession({ state: "idle", lastActivity: 0 });
  const stall = one(
    s,
    TH.unfinishedMs,
    TH,
    [mkRun({ status: "waiting_for_new_head" })],
    observed({ ...AHEAD, commits: 1 }),
  );
  assert.match(stall!.reason, /you have 1 commit that is not pushed/);
});

test("a checkout that IS pushed says nothing extra - the missing step is something else", () => {
  // `pushed` is a positive observation and still licenses no clause: HEAD being level with its
  // upstream does not prove the head the Inspector waits for exists. It only rules a push out.
  const s = mkSession({ state: "idle", lastActivity: 0 });
  const stall = one(
    s,
    TH.unfinishedMs,
    TH,
    [mkRun({ status: "waiting_for_new_head" })],
    observed({ state: "pushed", branch: "fix/thing", upstream: "origin/fix/thing" }),
  );
  assert.equal(stall?.reason, "idle 20m - No-Mistakes Review is waiting for a pushed head");
});

test("every UNKNOWN reason claims nothing at all", () => {
  // The load-bearing one. A branch with no upstream is the ordinary state of work nobody has
  // pushed yet, and accusing it of a forgotten step sends a person hunting a mistake that was
  // never made. Enumerated rather than sampled so a new reason cannot default into speech.
  const reasons = [
    "no_checkout",
    "not_a_repo",
    "detached_head",
    "no_upstream",
    "git_failed",
    "unreadable",
  ] as const;
  for (const why of reasons) {
    const s = mkSession({ state: "idle", lastActivity: 0 });
    const stall = one(
      s,
      TH.unfinishedMs,
      TH,
      [mkRun({ status: "waiting_for_new_head" })],
      observed({ state: "unknown", why }),
    );
    assert.equal(
      stall?.reason,
      "idle 20m - No-Mistakes Review is waiting for a pushed head",
      `${why} must add no clause`,
    );
  }
});

test("no observation yet reads as no claim, not as nothing unpushed", () => {
  // The first watcher tick, and every embedder that wired no observer. An empty map has to be
  // indistinguishable from the behaviour before any of this existed.
  const s = mkSession({ state: "idle", lastActivity: 0 });
  const stall = one(s, TH.unfinishedMs, TH, [mkRun({ status: "waiting_for_new_head" })], new Map());
  assert.equal(stall?.reason, "idle 20m - No-Mistakes Review is waiting for a pushed head");
});

test("an observation keyed to a DIFFERENT run is never borrowed", () => {
  // A multi-repo task holds one run per repository, each on its own checkout. Reading another
  // run's count would report one repository's commits against a different repository's run.
  const s = mkSession({ state: "idle", lastActivity: 0 });
  const stall = one(
    s,
    TH.unfinishedMs,
    TH,
    [mkRun({ id: "run-here", status: "waiting_for_new_head" })],
    observed(AHEAD, "run-elsewhere"),
  );
  assert.equal(stall?.reason, "idle 20m - No-Mistakes Review is waiting for a pushed head");
});

test("waiting_for_session never quotes a push - it is un-parked by a resubmission", () => {
  // Even with commits genuinely unpushed, "push the branch" is the wrong instruction for a
  // round that never reopened, and the two must not blur into one sentence.
  const s = mkSession({ state: "idle", lastActivity: 0 });
  const stall = one(s, TH.unfinishedMs, TH, [mkRun()], observed(AHEAD));
  assert.match(stall!.reason, /repair round 2 never reopened/);
  assert.doesNotMatch(stall!.reason, /not pushed/);
});

test("an unpushed count does not make a healthy session stall", () => {
  // The observation only ever changes the WORDING of a stall the clock already decided on. It
  // is not itself evidence of being stuck - a session that just reported is still fine.
  const s = mkSession({ state: "idle", lastActivity: 0 });
  assert.equal(
    one(s, TH.unfinishedMs - 1, TH, [mkRun({ status: "waiting_for_new_head" })], observed(AHEAD)),
    null,
  );
});

test("a parked run belonging to ANOTHER session is not this session's stall", () => {
  const s = mkSession({ id: "mine", state: "idle", lastActivity: 0 });
  assert.equal(one(s, 999 * MIN, TH, [mkRun({ sessionId: "theirs" })]), null);
});

test("a run whose session was orphaned strands nobody - it belongs to no session", () => {
  // `orphanBinding` nulls `sessionId` and blocks the run. It is somebody's problem, but not
  // this idle session's, and a null must never match a session that also has no id to give.
  const s = mkSession({ id: "mine", state: "idle", lastActivity: 0 });
  assert.equal(one(s, 999 * MIN, TH, [mkRun({ sessionId: null })]), null);
});

test("a run that is RUNNING is not parked - the workflow is working, not waiting", () => {
  const s = mkSession({ state: "idle", lastActivity: 0 });
  for (const status of ["running", "capturing", "completed", "blocked"] as const) {
    assert.equal(one(s, 999 * MIN, TH, [mkRun({ status })]), null, status);
  }
});

test("waiting_for_pr and waiting_for_inspector wait on machinery, not on the session", () => {
  // Neither is un-parked by anything the bound session can do at its keyboard, so neither is
  // outstanding work against it. `waiting_for_pr` already has its own missing-pr alert.
  const s = mkSession({ state: "idle", lastActivity: 0 });
  for (const status of ["waiting_for_pr", "waiting_for_inspector"] as const) {
    assert.equal(one(s, 999 * MIN, TH, [mkRun({ status })]), null, status);
  }
});

test("a parked run is reported ahead of an open task - it is the more specific cause", () => {
  const s = mkSession({
    state: "idle",
    lastActivity: 0,
    task: mkTask({ status: "running" }),
    queue: mkQueue({ openCount: 3, drained: false }),
  });
  const stall = one(s, TH.unfinishedMs, TH, [mkRun()]);
  assert.equal(stall?.kind, "workflow-parked");
  assert.match(stall!.reason, /never reopened/);
});

test("a parked run shares the unfinished-work clock rather than getting one of its own", () => {
  const s = mkSession({ state: "idle", lastActivity: 0 });
  assert.equal(one(s, TH.unfinishedMs - 1, TH, [mkRun()]), null);
  assert.equal(one(s, TH.unfinishedMs, TH, [mkRun()])?.kind, "workflow-parked");
});

test("a WORKING session with a parked run is not stalled - it is still on the repair", () => {
  // The whole point is the silence AFTER the fix. A session mid-turn has not gone quiet, and
  // flagging it would nag exactly the agent that is doing what the packet asked.
  const s = mkSession({ state: "working", lastActivity: 999 * MIN });
  assert.equal(one(s, 999 * MIN, TH, [mkRun()]), null);
});

test("an UNINSTRUMENTED session with a parked run stays silent - no usable clock", () => {
  // The same gate the other two silence rules take. `lastActivity` is stale or null without
  // hooks, so every uninstrumented session would trip the moment the threshold elapsed.
  const s = mkSession({ instrumented: false, state: "idle", lastActivity: null, firstSeen: 0 });
  assert.equal(one(s, 999 * MIN, TH, [mkRun()]), null);
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
  const stalls = detectStalls([stuck, fine, done], [], NO_UNPUSHED, 100 * MIN + 30_000);
  assert.deepEqual(
    stalls.map((x) => x.sessionId),
    ["a"],
  );
});

test("detectStalls matches each parked run to the session it is bound to", () => {
  const parked = mkSession({ id: "a", state: "idle", lastActivity: 0 });
  const alsoParked = mkSession({ id: "b", state: "idle", lastActivity: 0 });
  const free = mkSession({ id: "c", state: "idle", lastActivity: 0 });
  const stalls = detectStalls(
    [parked, alsoParked, free],
    [
      mkRun({ id: "run-a", sessionId: "a" }),
      mkRun({ id: "run-b", sessionId: "b", status: "waiting_for_new_head" }),
    ],
    NO_UNPUSHED,
    999 * MIN,
  );
  assert.deepEqual(
    stalls.map((x) => [x.sessionId, x.workflowRunId]),
    [["a", "run-a"], ["b", "run-b"]],
  );
});

test("an empty run list is the pre-workflow behaviour exactly", () => {
  // Every existing caller that has no runs to give must keep getting the answers it got.
  const s = mkSession({ state: "idle", lastActivity: 0, task: mkTask({ status: "running" }) });
  assert.equal(one(s, TH.unfinishedMs, TH, [])?.kind, "unfinished-work");
});

test("forMs reports how long it has been stuck", () => {
  const s = mkSession({ state: "working", lastActivity: 0 });
  assert.equal(one(s, 42 * MIN)?.forMs, 42 * MIN);
});
