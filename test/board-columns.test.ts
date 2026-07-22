import { test } from "node:test";
import assert from "node:assert/strict";
import type { Session } from "../src/shared/types.ts";
import { gateParked } from "../src/shared/session.ts";
import { boardColumnModes, groupByTone, TONE_GROUPS } from "../src/web/lib/tone.ts";
import type { Tone } from "../src/web/lib/format.ts";
import { canAcceptTask } from "../src/web/components/layouts/BacklogColumn.tsx";
import { nm } from "./helpers/session-fixture.ts";

/**
 * The board's shape is decided by two small pure rules - which empty columns stay and
 * which drops are legal - and both are the sort that read as obviously correct while
 * being wrong in one state. Asserted here rather than by eye on a dashboard, because
 * the states that matter (an "attention" column emptying, a drill-in, an agent in the
 * wrong repo) are exactly the ones you don't happen to have on screen.
 */

function session(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    agent: "claude",
    name: "s1",
    nameSource: "tmux",
    state: "idle",
    cwd: "/repo",
    gitBranch: null,
    gitRoot: "/repo",
    repoRoot: "/repo",
    nomistakesGated: false,
    pid: 1,
    tty: null,
    permissionMode: null,
    terminals: [],
    agentSessionId: null,
    transcriptPath: null,
    // State-confirmed, so `stateDisplay` trusts the reported state instead of filing
    // every session under "unconfirmed" - which is what the board would show.
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
    nomistakesNarration: null,
    prUrl: null,
    prNumber: null,
    prState: null,
    prChecks: null,
    meta: null,
    note: null,
    cost: null,
    goal: null,
    queue: null,
    orphanedQueue: null,
    ...over,
  } as Session;
}

const NONE: ReadonlySet<Tone> = new Set();

function modesFor(sessions: Session[], revealed: ReadonlySet<Tone> = NONE, focused = false) {
  const gateAlerts = new Set(sessions.filter((s) => gateParked(s, sessions)).map((s) => s.id));
  return boardColumnModes(groupByTone(sessions, gateAlerts), revealed, focused);
}

test("an empty 'needs you' keeps its column - the all-clear IS the information", () => {
  // Every other column empties into the stash; this one never does. An operator who
  // glances at the board must be able to READ that nothing is waiting on them, not
  // infer it from a column that isn't there.
  const modes = modesFor([session({ state: "working" })]);
  assert.equal(modes.get("attention"), "calm");
  assert.equal(modes.get("working"), "sessions");
  for (const tone of ["idle", "neutral", "exited"] as const) {
    assert.equal(modes.get(tone), "stashed", tone);
  }
});

test("a column that has sessions is never stashed, whatever its tone", () => {
  const modes = modesFor([session({ state: "idle" }), session({ id: "s2", state: "exited" })]);
  assert.equal(modes.get("idle"), "sessions");
  assert.equal(modes.get("exited"), "sessions");
});

test("'needs you' with sessions in it is an ordinary column, not an all-clear", () => {
  const modes = modesFor([session({ state: "awaiting_input" })]);
  assert.equal(modes.get("attention"), "sessions");
});

test("an idle session parked at a no-mistakes gate moves to 'needs you'", () => {
  const run = nm({
    branch: "feature/review",
    awaitingAgent: "parked 10s",
    gateStep: "review",
  });
  const parked = session({ state: "idle", gitBranch: "feature/review", nomistakes: run });
  const groups = groupByTone([parked], new Set([parked.id]));
  assert.deepEqual(groups.find((g) => g.tone === "attention")?.sessions, [parked]);
  assert.equal(groups.find((g) => g.tone === "idle")?.sessions.length, 0);

  // A sibling still driving this exact run keeps the decision with the agent.
  const driver = session({
    id: "driver",
    state: "working",
    gitBranch: "feature/review",
    nomistakes: run,
  });
  const driven = groupByTone([parked, driver], new Set());
  assert.equal(driven.find((g) => g.tone === "attention")?.sessions.length, 0);
  assert.deepEqual(driven.find((g) => g.tone === "idle")?.sessions, [parked]);
});

test("a revealed column comes back out of the stash, and only that one", () => {
  const modes = modesFor([session({ state: "working" })], new Set<Tone>(["exited"]));
  assert.equal(modes.get("exited"), "revealed");
  assert.equal(modes.get("idle"), "stashed");
  assert.equal(modes.get("neutral"), "stashed");
});

test("a drill-in stashes nothing: every column stays mounted across the morph", () => {
  // Opening a session animates all five columns' widths into a rail plus a detail
  // pane. Stashing one mid-morph would unmount it under its own animation, so while
  // focused they are all rendered (collapsed to nothing) instead.
  const modes = modesFor([session({ state: "working" })], NONE, true);
  for (const { tone } of TONE_GROUPS) {
    assert.notEqual(modes.get(tone), "stashed", tone);
  }
  // "needs you" is still the all-clear, not a bare empty column.
  assert.equal(modes.get("attention"), "calm");
});

test("every tone gets a verdict - no column can fall through the rules unrendered", () => {
  const modes = modesFor([]);
  assert.equal(modes.size, TONE_GROUPS.length);
  for (const { tone } of TONE_GROUPS) assert.ok(modes.get(tone), tone);
});

test("only an idle agent in the task's own repo may be dropped on", () => {
  assert.equal(canAcceptTask(session(), "/repo", false), true);
  // Busy in any sense is not a drop target: the prompt would land mid-turn.
  for (const state of ["working", "awaiting_input", "awaiting_review", "starting", "exited"] as const) {
    assert.equal(canAcceptTask(session({ state }), "/repo", false), false, state);
  }
  // The wrong repo is the one way this gesture does damage you can't undo from the
  // dashboard, so it is refused rather than best-efforted.
  assert.equal(canAcceptTask(session({ repoRoot: "/other" }), "/repo", false), false);
  assert.equal(canAcceptTask(session({ repoRoot: null }), "/repo", false), false);
  // Nothing in the air, nothing droppable.
  assert.equal(canAcceptTask(session(), null, false), false);
});

test("only hook-instrumented sessions in the Idle column accept drops", () => {
  // Both of these report state "idle" and would pass a naive raw-state check, and
  // neither sits in the Idle column - so neither may be handed more work.
  //
  // With no fresh lifecycle reading, "idle" is a guess. Shows as Unconfirmed.
  assert.equal(
    canAcceptTask(session({ instrumented: false, stateConfirmed: false }), "/repo", false),
    false,
  );
  // A Codex rollout can confirm idle without a hook, so it belongs in Idle, but the
  // hook-dependent handover remains unavailable.
  assert.equal(
    canAcceptTask(session({ instrumented: false, stateConfirmed: true }), "/repo", false),
    false,
  );
  // A review already parked on it: the agent is idle precisely BECAUSE it is waiting
  // on the human. Shows under Needs you.
  assert.equal(canAcceptTask(session({ pendingReviews: 1 }), "/repo", false), false);
  // The no-mistakes gate is the same kind of human wait. BoardView supplies this
  // cross-session verdict to the drop predicate.
  assert.equal(canAcceptTask(session(), "/repo", true), false);
});
