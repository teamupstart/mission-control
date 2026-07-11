import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, renderReportMarkdown } from "../src/server/report.ts";
import { gateParked, needsYouReason, reportBucket } from "../src/shared/session.ts";
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
    nomistakesGated: false,
    pid: 1,
    tty: null,
    wezterm: null,
    tmux: null,
    agentSessionId: null,
    instrumented: true,
    activity: null,
    startedAt: null,
    firstSeen: 0,
    lastSeen: 0,
    lastActivity: null,
    pendingReviews: 0,
    nomistakes: null,
    nomistakesNarration: null,
    task: null,
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
    status: "queued",
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
    mkTask({ id: "q1", title: "Queued one", status: "queued" }),
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

  // A fleet of uninstrumented sessions must produce a non-empty Idle section.
  const fleet = [
    mkSession({ id: "a", state: "working", instrumented: false }),
    mkSession({ id: "b", state: "working", instrumented: false }),
    mkSession({ id: "c", state: "working", instrumented: true }), // the only confirmed-running one
  ];
  const r = buildReport({ sessions: fleet, tasks: [] }, 0);
  assert.deepEqual(r.idle.map((i) => i.sessionId).sort(), ["a", "b"]);
  assert.deepEqual(r.working.map((i) => i.sessionId), ["c"]);
});

function parkedGate(over: Partial<NmRunSummary> = {}): NmRunSummary {
  return {
    status: "running",
    branch: "feature/x",
    awaitingAgent: "parked 0s",
    findingsSummary: "1 awaiting",
    gateStep: "review",
    gateSummary: "found 1 issue",
    gateRisk: "medium",
    steps: [],
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
  // branch (sibling terminals in a checkout, or a dispatched crewmate). Three
  // terminals in /repo on main; one runs /no-mistakes (working), two sit idle.
  const run = parkedGate({ branch: "main" });
  const driver = mkSession({ id: "ai1", cwd: "/repo", gitBranch: "main", state: "working", nomistakes: run });
  const idleA = mkSession({ id: "ai2", cwd: "/repo", gitBranch: "main", state: "idle", nomistakes: run });
  const idleB = mkSession({ id: "ai3", cwd: "/repo", gitBranch: "main", state: "idle", nomistakes: run });
  const fleet = [driver, idleA, idleB];

  // The working sibling drives the gate, so no one - not even the idle ones - is nagged.
  assert.equal(gateParked(idleA, fleet), false);
  assert.equal(gateParked(idleB, fleet), false);
  assert.equal(gateParked(driver, fleet), false);
  assert.equal(buildReport({ sessions: fleet, tasks: [] }, 0).counts.needsYou, 0);

  // A busy session on a *different* branch is a different run - it must not
  // suppress the parked gate on main.
  const elsewhere = mkSession({ id: "x", cwd: "/repo", gitBranch: "other", state: "working" });
  assert.equal(gateParked(idleA, [idleA, elsewhere]), true);

  // Once every same-run session has stopped, the parked gate genuinely needs you.
  const allIdle = [{ ...driver, state: "idle" as SessionState }, idleA, idleB];
  assert.equal(gateParked(idleA, allIdle), true);
  assert.equal(buildReport({ sessions: allIdle, tasks: [] }, 0).counts.needsYou, 3);
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
  assert.match(md, /# Fleet bearings - \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
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
