import { test } from "node:test";
import { mkTask as baseTask } from "./helpers/session-fixture.ts";
import assert from "node:assert/strict";
import { buildReport, renderReportMarkdown } from "../src/server/report.ts";
import { reportBucket } from "../src/shared/session.ts";
import type { Session, SessionState, Task, TaskSummary } from "../src/shared/types.ts";

function mkSession(over: Partial<Session> = {}): Session {
  return {
    id: "s",
    agent: "claude",
    name: "sess",
    runtime: "terminal",
    // The report buckets every session on the machine, invited or not.
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
    note: null, cost: null, goal: null,
    queue: null,
    pendingTurns: [],
    orphanedQueue: null,
    inspector: null,
    paneDialog: null,
    ...over,
  };
}

/** The shared task fixture with this file's defaults on top. */
const mkTask = (over: Partial<Task> = {}): Task =>
  baseTask({ id: "t", intent: "do", status: "backlog", createdAt: 0, updatedAt: 0, ...over });

const shipSummary: TaskSummary = {
  id: "task-run",
  title: "Wire dispatch",
  kind: "ship",
  status: "running",
  outcome: null,
  outcomeUrl: null,
  scheduleId: null,
  scheduleOccurrenceId: null,
  scheduledFor: null,
  ensemble: null,
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
  // Working = an agent we can confirm is running. Hooks are one source.
  assert.equal(reportBucket(mkSession({ state: "working", instrumented: true })), "working");
  assert.equal(reportBucket(mkSession({ state: "starting", instrumented: true })), "working");
  // An explicit transcript lifecycle marker is another, including for a manual Codex
  // launch that has no injected hooks.
  assert.equal(reportBucket(mkSession({ state: "working", instrumented: false, stateConfirmed: true })), "working");

  // Idle = open, not prompting you, and either confirmed idle or lacking a live signal.
  assert.equal(reportBucket(mkSession({ state: "idle", instrumented: true })), "idle");
  assert.equal(reportBucket(mkSession({ state: "working", instrumented: false, stateConfirmed: false })), "idle");
  assert.equal(reportBucket(mkSession({ state: "starting", instrumented: false, stateConfirmed: false })), "idle");

  // Needs you = prompting you for input (or a review / parked gate).
  assert.equal(reportBucket(mkSession({ state: "awaiting_input", instrumented: true })), "needs-you");
  assert.equal(reportBucket(mkSession({ state: "awaiting_review", instrumented: true })), "needs-you");
  assert.equal(reportBucket(mkSession({ state: "idle", pendingReviews: 1 })), "needs-you");

  // A set of uninstrumented sessions must produce a non-empty Idle section.
  const sessions = [
    mkSession({ id: "a", state: "working", instrumented: false, stateConfirmed: false }),
    mkSession({ id: "b", state: "working", instrumented: false, stateConfirmed: false }),
    mkSession({ id: "c", state: "working", instrumented: true }), // the only confirmed-running one
  ];
  const r = buildReport({ sessions: sessions, tasks: [] }, 0);
  assert.deepEqual(r.idle.map((i) => i.sessionId).sort(), ["a", "b"]);
  assert.deepEqual(r.working.map((i) => i.sessionId), ["c"]);
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

test("the digest says which backlog rows the autopilot is skipping", () => {
  // A sitrep is pasted into a channel and read as a list of what is queued. A parked
  // item that looked identical to a live one is the one line in it that is not true -
  // and the reader has no switch in front of them to check it against.
  const r = buildReport(
    {
      sessions: [],
      tasks: [
        mkTask({ id: "q1", title: "Going ahead", status: "backlog", createdAt: 1 }),
        mkTask({ id: "q2", title: "On hold", status: "backlog", enabled: false, createdAt: 2 }),
      ],
    },
    1_700_000_000_000,
  );
  const md = renderReportMarkdown(r);
  assert.match(md, /"On hold" \(ship, disabled\)/);
  assert.match(md, /"Going ahead" \(ship\)/, "an ordinary row reads exactly as it always did");
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
