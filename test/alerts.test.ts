import { test } from "node:test";
import { mkTask as baseTask } from "./helpers/session-fixture.ts";
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
import type { WorkflowRunSummary } from "../src/shared/workflow.ts";

function mkSession(over: Partial<Session> = {}): Session {
  return {
    id: "s",
    agent: "claude",
    name: "sess",
    runtime: "terminal",
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
    nomistakes: null,
    nomistakesFixes: [],
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
  baseTask({ id: "t", intent: "do", status: "running", createdAt: 0, updatedAt: 0, ...over });

const scope = (
  sessions: Session[],
  tasks: Task[] = [],
  stalls: Stall[] = [],
  workflowRuns: WorkflowRunSummary[] = [],
): AlertScope => ({
  sessions,
  tasks,
  stalls,
  workflowRuns,
});

function workflowRun(over: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    id: "workflow-run",
    bindingId: "binding",
    workflowId: "workflow",
    workflowName: "Review flow",
    workflowVersion: 1,
    sessionId: "session",
    noteKey: "note",
    status: "running",
    phase: "persona_review",
    round: 1,
    maxRepairRounds: 5,
    activePersonaNames: [],
    failedPersonaCount: 0,
    bypassedPersonaReview: false,
    gate: "none",
    gatePrNumber: null,
    gateHeadShort: null,
    reviewPosture: null,
    uncertainDeliveryCount: 0,
    refusedDeliveryCount: 0,
    updatedAt: 1,
    ...over,
  };
}

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
    prUrl: null,
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

test("a menu appearing alerts, even with no hooks to report it", () => {
  // The gap: `awaiting_input` is hook-reported, so the uninstrumented session a pane
  // dialog is the ONLY evidence for got a correct board badge and no notification - the
  // most definitively blocked session on the board, silent to someone away from it.
  const menu = { options: [{ number: 1, label: "Yes" }, { number: 2, label: "No" }], highlighted: 1 };
  const quiet = mkSession({ id: "a", state: "idle" });
  const parked = mkSession({ id: "a", state: "idle", paneDialog: menu });

  const r = detectAlerts(scope([quiet]), scope([parked]));
  assert.equal(r.length, 1);
  assert.equal(r[0]?.kind, "needs-input");
  assert.equal(r[0]?.severity, "attention");
  assert.equal(r[0]?.body, "2 options to pick from");

  // Edge-triggered: the same menu still up next tick is not news.
  assert.equal(detectAlerts(scope([parked]), scope([parked])).length, 0);

  // Nor is the cursor moving in the terminal - that is the same question, read again.
  const moved = mkSession({ id: "a", state: "idle", paneDialog: { ...menu, highlighted: 2 } });
  assert.equal(detectAlerts(scope([parked]), scope([moved])).length, 0);
});

test("a menu replaced by a DIFFERENT one with no observed gap still alerts", () => {
  // Answering a permission prompt only for the next one to open inside the same 1.5s poll
  // leaves a menu on both sides of the transition. Edge-triggering on presence reads that
  // as "still parked" and never announces the new question, so the tightening is onto
  // identity: prompt plus rows.
  const first = mkSession({
    id: "a",
    state: "idle",
    inspector: null,
    paneDialog: { prompt: "Run npm test?", options: [{ number: 1, label: "Yes" }], highlighted: 1 },
  });
  const second = mkSession({
    id: "a",
    state: "idle",
    inspector: null,
    paneDialog: {
      prompt: "Which database?",
      options: [{ number: 1, label: "Postgres" }, { number: 2, label: "SQLite" }],
      highlighted: 1,
    },
  });
  const r = detectAlerts(scope([first]), scope([second]));
  assert.equal(r.length, 1);
  assert.equal(r[0]?.kind, "needs-input");
  assert.equal(r[0]?.body, "2 options to pick from");
});

test("a promoted driver request alerts when its visible shape is unchanged", () => {
  const menu = {
    source: "driver" as const,
    kind: "question" as const,
    prompt: "Choose one",
    options: [{ number: 1, label: "Yes" }],
    highlighted: 0,
  };
  const first = mkSession({
    id: "a",
    state: "idle",
    runtime: "sdk",
    paneDialog: { ...menu, requestId: "request-one" },
  });
  const second = mkSession({
    id: "a",
    state: "idle",
    runtime: "sdk",
    paneDialog: { ...menu, requestId: "request-two" },
  });
  const r = detectAlerts(scope([first]), scope([second]));
  assert.equal(r.length, 1);
  assert.equal(r[0]?.kind, "needs-input");
});

test("a menu opening on a session with reviews waiting announces the MENU", () => {
  // `needsYouReason` puts an open review first - correct for triage, where a review is the
  // more specific ask. An alert is the other question: what just happened. Routing the
  // body through it made the one toast the human gets say "to review" about a menu, and
  // the review alert can't correct that (it only fires when the count rises from zero).
  const menu = { options: [{ number: 1, label: "Yes" }, { number: 2, label: "No" }], highlighted: 1 };
  const reviewing = mkSession({ id: "a", state: "idle", pendingReviews: 3 });
  const parked = mkSession({ id: "a", state: "idle", pendingReviews: 3, paneDialog: menu });

  const r = detectAlerts(scope([reviewing]), scope([parked]));
  const input = r.filter((a) => a.kind === "needs-input");
  assert.equal(input.length, 1);
  assert.equal(input[0]?.body, "2 options to pick from");
});

test("one blocked session is one alert, however many ways it says so", () => {
  // An instrumented session hits both paths on the same tick - the Notification hook
  // flips the state as the pane capture reads the menu - and two toasts for one prompt
  // is how an alert stream teaches people to ignore it.
  const menu = { options: [{ number: 1, label: "Yes" }], highlighted: 1 };
  const working = mkSession({ id: "a", state: "working" });
  const both = mkSession({ id: "a", state: "awaiting_input", paneDialog: menu });
  const r = detectAlerts(scope([working]), scope([both]));
  assert.equal(r.filter((a) => a.kind === "needs-input").length, 1);
});

test("a menu left on an exited session's screen alerts nobody", () => {
  const menu = { options: [{ number: 1, label: "Yes" }], highlighted: 1 };
  const live = mkSession({ id: "a", state: "working" });
  const dead = mkSession({ id: "a", state: "exited", paneDialog: menu });
  assert.equal(detectAlerts(scope([live]), scope([dead])).length, 0);
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
    prUrl: null,
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
    wrapupAnswered: false,
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

test("the drain-time wrap-up ask alerts once per drain", () => {
  // Once per DRAIN, not once ever: the ask is edge-detected on its timestamp moving,
  // so a repeat drain (which clears `wrapupAskedAt` back to null when the new items
  // are queued, then stamps a fresh one) speaks again while a re-render does not.
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

test("a RE-ARMED prompted wrap-up alerts again, though the ask was never null", () => {
  // The regression this pins. The prompted trigger re-stamps `wrapupAskedAt` over an
  // already-set value - only the drain path passes back through null, because
  // `addItem` clears it when new work is queued. Edge-detecting on the timestamp
  // appearing therefore went silent for every prompted episode after the first, which
  // is the mainline case: re-arm requires a NEW HUMAN PROMPT, so the human does more
  // work, Foreman decides it is shippable, and nothing says so.
  const answered = mkSession({
    id: "a",
    queue: mkQueue({ openCount: 0, totalCount: 0, wrapupAskedAt: 100, wrapupAnswered: true }),
  });
  const reArmed = mkSession({
    id: "a",
    queue: mkQueue({ openCount: 0, totalCount: 0, wrapupAskedAt: 200, wrapupAnswered: false }),
  });

  const r = detectAlerts(scope([answered]), scope([reArmed]));
  assert.equal(r.length, 1);
  assert.equal(r[0]?.id, "wrapup:a");
  // ...and it is worded as a prompted wrap-up, not as a queue that drained.
  assert.doesNotMatch(r[0]?.title ?? "", /queue/i);

  // Still edge-triggered: the same episode re-rendered says nothing more.
  assert.equal(detectAlerts(scope([reArmed]), scope([reArmed])).length, 0);
});

test("answering an ask is not itself an alert", () => {
  // The answer lands on the same timestamp, so nothing new was asked. Without the
  // pending check a frame carrying a new ask AND its answer together would announce a
  // question that is already settled.
  const asked = mkSession({
    id: "a",
    queue: mkQueue({ openCount: 0, totalCount: 0, wrapupAskedAt: 200 }),
  });
  const done = mkSession({
    id: "a",
    queue: mkQueue({ openCount: 0, totalCount: 0, wrapupAskedAt: 200, wrapupAnswered: true }),
  });
  assert.equal(detectAlerts(scope([asked]), scope([done])).length, 0);

  const fresh = mkSession({
    id: "a",
    queue: mkQueue({ openCount: 0, totalCount: 0, wrapupAskedAt: 300, wrapupAnswered: true }),
  });
  assert.equal(detectAlerts(scope([done]), scope([fresh])).length, 0);
});

test("workflow transitions use the shared edge-triggered alert engine", () => {
  const base = workflowRun();
  const cases: Array<{
    next: WorkflowRunSummary;
    id: string;
    severity: "attention" | "info";
  }> = [
    {
      next: workflowRun({ uncertainDeliveryCount: 1, phase: "delivery_uncertain" }),
      id: "workflow:workflow-run:uncertain",
      severity: "attention",
    },
    {
      next: workflowRun({ status: "failed", phase: "persona_error" }),
      id: "workflow:workflow-run:failed",
      severity: "attention",
    },
    {
      next: workflowRun({ status: "waiting_for_session", phase: "unchanged_evidence" }),
      id: "workflow:workflow-run:manual-resubmit",
      severity: "attention",
    },
    {
      next: workflowRun({ gate: "waiting_pr", phase: "waiting_for_pr" }),
      id: "workflow:workflow-run:missing-pr",
      severity: "attention",
    },
    {
      next: workflowRun({ status: "blocked", gate: "blocked", phase: "inspector_disabled" }),
      id: "workflow:workflow-run:inspector-enablement",
      severity: "attention",
    },
    {
      next: workflowRun({ status: "completed", phase: "complete" }),
      id: "workflow:workflow-run:completed",
      severity: "info",
    },
  ];
  for (const item of cases) {
    const previous = scope([], [], [], [base]);
    const next = scope([], [], [], [item.next]);
    const alerts = detectAlerts(previous, next);
    assert.equal(alerts.length, 1, item.id);
    assert.equal(alerts[0]?.id, item.id);
    assert.equal(alerts[0]?.severity, item.severity);
    assert.equal(alerts[0]?.workflowRunId, "workflow-run");
    assert.deepEqual(detectAlerts(next, next), [], `${item.id} repeated without an edge`);
  }
});
