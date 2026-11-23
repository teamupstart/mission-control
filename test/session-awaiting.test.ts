import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { ReportAwaitingBody, ReportBlockerBody } from "../src/shared/protocol.ts";
import type { Session } from "../src/shared/types.ts";
import { SESSION_AWAITING_FLAG_ID } from "../src/shared/feature-flag-registry.ts";
import { mkMuxHandle, mkSession, mkTask } from "./helpers/session-fixture.ts";

// A session idle on purpose while a background process finishes (issue #1596). The record is
// keyed by the note key like a blocker, but it ends on the session's own next turn, on exit,
// with its task, or on a clear, and its hold lifts by itself at the deadline it declared.

const home = mkdtempSync(join(tmpdir(), "mission-session-awaiting-"));
process.env.MISSION_HOME = home;

const {
  openDb, loadSessionAwaitings, markWorkCycleActive, completeWorkCycle, workCycleFor, getQueueRow,
  upsertSessionAwaiting, deleteSessionAwaiting,
} = await import("../src/server/db.ts");
const { resolvedSessionIntent } = await import("../src/shared/goal.ts");
const { Registry, noteKeyFor } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const { applyFeatureFlagIntent } = await import("../src/server/feature-flags/index.ts");
const { maintainScoutSessionCredentials } = await import("../src/server/scouts/session-credentials.ts");
const { sessionScoutCredentialLocator } = await import("../src/server/scouts/submission-auth.ts");
const { sessionScoutCredentialPath } = await import("../src/shared/harness-runtime.mjs");
const { isAwaiting, awaitingOverdue } = await import("../src/shared/session.ts");
const { detectStall, NO_UNPUSHED } = await import("../src/shared/stall.ts");
const {
  reserveInjection, releaseInjection, recordInjection, confirmReservedInjection, onAutomatedDelivery, forgetInjections,
  onPersonDelivery, notePersonDelivery, withdrawPersonDelivery, injectionFingerprint,
  AutomatedAttributionError, PersonAttributionError, originOf, outstandingAutomatedClaims,
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
    gitRoot: null,
    repoRoot: null,
    ...over,
  };
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
  // The status really landed on this session, with an activity stamp newer than the declaration.
  assert.equal(registry.getSession(d.syntheticId)?.activity, "watching CI");
  assert.ok((registry.getSession(d.syntheticId)?.lastActivity ?? 0) > at, "report_status did not stamp the session");
  assert.equal(registry.getSession(d.syntheticId)?.state, "idle");
  hook(registry, d, "PreToolUse", "go", at + 500);
  assert.ok(registry.getAwaiting(d.syntheticId), "a report_status mid-turn settled the wait, so the turn's next tool call read as the wake");
  hook(registry, d, "Stop", "go", at + 1_000);
  assert.ok(registry.getAwaiting(d.syntheticId));

  hook(registry, d, "UserPromptSubmit", "the build finished", at + 120_000);
  assert.equal(registry.getAwaiting(d.syntheticId), null);
  assert.equal(clearedEvents(d.syntheticId).at(-1)?.actor, "wake");
});

test("an idle declaration's turn end is judged by which report it is, not by its millisecond", () => {
  // A Stop stamped in the same millisecond as the declaration is still that turn's end.
  const registry = new Registry();
  const stored = (d: DiscoveredSession) =>
    loadSessionAwaitings().find((row) => row.noteKey === noteKeyFor(registry.getSession(d.syntheticId)!))!;
  const d = mkDiscovered();
  registry.applyDiscovery([d]);
  const at = Date.now() - 60_000;
  hook(registry, d, "UserPromptSubmit", "go", at - 2_000);
  hook(registry, d, "Stop", "go", at - 1_000);
  assert.equal(registry.reportAwaiting(d.syntheticId, body(at), at).ok, true);
  // A Stop of the previous turn, stamped before the declaration and arriving after it, is not it.
  hook(registry, d, "Stop", "go", at - 500);
  assert.equal(stored(d).settledAt, null, "a report stamped before the declaration settled it");
  hook(registry, d, "Stop", "go", at);
  assert.notEqual(stored(d).settledAt, null, "a Stop in the declaration's own millisecond did not end the declaring turn");
  hook(registry, d, "UserPromptSubmit", "the build finished", at + 120_000);
  assert.equal(registry.getAwaiting(d.syntheticId), null, "the next turn was not judged as the wake");
  assert.equal(clearedEvents(d.syntheticId).at(-1)?.actor, "wake");

  // The other edge: the reading the wait was declared against shares the declaration's
  // millisecond. It is that reading, not a later one, so it never settles the declaring turn,
  // and the turn's own late tool call is not the wake.
  const e = mkDiscovered();
  registry.applyDiscovery([e]);
  hook(registry, e, "UserPromptSubmit", "go", at - 2_000);
  hook(registry, e, "Stop", "go", at);
  assert.equal(registry.reportAwaiting(e.syntheticId, body(at), at).ok, true);
  assert.equal(stored(e).settledAt, null, "the reading declared against settled the declaring turn");
  hook(registry, e, "PreToolUse", "go", at + 100);
  assert.ok(registry.getAwaiting(e.syntheticId), "the declaring turn's own tool call read as the wake");
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

test("a subagent's prompt never decides the main session's undecided turn", (t) => {
  // A subagent reports its own prompt through the parent's hooks. It is not the prompt of the
  // turn the wait is judging, so it must not be read as the wake before the turn's own prompt
  // (here Mission Control's delivery) arrives.
  const registry = new Registry();
  t.after(wireNudges(registry));
  const d = working(registry);
  assert.equal(registry.reportAwaiting(d.syntheticId, body()).ok, true);
  hook(registry, d, "Stop");
  reserveInjection(d.syntheticId, "Please wrap up and open the pull request.", "foreman");
  hook(registry, d, "PreToolUse");
  registry.applyHook({
    agent: "claude",
    event: "UserPromptSubmit",
    sessionId: `agent-${d.syntheticId}`,
    agentId: "subagent-1",
    cwd: d.cwd,
    transcriptPath: null,
    prompt: "Search the repository for the failing test.",
    env: { tmuxPane: (d.terminals[0] as { paneId: string }).paneId },
  });
  assert.ok(registry.getAwaiting(d.syntheticId), "a subagent's prompt was read as the wake");
  hook(registry, d, "UserPromptSubmit", "Please wrap up and open the pull request.");
  hook(registry, d, "Stop");
  assert.ok(registry.getAwaiting(d.syntheticId), "the delivery's own turn ended the wait");
  assert.deepEqual(clearedEvents(d.syntheticId), []);
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

test("a delivery's turn on a driver session that never reports prompts uses up the delivery rather than waking", (t) => {
  // A Codex SDK launch has no prompt hook, though its driver marks the session instrumented:
  // a turn ending with no prompt reported says nothing about whose turn it was there.
  const registry = new Registry();
  t.after(wireNudges(registry));
  const sdk = registry.registerSdkSession({ id: `sdk:awaiting-${++seq}`, agent: "codex", name: "embedded", cwd: "/repo", agentSessionId: `agent-aw-codex-${seq}` });
  const drive = (state: "working" | "idle") => registry.applyDriverEvent(sdk.id, { kind: "state", state, activity: null });
  registry.applyDriverEvent(sdk.id, { kind: "bound", agentSessionId: `${sdk.id}-native`, transcriptPath: null, modelId: null, pid: null });
  assert.equal(registry.getSession(sdk.id)?.hooksSeen, true, "the fixture is not marked instrumented as a bound driver is");
  drive("working");
  assert.equal(registry.reportAwaiting(sdk.id, body()).ok, true);
  drive("idle");
  reserveInjection(sdk.id, "Please wrap up and open the pull request.", "foreman");
  drive("working");
  drive("idle");
  assert.ok(registry.getAwaiting(sdk.id), "Mission Control's own delivery ended the wait as a wake");
  assert.deepEqual(
    loadSessionAwaitings().find((row) => row.noteKey === noteKeyFor(registry.getSession(sdk.id)!))!.pendingNudges,
    [],
    "the delivery's turn did not use it up",
  );
  // Nothing outstanding now: the session's own next turn is the wake.
  drive("working");
  assert.equal(registry.getAwaiting(sdk.id), null);
  assert.equal(clearedEvents(sdk.id).at(-1)?.actor, "wake");
});

test("a delivery listener that fails is logged with the session and delivery; a reservation it fails is refused, a landed record goes on", (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const stop = onAutomatedDelivery(() => { throw new Error("listener down"); });
  const heard: string[] = [];
  const stopNext = onAutomatedDelivery((delivery) => { heard.push(`${delivery.sessionId}:${delivery.released ? "released" : "claimed"}`); });
  try {
    // Not yet typed: refused, so nothing is sent with an attribution that was not stored, and a
    // listener that did store it is told it is taken back.
    assert.throws(() => reserveInjection("sdk:listener-check", "Please wrap up and open the pull request.", "foreman"),
      AutomatedAttributionError);
    assert.equal(originOf("sdk:listener-check", "Please wrap up and open the pull request."), undefined);
    // Already landed: nothing left to refuse, so it is recorded and the failure only logged.
    recordInjection("sdk:listener-landed", "Round 2 repair packet", "workflow");
    assert.equal(originOf("sdk:listener-landed", "Round 2 repair packet"), "workflow");
  } finally {
    stop();
    stopNext();
    forgetInjections("sdk:listener-landed");
  }
  assert.deepEqual(heard, ["sdk:listener-check:claimed", "sdk:listener-check:released", "sdk:listener-landed:claimed"],
    "a listener that stored the refused delivery was never told it was taken back");
  const logged = errors.mock.calls.map((call) => String(call.arguments[0]));
  assert.ok(logged.some((line) => line.includes("sdk:listener-check") && line.includes(injectionFingerprint("Please wrap up and open the pull request."))),
    "the failing listener left no log line naming the session and delivery");
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

  // A terminal session whose pane cannot be reached: refused before anything is written, so the
  // announcement is taken back there too.
  const paneless = mkDiscovered({ terminals: [] });
  registry.applyDiscovery([paneless]);
  heard.length = 0;
  await post(`/api/sessions/${paneless.syntheticId}/send`, { text: "Terminal words", origin: "human" });
  assert.deepEqual(heard.map((h) => [h.key, h.released]), [
    [injectionFingerprint("Terminal words"), false], [injectionFingerprint("Terminal words"), true],
  ]);
});

test("an automated delivery whose attribution cannot be stored on the wait is refused before anything is typed", async (t) => {
  // A nudge typed without its claim on the wait would start a turn read as the session's own
  // wake. The wait cannot be written, so the reservation is refused: nothing is claimed, no
  // authorship is on file, and the inject door settles it as never having reached the pane.
  const WRAP = "Please wrap up and open the pull request.";
  const registry = new Registry();
  t.after(wireNudges(registry));
  const app = mkApp(registry);
  const d = working(registry);
  assert.equal(registry.reportAwaiting(d.syntheticId, body()).ok, true);
  hook(registry, d, "Stop");
  const key = noteKeyFor(registry.getSession(d.syntheticId)!);
  const stored = () => loadSessionAwaitings().find((row) => row.noteKey === key)!;
  openDb().exec(`CREATE TEMP TRIGGER awaiting_store_down BEFORE UPDATE ON session_awaitings
    BEGIN SELECT RAISE(ABORT, 'store down'); END`);
  try {
    assert.throws(() => reserveInjection(d.syntheticId, WRAP, "foreman"), AutomatedAttributionError);
    const res = await app.request(`/api/sessions/${d.syntheticId}/inject`, {
      method: "POST",
      headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
      body: JSON.stringify({ text: WRAP, origin: "workflow" }),
    });
    const sent = await res.json() as { ok: boolean; error?: string; pasted?: boolean };
    assert.equal(sent.ok, false);
    assert.equal(sent.pasted, false, "the refusal did not read as nothing reaching the pane");
    assert.match(sent.error ?? "", /could not record this delivery/, "the transport was called after all");
  } finally {
    openDb().exec("DROP TRIGGER IF EXISTS awaiting_store_down");
  }
  assert.deepEqual(stored().pendingNudges, [], "a refused delivery was stored as pending");
  assert.equal(originOf(d.syntheticId, WRAP), undefined, "a refused delivery still claimed authorship");
  assert.deepEqual(outstandingAutomatedClaims(d.syntheticId, 0), [], "a refused delivery left its claim");
  assert.ok(registry.getAwaiting(d.syntheticId));

  // With the wait writable again, the same delivery is claimed and stored on it.
  reserveInjection(d.syntheticId, WRAP, "foreman");
  assert.equal(stored().pendingNudges.length, 1);
  releaseInjection(d.syntheticId, WRAP);
  assert.equal(registry.clearAwaiting(d.syntheticId, "operator"), true);
});

test("a refused reservation never gives back an earlier reservation of the same text", async (t) => {
  // A sender's failure path releases the text it reserved. A reservation refused for its
  // attribution reserved nothing, so releasing there would take back an earlier delivery of the
  // same words, whose turn would then read as the session's wake or the operator's Goal.
  const WRAP = "Please wrap up and open the pull request.";
  const registry = new Registry();
  t.after(wireNudges(registry));
  const app = mkApp(registry);
  const d = working(registry);
  assert.equal(registry.reportAwaiting(d.syntheticId, body()).ok, true);
  hook(registry, d, "Stop");
  const key = noteKeyFor(registry.getSession(d.syntheticId)!);
  const stored = () => loadSessionAwaitings().find((row) => row.noteKey === key)!;
  reserveInjection(d.syntheticId, WRAP, "workflow");
  const earlier = outstandingAutomatedClaims(d.syntheticId, 0);
  assert.equal(earlier.length, 1);
  openDb().exec(`CREATE TEMP TRIGGER awaiting_store_down BEFORE UPDATE ON session_awaitings
    BEGIN SELECT RAISE(ABORT, 'store down'); END`);
  try {
    const res = await app.request(`/api/sessions/${d.syntheticId}/inject`, {
      method: "POST",
      headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
      body: JSON.stringify({ text: WRAP, origin: "workflow" }),
    });
    const sent = await res.json() as { ok: boolean; pasted?: boolean };
    assert.equal(sent.ok, false);
    assert.equal(sent.pasted, false);
  } finally {
    openDb().exec("DROP TRIGGER IF EXISTS awaiting_store_down");
  }
  assert.deepEqual(outstandingAutomatedClaims(d.syntheticId, 0), earlier, "the refusal gave back the earlier delivery's claim");
  assert.equal(originOf(d.syntheticId, WRAP), "workflow", "the earlier delivery lost its authorship");
  assert.equal(stored().pendingNudges.length, 1, "the earlier delivery's nudge was taken off the wait");
  releaseInjection(d.syntheticId, WRAP);
  assert.equal(registry.clearAwaiting(d.syntheticId, "operator"), true);
});

test("a removal whose wait cannot be cleared still publishes session_remove, and the wait stays stored for the prune", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const errors = t.mock.method(console, "error", () => {});
  const registry = new Registry();
  const d = working(registry);
  assert.equal(registry.reportAwaiting(d.syntheticId, body()).ok, true);
  const key = noteKeyFor(registry.getSession(d.syntheticId)!);
  const removed: string[] = [];
  const listen = (e: { type: string; id?: string }) => { if (e.type === "session_remove" && e.id) removed.push(e.id); };
  registry.on("event", listen);
  openDb().exec(`CREATE TEMP TRIGGER awaiting_audit_down BEFORE INSERT ON session_events
    WHEN NEW.kind = 'session_awaiting_cleared' BEGIN SELECT RAISE(ABORT, 'audit down'); END`);
  try {
    registry.applyDiscovery([]);
    t.mock.timers.tick(8_000);
  } finally {
    openDb().exec("DROP TRIGGER IF EXISTS awaiting_audit_down");
    registry.off("event", listen);
  }
  assert.equal(registry.getSession(d.syntheticId), undefined);
  assert.deepEqual(removed, [d.syntheticId], "a failed wait clear stopped the removal from being published");
  assert.ok(loadSessionAwaitings().some((row) => row.noteKey === key), "the wait's row went without its audit row");
  assert.ok(errors.mock.calls.some((call) => String(call.arguments[0]).includes(d.syntheticId)),
    "the failed clear left no log line naming the session");
  // Every Registry reloads stored waits: leave none behind for the tests after this one.
  deleteSessionAwaiting(key);
});

test("a wait whose bookkeeping cannot be written never stops a session or a question being published", (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const registry = new Registry();
  const reviews = new ReviewManager(registry);
  const d = working(registry);
  assert.equal(registry.reportAwaiting(d.syntheticId, body()).ok, true);
  hook(registry, d, "Stop");
  const states: string[] = [];
  const questions: string[] = [];
  const listen = (e: { type: string; session?: { id: string; state: string }; review?: { id: string } }) => {
    if (e.type === "session_upsert" && e.session?.id === d.syntheticId) states.push(e.session.state);
    if (e.type === "review_upsert" && e.review) questions.push(e.review.id);
  };
  registry.on("event", listen);
  openDb().exec(`CREATE TEMP TRIGGER awaiting_audit_down BEFORE INSERT ON session_events
    WHEN NEW.kind = 'session_awaiting_cleared' BEGIN SELECT RAISE(ABORT, 'audit down'); END`);
  let review: { id: string };
  try {
    // The session's next turn is its wake. Ending the wait fails; the hook and its publish do not.
    assert.doesNotThrow(() => hook(registry, d, "UserPromptSubmit", "Check the build log for me."));
    assert.equal(states.at(-1), "working", "the session's new state was never published");
    // A new question ends a standing wait. That fails too; the question is still published.
    review = reviews.create(d.syntheticId, "input", "Pick one", "Which?");
    assert.ok(questions.includes(review.id), "the question was never published");
  } finally {
    openDb().exec("DROP TRIGGER IF EXISTS awaiting_audit_down");
    registry.off("event", listen);
  }
  // Left standing, to a later reading, the prune or its deadline, and logged with the session.
  assert.ok(registry.getAwaiting(d.syntheticId), "a failed clear dropped the wait anyway");
  assert.ok(errors.mock.calls.some((call) => String(call.arguments[0]).includes(d.syntheticId)),
    "the failed bookkeeping left no log line naming the session");
  reviews.resolve(review.id, "approve", "the first");
  assert.equal(registry.clearAwaiting(d.syntheticId, "operator"), true);
});

test("a wait clear that fails as a side effect never stops a task write, the preview switching off, or a hook", (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const registry = new Registry();
  t.after(wireNudges(registry));
  const [first, second] = workingPair(registry);
  for (const d of [first, second]) assert.equal(registry.reportAwaiting(d.syntheticId, body()).ok, true);
  const failFor = (sessionId: string) => openDb().exec(`CREATE TEMP TRIGGER awaiting_audit_down BEFORE INSERT ON session_events
    WHEN NEW.kind = 'session_awaiting_cleared' AND NEW.session_id = '${sessionId}' BEGIN SELECT RAISE(ABORT, 'audit down'); END`);
  const restore = () => openDb().exec("DROP TRIGGER IF EXISTS awaiting_audit_down");

  // The preview switched off: the first wait's clear fails, the second's still ends.
  // Every wait standing in the shared database ends but the one whose clear fails.
  const standing = loadSessionAwaitings().length;
  failFor(first.syntheticId);
  try {
    assert.equal(registry.clearAllAwaitings("flag"), standing - 1, "one failed clear stopped the rest");
  } finally {
    restore();
  }
  assert.ok(registry.getAwaiting(first.syntheticId), "the failed clear dropped its wait anyway");
  assert.equal(registry.getAwaiting(second.syntheticId), null);

  // A task reaching a terminal status: its write completes though its wait's clear fails.
  const task = mkTask({ id: `task-guarded-${++seq}`, sessionId: first.syntheticId, status: "running", worktreePath: first.cwd });
  registry.upsertTask(task);
  failFor(first.syntheticId);
  try {
    assert.doesNotThrow(() => registry.upsertTask({ ...task, status: "done" }));
  } finally {
    restore();
  }
  assert.equal(registry.getTask(task.id)?.status, "done", "the task write stopped at the wait");
  assert.ok(registry.getAwaiting(first.syntheticId));

  // A late prompt that wakes an undecided turn: the hook completes though the clear fails.
  assert.equal(registry.clearAwaiting(first.syntheticId, "operator"), true);
  assert.equal(registry.reportAwaiting(second.syntheticId, body()).ok, true);
  hook(registry, second, "Stop");
  reserveInjection(second.syntheticId, "Round 9 repair packet", "workflow");
  hook(registry, second, "PreToolUse");
  failFor(second.syntheticId);
  try {
    assert.doesNotThrow(() => hook(registry, second, "UserPromptSubmit", "Check the build log for me."));
  } finally {
    restore();
  }
  assert.ok(errors.mock.calls.some((call) => String(call.arguments[0]).includes(second.syntheticId)),
    "the failed late-prompt clear left no log line naming the session");
  releaseInjection(second.syntheticId, "Round 9 repair packet");
  // Every Registry reloads stored waits: leave none behind for the tests after this one.
  registry.clearAwaiting(second.syntheticId, "operator");
});

test("a person's send whose attribution cannot be stored on the wait is refused before it is written, and contests nothing", async (t) => {
  // An operator's words repeating a pending nudge must contest it, or their turn is used up as
  // Mission Control's and the wait stands. The wait cannot be written, so the send is refused:
  // the nudge is left uncontested, no recent send is remembered, and both doors answer that
  // nothing reached the session.
  const WRAP = "Please wrap up and open the pull request.";
  const registry = new Registry();
  t.after(wireNudges(registry));
  const app = mkApp(registry);
  const d = working(registry);
  assert.equal(registry.reportAwaiting(d.syntheticId, body()).ok, true);
  hook(registry, d, "Stop");
  reserveInjection(d.syntheticId, WRAP, "foreman");
  const key = noteKeyFor(registry.getSession(d.syntheticId)!);
  const stored = () => loadSessionAwaitings().find((row) => row.noteKey === key)!;
  assert.equal(stored().pendingNudges.length, 1);
  const post = (path: string, payload: unknown) => app.request(path, {
    method: "POST",
    headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  openDb().exec(`CREATE TEMP TRIGGER awaiting_store_down BEFORE UPDATE ON session_awaitings
    BEGIN SELECT RAISE(ABORT, 'store down'); END`);
  try {
    assert.throws(() => notePersonDelivery(d.syntheticId, WRAP), PersonAttributionError);
    for (const door of ["send", "inject"]) {
      const res = await post(`/api/sessions/${d.syntheticId}/${door}`, { text: WRAP, origin: "human" });
      const sent = await res.json() as { ok: boolean; error?: string; pasted?: boolean };
      assert.equal(sent.ok, false, `${door} reported a refused send as delivered`);
      assert.equal(sent.pasted, false, `${door} did not read the refusal as nothing reaching the session`);
      assert.match(sent.error ?? "", /could not record these words as a person's/, `${door} reached the transport after all`);
    }
  } finally {
    openDb().exec("DROP TRIGGER IF EXISTS awaiting_store_down");
  }
  assert.equal(stored().pendingNudges[0]!.contestedBy, undefined, "a refused send contested the nudge");
  // With the wait writable again, a second automated delivery of the same words is not
  // contested by a send that never happened.
  reserveInjection(d.syntheticId, WRAP, "workflow");
  assert.deepEqual(stored().pendingNudges.map((n) => n.contestedBy), [undefined, undefined],
    "a refused send was remembered and contested a later delivery");
  releaseInjection(d.syntheticId, WRAP);
  releaseInjection(d.syntheticId, WRAP);
  assert.equal(registry.clearAwaiting(d.syntheticId, "operator"), true);
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

test("a session that exits takes its wait with it on its removal, and a provisional exit does not", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const registry = new Registry();
  const d = working(registry);
  assert.equal(registry.reportAwaiting(d.syntheticId, body()).ok, true);
  const key = noteKeyFor(registry.getSession(d.syntheticId)!);
  // A discovery miss: exited is drawn at once, but the eviction is only under way.
  registry.applyDiscovery([]);
  assert.equal(registry.getSession(d.syntheticId)?.state, "exited");
  assert.ok(registry.getAwaiting(d.syntheticId), "a provisional exit ended the wait");
  // The next sweep sees the same process again and cancels the eviction: the wait still stands.
  registry.applyDiscovery([d]);
  assert.notEqual(registry.getSession(d.syntheticId)?.state, "exited");
  assert.ok(registry.getAwaiting(d.syntheticId), "the cancelled eviction lost the wait");
  assert.deepEqual(clearedEvents(d.syntheticId), []);
  // Gone for good: the removal after the linger ends the wait.
  registry.applyDiscovery([]);
  t.mock.timers.tick(8_000);
  assert.equal(registry.getSession(d.syntheticId), undefined);
  assert.ok(!loadSessionAwaitings().some((row) => row.noteKey === key), "the removed session's wait was kept");
  assert.equal(clearedEvents(d.syntheticId).at(-1)?.actor, "exit");
});

test("a blocker that fails to write keeps the wait it would have replaced", () => {
  const registry = new Registry();
  const d = working(registry);
  assert.equal(registry.reportAwaiting(d.syntheticId, body()).ok, true);
  const key = noteKeyFor(registry.getSession(d.syntheticId)!);
  assert.throws(() => registry.reportBlocker(d.syntheticId, { ...BLOCKER, reason: null as unknown as string }));
  assert.ok(registry.getAwaiting(d.syntheticId), "the failed blocker write dropped the wait");
  assert.ok(loadSessionAwaitings().some((row) => row.noteKey === key), "the failed blocker write deleted the wait's row");
  assert.equal(registry.getSession(d.syntheticId)?.blocker, null);
  assert.deepEqual(clearedEvents(d.syntheticId), []);
});

test("a live sibling sharing the key never starts or ends the holder's turn", () => {
  const registry = new Registry();
  const conversation = `sibling-conv-${++seq}`;
  const a = mkDiscovered({ agent: "codex", agentSessionId: conversation });
  const b = mkDiscovered({ agent: "codex", agentSessionId: conversation });
  registry.applyDiscovery([a, b]);
  let at = Date.now() - 60_000;
  const read = (d: DiscoveredSession, state: "idle" | "working") => {
    registry.applyPassiveActivity(registry.getSession(d.syntheticId)!, { state, lastActivity: at += 1_000 });
    registry.applyDiscovery([a, b]);
  };
  read(a, "working");
  read(b, "working");
  assert.equal(registry.reportAwaiting(a.syntheticId, body()).ok, true);
  const key = noteKeyFor(registry.getSession(a.syntheticId)!);
  const stored = () => loadSessionAwaitings().find((row) => row.noteKey === key)!;
  // The sibling going idle is not the holder's declaring turn ending.
  read(b, "idle");
  assert.equal(stored().settledAt, null, "the sibling's idle settled the holder's declaring turn");
  read(a, "idle");
  assert.notEqual(stored().settledAt, null);
  // The sibling working again is not the holder's next turn.
  read(b, "working");
  assert.ok(registry.getAwaiting(a.syntheticId), "the sibling's reading ended the holder's wait");
  assert.deepEqual(clearedEvents(a.syntheticId), []);
  // The holder's own next turn is the wake.
  read(a, "working");
  assert.equal(registry.getAwaiting(a.syntheticId), null);
  assert.equal(clearedEvents(a.syntheticId).at(-1)?.actor, "wake");
});

test("a wake publishes the cleared wait of every session sharing its key", () => {
  const registry = new Registry();
  const conversation = `shared-conv-${++seq}`;
  const a = mkDiscovered({ agent: "codex", agentSessionId: conversation });
  const b = mkDiscovered({ agent: "codex", agentSessionId: conversation });
  registry.applyDiscovery([a, b]);
  let at = Date.now() - 60_000;
  const read = (d: DiscoveredSession, state: "idle" | "working") => {
    registry.applyPassiveActivity(registry.getSession(d.syntheticId)!, { state, lastActivity: at += 1_000 });
    registry.applyDiscovery([a, b]);
  };
  read(a, "working");
  read(b, "idle");
  assert.equal(noteKeyFor(registry.getSession(a.syntheticId)!), noteKeyFor(registry.getSession(b.syntheticId)!));
  assert.equal(registry.reportAwaiting(a.syntheticId, body()).ok, true);
  assert.ok(registry.getSession(b.syntheticId)?.awaiting, "the sibling did not show the shared wait");
  read(a, "idle");
  const published: Array<{ id: string; awaiting: unknown }> = [];
  const listen = (e: { type: string; session?: { id: string; awaiting: unknown } }) => {
    if (e.type === "session_upsert" && e.session) published.push({ id: e.session.id, awaiting: e.session.awaiting });
  };
  registry.on("event", listen);
  try {
    read(a, "working");
  } finally {
    registry.off("event", listen);
  }
  assert.equal(registry.getAwaiting(a.syntheticId), null);
  assert.ok(
    published.some((p) => p.id === b.syntheticId && p.awaiting === null),
    "the sibling's cleared wait was never published",
  );
});

test("a reset that cancels the session's task ends the wait declared for it", () => {
  const registry = new Registry();
  const d = working(registry);
  const sid = d.syntheticId;
  registry.upsertTask(mkTask({ id: `task-reset-${++seq}`, status: "running", sessionId: sid }));
  assert.ok(registry.getSession(sid)?.task, "the fixture task is not bound to the session");
  assert.equal(registry.reportAwaiting(sid, body()).ok, true);
  registry.resetWorkEpisode(sid);
  assert.equal(registry.getAwaiting(sid), null, "the reset cancelled the task but kept its wait");
  assert.equal(clearedEvents(sid).at(-1)?.actor, "task");
});

test("a turn a session without hooks starts and ends between sweeps is still judged", (t) => {
  const registry = new Registry();
  t.after(wireNudges(registry));
  const d = mkDiscovered({ agent: "codex" });
  registry.applyDiscovery([d]);
  let at = Date.now() - 60_000;
  const read = (state: "idle" | "working", turnStartedAt?: number) => {
    at += 1_000;
    registry.applyPassiveActivity(registry.getSession(d.syntheticId)!, { state, lastActivity: at, ...(turnStartedAt ? { turnStartedAt } : {}) });
    registry.applyDiscovery([d]);
  };
  read("working", at);
  assert.equal(registry.reportAwaiting(d.syntheticId, body()).ok, true);
  read("idle");
  const settled = loadSessionAwaitings().find((row) => row.noteKey === noteKeyFor(registry.getSession(d.syntheticId)!))!.settledAt!;
  assert.ok(settled);

  // A delivery of Mission Control's lands, and its whole turn falls between two sweeps: the
  // transcript is idle again, with a newer turn marker. It uses up the delivery.
  reserveInjection(d.syntheticId, "Please wrap up and open the pull request.", "foreman");
  read("idle", settled + 1_000);
  assert.ok(registry.getAwaiting(d.syntheticId), "a missed nudge turn ended the wait");
  assert.deepEqual(
    loadSessionAwaitings().find((row) => row.noteKey === noteKeyFor(registry.getSession(d.syntheticId)!))!.pendingNudges,
    [],
    "the missed nudge turn did not use up its delivery",
  );

  // The session's own wake, just as quick: nothing is outstanding, so it is the wake.
  read("idle", settled + 5_000);
  assert.equal(registry.getAwaiting(d.syntheticId), null, "a turn missed between sweeps was never judged");
  assert.equal(clearedEvents(d.syntheticId).at(-1)?.actor, "wake");
});

test("a missed turn is judged from the transcript even after report_status marked the session as hooked", () => {
  // `report_status` sets `hooksSeen` on a session whose lifecycle still arrives only through its
  // transcript: its reading still comes from the transcript, so its turn marker still counts.
  const registry = new Registry();
  const d = mkDiscovered({ agent: "codex" });
  registry.applyDiscovery([d]);
  let at = Date.now() - 60_000;
  const read = (state: "idle" | "working", turnStartedAt?: number) => {
    at += 1_000;
    registry.applyPassiveActivity(registry.getSession(d.syntheticId)!, { state, lastActivity: at, ...(turnStartedAt ? { turnStartedAt } : {}) });
    registry.applyDiscovery([d]);
  };
  read("working", at);
  assert.equal(registry.reportAwaiting(d.syntheticId, body()).ok, true);
  read("idle");
  registry.applyStatus({ tmuxPane: (d.terminals[0] as { paneId: string }).paneId }, null, "watching CI");
  assert.equal(registry.getSession(d.syntheticId)?.hooksSeen, true, "the fixture is not marked as hooked");
  const settled = loadSessionAwaitings().find((row) => row.noteKey === noteKeyFor(registry.getSession(d.syntheticId)!))!.settledAt!;
  read("idle", settled + 5_000);
  assert.equal(registry.getAwaiting(d.syntheticId), null, "the missed wake was skipped because the session read as hooked");
  assert.equal(clearedEvents(d.syntheticId).at(-1)?.actor, "wake");
});

test("a declaration whose request body is read after the preview switched off is refused", async () => {
  const registry = new Registry();
  const app = mkApp(registry);
  const sdk = registry.registerSdkSession({ id: `sdk:awaiting-${++seq}`, agent: "claude", name: "embedded", cwd: "/repo", agentSessionId: `agent-aw-flag-${seq}` });
  applyFeatureFlagIntent({ kind: "flag", id: SESSION_AWAITING_FLAG_ID, enabled: true });
  try {
    const payload = new TextEncoder().encode(JSON.stringify({ env: {}, sessionId: sdk.id, ...wire() }));
    // The preview is switched off while the body is still arriving, after the route's gate ran.
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        applyFeatureFlagIntent({ kind: "flag", id: SESSION_AWAITING_FLAG_ID, enabled: false });
        controller.enqueue(payload);
        controller.close();
      },
    });
    const res = await app.request("/mcp/awaiting", {
      method: "POST",
      headers: { host: "127.0.0.1", "content-type": "application/json", "x-harness-token": ensureToken() },
      body: stream,
      duplex: "half",
    } as RequestInit);
    assert.equal(res.status, 404, "a declaration landed after the preview was switched off");
    assert.equal((await res.json()).feature, SESSION_AWAITING_FLAG_ID);
    assert.equal(registry.getAwaiting(sdk.id), null);
  } finally {
    applyFeatureFlagIntent({ kind: "flag", id: SESSION_AWAITING_FLAG_ID, enabled: false });
  }
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
  // The audit row of that clear is filed under the session that held the wait, not the key.
  assert.equal(clearedEvents(d.syntheticId).at(-1)?.actor, "exit", "the prune's audit row is not under the session");
});

test("a blocker replacing a wait is published as one update carrying both", () => {
  const registry = new Registry();
  const d = working(registry);
  assert.equal(registry.reportAwaiting(d.syntheticId, body()).ok, true);
  const published: Array<{ awaiting: unknown; blocker: unknown }> = [];
  const listen = (e: { type: string; session?: Session }) => {
    if (e.type === "session_upsert" && e.session?.id === d.syntheticId) {
      published.push({ awaiting: e.session.awaiting, blocker: e.session.blocker });
    }
  };
  registry.on("event", listen);
  let reported: ReturnType<RegistryT["reportBlocker"]>;
  try {
    reported = registry.reportBlocker(d.syntheticId, BLOCKER);
  } finally {
    registry.off("event", listen);
  }
  assert.ok(reported.ok);
  // Exactly one publish, carrying both changes: the wait gone and the blocker it returned.
  assert.deepEqual(published, [{ awaiting: null, blocker: reported.blocker }]);
});

test("a blocker replacing a wait whose audit row cannot be written leaves the wait, and no blocker, anywhere", () => {
  const registry = new Registry();
  const d = working(registry);
  assert.equal(registry.reportAwaiting(d.syntheticId, body()).ok, true);
  const key = noteKeyFor(registry.getSession(d.syntheticId)!);
  // The wait's audit insert fails inside the replacement's transaction.
  openDb().exec(`CREATE TEMP TRIGGER awaiting_audit_down BEFORE INSERT ON session_events
    WHEN NEW.kind = 'session_awaiting_cleared' BEGIN SELECT RAISE(ABORT, 'audit down'); END`);
  try {
    assert.throws(() => registry.reportBlocker(d.syntheticId, BLOCKER), /audit down/);
  } finally {
    openDb().exec("DROP TRIGGER IF EXISTS awaiting_audit_down");
  }
  // Rolled back whole: the wait still stands in SQLite and in the Registry, and no blocker was
  // written to either, so the two never disagree.
  assert.ok(registry.getAwaiting(d.syntheticId), "the Registry lost the wait");
  assert.ok(loadSessionAwaitings().some((row) => row.noteKey === key), "the wait's row was deleted");
  assert.equal(registry.getSession(d.syntheticId)?.blocker, null);
  const blockerRows = openDb().prepare("SELECT COUNT(*) AS n FROM session_blockers WHERE note_key = ?").get(key) as { n: number };
  assert.equal(blockerRows.n, 0, "SQLite holds a blocker the Registry never installed");
  // Every Registry reloads stored waits: leave none behind for the tests after this one.
  assert.equal(registry.clearAwaiting(d.syntheticId, "operator"), true);
});

test("a declaration or a clear whose audit row cannot be written changes nothing, in SQLite or in the Registry", () => {
  const registry = new Registry();
  const d = working(registry);
  const key = noteKeyFor(registry.getSession(d.syntheticId)!);
  const stored = () => loadSessionAwaitings().find((row) => row.noteKey === key);
  const auditDown = (kind: string, write: () => unknown) => {
    openDb().exec(`CREATE TEMP TRIGGER awaiting_audit_down BEFORE INSERT ON session_events
      WHEN NEW.kind = '${kind}' BEGIN SELECT RAISE(ABORT, 'audit down'); END`);
    try {
      assert.throws(write, /audit down/);
    } finally {
      openDb().exec("DROP TRIGGER IF EXISTS awaiting_audit_down");
    }
  };

  // A first declaration: no wait anywhere, and no event.
  auditDown("session_awaiting_set", () => registry.reportAwaiting(d.syntheticId, body()));
  assert.equal(registry.getAwaiting(d.syntheticId), null, "the Registry kept a wait with no audit row");
  assert.equal(stored(), undefined, "SQLite kept a wait with no audit row");
  assert.deepEqual(awaitingEvents(d.syntheticId, "session_awaiting_set"), []);

  // A re-declaration: the earlier wait stands exactly as it was.
  assert.equal(registry.reportAwaiting(d.syntheticId, body()).ok, true);
  const before = stored();
  const cached = registry.getAwaiting(d.syntheticId);
  auditDown("session_awaiting_updated", () => registry.reportAwaiting(d.syntheticId, body(Date.now(), 30)));
  assert.deepEqual(stored(), before, "SQLite took the re-declaration with no audit row");
  assert.deepEqual(registry.getAwaiting(d.syntheticId), cached, "the Registry took the re-declaration with no audit row");
  assert.deepEqual(awaitingEvents(d.syntheticId, "session_awaiting_updated"), []);

  // A clear: the wait still stands in both, and no clear was logged.
  auditDown("session_awaiting_cleared", () => registry.clearAwaiting(d.syntheticId, "operator"));
  assert.deepEqual(registry.getAwaiting(d.syntheticId), cached, "the Registry dropped the wait with no audit row");
  assert.deepEqual(stored(), before, "SQLite deleted the wait with no audit row");
  assert.deepEqual(clearedEvents(d.syntheticId), []);

  // Every Registry reloads stored waits: leave none behind for the tests after this one.
  assert.equal(registry.clearAwaiting(d.syntheticId, "operator"), true);
  assert.equal(clearedEvents(d.syntheticId).length, 1);
});

test("a declaration or a clear inside a caller's open transaction is refused before it writes, so a rollback cannot strand the Registry", () => {
  const registry = new Registry();
  const d = working(registry);
  const key = noteKeyFor(registry.getSession(d.syntheticId)!);
  const stored = () => loadSessionAwaitings().find((row) => row.noteKey === key);
  const inOpenTransaction = (write: () => unknown) => {
    openDb().exec("BEGIN IMMEDIATE");
    try {
      assert.throws(write, /transaction/);
    } finally {
      openDb().exec("ROLLBACK");
    }
  };

  // A declaration: nothing in SQLite once the caller rolls back, and nothing in the Registry.
  inOpenTransaction(() => registry.reportAwaiting(d.syntheticId, body()));
  assert.equal(registry.getAwaiting(d.syntheticId), null, "the Registry holds a wait SQLite rolled back");
  assert.equal(stored(), undefined);
  assert.deepEqual(awaitingEvents(d.syntheticId, "session_awaiting_set"), []);

  // A clear: the wait still stands in both after the caller rolls back.
  assert.equal(registry.reportAwaiting(d.syntheticId, body()).ok, true);
  const before = stored();
  const cached = registry.getAwaiting(d.syntheticId);
  inOpenTransaction(() => registry.clearAwaiting(d.syntheticId, "operator"));
  assert.deepEqual(registry.getAwaiting(d.syntheticId), cached, "the Registry dropped a wait SQLite still holds");
  assert.deepEqual(stored(), before);
  assert.deepEqual(clearedEvents(d.syntheticId), []);

  // Every Registry reloads stored waits: leave none behind for the tests after this one.
  assert.equal(registry.clearAwaiting(d.syntheticId, "operator"), true);
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

test("the MCP routes bind to the caller and follow the preview; the session clears its own standing wait and the dashboard clears as the operator", async (t) => {
  const registry = new Registry();
  t.after(maintainScoutSessionCredentials(registry));
  const app = mkApp(registry);
  const sdk = registry.registerSdkSession({ id: `sdk:awaiting-${++seq}`, agent: "claude", name: "embedded", cwd: "/repo", agentSessionId: `agent-aw-route-${seq}` });
  const other = registry.registerSdkSession({ id: `sdk:awaiting-${++seq}`, agent: "claude", name: "other", cwd: "/repo", agentSessionId: `agent-aw-route-${seq}` });
  // The signed Registry credential each session's MCP bridge sends: it, not the body, names the caller.
  const credentialOf = (id: string) => {
    const path = sessionScoutCredentialPath(`session:${sessionScoutCredentialLocator(id)}`);
    t.after(() => rmSync(path, { force: true }));
    return readFileSync(path, "utf8").trim();
  };
  const sdkCredential = credentialOf(sdk.id);
  const otherCredential = credentialOf(other.id);
  const mcp = (path: string, body: unknown, credential: string = sdkCredential) => app.request(path, {
    method: "POST",
    headers: {
      host: "127.0.0.1", "content-type": "application/json", "x-harness-token": ensureToken(),
      ...(credential ? { "x-mission-scout-credential": credential } : {}),
    },
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
    // Inside the allowed window, so the missing zone is the only thing wrong with it.
    const zoneless = new Date(Date.now() + 20 * MIN).toISOString().slice(0, 19);
    const noZone = await mcp("/mcp/awaiting", { env: {}, sessionId: sdk.id, ...wire(zoneless) });
    assert.equal(noZone.status, 400, "a date-time with no zone");
    const noZoneError = JSON.stringify(await noZone.json());
    assert.match(noZoneError, /expectedBy/);
    assert.match(noZoneError, /datetime|date-time|ISO/i, "the refusal did not name the date-time format");
    assert.doesNotMatch(noZoneError, /in the future|at most 240 minutes/, "the refusal came from the deadline bounds, not the zone rule");
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
    // Bound to the caller's signed credential: without one nothing is declared, and a body that
    // names another session is refused rather than acted on for either session.
    assert.equal((await mcp("/mcp/awaiting", { env: {}, sessionId: sdk.id, ...wire() }, "")).status, 403);
    assert.equal(registry.getAwaiting(sdk.id), null, "a declaration without the caller's credential landed");
    assert.equal((await mcp("/mcp/awaiting", { env: {}, sessionId: sdk.id, ...wire() }, otherCredential)).status, 403);
    assert.equal(registry.getAwaiting(sdk.id), null, "another session's credential declared a wait on this one");
    assert.equal(registry.getAwaiting(other.id), null, "a mismatched declaration was retargeted to its caller");
    assert.equal(registry.reportAwaiting(sdk.id, body()).ok, true);
    assert.equal((await mcp("/mcp/awaiting/clear", { env: {}, sessionId: sdk.id }, otherCredential)).status, 403);
    assert.ok(registry.getAwaiting(sdk.id), "another session cleared this session's wait");
    assert.equal((await mcp("/mcp/awaiting/clear", { env: {}, sessionId: sdk.id }, "")).status, 403);
    assert.ok(registry.getAwaiting(sdk.id));
    assert.equal(registry.clearAwaiting(sdk.id, "operator"), true);

    // Switching the preview off ends every standing wait.
    assert.equal(registry.reportAwaiting(sdk.id, body()).ok, true);
    // Every wait standing in the shared database, not only this test's: a wait an earlier test
    // left behind is ended too, which is what switching the preview off promises.
    const standing = loadSessionAwaitings().length;
    assert.ok(standing >= 1);
    assert.equal(registry.clearAllAwaitings("flag"), standing);
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
  if (parsed.command.action === "complete") assert.fail("parsed as the two-request complete action");
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

test("the last judged transcript turn is stored with the wait, so a restart does not judge that turn again", () => {
  const record = {
    noteKey: "judged-turn-roundtrip", taskId: null, sessionId: "s-judged",
    awaiting: {
      id: "aw-judged", what: "CI checks", wakeSource: "command" as const, expectedBy: Date.now() + 600_000,
      referenceUrl: null, details: null, startedAt: 1_000, updatedAt: 1_000,
    },
    settledAt: 2_000, pendingNudges: [], undecidedTurn: false, redeclaredInTurn: false, judgedTurnAt: 2_500,
  };
  upsertSessionAwaiting(record);
  try {
    assert.equal(loadSessionAwaitings().find((row) => row.noteKey === record.noteKey)?.judgedTurnAt, 2_500);
    upsertSessionAwaiting({ ...record, judgedTurnAt: null });
    assert.equal(loadSessionAwaitings().find((row) => row.noteKey === record.noteKey)?.judgedTurnAt, null);
  } finally {
    deleteSessionAwaiting(record.noteKey);
  }
});
