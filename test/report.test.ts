import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, renderReportMarkdown } from "../src/server/report.ts";
import { gateParked, needsYouReason, reportBucket, runInFlight } from "../src/shared/session.ts";
import type { NmRunSummary, Session, SessionState, Task, TaskSummary } from "../src/shared/types.ts";

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
    nomistakesNarration: null,
    task: null,
    prUrl: null,
    prNumber: null,
    prState: null,
    prChecks: null,
    meta: null,
    note: null, goal: null,
    queue: null,
    orphanedQueue: null,
    paneDialog: null,
    ...over,
  };
}

function mkTask(over: Partial<Task> = {}): Task {
  return {
    id: "t",
    title: "T",
    intent: "do",
    kind: "ship",
    agent: "claude",
    repoRoot: "/repo",
    worktreePath: null,
    branch: null,
    provider: null,
    tmuxSession: null,
    sessionId: null,
    status: "backlog",
    outcome: null,
    outcomeUrl: null,
    error: null,
    createdAt: 0,
    updatedAt: 0,
    dispatchedAt: null,
    completedAt: null,
    ...over,
  };
}

const shipSummary: TaskSummary = {
  id: "task-run",
  title: "Wire dispatch",
  kind: "ship",
  status: "running",
  outcome: null,
  outcomeUrl: null,
};

test("buildReport buckets sessions the same way the shared helper does", () => {
  const sessions = [
    mkSession({ id: "s1", state: "awaiting_input" }),
    mkSession({ id: "s2", state: "idle" }),
    mkSession({ id: "s3", state: "working", task: shipSummary }),
    mkSession({ id: "s4", state: "working", pendingReviews: 2 }),
    mkSession({ id: "s5", state: "exited" }),
  ];
  const tasks = [
    mkTask({ id: "task-run", status: "running", worktreePath: "/wt" }),
    mkTask({ id: "q1", title: "Backlog one", status: "backlog" }),
    mkTask({ id: "d1", title: "Shipped it", status: "done", outcome: "opened PR #7", updatedAt: 50 }),
  ];

  const r = buildReport({ sessions, tasks }, 1_700_000_000_000);

  // Bucket parity: each session lands where reportBucket says.
  for (const s of sessions) {
    const b = reportBucket(s);
    const inNeeds = r.needsYou.some((i) => i.sessionId === s.id);
    const inWorking = r.working.some((i) => i.sessionId === s.id);
    const inIdle = r.idle.some((i) => i.sessionId === s.id);
    if (b === "needs-you") assert.ok(inNeeds, `${s.id} should be in needsYou`);
    else if (b === "working") assert.ok(inWorking, `${s.id} should be in working`);
    else if (b === "idle") assert.ok(inIdle, `${s.id} should be in idle`);
    else assert.ok(!inNeeds && !inWorking && !inIdle, `${s.id} (exited) should be listed nowhere`);
  }

  assert.equal(r.counts.needsYou, 2);
  assert.equal(r.counts.working, 1);
  assert.equal(r.counts.idle, 1);
  assert.equal(r.counts.exited, 1);
  assert.equal(r.counts.sessions, 4); // exited excluded from the live count

  // needsYou reasons.
  const s4 = r.needsYou.find((i) => i.sessionId === "s4");
  assert.equal(s4?.reason, "2 to review");
  const s1 = r.needsYou.find((i) => i.sessionId === "s1");
  assert.equal(s1?.reason, "needs input");

  // working item carries the task intent.
  const s3 = r.working.find((i) => i.sessionId === "s3");
  assert.equal(s3?.taskTitle, "Wire dispatch");
  assert.equal(s3?.kind, "ship");

  // backlog + recent.
  assert.equal(r.backlog.length, 1);
  assert.equal(r.backlog[0]?.id, "q1");
  assert.equal(r.recent.length, 1);
  assert.equal(r.recent[0]?.id, "d1");
  assert.equal(r.recentTruncated, false);
});

test("reportBucket: working is confirmed-running, idle is everything else that's open", () => {
  // Working = an agent we can confirm is running (needs hook instrumentation).
  assert.equal(reportBucket(mkSession({ state: "working", instrumented: true })), "working");
  assert.equal(reportBucket(mkSession({ state: "starting", instrumented: true })), "working");

  // Idle = open, not prompting you, not confirmed running: instrumented-idle,
  // AND every uninstrumented session (no live signal to prove it's busy).
  assert.equal(reportBucket(mkSession({ state: "idle", instrumented: true })), "idle");
  assert.equal(reportBucket(mkSession({ state: "working", instrumented: false })), "idle");
  assert.equal(reportBucket(mkSession({ state: "starting", instrumented: false })), "idle");

  // Needs you = prompting you for input (or a review / parked gate).
  assert.equal(reportBucket(mkSession({ state: "awaiting_input", instrumented: true })), "needs-you");
  assert.equal(reportBucket(mkSession({ state: "awaiting_review", instrumented: true })), "needs-you");
  assert.equal(reportBucket(mkSession({ state: "idle", pendingReviews: 1 })), "needs-you");

  // A set of uninstrumented sessions must produce a non-empty Idle section.
  const sessions = [
    mkSession({ id: "a", state: "working", instrumented: false }),
    mkSession({ id: "b", state: "working", instrumented: false }),
    mkSession({ id: "c", state: "working", instrumented: true }), // the only confirmed-running one
  ];
  const r = buildReport({ sessions: sessions, tasks: [] }, 0);
  assert.deepEqual(r.idle.map((i) => i.sessionId).sort(), ["a", "b"]);
  assert.deepEqual(r.working.map((i) => i.sessionId), ["c"]);
});

function parkedGate(over: Partial<NmRunSummary> = {}): NmRunSummary {
  return {
    id: "01RUN_PARKED",
    status: "running",
    branch: "feature/x",
    startedAt: null,
    endedAt: null,
    awaitingAgent: "parked 0s",
    findingsSummary: "1 awaiting",
    gateStep: "review",
    gateSummary: "found 1 issue",
    gateRisk: "medium",
    steps: [],
    activeSteps: [],
    findings: [],
    outcome: null,
    ...over,
  };
}

test("a parked gate only needs you once the agent has stopped driving it", () => {
  // The /no-mistakes skill answers the gate itself while the session works, so a
  // gate parked under a working (or presumed-working) agent must NOT nag you.
  // Distinct branches: these are four independent runs (one run per branch), not
  // four terminals co-driving one - so each session's own state decides its gate.
  const working = mkSession({ id: "w", state: "working", nomistakes: parkedGate({ branch: "feat/w" }) });
  const starting = mkSession({ id: "st", state: "starting", nomistakes: parkedGate({ branch: "feat/st" }) });
  const uninstrumented = mkSession({
    id: "u",
    state: "working",
    instrumented: false,
    nomistakes: parkedGate({ branch: "feat/u" }),
  });
  const idle = mkSession({ id: "i", state: "idle", nomistakes: parkedGate({ branch: "feat/i" }) });

  assert.equal(gateParked(working), false);
  assert.equal(gateParked(starting), false);
  assert.equal(gateParked(uninstrumented), false);
  assert.equal(gateParked(idle), true);

  assert.equal(reportBucket(working), "working");
  // Uninstrumented: not nagging (gate deferred), but not confirmed running either,
  // so it buckets as idle rather than padding "working".
  assert.equal(reportBucket(uninstrumented), "idle");
  assert.equal(reportBucket(idle), "needs-you");
  assert.equal(needsYouReason(idle), "gate parked at review");

  const r = buildReport({ sessions: [working, starting, uninstrumented, idle], tasks: [] }, 0);
  assert.deepEqual(
    r.needsYou.map((i) => i.sessionId),
    ["i"],
  );
  assert.equal(r.counts.needsYou, 1);
});

test("a parked gate defers to a same-worktree sibling still driving the run", () => {
  // no-mistakes decorates the one run onto every session sharing its worktree +
  // branch (sibling terminals in a checkout, or a dispatched agent). Three
  // terminals in /repo on main; one runs /no-mistakes (working), two sit idle.
  const run = parkedGate({ branch: "main" });
  const driver = mkSession({ id: "ai1", cwd: "/repo", gitBranch: "main", state: "working", nomistakes: run });
  const idleA = mkSession({ id: "ai2", cwd: "/repo", gitBranch: "main", state: "idle", nomistakes: run });
  const idleB = mkSession({ id: "ai3", cwd: "/repo", gitBranch: "main", state: "idle", nomistakes: run });
  const sessions = [driver, idleA, idleB];

  // The working sibling drives the gate, so no one - not even the idle ones - is nagged.
  assert.equal(gateParked(idleA, sessions), false);
  assert.equal(gateParked(idleB, sessions), false);
  assert.equal(gateParked(driver, sessions), false);
  assert.equal(buildReport({ sessions: sessions, tasks: [] }, 0).counts.needsYou, 0);

  // A busy session on a *different* branch is a different run - it must not
  // suppress the parked gate on main.
  const elsewhere = mkSession({ id: "x", cwd: "/repo", gitBranch: "other", state: "working" });
  assert.equal(gateParked(idleA, [idleA, elsewhere]), true);

  // Once every same-run session has stopped, the parked gate genuinely needs you.
  const allIdle = [{ ...driver, state: "idle" as SessionState }, idleA, idleB];
  assert.equal(gateParked(idleA, allIdle), true);
  assert.equal(buildReport({ sessions: allIdle, tasks: [] }, 0).counts.needsYou, 3);
});

/** A run mid-step: executing, not parked at a gate (no awaitingAgent/gateStep). */
function runningMidStep(over: Partial<NmRunSummary> = {}): NmRunSummary {
  return {
    id: "01RUN_MIDSTEP",
    status: "running",
    branch: "feature/x",
    startedAt: null,
    endedAt: null,
    awaitingAgent: null,
    findingsSummary: "2 awaiting, 7 auto-fix",
    gateStep: null,
    gateSummary: null,
    gateRisk: null,
    steps: [{ step: "review", status: "running", findings: 9 }],
    activeSteps: [],
    findings: [],
    outcome: null,
    ...over,
  };
}

test("a backgrounded no-mistakes run keeps its session out of the idle bucket", () => {
  // The agent can background the driving `axi respond` and end its turn: `Stop`
  // reports `idle` (true - it isn't thinking or calling tools), while the run
  // keeps going in a process descended from it and re-invokes it on completion.
  // Both signals are accurate; the session is simply not idle-and-available.
  const bg = mkSession({ id: "bg", state: "idle", nomistakes: runningMidStep() });
  assert.equal(reportBucket(bg), "working");
  // Mid-step is not a parked gate, so this must not nag you either.
  assert.equal(gateParked(bg), false);
  assert.equal(needsYouReason(bg), null);

  // Uninstrumented sessions get the same treatment: the live run is the proof.
  assert.equal(reportBucket(mkSession({ state: "idle", instrumented: false, nomistakes: runningMidStep() })), "working");

  // A finished/failed run proves nothing is in flight - back to idle.
  for (const status of ["completed", "failed"]) {
    assert.equal(reportBucket(mkSession({ state: "idle", nomistakes: runningMidStep({ status }) })), "idle");
  }
  // And no run at all is still plain idle.
  assert.equal(reportBucket(mkSession({ state: "idle" })), "idle");

  const r = buildReport({ sessions: [bg], tasks: [] }, 0);
  assert.deepEqual(r.working.map((i) => i.sessionId), ["bg"]);
  assert.equal(r.idle.length, 0);
});

test("a run in flight never outranks a state the hook stream can confirm", () => {
  // The whole point of the run-in-flight case is that it's weaker evidence than a
  // direct report from the agent. A real ask must still reach you, and a parked
  // gate that needs you must not be masked by the run that parked it.
  const asking = mkSession({ state: "awaiting_input", nomistakes: runningMidStep() });
  assert.equal(reportBucket(asking), "needs-you");
  assert.equal(needsYouReason(asking), "needs input");

  const reviewing = mkSession({ state: "awaiting_review", nomistakes: runningMidStep() });
  assert.equal(reportBucket(reviewing), "needs-you");

  const toReview = mkSession({ state: "idle", pendingReviews: 1, nomistakes: runningMidStep() });
  assert.equal(reportBucket(toReview), "needs-you");

  // A gate parked under a stopped agent stays needs-you even though the run that
  // parked it still reports `status: "running"` - the run is waiting ON you, so
  // treating "running" as self-driving here would swallow the ask forever.
  const parked = mkSession({ state: "idle", nomistakes: parkedGate() });
  assert.equal(parked.nomistakes?.status, "running");
  assert.equal(reportBucket(parked), "needs-you");
  assert.equal(needsYouReason(parked), "gate parked at review");
});

test("a parked run is waiting, not executing", () => {
  // `status` stays "running" while a run sits at a gate, so run-in-flight has to
  // mean "executing a step", not "not finished". An uninstrumented session whose
  // gate is deferred to its presumed-driving agent is the case that catches this:
  // gateParked says don't nag, and there's no confirmed execution behind it, so
  // it must stay idle rather than pad the working count on a technicality.
  const deferred = mkSession({ state: "working", instrumented: false, nomistakes: parkedGate() });
  assert.equal(gateParked(deferred), false);
  assert.equal(runInFlight(deferred), false);
  assert.equal(reportBucket(deferred), "idle");

  // Same session, same agent, run now executing again: confirmed work.
  assert.equal(runInFlight({ ...deferred, nomistakes: runningMidStep() }), true);
});

test("renderReportMarkdown reflects sections, counts, and outcomes", () => {
  const r = buildReport(
    {
      sessions: [mkSession({ id: "s1", state: "awaiting_input", name: "auth" })],
      tasks: [mkTask({ id: "d1", title: "Ship it", status: "done", outcome: "opened PR #7" })],
    },
    1_700_000_000_000,
  );
  const md = renderReportMarkdown(r);
  assert.match(md, /# Mission bearings - \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  assert.match(md, /Needs you \(1\)/);
  assert.match(md, /- "?auth"? - needs input/);
  assert.match(md, /Recent outcomes \(1\)/);
  assert.match(md, /Ship it.*opened PR #7/);
});

test("recent outcomes are capped and the cap is disclosed", () => {
  const tasks = Array.from({ length: 25 }, (_, i) =>
    mkTask({ id: `d${i}`, title: `t${i}`, status: "done", updatedAt: i }),
  );
  const r = buildReport({ sessions: [], tasks }, 0);
  assert.equal(r.recent.length, 20);
  assert.equal(r.recentTruncated, true);
  // newest first (highest updatedAt).
  assert.equal(r.recent[0]?.id, "d24");
  assert.match(renderReportMarkdown(r), /Recent outcomes \(20\+\)/);
});
