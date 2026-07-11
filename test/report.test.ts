import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, renderReportMarkdown } from "../src/server/report.ts";
import { reportBucket } from "../src/shared/session.ts";
import type { Session, SessionState, Task, TaskSummary } from "../src/shared/types.ts";

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
