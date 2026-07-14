import { test } from "node:test";
import assert from "node:assert/strict";
import {
  batchSeverity,
  detectAlerts,
  digestLine,
  hasReportable,
  summarizeAlerts,
  type Alert,
  type AlertSettings,
  type Fleet,
} from "../src/web/lib/alerts.ts";
import { chimeGate } from "../src/web/lib/chime.ts";
import type { NmRunSummary, Session, SessionState, Task } from "../src/shared/types.ts";

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
    nomistakesNarration: null,
    pid: 1,
    tty: null,
    permissionMode: null,
    wezterm: null,
    tmux: null,
    agentSessionId: null,
    transcriptPath: null,
    instrumented: true,
    activity: null,
    startedAt: null,
    firstSeen: 0,
    lastSeen: 0,
    lastActivity: null,
    pendingReviews: 0,
    nomistakes: null,
    task: null,
    prUrl: null,
    prNumber: null,
    prState: null,
    prChecks: null,
    meta: null,
    note: null,
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
    status: "running",
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

const WATCHING: AlertSettings = { notifications: true, sound: true, afk: false, digestMinutes: 15 };
const AFK: AlertSettings = { ...WATCHING, afk: true };
const fleet = (sessions: Session[], tasks: Task[] = []): Fleet => ({ sessions, tasks });

test("a session entering awaiting_input alerts once (attention), then stays quiet", () => {
  const working = mkSession({ id: "a", state: "working" });
  const waiting = mkSession({ id: "a", state: "awaiting_input" });

  const first = detectAlerts(fleet([working]), fleet([waiting]), WATCHING);
  assert.equal(first.length, 1);
  assert.equal(first[0]?.kind, "needs-input");
  assert.equal(first[0]?.severity, "attention");
  assert.equal(first[0]?.body, "needs input");

  // Same state on the next tick -> no repeat.
  assert.equal(detectAlerts(fleet([waiting]), fleet([waiting]), WATCHING).length, 0);
});

test("a new pending review alerts as a review, a parked gate as a gate", () => {
  const idle = mkSession({ id: "a", state: "idle" });
  const review = mkSession({ id: "a", state: "idle", pendingReviews: 2 });
  const r = detectAlerts(fleet([idle]), fleet([review]), WATCHING);
  assert.equal(r[0]?.kind, "review");
  assert.equal(r[0]?.body, "2 to review");

  const gate: NmRunSummary = {
    id: "01RUN_GATE",
    status: "running",
    branch: "x",
    awaitingAgent: "parked 1m",
    findingsSummary: null,
    gateStep: "review",
    gateSummary: null,
    gateRisk: null,
    steps: [],
    findings: [],
    outcome: null,
  };
  const parked = mkSession({ id: "b", state: "idle", nomistakes: gate });
  const g = detectAlerts(fleet([mkSession({ id: "b" })]), fleet([parked]), WATCHING);
  assert.equal(g[0]?.kind, "gate");
  assert.match(g[0]?.body ?? "", /gate parked at review/);
});

test("a session entering awaiting_review alerts too (needs a decision)", () => {
  const working = mkSession({ id: "a", state: "working" });
  const review = mkSession({ id: "a", state: "awaiting_review" });
  const r = detectAlerts(fleet([working]), fleet([review]), WATCHING);
  assert.equal(r.length, 1);
  assert.equal(r[0]?.kind, "needs-input");
  assert.equal(r[0]?.body, "needs review");
});

test("a review landing on an already-waiting session still alerts (stacked causes)", () => {
  const waiting = mkSession({ id: "a", state: "awaiting_input", pendingReviews: 0 });
  const plusReview = mkSession({ id: "a", state: "awaiting_input", pendingReviews: 1 });
  const r = detectAlerts(fleet([waiting]), fleet([plusReview]), WATCHING);
  // Still awaiting input (no new input alert), but a fresh review alert fires.
  assert.equal(r.length, 1);
  assert.equal(r[0]?.kind, "review");
  assert.equal(r[0]?.body, "to review");
});

test("a task reaching failed alerts (attention) in any mode", () => {
  const running = mkTask({ id: "t1", status: "running" });
  const failed = mkTask({ id: "t1", status: "failed", error: "boom" });
  const r = detectAlerts(fleet([], [running]), fleet([], [failed]), WATCHING);
  assert.equal(r.length, 1);
  assert.equal(r[0]?.kind, "task-failed");
  assert.equal(r[0]?.body, "boom");
});

test("idle + task-done alerts are AFK-only", () => {
  const busy = mkSession({ id: "a", state: "working" });
  const idle = mkSession({ id: "a", state: "idle" });
  const running = mkTask({ id: "t1", status: "running" });
  const done = mkTask({ id: "t1", status: "done", outcome: "shipped" });

  // Watching: neither idle nor done fire.
  assert.equal(detectAlerts(fleet([busy], [running]), fleet([idle], [done]), WATCHING).length, 0);

  // AFK: both fire (info).
  const r = detectAlerts(fleet([busy], [running]), fleet([idle], [done]), AFK);
  const kinds = r.map((a) => a.kind).sort();
  assert.deepEqual(kinds, ["idle", "task-done"]);
  assert.ok(r.every((a) => a.severity === "info"));
});

test("summarizeAlerts lists titles and caps the overflow", () => {
  const a = (title: string): Alert => ({
    id: title, kind: "needs-input", title, body: "", sessionId: null, severity: "attention",
  });
  assert.equal(summarizeAlerts([a("one")]), "one");
  assert.equal(summarizeAlerts([a("one"), a("two")]), "one · two");
  assert.equal(
    summarizeAlerts([a("one"), a("two"), a("three"), a("four"), a("five")]),
    "one · two · three · +2 more",
  );
});

test("batchSeverity is attention if any alert is attention, else info", () => {
  const a = (severity: Alert["severity"]): Alert => ({
    id: "x", kind: "idle", title: "", body: "", sessionId: null, severity,
  });
  assert.equal(batchSeverity([a("info"), a("attention"), a("info")]), "attention");
  assert.equal(batchSeverity([a("info"), a("info")]), "info");
  assert.equal(batchSeverity([]), "info");
});

test("hasReportable is false for an empty/all-exited fleet, true when there's activity", () => {
  assert.equal(hasReportable(fleet([])), false);
  assert.equal(hasReportable(fleet([mkSession({ state: "exited" })])), false);
  assert.equal(hasReportable(fleet([mkSession({ state: "idle" })])), true);
  assert.equal(hasReportable(fleet([], [mkTask({ status: "queued" })])), true);
  assert.equal(hasReportable(fleet([], [mkTask({ status: "done" })])), false);
});

test("chimeGate rate-limits, but lets an urgent tone cut through a recent info chime", () => {
  // Outside the window: always play.
  assert.equal(chimeGate(2000, 0, "info", "info"), true);
  // Within the window, same/low severity: suppressed.
  assert.equal(chimeGate(400, 0, "info", "info"), false);
  assert.equal(chimeGate(400, 0, "info", "attention"), false);
  assert.equal(chimeGate(400, 0, "attention", "attention"), false);
  // Within the window, urgent after a trivial chime: cuts through.
  assert.equal(chimeGate(400, 0, "attention", "info"), true);
});

test("digestLine counts sessions by bucket and includes queued tasks", () => {
  const line = digestLine(
    fleet(
      [
        mkSession({ id: "1", state: "awaiting_input" }),
        mkSession({ id: "2", state: "working" }),
        mkSession({ id: "3", state: "working" }),
        mkSession({ id: "4", state: "idle" }),
      ],
      [mkTask({ id: "q", status: "queued" })],
    ),
  );
  assert.equal(line, "1 need you · 2 working · 1 idle · 1 queued");
});
