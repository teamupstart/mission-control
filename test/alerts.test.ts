import { test } from "node:test";
import assert from "node:assert/strict";
import {
  batchSeverity,
  bufferable,
  deliverable,
  detectAlerts,
  digestLine,
  hasReportable,
  summarizeAlerts,
  withKnownStalls,
  type Alert,
  type AlertScope,
} from "../src/shared/alerts.ts";
import type { Stall } from "../src/shared/stall.ts";
import { chimeGate } from "../src/web/lib/chime.ts";
import type {
  NmRunSummary,
  Session,
  SessionQueueSummary,
  SessionState,
  Task,
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
    note: null, goal: null,
    queue: null,
    orphanedQueue: null,
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

const scope = (sessions: Session[], tasks: Task[] = [], stalls: Stall[] = []): AlertScope => ({
  sessions,
  tasks,
  stalls,
});

test("a session entering awaiting_input alerts once (attention), then stays quiet", () => {
  const working = mkSession({ id: "a", state: "working" });
  const waiting = mkSession({ id: "a", state: "awaiting_input" });

  const first = detectAlerts(scope([working]), scope([waiting]));
  assert.equal(first.length, 1);
  assert.equal(first[0]?.kind, "needs-input");
  assert.equal(first[0]?.severity, "attention");
  assert.equal(first[0]?.body, "needs input");

  // Same state on the next tick -> no repeat.
  assert.equal(detectAlerts(scope([waiting]), scope([waiting])).length, 0);
});

test("a new pending review alerts as a review, a parked gate as a gate", () => {
  const idle = mkSession({ id: "a", state: "idle" });
  const review = mkSession({ id: "a", state: "idle", pendingReviews: 2 });
  const r = detectAlerts(scope([idle]), scope([review]));
  assert.equal(r[0]?.kind, "review");
  assert.equal(r[0]?.body, "2 to review");

  const gate: NmRunSummary = {
    id: "01RUN_GATE",
    status: "running",
    branch: "x",
    startedAt: null,
    endedAt: null,
    awaitingAgent: "parked 1m",
    findingsSummary: null,
    gateStep: "review",
    gateSummary: null,
    gateRisk: null,
    steps: [],
    activeSteps: [],
    findings: [],
    outcome: null,
  };
  const parked = mkSession({ id: "b", state: "idle", nomistakes: gate });
  const g = detectAlerts(scope([mkSession({ id: "b" })]), scope([parked]));
  assert.equal(g[0]?.kind, "gate");
  assert.match(g[0]?.body ?? "", /gate parked at review/);
});

test("a session entering awaiting_review alerts too (needs a decision)", () => {
  const working = mkSession({ id: "a", state: "working" });
  const review = mkSession({ id: "a", state: "awaiting_review" });
  const r = detectAlerts(scope([working]), scope([review]));
  assert.equal(r.length, 1);
  assert.equal(r[0]?.kind, "needs-input");
  assert.equal(r[0]?.body, "needs review");
});

test("a review landing on an already-waiting session still alerts (stacked causes)", () => {
  const waiting = mkSession({ id: "a", state: "awaiting_input", pendingReviews: 0 });
  const plusReview = mkSession({ id: "a", state: "awaiting_input", pendingReviews: 1 });
  const r = detectAlerts(scope([waiting]), scope([plusReview]));
  // Still awaiting input (no new input alert), but a fresh review alert fires.
  assert.equal(r.length, 1);
  assert.equal(r[0]?.kind, "review");
  assert.equal(r[0]?.body, "to review");
});

test("a task reaching failed alerts (attention) in any mode", () => {
  const running = mkTask({ id: "t1", status: "running" });
  const failed = mkTask({ id: "t1", status: "failed", error: "boom" });
  const r = detectAlerts(scope([], [running]), scope([], [failed]));
  assert.equal(r.length, 1);
  assert.equal(r[0]?.kind, "task-failed");
  assert.equal(r[0]?.body, "boom");
});

test("idle + task-done are always DETECTED, as info - delivery decides who hears them", () => {
  // These used to be gated on an `afk` flag, which made away mode louder than
  // being at the desk. Detection is now unconditional and the severity carries
  // the meaning: info is digest material, never an interruption.
  const busy = mkSession({ id: "a", state: "working" });
  const idle = mkSession({ id: "a", state: "idle" });
  const running = mkTask({ id: "t1", status: "running" });
  const done = mkTask({ id: "t1", status: "done", outcome: "shipped" });

  const r = detectAlerts(scope([busy], [running]), scope([idle], [done]));
  assert.deepEqual(r.map((a) => a.kind).sort(), ["idle", "task-done"]);
  assert.ok(r.every((a) => a.severity === "info"));
  // ...and none of them is deliverable, at the desk or away.
  assert.equal(r.filter(deliverable).length, 0);
});

test("backgrounding a no-mistakes run is not 'went idle'", () => {
  // The idle alert fires on a working -> idle bucket transition. An agent that
  // backgrounds its no-mistakes run and ends its turn goes `working` -> `idle` in
  // hook state, but it hasn't finished a burst of work and it isn't waiting on
  // you - the run is still going and will re-invoke it. Alerting here trains you
  // to ignore the alert that matters.
  const running: NmRunSummary = {
    id: "01RUN_BACKGROUNDED",
    status: "running",
    branch: "feature/x",
    startedAt: null,
    endedAt: null,
    awaitingAgent: null,
    findingsSummary: null,
    gateStep: null,
    gateSummary: null,
    gateRisk: null,
    steps: [{ step: "review", status: "running", findings: 0 }],
    activeSteps: [],
    findings: [],
    outcome: null,
  };
  const driving = mkSession({ id: "a", state: "working", nomistakes: running });
  const backgrounded = mkSession({ id: "a", state: "idle", nomistakes: running });
  assert.equal(detectAlerts(scope([driving]), scope([backgrounded])).length, 0);

  // Once the run finishes and the agent is genuinely parked, it does fire.
  const finished = mkSession({ id: "a", state: "idle", nomistakes: { ...running, status: "completed" } });
  const r = detectAlerts(scope([driving]), scope([finished]));
  assert.deepEqual(r.map((a) => a.kind), ["idle"]);
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

test("hasReportable is false for an empty/all-exited scope, true when there's activity", () => {
  assert.equal(hasReportable(scope([])), false);
  assert.equal(hasReportable(scope([mkSession({ state: "exited" })])), false);
  assert.equal(hasReportable(scope([mkSession({ state: "idle" })])), true);
  assert.equal(hasReportable(scope([], [mkTask({ status: "backlog" })])), true);
  assert.equal(hasReportable(scope([], [mkTask({ status: "done" })])), false);
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

test("digestLine counts sessions by bucket and includes backlog tasks", () => {
  const line = digestLine(
    scope(
      [
        mkSession({ id: "1", state: "awaiting_input" }),
        mkSession({ id: "2", state: "working" }),
        mkSession({ id: "3", state: "working" }),
        mkSession({ id: "4", state: "idle" }),
      ],
      [mkTask({ id: "q", status: "backlog" })],
    ),
  );
  assert.equal(line, "1 need you · 2 working · 1 idle · 1 in backlog");
});

// ---- the work queue's two causes ----

function mkQueue(over: Partial<SessionQueueSummary> = {}): SessionQueueSummary {
  return {
    openCount: 1,
    totalCount: 1,
    inFlightState: null,
    inFlightIntent: null,
    round: 0,
    blockingGaps: 0,
    verifiedCount: 0,
    escalatedCount: 0,
    drained: false,
    wrapupAskedAt: null,
    updatedAt: 0,
    ...over,
  };
}

test("an item escalating alerts once, and a SECOND escalation alerts again", () => {
  // Edge-triggered on the COUNT rising rather than on `escalatedCount > 0`: the
  // latter would re-fire on every tick for the life of the row, and a queue that is
  // driving a batch will sit with a finished escalation in it for a long time.
  const before = mkSession({ id: "a", queue: mkQueue() });
  const stuck = mkSession({ id: "a", queue: mkQueue({ escalatedCount: 1 }) });

  const first = detectAlerts(scope([before]), scope([stuck]));
  assert.equal(first.length, 1);
  assert.equal(first[0]?.kind, "foreman");
  assert.equal(first[0]?.id, "queue:a");
  assert.equal(first[0]?.severity, "attention");

  // Same count next tick -> quiet.
  assert.equal(detectAlerts(scope([stuck]), scope([stuck])).length, 0);

  // A second item escalating is a second thing needing you, so it speaks again.
  const worse = mkSession({ id: "a", queue: mkQueue({ escalatedCount: 2 }) });
  assert.equal(detectAlerts(scope([stuck]), scope([worse])).length, 1);
});

test("a queue's first sight with an escalation already in it still alerts", () => {
  // The same first-sight convention the sibling `review:` alert uses: a session that
  // appears (or that the panel sees for the first time) already needing you must not
  // be silently swallowed just because there is no `before` to compare against.
  const stuck = mkSession({ id: "a", queue: mkQueue({ escalatedCount: 1 }) });
  const r = detectAlerts(scope([]), scope([stuck]));
  assert.equal(r.length, 1);
  assert.equal(r[0]?.id, "queue:a");
});

test("the drain-time wrap-up ask alerts once, when it first appears", () => {
  // `wrapupAskedAt` is stamped once and then stays, so this has to trigger on it
  // APPEARING - not on it being set, which is true forever afterwards.
  const draining = mkSession({ id: "a", queue: mkQueue({ openCount: 0, drained: true }) });
  const asked = mkSession({
    id: "a",
    queue: mkQueue({ openCount: 0, drained: true, wrapupAskedAt: 123 }),
  });

  const r = detectAlerts(scope([draining]), scope([asked]));
  assert.equal(r.length, 1);
  assert.equal(r[0]?.id, "wrapup:a");
  assert.equal(r[0]?.kind, "foreman");

  assert.equal(detectAlerts(scope([asked]), scope([asked])).length, 0);
});

test("an escalation and a wrap-up ask on one tick are two separate alerts", () => {
  // They are different questions - "this item is stuck" and "the batch is done, ship
  // it?" - so neither may swallow the other.
  const before = mkSession({ id: "a", queue: mkQueue() });
  const both = mkSession({
    id: "a",
    queue: mkQueue({ escalatedCount: 1, wrapupAskedAt: 123, drained: true }),
  });
  const r = detectAlerts(scope([before]), scope([both]));
  assert.deepEqual(r.map((a: Alert) => a.id).sort(), ["queue:a", "wrapup:a"]);
});

// ---- stuck (from the daemon's stall detector) ----

const stall = (over: Partial<Stall> = {}): Stall => ({
  sessionId: "a",
  kind: "silent-working",
  forMs: 600_000,
  reason: "working but silent for 10m",
  ...over,
});

test("a newly-stalled session alerts once, as attention", () => {
  const s = mkSession({ id: "a", name: "auth-refactor" });
  const r = detectAlerts(scope([s]), scope([s], [], [stall()]));
  assert.equal(r.length, 1);
  assert.equal(r[0]?.kind, "stuck");
  assert.equal(r[0]?.severity, "attention");
  assert.match(r[0]!.title, /auth-refactor looks stuck/);
  assert.equal(r[0]?.body, "working but silent for 10m");
});

test("a stall that PERSISTS does not re-alert every tick", () => {
  // The detector reports a stall as long as it lasts; without edge-triggering this
  // would fire a notification on every poll for as long as the session stayed wedged.
  const s = mkSession({ id: "a" });
  const stalled = scope([s], [], [stall()]);
  assert.equal(detectAlerts(stalled, stalled).length, 0);
});

test("a stall that CHANGES kind alerts again - that is new information", () => {
  const s = mkSession({ id: "a" });
  const quiet = scope([s], [], [stall({ kind: "silent-working" })]);
  const escalated = scope([s], [], [stall({ kind: "escalated", reason: "escalated to you 5m ago" })]);
  const r = detectAlerts(quiet, escalated);
  assert.deepEqual(r.map((a: Alert) => a.kind), ["stuck"]);
  assert.equal(r[0]?.body, "escalated to you 5m ago");
});

test("a stall that RESOLVES alerts nothing", () => {
  const s = mkSession({ id: "a" });
  assert.equal(detectAlerts(scope([s], [], [stall()]), scope([s])).length, 0);
});

test("stuck alerts break through while away - they are attention, not digest material", () => {
  const s = mkSession({ id: "a" });
  const r = detectAlerts(scope([s]), scope([s], [], [stall()]));
  assert.equal(r.filter(deliverable).length, 1);
  assert.equal(r.filter(bufferable).length, 0);
});

// ---- stalls arriving after the snapshot (the notifier's baseline) ----
//
// Stalls are polled on their own channel, so they can land either side of the SSE
// snapshot the rest of the scope arrives in. These pin the property that ordering
// cannot change what you hear: a session stuck BEFORE the page loaded is never
// announced, and one that goes stuck after it is announced exactly once.

test("a session already stuck when the page loads alerts ZERO times", () => {
  // The race this rules out: snapshot first, so the baseline is captured with no
  // stalls, then the stalls fetch resolves and every pre-existing stall reads as new.
  const s = mkSession({ id: "a" });
  const snapshotOnly: AlertScope = { sessions: [s], tasks: [] }; // stalls not read yet
  const withStalls = scope([s], [], [stall()]);
  const r = detectAlerts(withKnownStalls(snapshotOnly, withStalls), withStalls);
  assert.equal(r.length, 0);
});

test("a stall that BEGINS after the first read still alerts exactly once", () => {
  const s = mkSession({ id: "a" });
  const quiet = scope([s], [], []); // read, and nothing was stuck
  const stuck = scope([s], [], [stall()]);
  assert.equal(detectAlerts(withKnownStalls(quiet, stuck), stuck).length, 1);
  assert.equal(detectAlerts(withKnownStalls(stuck, stuck), stuck).length, 0);
});

test("read-and-empty is not the same as never-read", () => {
  // The distinction the whole guard rests on: [] is knowledge, undefined is not.
  const s = mkSession({ id: "a" });
  const stuck = scope([s], [], [stall()]);
  assert.deepEqual(withKnownStalls({ sessions: [s], tasks: [] }, stuck).stalls, stuck.stalls);
  assert.deepEqual(withKnownStalls(scope([s], [], []), stuck).stalls, []);
});

test("a baseline that never read stalls is left alone when the next scope hasn't either", () => {
  const s = mkSession({ id: "a" });
  const bare: AlertScope = { sessions: [s], tasks: [] };
  assert.equal(withKnownStalls(bare, bare).stalls, undefined);
});

test("a scope with no stalls omits the field rather than guessing", () => {
  // Nothing but the daemon can compute stalls - sessionEqual keeps lastActivity off
  // the wire - so a scope built before the client's read of them lands carries none.
  const s = mkSession({ id: "a" });
  const noStalls: AlertScope = { sessions: [s], tasks: [] };
  assert.equal(detectAlerts(noStalls, noStalls).length, 0);
});

test("deliverable and bufferable partition a batch exactly", () => {
  const busy = mkSession({ id: "a", state: "working" });
  const idle = mkSession({ id: "a", state: "idle" });
  const waiting = mkSession({ id: "b", state: "awaiting_input" });
  const r = detectAlerts(scope([busy, mkSession({ id: "b", state: "working" })]), scope([idle, waiting]));
  assert.equal(r.filter(deliverable).length + r.filter(bufferable).length, r.length);
  assert.deepEqual(r.filter(deliverable).map((a: Alert) => a.kind), ["needs-input"]);
  assert.deepEqual(r.filter(bufferable).map((a: Alert) => a.kind), ["idle"]);
});

test("digestLine counts stalled sessions", () => {
  const s = mkSession({ id: "a", state: "working" });
  assert.match(digestLine(scope([s], [], [stall()])), /1 stuck/);
  assert.doesNotMatch(digestLine(scope([s])), /stuck/);
});

test("an idle alert carries no redundant body when the activity is just 'idle'", () => {
  // The Stop hook sets activity to the literal string "idle", so using it
  // unconditionally produced "X went idle - idle" - noise in the digest, and
  // enough to make the digest model report that nothing had happened.
  const busy = mkSession({ id: "a", state: "working" });
  const stopped = mkSession({ id: "a", state: "idle", activity: "idle" });
  assert.equal(detectAlerts(scope([busy]), scope([stopped]))[0]?.body, "");

  // A real last-activity line still rides along, because that DOES add something.
  const withWork = mkSession({ id: "a", state: "idle", activity: "npm test done" });
  assert.equal(detectAlerts(scope([busy]), scope([withWork]))[0]?.body, "npm test done");
});
