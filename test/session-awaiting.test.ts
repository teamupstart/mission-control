import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { ReportAwaitingBody, ReportBlockerBody } from "../src/shared/protocol.ts";
import { SESSION_AWAITING_FLAG_ID } from "../src/shared/feature-flag-registry.ts";
import { mkMuxHandle, mkSession, mkTask } from "./helpers/session-fixture.ts";

// A session idle on purpose while a background process finishes (issue #1596). The record is
// keyed by the note key like a blocker, but it ends on the session's own next turn, on exit,
// with its task, or on a clear, and its hold lifts by itself at the deadline it declared.

const home = mkdtempSync(join(tmpdir(), "mission-session-awaiting-"));
process.env.MISSION_HOME = home;

const {
  openDb, loadSessionAwaitings, markWorkCycleActive, completeWorkCycle, workCycleFor, getQueueRow,
} = await import("../src/server/db.ts");
const { resolvedSessionIntent } = await import("../src/shared/goal.ts");
const { Registry, noteKeyFor } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const { applyFeatureFlagIntent } = await import("../src/server/feature-flags/index.ts");
const { isAwaiting, awaitingOverdue } = await import("../src/shared/session.ts");
const { detectStall, NO_UNPUSHED } = await import("../src/shared/stall.ts");
const {
  reserveInjection, releaseInjection, recordInjection, confirmReservedInjection, onAutomatedDelivery, forgetInjections,
  onPersonDelivery, notePersonDelivery, withdrawPersonDelivery, injectionFingerprint,
} = await import("../src/server/injections.ts");

type ReviewManagerT = import("../src/server/reviews.ts").ReviewManager;
type TaskManager = import("../src/server/tasks.ts").TaskManager;
type RegistryT = InstanceType<typeof Registry>;

after(() => rmSync(home, { recursive: true, force: true }));
openDb();

let seq = 0;

function mkDiscovered(over: Partial<DiscoveredSession> = {}): DiscoveredSession {
  const n = ++seq;
  return {
    syntheticId: `proc:ttys20${n}:${n}:0`,
    agent: "claude",
    name: "work",
    nameSource: "process",
    cwd: `/wt/awaiting-${n}`,
    gitBranch: "harness/awaiting",
    pid: 2000 + n,
    tty: `ttys20${n}`,
    terminals: [mkMuxHandle({ session: "s", windowName: "w", windowIndex: 0, paneId: `%${200 + n}` })],
    startedAt: 0,
    ...over,
  } as DiscoveredSession;
}

const WHAT = "CI checks on PR #1612";
const MIN = 60_000;

/** A declaration as the registry receives it: `expectedBy` already read into epoch ms. */
function body(at = Date.now(), minutes = 20): ReportAwaitingBody {
  return {
    what: WHAT,
    wakeSource: "command",
    expectedBy: at + minutes * MIN,
    referenceUrl: "https://github.com/teamupstart/mission-control/pull/1612/checks",
    details: "Started `gh pr checks 1612 --watch` in the background.",
  };
}

/** The same declaration as `report_awaiting` sends it over the wire: `expectedBy` as ISO 8601. */
function wire(expectedBy: number | string = Date.now() + 20 * MIN) {
  const { expectedBy: _ms, ...rest } = body();
  return { ...rest, expectedBy: typeof expectedBy === "string" ? expectedBy : new Date(expectedBy).toISOString() };
}

const BLOCKER: ReportBlockerBody = {
  kind: "question",
  reason: "Need the retention window",
  waitingOn: "Dana (platform)",
  resumeWhen: "Platform answers",
  referenceUrl: null,
  details: null,
};

/**
 * Drive a discovered terminal session's state through its hooks, as a real turn would. `ts` is
 * when the hook says it fired; omitted, it is the moment it arrives.
 */
function hook(
  registry: RegistryT,
  d: DiscoveredSession,
  event: "UserPromptSubmit" | "Stop" | "PreToolUse",
  prompt = "go",
  ts?: number,
) {
  registry.applyHook({
    agent: "claude",
    event,
    sessionId: `agent-${d.syntheticId}`,
    cwd: d.cwd,
    transcriptPath: null,
    ...(event === "UserPromptSubmit" ? { prompt } : {}),
    ...(event === "PreToolUse" ? { toolName: "Bash" } : {}),
    ...(ts !== undefined ? { ts } : {}),
    env: { tmuxPane: (d.terminals[0] as { paneId: string }).paneId },
  });
}

function awaitingEvents(sessionId: string, kind: string): Array<Record<string, unknown>> {
  const rows = openDb().prepare(`SELECT payload FROM session_events WHERE session_id = ? AND kind = ? ORDER BY id`)
    .all(sessionId, kind) as Array<{ payload: string }>;
  return rows.map((r) => JSON.parse(r.payload) as Record<string, unknown>);
}

function clearedEvents(sessionId: string): Array<Record<string, unknown>> {
  return awaitingEvents(sessionId, "session_awaiting_cleared");
}

/**
 * Wire Mission Control's automated deliveries, and a person's own, into this registry's waits,
 * exactly as the daemon does at startup (`src/server/index.ts`). Returns the unsubscribe.
 */
function wireNudges(registry: RegistryT): () => void {
  const stopAutomated = onAutomatedDelivery((delivery) =>
    registry.noteAutomatedDelivery(delivery.sessionId, delivery.at, delivery.key, delivery.released));
  const stopPerson = onPersonDelivery((delivery) => registry.notePersonDelivery(delivery));
  return () => {
    stopAutomated();
    stopPerson();
  };
}

/** Two discovered sessions, live together, each in the middle of the turn that declares a wait. */
function workingPair(registry: RegistryT): [DiscoveredSession, DiscoveredSession] {
  const pair: [DiscoveredSession, DiscoveredSession] = [mkDiscovered(), mkDiscovered()];
  registry.applyDiscovery(pair);
  for (const d of pair) hook(registry, d, "UserPromptSubmit");
  return pair;
}

/** A discovered session in the middle of the turn that declares the wait. */
function working(registry: RegistryT): DiscoveredSession {
  const d = mkDiscovered();
  registry.applyDiscovery([d]);
  hook(registry, d, "UserPromptSubmit");
  assert.equal(registry.getSession(d.syntheticId)?.state, "working");
  return d;
}

test("a declaration records what, how it wakes and a deadline measured on the daemon's clock", () => {
  const registry = new Registry();
  const d = working(registry);
  const r = registry.reportAwaiting(d.syntheticId, body(1_000_000), 1_000_000);
  assert.ok(r.ok && r.created);
  const a = registry.getSession(d.syntheticId)!.awaiting!;
  assert.equal(a.what, WHAT);
  assert.equal(a.wakeSource, "command");
  assert.equal(a.expectedBy, 1_000_000 + 20 * 60_000);
  assert.equal(a.startedAt, 1_000_000);
  assert.ok(loadSessionAwaitings().some((row) => row.noteKey === noteKeyFor(registry.getSession(d.syntheticId)!)));

  // A re-declaration in the same turn keeps the wait's start and moves the deadline, under a new
  // id: a Clear sent from a view of the earlier declaration must not end this one.
  const again = registry.reportAwaiting(d.syntheticId, body(1_060_000, 45), 1_060_000);
  assert.ok(again.ok && !again.created);
  const b = registry.getSession(d.syntheticId)!.awaiting!;
  assert.notEqual(b.id, a.id);
  assert.equal(b.startedAt, 1_000_000);
  assert.equal(b.expectedBy, 1_060_000 + 45 * 60_000);

  // One audit row for the declaration and one for the re-declaration, with their payloads.
  assert.deepEqual(awaitingEvents(d.syntheticId, "session_awaiting_set"), [{
    actor: "session", what: WHAT, wakeSource: "command", expectedBy: 1_000_000 + 20 * MIN,
  }]);
  assert.deepEqual(awaitingEvents(d.syntheticId, "session_awaiting_updated"), [{
    actor: "session", what: WHAT, wakeSource: "command", expectedBy: 1_060_000 + 45 * MIN, sinceMs: 60_000,
  }]);
});

test("expectedBy is bounded on the daemon's clock: it must be after now and at most 240 minutes out", () => {
  const registry = new Registry();
  const d = working(registry);
  const at = 50_000_000;
  const declare = (expectedBy: number) => registry.reportAwaiting(d.syntheticId, { ...body(at), expectedBy }, at);

  const now = declare(at);
  assert.ok(!now.ok && now.status === 400 && /in the future/.test(now.error), "a deadline of now was accepted");
  const before = declare(at - 1);
  assert.ok(!before.ok && before.status === 400);
  const beyond = declare(at + 240 * MIN + 1);
  assert.ok(!beyond.ok && beyond.status === 400 && /at most 240 minutes/.test(beyond.error), "a deadline past the ceiling was accepted");
  assert.equal(registry.getAwaiting(d.syntheticId), null, "a refused declaration was stored");

  // The exact limits are accepted: the first instant after now, and the ceiling itself.
  const soonest = declare(at + 1);
  assert.ok(soonest.ok);
  assert.equal(registry.getAwaiting(d.syntheticId)?.expectedBy, at + 1);
  const ceiling = declare(at + 240 * MIN);
  assert.ok(ceiling.ok);
  assert.equal(registry.getAwaiting(d.syntheticId)?.expectedBy, at + 240 * MIN);
});

test("the wait ends on the session's next turn, not on the rest of the turn that declared it", () => {
  const registry = new Registry();
  const d = working(registry);
  assert.equal(registry.reportAwaiting(d.syntheticId, body()).ok, true);

  // Still the declaring turn: more tool calls do not wake it.
  hook(registry, d, "PreToolUse");
  assert.ok(registry.getAwaiting(d.syntheticId), "a tool call inside the declaring turn ended the wait");

  // The turn ends; the session is idle on purpose.
  hook(registry, d, "Stop");
  assert.equal(registry.getSession(d.syntheticId)?.state, "idle");
  assert.ok(registry.getAwaiting(d.syntheticId), "the declaring turn's end ended the wait");

  // The background process reports back and starts a new turn: that is the wake.
  hook(registry, d, "UserPromptSubmit");
  assert.equal(registry.getAwaiting(d.syntheticId), null);
  assert.equal(registry.getSession(d.syntheticId)?.awaiting, null);
  assert.ok(!loadSessionAwaitings().some((row) => row.noteKey === noteKeyFor(registry.getSession(d.syntheticId)!)));
  assert.equal(clearedEvents(d.syntheticId).at(-1)?.actor, "wake");
});

test("a wait declared while the registry already reads the session idle still ends on the next turn", () => {
  // The declaring turn's hooks lost the race with the MCP call, or never arrived: the registry
  // read idle before the declaration and still does after it, so that turn's end is no
  // transition. Its Stop, stamped after the call returned, is what says the turn is over.
  const registry = new Registry();
  const d = mkDiscovered();
  registry.applyDiscovery([d]);
  const at = Date.now() - 60_000;
  hook(registry, d, "UserPromptSubmit", "go", at - 2_000);
  hook(registry, d, "Stop", "go", at - 1_000);
  assert.equal(registry.getSession(d.syntheticId)?.state, "idle");
  assert.equal(registry.reportAwaiting(d.syntheticId, body(at), at).ok, true);

  hook(registry, d, "Stop", "go", at + 1_000);
  assert.ok(registry.getAwaiting(d.syntheticId), "the declaring turn's end ended the wait");

  hook(registry, d, "UserPromptSubmit", "the build finished", at + 120_000);
  assert.equal(registry.getAwaiting(d.syntheticId), null, "the next turn after an idle declaration was not the wake");
  assert.equal(clearedEvents(d.syntheticId).at(-1)?.actor, "wake");
});

test("a late hook from a turn that declared while the registry read idle is not the wake", () => {
  // The same race, the other way round: the declaring turn's own hooks arrive after the call.
  // Its working reading and its end are that turn's, and only the turn after it is the wake.
  const registry = new Registry();
  const d = mkDiscovered();
  registry.applyDiscovery([d]);
  const at = Date.now() - 60_000;
  hook(registry, d, "UserPromptSubmit", "go", at - 2_000);
  hook(registry, d, "Stop", "go", at - 1_000);
  assert.equal(registry.reportAwaiting(d.syntheticId, body(at), at).ok, true);

  hook(registry, d, "PreToolUse", "go", at - 200);
  assert.equal(registry.getSession(d.syntheticId)?.state, "working");
  assert.ok(registry.getAwaiting(d.syntheticId), "the declaring turn's late tool call read as the wake");
  hook(registry, d, "Stop", "go", at + 1_000);
  assert.ok(registry.getAwaiting(d.syntheticId), "the declaring turn's end ended the wait");

  hook(registry, d, "UserPromptSubmit", "the build finished", at + 120_000);
  assert.equal(registry.getAwaiting(d.syntheticId), null);
  assert.equal(clearedEvents(d.syntheticId).at(-1)?.actor, "wake");
});

test("report_status inside a turn that declared while the registry read idle does not end that turn", () => {
  // `report_status` stamps the session's activity mid-turn and leaves its state alone, so the
  // registry still reads idle with a fresher stamp. That is not the turn ending: only the
  // session's own lifecycle source reporting idle after the declaration is.
  const registry = new Registry();
  const d = mkDiscovered();
  registry.applyDiscovery([d]);
  const at = Date.now() - 60_000;
  hook(registry, d, "UserPromptSubmit", "go", at - 2_000);
  hook(registry, d, "Stop", "go", at - 1_000);
  assert.equal(registry.reportAwaiting(d.syntheticId, body(at), at).ok, true);

  registry.applyStatus({ tmuxPane: (d.terminals[0] as { paneId: string }).paneId }, `agent-${d.syntheticId}`, "watching CI");
  assert.equal(registry.getSession(d.syntheticId)?.state, "idle");
  hook(registry, d, "PreToolUse", "go", at + 500);
  assert.ok(registry.getAwaiting(d.syntheticId), "a report_status mid-turn settled the wait, so the turn's next tool call read as the wake");
  hook(registry, d, "Stop", "go", at + 1_000);
  assert.ok(registry.getAwaiting(d.syntheticId));

  hook(registry, d, "UserPromptSubmit", "the build finished", at + 120_000);
  assert.equal(registry.getAwaiting(d.syntheticId), null);
  assert.equal(clearedEvents(d.syntheticId).at(-1)?.actor, "wake");
});

test("a hookless session that declares while it reads idle still ends its wait on the next turn", () => {
  // A transcript-read session whose declaring turn was too short for any sweep to see working.
  // Its end moves only `lastActivity`; the sweep still emits that, and the fresher reading is
  // what records the declaring turn's end.
  const registry = new Registry();
  const d = mkDiscovered({ agent: "codex" });
  registry.applyDiscovery([d]);
  const read = (state: "idle" | "working", lastActivity: number) => {
    registry.applyPassiveActivity(registry.getSession(d.syntheticId)!, { state, lastActivity });
    registry.applyDiscovery([d]);
  };
  const at = Date.now() - 60_000;
  read("idle", at - 1_000);
  assert.equal(registry.getSession(d.syntheticId)?.stateConfirmed, true);
  assert.equal(registry.reportAwaiting(d.syntheticId, body(at), at).ok, true);

  read("idle", at + 1_000);
  assert.ok(registry.getAwaiting(d.syntheticId), "the declaring turn's end ended the wait");

  read("working", at + 120_000);
  assert.equal(registry.getAwaiting(d.syntheticId), null, "the next turn after an idle declaration was not the wake");
  assert.equal(clearedEvents(d.syntheticId).at(-1)?.actor, "wake");
});

test("Mission Control's own nudge is not a wake: the wait stands through it and ends on the session's next turn", (t) => {
  const registry = new Registry();
  t.after(wireNudges(registry));
  const d = working(registry);
  assert.equal(registry.reportAwaiting(d.syntheticId, body()).ok, true);
  hook(registry, d, "Stop");

  // Past the deadline Foreman (or a workflow, or a resident) types into the session. It claims
  // the delivery before typing, so the turn that follows is Mission Control's, not the wake.
  reserveInjection(d.syntheticId, "Please wrap up and open the pull request.", "foreman");
  hook(registry, d, "UserPromptSubmit", "Please wrap up and open the pull request.");
  assert.ok(registry.getAwaiting(d.syntheticId), "Mission Control's own nudge ended the wait");
  hook(registry, d, "Stop");
  assert.ok(registry.getAwaiting(d.syntheticId), "the nudged turn's end ended the wait");
  assert.deepEqual(clearedEvents(d.syntheticId), []);

  // The next turn nobody in Mission Control started is the session's own wake.
  hook(registry, d, "UserPromptSubmit");
  assert.equal(registry.getAwaiting(d.syntheticId), null);
  assert.equal(clearedEvents(d.syntheticId).at(-1)?.actor, "wake");
});

test("a controlling session's message is a wake, and so is a turn after an automated delivery that never landed", (t) => {
  const registry = new Registry();
  t.after(wireNudges(registry));
  const delegated = working(registry);
  assert.equal(registry.reportAwaiting(delegated.syntheticId, body()).ok, true);
  hook(registry, delegated, "Stop");
  // Another agent speaking through session control is not Mission Control's automation.
  recordInjection(delegated.syntheticId, "Check your CI now.", "session");
  hook(registry, delegated, "UserPromptSubmit");
  assert.equal(registry.getAwaiting(delegated.syntheticId), null);
  assert.equal(clearedEvents(delegated.syntheticId).at(-1)?.actor, "wake");

  const refused = working(registry);
  assert.equal(registry.reportAwaiting(refused.syntheticId, body()).ok, true);
  hook(registry, refused, "Stop");
  // A workflow claimed a delivery and then provably failed to type it: nothing was nudged.
  reserveInjection(refused.syntheticId, "Round 2 repair packet", "workflow");
  releaseInjection(refused.syntheticId, "Round 2 repair packet");
  hook(registry, refused, "UserPromptSubmit");
  assert.equal(registry.getAwaiting(refused.syntheticId), null, "a refused delivery kept a real wake from ending the wait");
});

test("a nudge claimed before a daemon restart is still not a wake after it, and rediscovery is not a wake either", () => {
  const first = new Registry();
  const stopFirst = wireNudges(first);
  let key: string;
  let d: DiscoveredSession;
  try {
    d = working(first);
    assert.equal(first.reportAwaiting(d.syntheticId, body()).ok, true);
    hook(first, d, "Stop");
    key = noteKeyFor(first.getSession(d.syntheticId)!);
    // Past the deadline Foreman claims a delivery, and the daemon restarts before it sees the
    // turn that delivery starts.
    reserveInjection(d.syntheticId, "Please wrap up and open the pull request.", "foreman");
    const stored = loadSessionAwaitings().find((row) => row.noteKey === key)!;
    assert.ok(stored.settledAt !== null, "the declaring turn's end was not stored");
    assert.equal(stored.pendingNudges.length, 1, "the nudge was not stored on the wait");
  } finally {
    stopFirst();
  }
  // The restart forgets every in-memory delivery; only what SQLite holds survives it.
  forgetInjections();
  const second = new Registry();
  second.applyDiscovery([d]);
  // Rediscovery is the first state this process sees, never a turn starting: no wake.
  assert.ok(second.getAwaiting(d.syntheticId), "rediscovering the session after the restart ended its wait");
  hook(second, d, "Stop");
  // The nudged turn starts: the stored attribution keeps it from reading as the wake.
  hook(second, d, "UserPromptSubmit", "Please wrap up and open the pull request.");
  assert.ok(second.getAwaiting(d.syntheticId), "a nudge claimed before the restart ended the wait as a wake");
  assert.deepEqual(clearedEvents(d.syntheticId), []);
  // The turn after the nudge's own end is judged afresh, and this one is the wake.
  hook(second, d, "Stop");
  hook(second, d, "UserPromptSubmit");
  assert.equal(second.getAwaiting(d.syntheticId), null);
  assert.equal(clearedEvents(d.syntheticId).at(-1)?.actor, "wake");
});

test("overlapping automated deliveries: withdrawing one that failed keeps the earlier one's turn from reading as a wake", (t) => {
  const registry = new Registry();
  t.after(wireNudges(registry));
  const d = working(registry);
  assert.equal(registry.reportAwaiting(d.syntheticId, body()).ok, true);
  hook(registry, d, "Stop");
  const key = noteKeyFor(registry.getSession(d.syntheticId)!);
  const stored = () => loadSessionAwaitings().find((row) => row.noteKey === key)!;

  // A workflow claims delivery A, then Foreman claims delivery B, before the session's next turn.
  reserveInjection(d.syntheticId, "Round 2 repair packet", "workflow");
  const [a] = stored().pendingNudges;
  assert.ok(a !== undefined && a.at >= stored().settledAt!);
  reserveInjection(d.syntheticId, "Please wrap up and open the pull request.", "foreman");
  assert.equal(stored().pendingNudges.length, 2);
  // B provably fails to land and is given back. A is still on its way.
  releaseInjection(d.syntheticId, "Please wrap up and open the pull request.");
  assert.deepEqual(stored().pendingNudges, [a], "withdrawing B erased the attribution A still holds");

  // A's turn starts: Mission Control's, not the wake.
  hook(registry, d, "UserPromptSubmit", "Round 2 repair packet");
  assert.ok(registry.getAwaiting(d.syntheticId), "the landed delivery's turn ended the wait as a wake");
  hook(registry, d, "Stop");
  hook(registry, d, "UserPromptSubmit");
  assert.equal(registry.getAwaiting(d.syntheticId), null);
  assert.equal(clearedEvents(d.syntheticId).at(-1)?.actor, "wake");
});

test("overlapping automated deliveries across a restart: the earlier landed delivery is still Mission Control's after it", () => {
  const first = new Registry();
  const stopFirst = wireNudges(first);
  let d: DiscoveredSession;
  try {
    d = working(first);
    assert.equal(first.reportAwaiting(d.syntheticId, body()).ok, true);
    hook(first, d, "Stop");
    const key = noteKeyFor(first.getSession(d.syntheticId)!);
    const stored = () => loadSessionAwaitings().find((row) => row.noteKey === key)!;
    reserveInjection(d.syntheticId, "Round 2 repair packet", "workflow");
    const [a] = stored().pendingNudges;
    reserveInjection(d.syntheticId, "Please wrap up and open the pull request.", "foreman");
    releaseInjection(d.syntheticId, "Please wrap up and open the pull request.");
    assert.ok(a !== undefined);
    assert.deepEqual(stored().pendingNudges, [a], "the stored attribution did not keep the delivery that landed");
  } finally {
    stopFirst();
  }
  forgetInjections();
  const second = new Registry();
  second.applyDiscovery([d]);
  assert.ok(second.getAwaiting(d.syntheticId));
  hook(second, d, "Stop");
  hook(second, d, "UserPromptSubmit", "Round 2 repair packet");
  assert.ok(second.getAwaiting(d.syntheticId), "after the restart the landed delivery's turn ended the wait as a wake");
  hook(second, d, "Stop");
  hook(second, d, "UserPromptSubmit");
  assert.equal(second.getAwaiting(d.syntheticId), null);
  assert.equal(clearedEvents(d.syntheticId).at(-1)?.actor, "wake");
});

test("two automated deliveries that both land are two nudged turns: neither reads as the wake", (t) => {
  const registry = new Registry();
  t.after(wireNudges(registry));
  const d = working(registry);
  assert.equal(registry.reportAwaiting(d.syntheticId, body()).ok, true);
  hook(registry, d, "Stop");
  const key = noteKeyFor(registry.getSession(d.syntheticId)!);
  const stored = () => loadSessionAwaitings().find((row) => row.noteKey === key)!;

  // A workflow's packet A and Foreman's prompt B are both claimed, and both land, before A starts.
  reserveInjection(d.syntheticId, "Round 2 repair packet", "workflow");
  confirmReservedInjection(d.syntheticId, "Round 2 repair packet", "workflow");
  reserveInjection(d.syntheticId, "Please wrap up and open the pull request.", "foreman");
  confirmReservedInjection(d.syntheticId, "Please wrap up and open the pull request.", "foreman");
  assert.equal(stored().pendingNudges.length, 2);

  // A's turn, then A's end: the wait settles again later than both claims.
  hook(registry, d, "UserPromptSubmit", "Round 2 repair packet");
  assert.ok(registry.getAwaiting(d.syntheticId), "A's turn ended the wait as a wake");
  hook(registry, d, "Stop");
  assert.equal(stored().pendingNudges.length, 1);
  // B's turn is Mission Control's too.
  hook(registry, d, "UserPromptSubmit", "Please wrap up and open the pull request.");
  assert.ok(registry.getAwaiting(d.syntheticId), "B's turn ended the wait as a wake once A's turn had settled it again");
  hook(registry, d, "Stop");
  assert.deepEqual(stored().pendingNudges, []);
  assert.deepEqual(clearedEvents(d.syntheticId), []);
  // With every delivery's turn used up, the next turn is the session's own wake.
  hook(registry, d, "UserPromptSubmit");
  assert.equal(registry.getAwaiting(d.syntheticId), null);
  assert.equal(clearedEvents(d.syntheticId).at(-1)?.actor, "wake");
});

test("two automated deliveries that both land are two nudged turns across a daemon restart too", () => {
  const first = new Registry();
  const stopFirst = wireNudges(first);
  let d: DiscoveredSession;
  try {
    d = working(first);
    assert.equal(first.reportAwaiting(d.syntheticId, body()).ok, true);
    hook(first, d, "Stop");
    reserveInjection(d.syntheticId, "Round 3 repair packet", "workflow");
    confirmReservedInjection(d.syntheticId, "Round 3 repair packet", "workflow");
    reserveInjection(d.syntheticId, "Please open the pull request now.", "foreman");
    confirmReservedInjection(d.syntheticId, "Please open the pull request now.", "foreman");
  } finally {
    stopFirst();
  }
  // The restart forgets every in-memory claim; the wait's stored count is all that survives.
  forgetInjections();
  const second = new Registry();
  second.applyDiscovery([d]);
  const key = noteKeyFor(second.getSession(d.syntheticId)!);
  assert.equal(loadSessionAwaitings().find((row) => row.noteKey === key)?.pendingNudges.length, 2);
  hook(second, d, "Stop");
  for (const [which, text] of [["A", "Round 3 repair packet"], ["B", "Please open the pull request now."]]) {
    hook(second, d, "UserPromptSubmit", text);
    assert.ok(second.getAwaiting(d.syntheticId), `after the restart ${which}'s turn ended the wait as a wake`);
    hook(second, d, "Stop");
  }
  assert.deepEqual(clearedEvents(d.syntheticId), []);
  hook(second, d, "UserPromptSubmit");
  assert.equal(second.getAwaiting(d.syntheticId), null);
  assert.equal(clearedEvents(d.syntheticId).at(-1)?.actor, "wake");
});

test("an operator's message that starts a turn before a pending automated delivery lands is the wake; the delivery's later turn is not", (t) => {
  const registry = new Registry();
  t.after(wireNudges(registry));
  const d = working(registry);
  assert.equal(registry.reportAwaiting(d.syntheticId, body()).ok, true);
  hook(registry, d, "Stop");
  const key = noteKeyFor(registry.getSession(d.syntheticId)!);
  // Foreman claims delivery A, but the operator's own message reaches the session first.
  reserveInjection(d.syntheticId, "Please wrap up and open the pull request.", "foreman");
  assert.equal(loadSessionAwaitings().find((row) => row.noteKey === key)?.pendingNudges.length, 1);
  hook(registry, d, "UserPromptSubmit", "CI is green now, carry on.");
  assert.equal(registry.getAwaiting(d.syntheticId), null, "the operator's turn was taken for Mission Control's delivery");
  assert.equal(clearedEvents(d.syntheticId).at(-1)?.actor, "wake");
  assert.equal(clearedEvents(d.syntheticId).length, 1);

  // The other order on a second session: A's turn first is a nudge, then the operator's is the wake.
  const other = working(registry);
  assert.equal(registry.reportAwaiting(other.syntheticId, body()).ok, true);
  hook(registry, other, "Stop");
  reserveInjection(other.syntheticId, "Please wrap up and open the pull request.", "foreman");
  hook(registry, other, "UserPromptSubmit", "Please wrap up and open the pull request.");
  assert.ok(registry.getAwaiting(other.syntheticId), "Mission Control's delivery was taken for the wake");
  hook(registry, other, "Stop");
  hook(registry, other, "UserPromptSubmit", "CI is green now, carry on.");
  assert.equal(registry.getAwaiting(other.syntheticId), null);
  assert.equal(clearedEvents(other.syntheticId).at(-1)?.actor, "wake");
});

test("a turn whose prompt arrives after it started is decided by that prompt, and one that never reports a prompt is the wake", (t) => {
  const registry = new Registry();
  t.after(wireNudges(registry));
  // A turn that starts with a tool call, its prompt reported only afterwards (an SDK driver's
  // state can arrive before the prompt hook): undecided until the prompt says it was Foreman's.
  const late = working(registry);
  assert.equal(registry.reportAwaiting(late.syntheticId, body()).ok, true);
  hook(registry, late, "Stop");
  reserveInjection(late.syntheticId, "Please wrap up and open the pull request.", "foreman");
  hook(registry, late, "PreToolUse");
  assert.ok(registry.getAwaiting(late.syntheticId), "an undecided turn ended the wait before its prompt arrived");
  hook(registry, late, "UserPromptSubmit", "Please wrap up and open the pull request.");
  assert.ok(registry.getAwaiting(late.syntheticId), "a late prompt that is Mission Control's delivery ended the wait");
  hook(registry, late, "Stop");
  assert.deepEqual(clearedEvents(late.syntheticId), []);

  // The same start with a pending delivery, but the late prompt is someone else's: the wake.
  const other = working(registry);
  assert.equal(registry.reportAwaiting(other.syntheticId, body()).ok, true);
  hook(registry, other, "Stop");
  reserveInjection(other.syntheticId, "Round 2 repair packet", "workflow");
  hook(registry, other, "PreToolUse");
  hook(registry, other, "UserPromptSubmit", "Check the build log for me.");
  assert.equal(registry.getAwaiting(other.syntheticId), null);
  assert.equal(clearedEvents(other.syntheticId).at(-1)?.actor, "wake");

  // A turn that never reports a prompt at all, on a hook-instrumented session: every delivery
  // Mission Control types reports one, so this turn is the session's own wake, at its end.
  const silent = working(registry);
  assert.equal(registry.reportAwaiting(silent.syntheticId, body()).ok, true);
  hook(registry, silent, "Stop");
  reserveInjection(silent.syntheticId, "Round 3 repair packet", "workflow");
  hook(registry, silent, "PreToolUse");
  assert.ok(registry.getAwaiting(silent.syntheticId));
  hook(registry, silent, "Stop");
  assert.equal(registry.getAwaiting(silent.syntheticId), null);
  assert.equal(clearedEvents(silent.syntheticId).at(-1)?.actor, "wake");
});

test("a re-declaration inside an undecided nudge turn still uses up that nudge, so the next real wake ends the wait", (t) => {
  // A harness without prompt hooks: an automated nudge starts a turn nobody can attribute until
  // it ends. The agent finds its background work still running and declares again in that turn.
  // The turn must still use up the nudge that started it, or the session's next real wake is
  // taken for that nudge and the wait stands until its deadline.
  const registry = new Registry();
  t.after(wireNudges(registry));
  const d = mkDiscovered({ agent: "codex" });
  registry.applyDiscovery([d]);
  let at = Date.now() - 60_000;
  const read = (state: "idle" | "working") => {
    registry.applyPassiveActivity(registry.getSession(d.syntheticId)!, { state, lastActivity: at += 1_000 });
    registry.applyDiscovery([d]);
  };
  const stored = () => loadSessionAwaitings().find((row) => row.noteKey === noteKeyFor(registry.getSession(d.syntheticId)!))!;
  read("working");
  assert.equal(registry.reportAwaiting(d.syntheticId, body()).ok, true);
  read("idle");
  reserveInjection(d.syntheticId, "Please wrap up and open the pull request.", "foreman");
  read("working");
  assert.equal(stored().undecidedTurn, true);

  assert.equal(registry.reportAwaiting(d.syntheticId, body(Date.now(), 30)).ok, true);
  assert.equal(stored().undecidedTurn, true, "the re-declaration dropped the turn in flight");
  assert.equal(stored().redeclaredInTurn, true);
  read("idle");
  assert.ok(registry.getAwaiting(d.syntheticId), "the re-declared wait ended at the nudge turn's end");
  assert.deepEqual(stored().pendingNudges, [], "the nudge turn's end did not use up its nudge");
  assert.equal(stored().redeclaredInTurn, false);

  read("working");
  assert.equal(registry.getAwaiting(d.syntheticId), null, "the next real wake was taken for the nudge");
  assert.equal(clearedEvents(d.syntheticId).at(-1)?.actor, "wake");
});

test("on a hook-instrumented session a re-declaration inside an undecided turn lets the turn be decided but never woken", (t) => {
  const registry = new Registry();
  t.after(wireNudges(registry));
  const stored = (d: DiscoveredSession) =>
    loadSessionAwaitings().find((row) => row.noteKey === noteKeyFor(registry.getSession(d.syntheticId)!))!;

  // The late prompt is the delivery's: it is used up, as it would be without the re-declaration.
  const late = working(registry);
  assert.equal(registry.reportAwaiting(late.syntheticId, body()).ok, true);
  hook(registry, late, "Stop");
  reserveInjection(late.syntheticId, "Please wrap up and open the pull request.", "foreman");
  hook(registry, late, "PreToolUse");
  assert.equal(registry.reportAwaiting(late.syntheticId, body(Date.now(), 30)).ok, true);
  hook(registry, late, "UserPromptSubmit", "Please wrap up and open the pull request.");
  assert.deepEqual(stored(late).pendingNudges, [], "the late prompt did not use up its delivery after the re-declaration");
  hook(registry, late, "Stop");
  assert.ok(registry.getAwaiting(late.syntheticId));

  // The late prompt is someone else's: the wake came and went inside the turn that re-declared,
  // so the wait stands, and the delivery stays pending for its own turn.
  const other = working(registry);
  assert.equal(registry.reportAwaiting(other.syntheticId, body()).ok, true);
  hook(registry, other, "Stop");
  reserveInjection(other.syntheticId, "Round 2 repair packet", "workflow");
  hook(registry, other, "PreToolUse");
  assert.equal(registry.reportAwaiting(other.syntheticId, body(Date.now(), 30)).ok, true);
  hook(registry, other, "UserPromptSubmit", "Check the build log for me.");
  assert.ok(registry.getAwaiting(other.syntheticId), "a turn that re-declared the wait ended it on its late prompt");
  assert.equal(stored(other).pendingNudges.length, 1);

  // No prompt ever reported: on a hook-instrumented session that is the session's own turn, and
  // having re-declared in it, the wait stands.
  const silent = working(registry);
  assert.equal(registry.reportAwaiting(silent.syntheticId, body()).ok, true);
  hook(registry, silent, "Stop");
  reserveInjection(silent.syntheticId, "Round 3 repair packet", "workflow");
  hook(registry, silent, "PreToolUse");
  assert.equal(registry.reportAwaiting(silent.syntheticId, body(Date.now(), 30)).ok, true);
  hook(registry, silent, "Stop");
  assert.ok(registry.getAwaiting(silent.syntheticId), "a turn that re-declared the wait ended it at its end");
  assert.equal(stored(silent).pendingNudges.length, 1);
});

test("a turn left undecided at a restart is still decided by its prompt after it", () => {
  const WRAP = "Please wrap up and open the pull request.";
  // Two sessions, each with Foreman's delivery pending and a turn under way whose prompt has
  // not arrived when the daemon goes down.
  const first = new Registry();
  const stopFirst = wireNudges(first);
  let operator: DiscoveredSession;
  let foreman: DiscoveredSession;
  try {
    [operator, foreman] = workingPair(first);
    for (const d of [operator, foreman]) {
      assert.equal(first.reportAwaiting(d.syntheticId, body()).ok, true);
      hook(first, d, "Stop");
      reserveInjection(d.syntheticId, WRAP, "foreman");
      hook(first, d, "PreToolUse");
      const key = noteKeyFor(first.getSession(d.syntheticId)!);
      assert.equal(loadSessionAwaitings().find((row) => row.noteKey === key)?.undecidedTurn, true,
        "the undecided turn was not stored");
    }
  } finally {
    stopFirst();
  }
  forgetInjections();
  const second = new Registry();
  second.applyDiscovery([operator, foreman]);
  // The operator's prompt arrives after the restart: that turn was the wake.
  hook(second, operator, "UserPromptSubmit", "CI is green now, carry on.");
  assert.equal(second.getAwaiting(operator.syntheticId), null, "the undecided turn was forgotten across the restart");
  assert.equal(clearedEvents(operator.syntheticId).at(-1)?.actor, "wake");
  // Foreman's prompt arrives after the restart: that turn was the nudge, and the wait stands.
  hook(second, foreman, "UserPromptSubmit", WRAP);
  assert.ok(second.getAwaiting(foreman.syntheticId), "Mission Control's late prompt after the restart ended the wait");
  hook(second, foreman, "Stop");
  hook(second, foreman, "UserPromptSubmit", "CI is green now, carry on.");
  assert.equal(second.getAwaiting(foreman.syntheticId), null);
  assert.equal(clearedEvents(foreman.syntheticId).at(-1)?.actor, "wake");
});

test("a turn already under way when the daemon comes back is judged, not missed", () => {
  const WRAP = "Please wrap up and open the pull request.";
  const first = new Registry();
  const stopFirst = wireNudges(first);
  let own: DiscoveredSession;
  let nudged: DiscoveredSession;
  try {
    [own, nudged] = workingPair(first);
    for (const d of [own, nudged]) {
      assert.equal(first.reportAwaiting(d.syntheticId, body()).ok, true);
      hook(first, d, "Stop");
    }
    reserveInjection(nudged.syntheticId, WRAP, "foreman");
  } finally {
    stopFirst();
  }
  forgetInjections();
  const second = new Registry();
  second.applyDiscovery([own, nudged]);
  // Rediscovery alone presumes `working` and judges nothing.
  assert.ok(second.getAwaiting(own.syntheticId));
  // The first confirmed reading is a turn already running: the session's own prompt is the wake...
  hook(second, own, "UserPromptSubmit", "CI is green now, carry on.");
  assert.equal(second.getAwaiting(own.syntheticId), null, "a turn under way at the restart was missed");
  assert.equal(clearedEvents(own.syntheticId).at(-1)?.actor, "wake");
  // ...and Foreman's pending delivery's prompt is the nudge.
  hook(second, nudged, "UserPromptSubmit", WRAP);
  assert.ok(second.getAwaiting(nudged.syntheticId), "a nudge under way at the restart was taken for the wake");
  hook(second, nudged, "Stop");
  hook(second, nudged, "UserPromptSubmit", "CI is green now, carry on.");
  assert.equal(second.getAwaiting(nudged.syntheticId), null);
});

test("a delivery claimed just before the wait is declared still counts as Mission Control's turn", (t) => {
  const registry = new Registry();
  t.after(wireNudges(registry));
  const WRAP = "Please wrap up and open the pull request.";
  const d = working(registry);
  // Foreman claims a delivery while the session is still in the turn that will declare the wait.
  reserveInjection(d.syntheticId, WRAP, "foreman");
  assert.equal(registry.reportAwaiting(d.syntheticId, body()).ok, true);
  const key = noteKeyFor(registry.getSession(d.syntheticId)!);
  assert.equal(loadSessionAwaitings().find((row) => row.noteKey === key)?.pendingNudges.length, 1,
    "the delivery claimed before the declaration was not carried into the wait");
  hook(registry, d, "Stop");
  // It lands after the declaring turn ended: its turn is Mission Control's, not the wake.
  hook(registry, d, "UserPromptSubmit", WRAP);
  assert.ok(registry.getAwaiting(d.syntheticId), "a delivery claimed just before the wait ended it as a wake");
  hook(registry, d, "Stop");
  hook(registry, d, "UserPromptSubmit", "CI is green now, carry on.");
  assert.equal(registry.getAwaiting(d.syntheticId), null);
  assert.equal(clearedEvents(d.syntheticId).at(-1)?.actor, "wake");

  // A delivery whose prompt already came back (it started the turn that declares the wait) is
  // spent, and a new declaration does not carry it.
  const spent = mkDiscovered();
  registry.applyDiscovery([spent]);
  reserveInjection(spent.syntheticId, "Round 2 repair packet", "workflow");
  hook(registry, spent, "UserPromptSubmit", "Round 2 repair packet");
  assert.equal(registry.reportAwaiting(spent.syntheticId, body()).ok, true);
  const spentKey = noteKeyFor(registry.getSession(spent.syntheticId)!);
  assert.deepEqual(loadSessionAwaitings().find((row) => row.noteKey === spentKey)?.pendingNudges, []);
});

test("a person's message in the same words as a pending automated delivery is the wake, in either order and across a restart", () => {
  const WRAP = "Please wrap up and open the pull request.";
  const stored = (registry: RegistryT, d: DiscoveredSession) =>
    loadSessionAwaitings().find((row) => row.noteKey === noteKeyFor(registry.getSession(d.syntheticId)!))!;

  // Foreman claims a delivery, then the operator sends the very same words. Either turn of
  // those words may land first and neither says whose it is, so the pending delivery is
  // contested, and stored that way so a restart in between still knows.
  const first = new Registry();
  const stopFirst = wireNudges(first);
  let d: DiscoveredSession;
  try {
    d = working(first);
    assert.equal(first.reportAwaiting(d.syntheticId, body()).ok, true);
    hook(first, d, "Stop");
    reserveInjection(d.syntheticId, WRAP, "foreman");
    assert.equal(stored(first, d).pendingNudges[0]?.contestedBy, undefined);
    notePersonDelivery(d.syntheticId, WRAP);
    assert.equal(stored(first, d).pendingNudges[0]?.contestedBy?.length, 1, "the person's identical words did not contest the nudge");
  } finally {
    stopFirst();
  }
  forgetInjections();
  const second = new Registry();
  second.applyDiscovery([d]);
  hook(second, d, "Stop");
  hook(second, d, "UserPromptSubmit", WRAP);
  assert.equal(second.getAwaiting(d.syntheticId), null, "the person's turn was used up as Mission Control's nudge");
  assert.equal(clearedEvents(d.syntheticId).at(-1)?.actor, "wake");

  // The other order: the operator's words go first, and Foreman claims the same words before
  // the operator's turn has started. The delivery is contested from the moment it is stored.
  const registry = new Registry();
  const stop = wireNudges(registry);
  try {
    const e = working(registry);
    assert.equal(registry.reportAwaiting(e.syntheticId, body()).ok, true);
    hook(registry, e, "Stop");
    notePersonDelivery(e.syntheticId, WRAP);
    reserveInjection(e.syntheticId, WRAP, "foreman");
    assert.equal(stored(registry, e).pendingNudges[0]?.contestedBy?.length, 1);
    hook(registry, e, "UserPromptSubmit", WRAP);
    assert.equal(registry.getAwaiting(e.syntheticId), null);
    assert.equal(clearedEvents(e.syntheticId).at(-1)?.actor, "wake");

    // A person's message in other words contests nothing: the nudge's turn is still the nudge.
    const f = working(registry);
    assert.equal(registry.reportAwaiting(f.syntheticId, body()).ok, true);
    hook(registry, f, "Stop");
    reserveInjection(f.syntheticId, WRAP, "foreman");
    notePersonDelivery(f.syntheticId, "Also bump the version, please.");
    assert.equal(stored(registry, f).pendingNudges[0]?.contestedBy, undefined);
    hook(registry, f, "UserPromptSubmit", WRAP);
    assert.ok(registry.getAwaiting(f.syntheticId), "an uncontested nudge's turn read as the wake");
  } finally {
    stop();
  }
});

test("the dashboard's send and inject doors announce the operator's words as a person's, and take back a send that never landed", async (t) => {
  const registry = new Registry();
  const app = mkApp(registry);
  const sdk = registry.registerSdkSession({ id: `sdk:awaiting-${++seq}`, agent: "claude", name: "embedded", cwd: "/repo", agentSessionId: `agent-aw-doors-${seq}` });
  const heard: Array<{ id: string; key: string; released: boolean }> = [];
  t.after(onPersonDelivery((delivery) => { heard.push({ id: delivery.id, key: delivery.key, released: delivery.released }); }));
  const post = (path: string, body: unknown) => app.request(path, {
    method: "POST",
    headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  // No driver is attached, so each send is refused before anything is written: announced
  // before the write, as the reservation beside it is, then taken back on that positive
  // evidence, so it contests nothing.
  await post(`/api/sessions/${sdk.id}/send`, { text: "Send words", origin: "human" });
  await post(`/api/sessions/${sdk.id}/inject`, { text: "Inject words", origin: "human" });
  assert.equal(heard.length, 4);
  assert.deepEqual(heard.map((h) => [h.key, h.released]), [
    [injectionFingerprint("Send words"), false], [injectionFingerprint("Send words"), true],
    [injectionFingerprint("Inject words"), false], [injectionFingerprint("Inject words"), true],
  ]);
  assert.equal(heard[1]!.id, heard[0]!.id, "the withdrawal named a different send");
  assert.equal(heard[3]!.id, heard[2]!.id);
});

test("a person's send that never landed lifts its contest, unless another send of the same words still stands", (t) => {
  // Contesting the delivery before the person's send resolves is what makes their turn the
  // wake. A send that then provably fails leaves no person's turn to come, and keeping the
  // contest would read the automated delivery's own turn as the wake and end a wait whose
  // process may still be running.
  const WRAP = "Please wrap up and open the pull request.";
  const registry = new Registry();
  t.after(wireNudges(registry));
  const nudgeOf = (d: DiscoveredSession) =>
    loadSessionAwaitings().find((row) => row.noteKey === noteKeyFor(registry.getSession(d.syntheticId)!))!.pendingNudges[0];

  const d = working(registry);
  assert.equal(registry.reportAwaiting(d.syntheticId, body()).ok, true);
  hook(registry, d, "Stop");
  reserveInjection(d.syntheticId, WRAP, "foreman");
  const failed = notePersonDelivery(d.syntheticId, WRAP);
  assert.equal(nudgeOf(d)?.contestedBy?.length, 1);
  withdrawPersonDelivery(failed);
  assert.equal(nudgeOf(d)?.contestedBy, undefined, "a failed send left its contest standing");
  hook(registry, d, "UserPromptSubmit", WRAP);
  assert.ok(registry.getAwaiting(d.syntheticId), "the automated delivery's own turn read as the wake after the person's send failed");

  // Two sends of the same words, and only one fails: the other's turn is still coming.
  const e = working(registry);
  assert.equal(registry.reportAwaiting(e.syntheticId, body()).ok, true);
  hook(registry, e, "Stop");
  reserveInjection(e.syntheticId, WRAP, "foreman");
  notePersonDelivery(e.syntheticId, WRAP);
  withdrawPersonDelivery(notePersonDelivery(e.syntheticId, WRAP));
  assert.equal(nudgeOf(e)?.contestedBy?.length, 1, "one failed send lifted the contest another still holds");
  hook(registry, e, "UserPromptSubmit", WRAP);
  assert.equal(registry.getAwaiting(e.syntheticId), null);
  assert.equal(clearedEvents(e.syntheticId).at(-1)?.actor, "wake");
});

test("a duplicate person's send that fails after a restart withdraws only its own claim on the contest", () => {
  // The first send's claim is stored on the wait; the daemon restarts while that message is
  // still on its way. A second send of the same words then fails, and taking it back must not
  // erase the first one's claim, or the first person's turn would be used up as the nudge.
  const WRAP = "Please wrap up and open the pull request.";
  const stored = (registry: RegistryT, d: DiscoveredSession) =>
    loadSessionAwaitings().find((row) => row.noteKey === noteKeyFor(registry.getSession(d.syntheticId)!))!;
  const first = new Registry();
  const stopFirst = wireNudges(first);
  let d: DiscoveredSession;
  let firstSend: string;
  try {
    d = working(first);
    assert.equal(first.reportAwaiting(d.syntheticId, body()).ok, true);
    hook(first, d, "Stop");
    reserveInjection(d.syntheticId, WRAP, "foreman");
    firstSend = notePersonDelivery(d.syntheticId, WRAP).id;
    assert.deepEqual(stored(first, d).pendingNudges[0]?.contestedBy, [firstSend]);
  } finally {
    stopFirst();
  }
  forgetInjections();
  const second = new Registry();
  const stopSecond = wireNudges(second);
  try {
    second.applyDiscovery([d]);
    hook(second, d, "Stop");
    const failed = notePersonDelivery(d.syntheticId, WRAP);
    withdrawPersonDelivery(failed);
    assert.deepEqual(stored(second, d).pendingNudges[0]?.contestedBy, [firstSend], "the failed send erased the first send's stored claim");
    hook(second, d, "UserPromptSubmit", WRAP);
    assert.equal(second.getAwaiting(d.syntheticId), null, "the first person's turn was used up as Mission Control's nudge");
    assert.equal(clearedEvents(d.syntheticId).at(-1)?.actor, "wake");
  } finally {
    stopSecond();
  }
});

test("a note-key rotation carries the wait to the new key, as it carries a blocker", () => {
  const registry = new Registry();
  const d = mkDiscovered();
  registry.applyDiscovery([d]);
  // Declared before any hook bound the conversation: the wait is keyed on the synthetic id.
  assert.equal(registry.reportAwaiting(d.syntheticId, body()).ok, true);
  assert.ok(loadSessionAwaitings().some((row) => row.noteKey === d.syntheticId));

  const agentSessionId = `agent-aw-rotate-${seq}`;
  registry.applyHook({
    agent: "claude",
    event: "SessionStart",
    sessionId: agentSessionId,
    cwd: d.cwd,
    transcriptPath: null,
    env: { tmuxPane: (d.terminals[0] as { paneId: string }).paneId },
  });
  const s = registry.getSession(d.syntheticId)!;
  assert.equal(s.agentSessionId, agentSessionId);
  assert.equal(s.awaiting?.what, WHAT, "the wait did not follow the key to the card");
  assert.equal(registry.getAwaiting(d.syntheticId)?.what, WHAT);
  const keys = loadSessionAwaitings().map((row) => row.noteKey);
  assert.ok(keys.includes(agentSessionId), "the wait was not stored under the new key");
  assert.ok(!keys.includes(d.syntheticId), "the wait stranded under the old key");
});

test("a session that exits takes its wait with it, unlike a blocker", () => {
  const registry = new Registry();
  const d = working(registry);
  assert.equal(registry.reportAwaiting(d.syntheticId, body()).ok, true);
  registry.applyDiscovery([]);
  assert.equal(registry.getSession(d.syntheticId)?.state, "exited");
  assert.equal(registry.getSession(d.syntheticId)?.awaiting, null);
  assert.equal(clearedEvents(d.syntheticId).at(-1)?.actor, "exit");
});

test("a restart reloads the wait, and drops it once its session has been gone past the grace", () => {
  const d = mkDiscovered({ agentSessionId: `agent-restart-${seq + 1}` } as Partial<DiscoveredSession>);
  const first = new Registry();
  first.applyDiscovery([d]);
  assert.equal(first.reportAwaiting(d.syntheticId, body()).ok, true);

  const second = new Registry();
  second.applyDiscovery([d]);
  assert.equal(second.getSession(d.syntheticId)?.awaiting?.what, WHAT, "the wait did not survive a restart");

  // A third daemon that never sees the session again: kept through the grace, then dropped.
  const third = new Registry();
  third.applyDiscovery([]);
  const now = Date.now();
  const mine = () => loadSessionAwaitings().some((row) => row.noteKey === d.agentSessionId);
  third.pruneAwaitings(180_000, now);
  third.pruneAwaitings(180_000, now + 60_000);
  assert.ok(mine(), "dropped inside the grace");
  assert.ok(third.pruneAwaitings(180_000, now + 181_000) >= 1);
  assert.ok(!mine(), "a wait outlived its session past the grace");
});

test("a wait is refused while a request_input is pending, and a new question ends a standing wait", () => {
  const registry = new Registry();
  const reviews = new ReviewManager(registry);
  const d = working(registry);
  const review = reviews.create(d.syntheticId, "input", "Pick one", "Which?");
  const refused = registry.reportAwaiting(d.syntheticId, body());
  assert.ok(!refused.ok && refused.status === 409 && /request_input/.test(refused.error));
  reviews.resolve(review.id, "approve", "the first");

  assert.equal(registry.reportAwaiting(d.syntheticId, body()).ok, true);
  reviews.create(d.syntheticId, "input", "Another", "Which now?");
  assert.equal(registry.getAwaiting(d.syntheticId), null, "a pending question hid behind a wait");
  assert.equal(clearedEvents(d.syntheticId).at(-1)?.actor, "input");
});

test("a blocker outranks a wait: it replaces one, and a blocked session cannot declare one", () => {
  const registry = new Registry();
  const d = working(registry);
  assert.equal(registry.reportAwaiting(d.syntheticId, body()).ok, true);
  assert.equal(registry.reportBlocker(d.syntheticId, BLOCKER).ok, true);
  const s = registry.getSession(d.syntheticId)!;
  assert.equal(s.awaiting, null);
  assert.ok(s.blocker);
  assert.equal(clearedEvents(d.syntheticId).at(-1)?.actor, "blocker");
  const refused = registry.reportAwaiting(d.syntheticId, body());
  assert.ok(!refused.ok && refused.status === 409 && /blocker/.test(refused.error));
});

test("a task reaching a terminal status ends the wait declared for it, and a finished task refuses one", () => {
  const registry = new Registry();
  const d = working(registry);
  const task = mkTask({ id: `task-awaiting-${seq}`, sessionId: d.syntheticId, status: "running", worktreePath: d.cwd });
  registry.upsertTask(task);
  assert.equal(registry.reportAwaiting(d.syntheticId, body()).ok, true);
  registry.upsertTask({ ...task, title: "renamed" });
  assert.ok(registry.getAwaiting(d.syntheticId), "a non-terminal write ended it");
  registry.upsertTask({ ...task, status: "done" });
  assert.equal(registry.getAwaiting(d.syntheticId), null);
  assert.equal(clearedEvents(d.syntheticId).at(-1)?.actor, "task");
  const refused = registry.reportAwaiting(d.syntheticId, body());
  assert.ok(!refused.ok && /already done/.test(refused.error));
});

test("the hold lasts until the deadline, and the stuck-session rule applies again after it", () => {
  const now = 10_000_000;
  const awaiting = {
    id: "a1", what: "CI checks", wakeSource: "command" as const, expectedBy: now + 60_000,
    referenceUrl: null, details: null, startedAt: now - 40 * 60_000, updatedAt: now - 40 * 60_000,
  };
  const session = mkSession({
    id: "aw-stall", state: "idle", activity: null, stateConfirmed: true, hooksSeen: true, instrumented: true,
    lastActivity: now - 40 * 60_000, awaiting,
    task: { ...mkTask({ id: "t-stall", status: "running" }), fullTitle: "T", repoPrs: [] } as never,
    workCycle: { generation: 1, active: false, completedAt: now - 40 * 60_000, updatedAt: now - 40 * 60_000 } as never,
  });
  assert.equal(isAwaiting(session, now), true);
  assert.equal(awaitingOverdue(session, now), false);
  assert.equal(isAwaiting(session, now + 60_000), false, "the deadline itself lifts the hold");
  assert.equal(awaitingOverdue(session, now + 60_000), true);

  const stall = (s: typeof session, at: number) => detectStall(s, [s], [], NO_UNPUSHED, at);
  const bare = { ...session, awaiting: null };
  assert.equal(stall(bare, now)?.kind, "unfinished-work", "the fixture is not a stuck candidate, so the test proves nothing");
  assert.equal(stall(session, now), null, "a session awaiting inside its deadline was flagged stuck");
  assert.equal(stall(session, now + 61_000)?.kind, "unfinished-work", "the hold outlived its deadline");
});

function mkApp(registry: RegistryT) {
  return buildApp({
    registry,
    reviews: new ReviewManager(registry) as ReviewManagerT,
    tasks: {} as TaskManager,
    queues: {} as InstanceType<typeof QueueManager>,
  });
}

test("the MCP routes bind to the caller and follow the preview; the session clears its own standing wait and the dashboard clears as the operator", async () => {
  const registry = new Registry();
  const app = mkApp(registry);
  const sdk = registry.registerSdkSession({ id: `sdk:awaiting-${++seq}`, agent: "claude", name: "embedded", cwd: "/repo", agentSessionId: `agent-aw-route-${seq}` });
  const mcp = (path: string, body: unknown) => app.request(path, {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json", "x-harness-token": ensureToken() },
    body: JSON.stringify(body),
  });
  const api = (path: string, body: unknown) => app.request(path, {
    method: "POST",
    headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  // Off by default: the declaration route is gone and says which feature gates it.
  applyFeatureFlagIntent({ kind: "flag", id: SESSION_AWAITING_FLAG_ID, enabled: false });
  const off = await mcp("/mcp/awaiting", { env: {}, sessionId: sdk.id, ...wire() });
  assert.equal(off.status, 404);
  assert.equal((await off.json()).feature, SESSION_AWAITING_FLAG_ID);
  assert.equal(registry.getAwaiting(sdk.id), null);

  applyFeatureFlagIntent({ kind: "flag", id: SESSION_AWAITING_FLAG_ID, enabled: true });
  try {
    // `expectedBy` is required, must be an ISO 8601 date-time with a zone, and is bounded: in the
    // future and no more than 240 minutes out.
    const { expectedBy: _required, ...missing } = wire();
    assert.equal((await mcp("/mcp/awaiting", { env: {}, sessionId: sdk.id, ...missing })).status, 400, "expectedBy is required");
    assert.equal((await mcp("/mcp/awaiting", { env: {}, sessionId: sdk.id, ...wire("in twenty minutes") })).status, 400);
    assert.equal((await mcp("/mcp/awaiting", { env: {}, sessionId: sdk.id, ...wire("2026-11-20T15:40:00") })).status, 400, "a date-time with no zone");
    const past = await mcp("/mcp/awaiting", { env: {}, sessionId: sdk.id, ...wire(Date.now() - MIN) });
    assert.equal(past.status, 400);
    assert.match((await past.json()).error, /in the future/);
    const beyond = await mcp("/mcp/awaiting", { env: {}, sessionId: sdk.id, ...wire(Date.now() + 241 * MIN) });
    assert.equal(beyond.status, 400, "past the ceiling");
    assert.match((await beyond.json()).error, /at most 240 minutes/);
    assert.equal(registry.getAwaiting(sdk.id), null, "a refused declaration was stored");
    assert.equal((await mcp("/mcp/awaiting", { env: {}, sessionId: sdk.id, ...wire(), referenceUrl: "ftp://nope" })).status, 400);
    assert.equal((await mcp("/mcp/awaiting", { env: {}, sessionId: sdk.id, ...wire(), wakeSource: "hope" })).status, 400);
    // Just inside the ceiling is accepted over the wire too (the exact limits are pinned above,
    // where the clock is injected).
    const edge = await mcp("/mcp/awaiting", { env: {}, sessionId: sdk.id, ...wire(Date.now() + 240 * MIN - 5_000) });
    assert.equal(edge.status, 200);
    assert.equal(registry.clearAwaiting(sdk.id, "operator"), true);
    const set = await mcp("/mcp/awaiting", { env: {}, sessionId: sdk.id, ...wire() });
    assert.equal(set.status, 200);
    const created = (await set.json()) as { created: boolean; awaiting: { id: string } };
    assert.equal(created.created, true);
    assert.equal(registry.getAwaiting(sdk.id)?.what, WHAT);

    // The session ends its own standing wait: cleared, gone from SQLite, and attributed to it.
    const ownKey = noteKeyFor(registry.getSession(sdk.id)!);
    const own = await mcp("/mcp/awaiting/clear", { env: {}, sessionId: sdk.id, resolution: "build cancelled" });
    assert.equal(own.status, 200);
    assert.deepEqual(await own.json(), { sessionId: sdk.id, cleared: true });
    assert.equal(registry.getAwaiting(sdk.id), null);
    assert.ok(!loadSessionAwaitings().some((row) => row.noteKey === ownKey), "the session's clear left the wait stored");
    const ownEvent = clearedEvents(sdk.id).at(-1)!;
    assert.equal(ownEvent.actor, "session");
    assert.equal(ownEvent.resolution, "build cancelled");
    assert.equal(typeof ownEvent.durationMs, "number");
    const redeclared = await mcp("/mcp/awaiting", { env: {}, sessionId: sdk.id, ...wire() });
    assert.equal(redeclared.status, 200);
    created.awaiting = ((await redeclared.json()) as { awaiting: { id: string } }).awaiting;

    // A Clear sent from a view of the previous declaration is refused once the session has
    // declared again, even though it is the same continuing wait: the sender never saw the new
    // reason or deadline it would be ending.
    const viewed = created.awaiting.id;
    const moved = await mcp("/mcp/awaiting", { env: {}, sessionId: sdk.id, ...wire(Date.now() + 45 * MIN) });
    assert.equal(moved.status, 200);
    const redeclaredAgain = ((await moved.json()) as { created: boolean; awaiting: { id: string } });
    assert.equal(redeclaredAgain.created, false);
    assert.notEqual(redeclaredAgain.awaiting.id, viewed);
    const staleView = await api(`/api/sessions/${sdk.id}/awaiting/clear`, { awaitingId: viewed });
    assert.equal(staleView.status, 409, "a Clear from an earlier view ended the re-declared wait");
    assert.ok(registry.getAwaiting(sdk.id), "the refused Clear removed the wait");
    created.awaiting = redeclaredAgain.awaiting;

    // A Clear that names no wait at all is refused too: it could end one declared after the
    // caller looked, so the dashboard and every controller must say which wait they saw.
    const unnamed = await api(`/api/sessions/${sdk.id}/awaiting/clear`, { resolution: "CI was cancelled" });
    assert.equal(unnamed.status, 400, "a Clear naming no wait ended the standing one");
    assert.ok(registry.getAwaiting(sdk.id), "the refused unnamed Clear removed the wait");

    // A Clear aimed at a wait the caller never saw is refused; the current one clears.
    assert.equal((await api(`/api/sessions/${sdk.id}/awaiting/clear`, { awaitingId: "some-other-wait" })).status, 409);
    const cleared = await api(`/api/sessions/${sdk.id}/awaiting/clear`, { awaitingId: created.awaiting.id });
    assert.deepEqual(await cleared.json(), { ok: true, cleared: true });
    assert.equal(registry.getAwaiting(sdk.id), null);
    assert.equal(clearedEvents(sdk.id).at(-1)?.actor, "operator");
    const again = await mcp("/mcp/awaiting/clear", { env: {}, sessionId: sdk.id, resolution: "cancelled" });
    assert.deepEqual(await again.json(), { sessionId: sdk.id, cleared: false });
    assert.equal((await mcp("/mcp/awaiting", { env: {}, sessionId: "sdk:nobody", ...wire() })).status, 404);

    // Switching the preview off ends every standing wait.
    assert.equal(registry.reportAwaiting(sdk.id, body()).ok, true);
    assert.equal(registry.clearAllAwaitings("flag"), 1);
    assert.equal(registry.getAwaiting(sdk.id), null);
    assert.equal(clearedEvents(sdk.id).at(-1)?.actor, "flag");
  } finally {
    applyFeatureFlagIntent({ kind: "flag", id: SESSION_AWAITING_FLAG_ID, enabled: false });
  }
});

test("read_sessions summarizes a wait with whether it is overdue, and control_session clears through the dashboard route", async () => {
  const { awaitingSummary, controlRequest } = await import("../src/server/session-control.ts");
  const { SessionControlRequestSchema } = await import("../src/shared/protocol.ts");
  const awaiting = {
    id: "aw-1", what: "CI checks", wakeSource: "monitor" as const, expectedBy: 2_000, referenceUrl: null,
    details: "long notes", startedAt: 1_000, updatedAt: 1_000,
  };
  assert.deepEqual(awaitingSummary(awaiting, 1_500), {
    id: "aw-1", what: "CI checks", wakeSource: "monitor", expectedBy: 2_000, referenceUrl: null, startedAt: 1_000, overdue: false,
  });
  assert.equal(awaitingSummary(awaiting, 2_000)?.overdue, true);
  assert.equal(awaitingSummary(null), null);

  const parsed = SessionControlRequestSchema.parse({ sessionId: "s1", command: { action: "clear_awaiting", awaitingId: "aw-1", resolution: "build cancelled" } });
  assert.deepEqual(controlRequest("s1", parsed.command), {
    path: "/api/sessions/s1/awaiting/clear", method: "POST", body: { resolution: "build cancelled", awaitingId: "aw-1" },
  });
});

test("the daemon refuses prompted completion while a wait stands without spending the generation, and consumes it at the deadline", () => {
  const registry = new Registry();
  const noteKey = `agent-aw-prompted-${++seq}`;
  const d = mkDiscovered({ agentSessionId: noteKey } as Partial<DiscoveredSession>);
  registry.applyDiscovery([d]);
  registry.upsertGoal(d.syntheticId, {
    prompt: "Implement the fix", text: "Implement the fix", objective: "Implement the fix",
    focus: "Implement the fix", relationship: "initial", rationale: "Initial task objective",
    objectiveVersion: 1, promptRevision: 1, resolvedPromptRevision: 1, pendingPrompts: [], source: "heuristic",
  }, Date.now() - 3 * MIN);
  // An eligible settled generation, exactly what `consumePromptedGeneration` re-verifies.
  const session = registry.getSession(d.syntheticId)!;
  Object.assign(session, { hooksSeen: true, instrumented: true, stateConfirmed: true, state: "idle", pendingTurns: [] });
  assert.equal(registry.ensureQueue(d.syntheticId), noteKey);
  markWorkCycleActive(noteKey, Date.now() - 3 * MIN);
  completeWorkCycle(noteKey, Date.now() - 2 * MIN, Date.now() - 2 * MIN);
  session.workCycle = workCycleFor(noteKey) ?? undefined;
  const intent = resolvedSessionIntent(registry.getGoal(d.syntheticId))!;
  const request = {
    logicalKey: noteKey,
    generation: 1,
    expectedIntent: {
      objective: intent.objective, objectiveVersion: intent.objectiveVersion,
      promptRevision: intent.promptRevision, episodeKey: intent.episodeKey,
    },
    ask: false,
    directHandoff: null,
    decision: null,
  };

  const declared = registry.reportAwaiting(d.syntheticId, body());
  assert.ok(declared.ok);
  const expectedBy = declared.awaiting.expectedBy;
  assert.equal(registry.consumePromptedGeneration(d.syntheticId, request, expectedBy - 1), false,
    "a session awaiting its CI had its generation consumed");
  assert.equal(getQueueRow(noteKey)?.promptedConsumedGeneration ?? null, null, "the refusal spent the generation");

  // No wake came: at the deadline the hold lifts and the same generation is consumed once.
  assert.equal(registry.consumePromptedGeneration(d.syntheticId, request, expectedBy), true,
    "the deadline passing did not release the generation");
  assert.equal(getQueueRow(noteKey)?.promptedConsumedGeneration, 1);
});

test("the daemon refuses the wrap-up ask while a wait stands, keeps the reset open, and allows the ask once the wait is overdue", async () => {
  const registry = new Registry();
  const queues = new QueueManager(registry);
  const app = buildApp({ registry, reviews: new ReviewManager(registry) as ReviewManagerT, tasks: {} as TaskManager, queues });
  const d = mkDiscovered({ agentSessionId: `agent-aw-wrapup-${++seq}` } as Partial<DiscoveredSession>);
  registry.applyDiscovery([d]);
  Object.assign(registry.getSession(d.syntheticId)!, { hooksSeen: true, instrumented: true });
  registry.setForemanInvite(d.syntheticId, "dispatch");
  const ask = (payload: unknown) => app.request(`/api/sessions/${d.syntheticId}/queue/wrapup/asked`, {
    method: "POST", headers: { host: "127.0.0.1:7317", "content-type": "application/json" }, body: JSON.stringify(payload),
  });

  assert.equal(registry.reportAwaiting(d.syntheticId, body()).ok, true);
  const refused = await ask({});
  assert.equal(refused.status, 409, "a session awaiting its CI was asked to ship");
  assert.match(((await refused.json()) as { error: string }).error, /awaiting a background process/);
  assert.equal((await ask({ clearAnswer: true })).status, 200, "the reset must stay open");

  // The same wait, declared twenty minutes ago with a ten-minute deadline: overdue now, so the
  // hold has lifted and the ask goes through.
  const past = Date.now() - 20 * MIN;
  assert.equal(registry.reportAwaiting(d.syntheticId, body(past, 10), past).ok, true);
  assert.ok(registry.getAwaiting(d.syntheticId), "the overdue wait still stands on the card");
  assert.equal((await ask({})).status, 200, "an overdue wait still held the wrap-up ask");
});
