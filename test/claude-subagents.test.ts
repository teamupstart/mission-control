import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  claudeSubagentSummary,
  emptyClaudeSubagents,
  foldClaudeSubagents,
  observeClaudeSubagentFrame,
  type ClaudeSubagentState,
} from "../src/server/harness/claude/subagents.ts";
import { SubagentEmitter } from "../src/server/sdk/subagent-emitter.ts";
import {
  SUBAGENT_LIMIT,
  hasSubagents,
  subagentCountLabel,
  subagentActivityLine,
  subagentCounts,
} from "../src/shared/subagents.ts";
import { SubagentTree, subagentRowDetail } from "../src/web/components/layouts/SubagentTree.tsx";
import type { ClaudeSdkMessage } from "../src/server/harness/claude/sdk-types.ts";
import type { SubagentEntry, SubagentSummary } from "../src/shared/types.ts";
import { mkSession } from "./helpers/session-fixture.ts";

const sys = (subtype: string, body: Record<string, unknown>): ClaudeSdkMessage => ({
  type: "system",
  subtype,
  session_id: "s",
  ...body,
});
const agent = (id: string, extra: Record<string, unknown> = {}) => ({
  task_id: id,
  task_type: "local_agent",
  subagent_type: "Explore",
  description: `agent ${id}`,
  ...extra,
});
const started = (id: string, extra: Record<string, unknown> = {}) =>
  sys("task_started", { ...agent(id), tool_use_id: `toolu_${id}`, ...extra });
const level = (...tasks: Record<string, unknown>[]) => sys("background_tasks_changed", { tasks });

function run(frames: ClaudeSdkMessage[], from = emptyClaudeSubagents(), now = 1_000): ClaudeSubagentState {
  return frames.reduce((s, f, i) => observeClaudeSubagentFrame(s, f, now + i), from);
}
const ids = (state: ClaudeSubagentState) => claudeSubagentSummary(state)?.agents.map((a) => a.id) ?? [];
const states = (state: ClaudeSubagentState) =>
  Object.fromEntries((claudeSubagentSummary(state)?.agents ?? []).map((a) => [a.id, a.state]));

test("the live set replaces membership, and leaving it silently means stopped", () => {
  let s = run([level(agent("a"), agent("b")), started("a", { is_backgrounded: true }), started("b", { is_backgrounded: true })]);
  assert.deepEqual(ids(s), ["a", "b"]);
  s = observeClaudeSubagentFrame(s, level(agent("a")), 5_000);
  assert.deepEqual(states(s), { a: "running", b: "stopped" });
  assert.equal(claudeSubagentSummary(s)!.agents.find((x) => x.id === "b")!.endedAt, 5_000);
});

test("only background, non-ambient local_agent tasks count", () => {
  const s = run([
    level(
      agent("bg"),
      agent("amb", { ambient: true }),
      { task_id: "sh", task_type: "local_bash", description: "watch" },
      { task_id: "main", task_type: "local_agent", subagent_type: "main-session", description: "main" },
    ),
    started("bg", { is_backgrounded: true }),
    started("fg", { is_backgrounded: false }),
    sys("task_started", { task_id: "sh", task_type: "local_bash", description: "watch", is_backgrounded: true }),
  ]);
  assert.deepEqual(ids(s), ["bg"]);
});

test("a foreground agent never counts, and is forgotten once it ends", () => {
  const s = run([started("fg", { is_backgrounded: false }), sys("task_notification", { task_id: "fg", status: "completed", summary: "x" })]);
  assert.equal(claudeSubagentSummary(s), null);
  assert.equal(s.tasks.size, 0);
});

test("an agent moved to the background starts counting then, with its original start", () => {
  let s = run([started("late", { is_backgrounded: false })], emptyClaudeSubagents(), 100);
  assert.equal(claudeSubagentSummary(s), null);
  s = observeClaudeSubagentFrame(s, sys("task_updated", { task_id: "late", patch: { is_backgrounded: true } }), 900);
  const [entry] = claudeSubagentSummary(s)!.agents;
  assert.equal(entry!.id, "late");
  assert.equal(entry!.startedAt, 100);
  assert.equal(entry!.launchTurnId, "toolu_late");
});

test("edges alone drive a CLI without the live set, filtered by is_backgrounded", () => {
  let s = run([started("a", { is_backgrounded: true }), started("b")]);
  assert.equal(s.levelSeen, false);
  assert.deepEqual(ids(s), ["a"]);
  s = observeClaudeSubagentFrame(s, sys("task_notification", { task_id: "a", status: "failed", summary: "boom" }), 2_000);
  assert.deepEqual(states(s), { a: "failed" });
});

test("progress and notification add detail; nulls stay null until reported", () => {
  let s = run([level(agent("a")), started("a", { is_backgrounded: true })]);
  let [entry] = claudeSubagentSummary(s)!.agents;
  assert.deepEqual(
    [entry!.toolUses, entry!.tokens, entry!.lastTool, entry!.summary],
    [null, null, null, null],
  );
  s = observeClaudeSubagentFrame(s, sys("task_progress", {
    task_id: "a", description: "agent a", last_tool_name: "Grep", summary: "searching",
    usage: { total_tokens: 41_000, tool_uses: 18, duration_ms: 1 },
  }), 3_000);
  [entry] = claudeSubagentSummary(s)!.agents;
  assert.deepEqual([entry!.toolUses, entry!.tokens, entry!.lastTool, entry!.summary], [18, 41_000, "Grep", "searching"]);
  s = observeClaudeSubagentFrame(s, sys("task_notification", {
    task_id: "a", status: "completed", summary: "done it", usage: { total_tokens: 50_000, tool_uses: 20, duration_ms: 1 },
  }), 4_000);
  [entry] = claudeSubagentSummary(s)!.agents;
  assert.deepEqual([entry!.state, entry!.endedAt, entry!.toolUses, entry!.summary], ["completed", 4_000, 20, "done it"]);
  // The level dropping it afterwards does not turn a completion into a stop.
  s = observeClaudeSubagentFrame(s, level(), 5_000);
  assert.equal(claudeSubagentSummary(s)!.agents[0]!.state, "completed");
});

test("a late level listing an ended agent does not revive it", () => {
  let s = run([level(agent("a")), started("a", { is_backgrounded: true })]);
  s = observeClaudeSubagentFrame(s, sys("task_updated", { task_id: "a", patch: { status: "killed", end_time: 7 } }), 8);
  s = observeClaudeSubagentFrame(s, level(agent("a")), 9);
  assert.deepEqual(states(s), { a: "stopped" });
});

test("finished agents fold only on the operator's turn, and the count goes once nothing runs", () => {
  let s = run([level(agent("a"), agent("b")), started("a", { is_backgrounded: true }), started("b", { is_backgrounded: true })]);
  s = observeClaudeSubagentFrame(s, sys("task_notification", { task_id: "a", status: "completed", summary: "" }), 2_000);
  // Nothing about a frame folds: the finished row stays listed.
  s = observeClaudeSubagentFrame(s, level(agent("b")), 2_100);
  assert.deepEqual(states(s), { a: "completed", b: "running" });
  s = foldClaudeSubagents(s);
  assert.deepEqual(claudeSubagentSummary(s), {
    agents: [claudeSubagentSummary(s)!.agents[0]!],
    finishedFolded: 1,
  });
  assert.deepEqual(ids(s), ["b"]);
  s = observeClaudeSubagentFrame(s, sys("task_notification", { task_id: "b", status: "completed", summary: "" }), 3_000);
  s = foldClaudeSubagents(s);
  assert.equal(claudeSubagentSummary(s), null);
});

test("an agent folded before the live set drops it is not revived by that late live set", () => {
  let s = run([level(agent("a"), agent("b")), started("a", { is_backgrounded: true }), started("b", { is_backgrounded: true })]);
  // The notification comes first; the live set still lists `a` until a later frame.
  s = observeClaudeSubagentFrame(s, sys("task_notification", { task_id: "a", status: "completed", summary: "" }), 2_000);
  s = foldClaudeSubagents(s);
  assert.deepEqual(states(s), { b: "running" });
  assert.equal(claudeSubagentSummary(s)!.finishedFolded, 1);

  // The late level still naming `a` must not bring it back as running.
  s = observeClaudeSubagentFrame(s, level(agent("a"), agent("b")), 2_100);
  assert.deepEqual(states(s), { b: "running" });
  assert.deepEqual(subagentCounts(claudeSubagentSummary(s)), { running: 1, finished: 0, folded: 1, listed: 1, atLeast: false });

  // Once the live set drops it the guard is spent; a real restart of the same id counts again.
  s = observeClaudeSubagentFrame(s, level(agent("b")), 2_200);
  assert.equal(s.retired.has("a"), false);
  s = observeClaudeSubagentFrame(s, started("a", { is_backgrounded: true }), 3_000);
  s = observeClaudeSubagentFrame(s, level(agent("a"), agent("b")), 3_001);
  assert.deepEqual(states(s), { a: "running", b: "running" });
});

test("only a start for a later run lifts the guard while a late live set still lists the agent", () => {
  let s = run([level(agent("a", { run_id: "r1" })), started("a", { is_backgrounded: true, run_id: "r1" })]);
  s = observeClaudeSubagentFrame(s, sys("task_notification", { task_id: "a", run_id: "r1", status: "completed", summary: "" }), 2);
  s = foldClaudeSubagents(s);
  assert.equal(s.retired.has("a"), true);
  // A start without a run id proves nothing about a new run: it stays folded.
  assert.equal(observeClaudeSubagentFrame(s, started("a", { is_backgrounded: true }), 3), s);
  // A start for a later run is a resume.
  s = observeClaudeSubagentFrame(s, started("a", { is_backgrounded: true, run_id: "r2" }), 4);
  assert.equal(s.retired.has("a"), false);
  assert.deepEqual(states(s), { a: "running" });
});

test("a repeated start without a run id does not revive an agent that just finished", () => {
  // The live set still names `a` after its notification, until the next frame drops it.
  let s = run([level(agent("a")), started("a", { is_backgrounded: true })]);
  s = observeClaudeSubagentFrame(s, sys("task_notification", { task_id: "a", status: "completed", summary: "" }), 2);
  assert.equal(s.live.has("a"), true);
  assert.equal(observeClaudeSubagentFrame(s, started("a", { is_backgrounded: true }), 3), s);
  assert.deepEqual(states(s), { a: "completed" });
});

test("an agent the live set marked ambient stays hidden when its start omits the flag", () => {
  // The set classifies `h` before its start, which then arrives without `ambient`.
  let s = run([level(agent("a"), agent("h", { ambient: true })), started("a", { is_backgrounded: true })]);
  s = observeClaudeSubagentFrame(s, started("h", { is_backgrounded: true }), 2);
  assert.deepEqual(states(s), { a: "running" });
  assert.equal(subagentCounts(claudeSubagentSummary(s)).running, 1);
  // Its later progress and end change nothing visible either.
  s = observeClaudeSubagentFrame(s, sys("task_notification", { task_id: "h", status: "completed", summary: "" }), 3);
  s = foldClaudeSubagents(s);
  assert.deepEqual(states(s), { a: "running" });
  assert.equal(claudeSubagentSummary(s)!.finishedFolded, 0, "housekeeping is never counted as finished");
});

test("an agent pushed past the cap is not revived by a late live set either", () => {
  const n = SUBAGENT_LIMIT + 1;
  const all = Array.from({ length: n }, (_, i) => `c${i}`);
  let s = run([level(...all.map((id) => agent(id))), ...all.map((id) => started(id, { is_backgrounded: true }))]);
  // Every agent ends while the live set still lists them all; the oldest finisher overflows.
  for (const [i, id] of all.entries()) {
    s = observeClaudeSubagentFrame(s, sys("task_notification", { task_id: id, status: "completed", summary: "" }), 10_000 + i);
  }
  const before = claudeSubagentSummary(s)!;
  assert.equal(before.agents.length, SUBAGENT_LIMIT);
  assert.equal(before.finishedFolded, 1);
  assert.equal(before.agents.some((a) => a.id === "c0"), false);

  s = observeClaudeSubagentFrame(s, level(...all.map((id) => agent(id))), 20_000);
  const after = claudeSubagentSummary(s)!;
  assert.equal(subagentCounts(after).running, 0, "the capped agent did not come back as running");
  assert.equal(after.agents.some((a) => a.id === "c0"), false);
});

test("every agent that ended stays guarded for as long as the live set still lists it", () => {
  // Far past any fixed limit: 100 agents finish and are folded while the live set still names
  // every one of them.
  const all = Array.from({ length: 100 }, (_, i) => `g${i}`);
  let s = run([level(...all.map((id) => agent(id))), ...all.map((id) => started(id, { is_backgrounded: true }))]);
  for (const [i, id] of all.entries()) {
    s = observeClaudeSubagentFrame(s, sys("task_notification", { task_id: id, status: "completed", summary: "" }), 10_000 + i);
  }
  s = foldClaudeSubagents(s);
  assert.equal(claudeSubagentSummary(s), null);
  s = observeClaudeSubagentFrame(s, level(...all.map((id) => agent(id))), 20_000);
  assert.equal(claudeSubagentSummary(s), null, "not one of them came back as running");
  assert.equal(s.retired.size, 100);
  // Bounded by the live set itself: once it stops naming them they are forgotten.
  s = observeClaudeSubagentFrame(s, level(), 20_001);
  assert.equal(s.retired.size, 0);
});

test("without a live set there is no stale membership to guard, so nothing is retained", () => {
  let s = emptyClaudeSubagents();
  for (let i = 0; i < 10; i += 1) {
    s = observeClaudeSubagentFrame(s, started(`fg${i}`, { is_backgrounded: false }), i);
    s = observeClaudeSubagentFrame(s, sys("task_notification", { task_id: `fg${i}`, status: "completed", summary: "" }), i);
  }
  assert.equal(s.levelSeen, false);
  assert.equal(s.retired.size, 0);
});

test("a resumed agent restarts as running even before the next turn folds its ended row", () => {
  let s = run([level(agent("a", { run_id: "r1" })), started("a", { is_backgrounded: true, run_id: "r1" })], emptyClaudeSubagents(), 100);
  s = observeClaudeSubagentFrame(s, sys("task_progress", { task_id: "a", run_id: "r1", last_tool_name: "Grep",
    usage: { total_tokens: 500, tool_uses: 7, duration_ms: 1 } }), 200);
  s = observeClaudeSubagentFrame(s, sys("task_notification", { task_id: "a", run_id: "r1", status: "failed", summary: "boom" }), 300);
  assert.deepEqual(states(s), { a: "failed" });

  // The same task id, a new run, before any fold.
  s = observeClaudeSubagentFrame(s, started("a", { is_backgrounded: true, run_id: "r2" }), 1_000);
  s = observeClaudeSubagentFrame(s, level(agent("a", { run_id: "r2" })), 1_001);
  const [entry] = claudeSubagentSummary(s)!.agents;
  assert.deepEqual(
    [entry!.state, entry!.startedAt, entry!.endedAt, entry!.toolUses, entry!.tokens, entry!.lastTool, entry!.summary],
    ["running", 1_000, null, null, null, null, null],
    "a new run starts clean rather than inheriting the failed run's state and counters",
  );

  // A late frame from the old run cannot end the new one.
  s = observeClaudeSubagentFrame(s, sys("task_notification", { task_id: "a", run_id: "r1", status: "completed", summary: "late" }), 1_100);
  assert.deepEqual(states(s), { a: "running" });
});

test("a later run named while the earlier one is still tracked as running starts clean", () => {
  const progress = (run: string, tools: number) => sys("task_progress", { task_id: "a", run_id: run,
    last_tool_name: "Grep", summary: `run ${run}`, usage: { total_tokens: tools * 100, tool_uses: tools, duration_ms: 1 } });
  let s = run([level(agent("a", { run_id: "r1" })), started("a", { is_backgrounded: true, run_id: "r1" })], emptyClaudeSubagents(), 100);
  s = observeClaudeSubagentFrame(s, progress("r1", 7), 200);
  assert.equal(claudeSubagentSummary(s)!.agents[0]!.toolUses, 7);

  // r1 never reported an end; the live set names r2 ahead of r2's start frame.
  s = observeClaudeSubagentFrame(s, level(agent("a", { run_id: "r2" })), 1_000);
  const fresh = claudeSubagentSummary(s)!.agents[0]!;
  assert.deepEqual(
    [fresh.state, fresh.startedAt, fresh.endedAt, fresh.toolUses, fresh.tokens, fresh.lastTool, fresh.summary, fresh.launchTurnId],
    ["running", 1_000, null, null, null, null, null, null],
    "the live set's later run does not inherit r1's clock or counters",
  );

  // Its start then fills in the launch, building on the r2 entry rather than resetting it again.
  s = observeClaudeSubagentFrame(s, started("a", { is_backgrounded: true, run_id: "r2" }), 1_050);
  const started2 = claudeSubagentSummary(s)!.agents[0]!;
  assert.deepEqual([started2.startedAt, started2.toolUses, started2.launchTurnId], [1_000, null, "toolu_a"]);

  // A late r1 frame changes nothing about r2.
  assert.equal(observeClaudeSubagentFrame(s, progress("r1", 9), 1_100), s);
});

test("a start naming a later run of a still-running task starts clean too", () => {
  let s = run([level(agent("a", { run_id: "r1" })), started("a", { is_backgrounded: true, run_id: "r1" })], emptyClaudeSubagents(), 100);
  s = observeClaudeSubagentFrame(s, sys("task_progress", { task_id: "a", run_id: "r1", last_tool_name: "Edit",
    usage: { total_tokens: 900, tool_uses: 4, duration_ms: 1 } }), 200);
  s = observeClaudeSubagentFrame(s, started("a", { is_backgrounded: true, run_id: "r2" }), 2_000);
  const entry = claudeSubagentSummary(s)!.agents[0]!;
  assert.deepEqual([entry.state, entry.startedAt, entry.toolUses, entry.tokens, entry.lastTool], ["running", 2_000, null, null, null]);
  // And the same run's own start, repeated, keeps building on it.
  s = observeClaudeSubagentFrame(s, sys("task_progress", { task_id: "a", run_id: "r2", usage: { total_tokens: 50, tool_uses: 1, duration_ms: 1 } }), 2_100);
  s = observeClaudeSubagentFrame(s, started("a", { is_backgrounded: true, run_id: "r2" }), 2_200);
  assert.deepEqual([claudeSubagentSummary(s)!.agents[0]!.startedAt, claudeSubagentSummary(s)!.agents[0]!.toolUses], [2_000, 1]);
});

test("a late start from an earlier run cannot roll a running task back to that run", () => {
  // r1 ran first, so its id is a run this task has already been seen in; then r2 takes over.
  let s = run([level(agent("a", { run_id: "r1" })), started("a", { is_backgrounded: true, run_id: "r1" })], emptyClaudeSubagents(), 50);
  s = observeClaudeSubagentFrame(s, level(agent("a", { run_id: "r2" })), 100);
  s = observeClaudeSubagentFrame(s, started("a", { is_backgrounded: true, run_id: "r2" }), 100);
  s = observeClaudeSubagentFrame(s, sys("task_progress", { task_id: "a", run_id: "r2", last_tool_name: "Edit",
    usage: { total_tokens: 300, tool_uses: 3, duration_ms: 1 } }), 200);
  // r1's start arrives late, while r2 runs: it changes nothing at all.
  assert.equal(observeClaudeSubagentFrame(s, started("a", { is_backgrounded: true, run_id: "r1" }), 300), s);
  s = observeClaudeSubagentFrame(s, started("a", { is_backgrounded: true, run_id: "r1" }), 300);
  // So r1's own late completion cannot end r2 either.
  s = observeClaudeSubagentFrame(s, sys("task_notification", { task_id: "a", run_id: "r1", status: "completed", summary: "old" }), 400);
  const entry = claudeSubagentSummary(s)!.agents[0]!;
  assert.deepEqual([entry.state, entry.toolUses, entry.summary], ["running", 3, null]);
  assert.equal(subagentActivityLine({ state: "idle", subagents: claudeSubagentSummary(s)! }), "idle · 1 agent still running");
});

test("runs are told apart by identity, not by how their ids sort", () => {
  // `r10` sorts before `r9` as text. It is still a new run of the agent that finished r9.
  let s = run([level(agent("a", { run_id: "r9" })), started("a", { is_backgrounded: true, run_id: "r9" })], emptyClaudeSubagents(), 100);
  s = observeClaudeSubagentFrame(s, sys("task_notification", { task_id: "a", run_id: "r9", status: "completed", summary: "" }), 200);
  // The live set still lists a; then it and the start report r10.
  s = observeClaudeSubagentFrame(s, level(agent("a", { run_id: "r10" })), 300);
  s = observeClaudeSubagentFrame(s, started("a", { is_backgrounded: true, run_id: "r10" }), 301);
  const entry = claudeSubagentSummary(s)!.agents[0]!;
  assert.deepEqual([entry.state, entry.startedAt, entry.endedAt], ["running", 300, null]);
  // r9's frames are now late, wherever r9 sorts.
  s = observeClaudeSubagentFrame(s, sys("task_notification", { task_id: "a", run_id: "r9", status: "failed", summary: "late" }), 400);
  assert.deepEqual(states(s), { a: "running" });
  assert.equal(observeClaudeSubagentFrame(s, started("a", { is_backgrounded: true, run_id: "r9" }), 500), s);

  // The same holds for a start that reaches a folded agent first, and for opaque ids.
  let t = run([level(agent("b", { run_id: "zz-old" })), started("b", { is_backgrounded: true, run_id: "zz-old" })]);
  t = observeClaudeSubagentFrame(t, sys("task_notification", { task_id: "b", run_id: "zz-old", status: "completed", summary: "" }), 2);
  t = foldClaudeSubagents(t);
  t = observeClaudeSubagentFrame(t, started("b", { is_backgrounded: true, run_id: "aa-new" }), 3);
  assert.deepEqual(states(t), { b: "running" });
  assert.deepEqual(t.tasks.get("b")!.pastRuns, ["zz-old"], "the folded run is remembered as past");
});

test("a task remembers every run it has had, so a very late frame stays late", () => {
  // Twenty runs of one task, each ending and resuming while the live set names it.
  const runs = Array.from({ length: 20 }, (_, i) => `run-${String(i).padStart(2, "0")}`);
  let s = run([level(agent("a", { run_id: runs[0] })), started("a", { is_backgrounded: true, run_id: runs[0] })]);
  for (const [i, r] of runs.slice(1).entries()) {
    s = observeClaudeSubagentFrame(s, sys("task_notification", { task_id: "a", run_id: runs[i], status: "completed", summary: "" }), 10 + i);
    s = observeClaudeSubagentFrame(s, started("a", { is_backgrounded: true, run_id: r }), 11 + i);
  }
  assert.equal(s.tasks.get("a")!.runId, runs[19]);
  assert.equal(s.tasks.get("a")!.pastRuns.length, 19);
  // The very first run's start, arriving now, is still recognised as late.
  assert.equal(observeClaudeSubagentFrame(s, started("a", { is_backgrounded: true, run_id: runs[0] }), 100), s);
  assert.deepEqual(states(s), { a: "running" });
});

test("foreground agents the live set never names leave nothing behind", () => {
  let s = run([level(agent("bg")), started("bg", { is_backgrounded: true })]);
  for (let i = 0; i < 50; i += 1) {
    s = observeClaudeSubagentFrame(s, started(`fg${i}`, { is_backgrounded: false }), 10 + i);
    s = observeClaudeSubagentFrame(s, sys("task_notification", { task_id: `fg${i}`, status: "completed", summary: "" }), 10 + i);
  }
  assert.equal(s.retired.size, 0, "no guard for agents the live set does not name");
  assert.deepEqual([...s.tasks.keys()], ["bg"]);
  // And a late start for one of them still cannot count it: the live set does not name it.
  assert.equal(observeClaudeSubagentFrame(s, started("fg3", { is_backgrounded: true }), 100).tasks.get("fg3")?.shown ?? false, false);
});

test("after a restart reported without a run id, late frames from the named runs before it stay late", () => {
  let s = run([level(agent("a", { run_id: "r1" })), started("a", { is_backgrounded: true, run_id: "r1" })], emptyClaudeSubagents(), 100);
  s = observeClaudeSubagentFrame(s, sys("task_notification", { task_id: "a", run_id: "r1", status: "completed", summary: "" }), 200);
  s = observeClaudeSubagentFrame(s, level(), 300);
  // It rejoins the set with no run id: a new run, whose own id is unknown.
  s = observeClaudeSubagentFrame(s, level(agent("a")), 400);
  assert.deepEqual([s.tasks.get("a")!.runId, s.tasks.get("a")!.pastRuns], [null, ["r1"]]);
  assert.deepEqual(states(s), { a: "running" });
  // A late r1 notification, progress or start cannot touch the new run.
  for (const late of [
    sys("task_notification", { task_id: "a", run_id: "r1", status: "completed", summary: "late" }),
    sys("task_progress", { task_id: "a", run_id: "r1", usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 } }),
    started("a", { is_backgrounded: true, run_id: "r1" }),
  ]) {
    assert.equal(observeClaudeSubagentFrame(s, late, 500), s);
  }
  assert.equal(subagentActivityLine({ state: "idle", subagents: claudeSubagentSummary(s)! }), "idle · 1 agent still running");
});

test("a repeated start for the run that already ended does not revive it", () => {
  let s = run([level(agent("a", { run_id: "r1" })), started("a", { is_backgrounded: true, run_id: "r1" })]);
  s = observeClaudeSubagentFrame(s, sys("task_notification", { task_id: "a", run_id: "r1", status: "completed", summary: "" }), 2);
  assert.equal(observeClaudeSubagentFrame(s, started("a", { is_backgrounded: true, run_id: "r1" }), 3), s);
  s = foldClaudeSubagents(s);
  assert.equal(observeClaudeSubagentFrame(s, started("a", { is_backgrounded: true, run_id: "r1" }), 4), s);
  assert.deepEqual(s.retired.get("a"), { runId: "r1", pastRuns: [] });
});

test("a live set naming a later run of a folded agent brings it back before its start arrives", () => {
  let s = run([level(agent("a", { run_id: "r1" })), started("a", { is_backgrounded: true, run_id: "r1" })]);
  s = observeClaudeSubagentFrame(s, sys("task_notification", { task_id: "a", run_id: "r1", status: "completed", summary: "" }), 2);
  s = foldClaudeSubagents(s);
  // Still the old run: late, so it stays folded.
  s = observeClaudeSubagentFrame(s, level(agent("a", { run_id: "r1" })), 3);
  assert.equal(claudeSubagentSummary(s), null);
  // A later run joins the set ahead of its task_started.
  s = observeClaudeSubagentFrame(s, level(agent("a", { run_id: "r2" })), 4);
  assert.deepEqual(states(s), { a: "running" });
  assert.equal(s.retired.has("a"), false);
});

test("an ambient agent that ends is dropped at once rather than held until the next turn", () => {
  let s = run([level(agent("a"), agent("b")), started("a", { is_backgrounded: true }), started("b", { is_backgrounded: true })]);
  // `a` turns out to be housekeeping, then ends; `b` is real work and keeps running.
  s = observeClaudeSubagentFrame(s, level(agent("a", { ambient: true }), agent("b")), 2);
  s = observeClaudeSubagentFrame(s, sys("task_notification", { task_id: "a", status: "completed", summary: "" }), 3);
  assert.equal(s.tasks.has("a"), false, "no hidden finished entry is left to accumulate");
  assert.deepEqual(states(s), { b: "running" });
  assert.equal(claudeSubagentSummary(s)!.finishedFolded, 0, "an ambient agent is never counted as finished");
  // And its id stays guarded while the live set still names it.
  s = observeClaudeSubagentFrame(s, level(agent("a"), agent("b")), 4);
  assert.deepEqual(states(s), { b: "running" });
});

test("once the live set has dropped an agent, a late start cannot bring it back", () => {
  // Folded after the live set dropped it: the guard is spent, so only live membership stops it.
  let s = run([level(agent("a"), agent("b")), started("a", { is_backgrounded: true }), started("b", { is_backgrounded: true })]);
  s = observeClaudeSubagentFrame(s, sys("task_notification", { task_id: "a", status: "completed", summary: "" }), 2);
  s = observeClaudeSubagentFrame(s, level(agent("b")), 3);
  s = foldClaudeSubagents(s);
  s = observeClaudeSubagentFrame(s, level(agent("b")), 4);
  assert.equal(s.retired.has("a"), false);
  s = observeClaudeSubagentFrame(s, started("a", { is_backgrounded: true }), 5);
  assert.deepEqual(states(s), { b: "running" }, "a delayed start does not count it");
  assert.deepEqual(subagentCounts(claudeSubagentSummary(s)).running, 1);
  // The next live set, still without it, clears the hidden leftover too.
  s = observeClaudeSubagentFrame(s, level(agent("b")), 6);
  assert.equal(s.tasks.has("a"), false);

  // Ended and still listed dimmed, with no run ids: a repeated start does not revive it either.
  let t = run([level(agent("c")), started("c", { is_backgrounded: true })]);
  t = observeClaudeSubagentFrame(t, sys("task_notification", { task_id: "c", status: "failed", summary: "" }), 2);
  t = observeClaudeSubagentFrame(t, level(), 3);
  assert.equal(observeClaudeSubagentFrame(t, started("c", { is_backgrounded: true }), 4), t);
  assert.deepEqual(states(t), { c: "failed" });
});

test("a start that beats its agent into the live set stays hidden until the set names it", () => {
  let s = run([level(agent("a")), started("a", { is_backgrounded: true })]);
  s = observeClaudeSubagentFrame(s, started("b", { is_backgrounded: true, description: "early" }), 2);
  assert.deepEqual(states(s), { a: "running" }, "not counted on the edge alone");
  s = observeClaudeSubagentFrame(s, level(agent("a"), agent("b")), 3);
  assert.deepEqual(states(s), { a: "running", b: "running" });
  assert.equal(claudeSubagentSummary(s)!.agents.find((x) => x.id === "b")!.launchTurnId, "toolu_b", "its detail was kept");
});

test("a foreground agent moved to the background counts only once the live set names it", () => {
  let s = run([level(agent("a")), started("a", { is_backgrounded: true }), started("fg", { is_backgrounded: false })]);
  s = observeClaudeSubagentFrame(s, sys("task_updated", { task_id: "fg", patch: { is_backgrounded: true } }), 2);
  assert.deepEqual(states(s), { a: "running" });
  s = observeClaudeSubagentFrame(s, level(agent("a"), agent("fg")), 3);
  assert.deepEqual(states(s), { a: "running", fg: "running" });
});

test("without run ids, an ended agent the live set re-lists after dropping it is a new run", () => {
  let s = run([level(agent("a")), started("a", { is_backgrounded: true })], emptyClaudeSubagents(), 100);
  s = observeClaudeSubagentFrame(s, sys("task_progress", { task_id: "a", usage: { total_tokens: 9, tool_uses: 4, duration_ms: 1 } }), 150);
  s = observeClaudeSubagentFrame(s, sys("task_notification", { task_id: "a", status: "completed", summary: "" }), 200);
  // Still listed after its end: a late listing, not a rejoin.
  s = observeClaudeSubagentFrame(s, level(agent("a")), 250);
  assert.deepEqual(states(s), { a: "completed" });
  s = observeClaudeSubagentFrame(s, level(), 300);
  // Resumed: its start arrives while the set does not name it (ignored), then the set names it.
  s = observeClaudeSubagentFrame(s, started("a", { is_backgrounded: true }), 400);
  assert.deepEqual(states(s), { a: "completed" });
  s = observeClaudeSubagentFrame(s, level(agent("a")), 500);
  const entry = claudeSubagentSummary(s)!.agents[0]!;
  assert.deepEqual([entry.state, entry.startedAt, entry.endedAt, entry.toolUses], ["running", 500, null, null]);
});

test("an agent its start marked ambient stays hidden when the live set omits the flag", () => {
  let s = run([level(agent("a")), started("a", { is_backgrounded: true })]);
  // The start says `h` is housekeeping; the live set then names it without the field.
  s = observeClaudeSubagentFrame(s, started("h", { is_backgrounded: true, ambient: true, run_id: "r1" }), 2);
  s = observeClaudeSubagentFrame(s, level(agent("a"), agent("h", { run_id: "r1" })), 3);
  assert.deepEqual(states(s), { a: "running" });
  assert.equal(subagentActivityLine({ state: "idle", subagents: claudeSubagentSummary(s)! }), "idle · 1 agent still running");
  // A genuinely new run of that id starts with a fresh classification.
  s = observeClaudeSubagentFrame(s, level(agent("a"), agent("h", { run_id: "r2" })), 4);
  assert.deepEqual(states(s), { a: "running", h: "running" });
});

test("a run the live set marked ambient stays hidden when a later live set omits the flag", () => {
  // Flagged by the set before any start, then named again without the field: same run, still hidden.
  let s = run([level(agent("a"), agent("h", { ambient: true, run_id: "r1" })), started("a", { is_backgrounded: true })]);
  s = observeClaudeSubagentFrame(s, level(agent("a"), agent("h", { run_id: "r1" })), 2);
  assert.deepEqual(states(s), { a: "running" });
  assert.equal(subagentActivityLine({ state: "idle", subagents: claudeSubagentSummary(s)! }), "idle · 1 agent still running");
  // And with no run ids at all, the same holds: nothing says it is a new run.
  let t = run([level(agent("h", { ambient: true }))]);
  t = observeClaudeSubagentFrame(t, level(agent("h")), 2);
  t = observeClaudeSubagentFrame(t, started("h", { is_backgrounded: true }), 3);
  assert.equal(claudeSubagentSummary(t), null);
});

test("a new run of an agent once marked ambient starts unclassified", () => {
  // Through its start: r2 is not housekeeping just because r1 was.
  let s = run([level(agent("h", { ambient: true, run_id: "r1" }))]);
  s = observeClaudeSubagentFrame(s, started("h", { is_backgrounded: true, run_id: "r2" }), 2);
  assert.deepEqual(states(s), { h: "running" });
  // Through the live set: r2 named without the flag shows too.
  let t = run([level(agent("h", { ambient: true, run_id: "r1" }))]);
  t = observeClaudeSubagentFrame(t, level(agent("h", { run_id: "r2" })), 2);
  assert.deepEqual(states(t), { h: "running" });
});

test("a no-op frame returns the same state object", () => {
  const s = run([level(agent("a")), started("a", { is_backgrounded: true })]);
  assert.equal(observeClaudeSubagentFrame(s, sys("task_progress", { task_id: "unknown", usage: {} }), 1), s);
  assert.equal(observeClaudeSubagentFrame(s, { type: "assistant" }, 1), s);
  assert.equal(foldClaudeSubagents(s), s);
});

test("the list is capped, running first, then the newest finished", () => {
  const n = SUBAGENT_LIMIT + 3;
  const all = Array.from({ length: n }, (_, i) => `t${i}`);
  let s = run([level(...all.map((id) => agent(id))), ...all.map((id) => started(id, { is_backgrounded: true }))]);
  // Finish all but two, oldest first.
  for (const [i, id] of all.slice(0, n - 2).entries()) {
    s = observeClaudeSubagentFrame(s, sys("task_notification", { task_id: id, status: "completed", summary: "" }), 10_000 + i);
  }
  const summary = claudeSubagentSummary(s)!;
  assert.equal(summary.agents.length, SUBAGENT_LIMIT);
  assert.deepEqual(summary.agents.slice(0, 2).map((a) => a.state), ["running", "running"]);
  assert.equal(summary.agents[2]!.id, all[n - 3]);
  assert.equal(summary.finishedFolded, n - SUBAGENT_LIMIT);
});

test("an agent that turns ambient leaves the list without counting as stopped", () => {
  let s = run([level(agent("a")), started("a", { is_backgrounded: true })]);
  s = observeClaudeSubagentFrame(s, level(agent("a", { ambient: true })), 2);
  assert.equal(claudeSubagentSummary(s), null);
});

// ---- the coalescing emitter (F5) -----------------------------------------------------

function fakeClock() {
  let now = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      const t = { at: now + ms, fn, id: nextId++ };
      timers.push(t);
      return t.id;
    },
    clearTimeout: (id: unknown) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    /** Timers still waiting to fire. */
    pending: () => timers.length,
    advance(ms: number) {
      now += ms;
      for (const t of [...timers].sort((a, b) => a.at - b.at)) {
        if (t.at <= now) {
          timers.splice(timers.indexOf(t), 1);
          t.fn();
        }
      }
    },
  };
}

const entry = (over: Partial<SubagentEntry> = {}): SubagentEntry => ({
  id: "a", type: "Explore", description: "d", state: "running", startedAt: 0, endedAt: null,
  toolUses: 1, tokens: 1, lastTool: null, summary: null, launchTurnId: null, ...over,
});
const summaryOf = (...agents: SubagentEntry[]): SubagentSummary => ({ agents, finishedFolded: 0 });

test("membership and state changes emit at once; counters at most once per interval", () => {
  const clock = fakeClock();
  const sent: (SubagentSummary | null)[] = [];
  const emitter = new SubagentEmitter((s) => sent.push(s), 5_000, clock);
  emitter.update(summaryOf(entry()));
  assert.equal(sent.length, 1);
  clock.advance(1_000);
  emitter.update(summaryOf(entry({ toolUses: 2 })));
  emitter.update(summaryOf(entry({ toolUses: 3 })));
  assert.equal(sent.length, 1, "counter-only change waits");
  clock.advance(4_000);
  assert.equal(sent.length, 2);
  assert.equal(sent[1]!.agents[0]!.toolUses, 3, "the latest counters go out");
  clock.advance(1_000);
  emitter.update(summaryOf(entry({ toolUses: 3, state: "completed", endedAt: 6_000 })));
  assert.equal(sent.length, 3, "a state change is not held");
  emitter.update(null);
  assert.deepEqual(sent.at(-1), null);
  emitter.update(null);
  assert.equal(sent.length, 4, "nothing moved, nothing sent");
});

test("a new run under the same task id is sent at once, not held as a counter change", () => {
  const clock = fakeClock();
  const sent: (SubagentSummary | null)[] = [];
  const emitter = new SubagentEmitter((s) => sent.push(s), 5_000, clock);
  emitter.update(summaryOf(entry({ startedAt: 0, toolUses: 9 })));
  clock.advance(1_000);
  // Same id, type, description and launch id; a fresh start and cleared counters.
  emitter.update(summaryOf(entry({ startedAt: 1_000, toolUses: null, tokens: null })));
  assert.equal(sent.length, 2, "the replacement run reached the board immediately");
  assert.equal(sent[1]!.agents[0]!.startedAt, 1_000);
});

test("a pending counter send is dropped when its change is undone", () => {
  const clock = fakeClock();
  const sent: (SubagentSummary | null)[] = [];
  const emitter = new SubagentEmitter((s) => sent.push(s), 5_000, clock);
  emitter.update(summaryOf(entry()));
  clock.advance(1_000);
  emitter.update(summaryOf(entry({ tokens: 9 })));
  assert.equal(clock.pending(), 1, "the counter change is held");
  // Back to exactly what was last sent: the held send has nothing left to say, so it is
  // cancelled outright rather than left to wake up and find nothing.
  emitter.update(summaryOf(entry()));
  assert.equal(clock.pending(), 0);
  clock.advance(10_000);
  assert.equal(sent.length, 1);
  // And the next counter change waits its own interval rather than riding a stale timer.
  emitter.update(summaryOf(entry({ tokens: 10 })));
  assert.equal(sent.length, 2, "the interval since the last send has already elapsed");
  assert.equal(sent[1]!.agents[0]!.tokens, 10);
});

test("a pending counter send is dropped when the driver ends", () => {
  const clock = fakeClock();
  const sent: (SubagentSummary | null)[] = [];
  const emitter = new SubagentEmitter((s) => sent.push(s), 5_000, clock);
  emitter.update(summaryOf(entry()));
  emitter.update(summaryOf(entry({ tokens: 9 })));
  emitter.dispose();
  clock.advance(10_000);
  assert.equal(sent.length, 1);
});

// ---- shared selectors ----------------------------------------------------------------

test("the idle line reads only for a parked parent with agents still running", () => {
  const subagents = summaryOf(entry({ id: "a" }), entry({ id: "b" }), entry({ id: "c", state: "completed", endedAt: 5 }));
  assert.equal(subagentActivityLine({ state: "idle", subagents }), "idle · 2 agents still running");
  assert.equal(subagentActivityLine({ state: "awaiting_input", subagents }), "idle · 2 agents still running");
  assert.equal(subagentActivityLine({ state: "awaiting_review", subagents }), "idle · 2 agents still running");
  assert.equal(
    subagentActivityLine({ state: "idle", subagents: summaryOf(entry()) }),
    "idle · 1 agent still running",
  );
  assert.equal(subagentActivityLine({ state: "working", subagents }), null);
  assert.equal(subagentActivityLine({ state: "idle", subagents: summaryOf(entry({ state: "failed", endedAt: 1 })) }), null);
  assert.equal(subagentActivityLine({ state: "idle" }), null);
  assert.deepEqual(subagentCounts(subagents), { running: 2, finished: 1, folded: 0, listed: 3, atLeast: false });
  assert.equal(hasSubagents(undefined), false);
  assert.equal(hasSubagents({ agents: [], finishedFolded: 0 }), false);
});

test("past the list limit the running count reads as a floor, never as fewer than are running", () => {
  // Thirteen running: the summary carries twelve, and the line must not claim exactly twelve.
  const ids13 = Array.from({ length: SUBAGENT_LIMIT + 1 }, (_, i) => `r${i}`);
  const s = run([level(...ids13.map((id) => agent(id))), ...ids13.map((id) => started(id, { is_backgrounded: true }))]);
  const summary = claudeSubagentSummary(s)!;
  assert.equal(summary.agents.length, SUBAGENT_LIMIT);
  assert.equal(subagentCounts(summary).atLeast, true);
  assert.equal(subagentActivityLine({ state: "idle", subagents: summary }), "idle · 12+ agents still running");
  const tree = renderToStaticMarkup(createElement(SubagentTree, { session: mkSession({ subagents: summary }) }));
  assert.match(tree, /12\+ sub-agents · 12\+ running/);

  // A list with a finished agent in it holds every running one, so its count stays exact.
  const exact = summaryOf(
    ...Array.from({ length: SUBAGENT_LIMIT - 1 }, (_, i) => entry({ id: `x${i}` })),
    entry({ id: "done", state: "completed", endedAt: 5 }),
  );
  assert.equal(subagentCounts(exact).atLeast, false);
  assert.equal(subagentActivityLine({ state: "idle", subagents: exact }), "idle · 11 agents still running");
  assert.equal(subagentCountLabel(1, false), "1");
});

// ---- the board tree -----------------------------------------------------------------

test("the tree draws nothing for a session without background agents", () => {
  assert.equal(renderToStaticMarkup(createElement(SubagentTree, { session: mkSession() })), "");
});

test("the tree shows three rows, folds the rest behind +N more, and counts folded agents", () => {
  const agents = [
    entry({ id: "1", type: "Explore", description: "Map call sites", toolUses: 18, lastTool: "Grep" }),
    entry({ id: "2", type: "general-purpose", description: "Convert billing", toolUses: 6, lastTool: "Edit" }),
    entry({ id: "3", state: "completed", description: "Find tests", endedAt: 65_000 }),
    entry({ id: "4" }),
    entry({ id: "5" }),
  ];
  const html = renderToStaticMarkup(createElement(SubagentTree, {
    session: mkSession({ name: "ledger", subagents: { agents, finishedFolded: 2 } }),
  }));
  assert.match(html, /aria-label="Background sub-agents of ledger"/);
  assert.match(html, /5 sub-agents · 4 running/);
  assert.equal((html.match(/class="st-row is-/g) ?? []).length, 3);
  assert.match(html, /class="st-row is-completed"/);
  assert.match(html, /<span class="st-end">done<\/span>/);
  assert.match(html, /\+2 more/);
  assert.match(html, /2 finished/);
});

test("each way an agent ends draws its own state class and word, and a running row draws none", () => {
  const html = renderToStaticMarkup(createElement(SubagentTree, {
    session: mkSession({
      name: "ends",
      subagents: {
        agents: [
          entry({ id: "r", description: "Still going" }),
          entry({ id: "f", description: "Broke", state: "failed", endedAt: 2_000 }),
          entry({ id: "s", description: "Halted", state: "stopped", endedAt: 1_000 }),
        ],
        finishedFolded: 0,
      },
    }),
  }));
  const row = (description: string): string =>
    html.match(new RegExp(`<li class="st-row is-[a-z]+">(?:(?!</li>).)*${description}(?:(?!</li>).)*</li>`))?.[0] ?? "";
  assert.match(row("Broke"), /^<li class="st-row is-failed">/);
  assert.match(row("Broke"), /<span class="st-end">failed<\/span>/);
  assert.match(row("Halted"), /^<li class="st-row is-stopped">/);
  assert.match(row("Halted"), /<span class="st-end">stopped<\/span>/);
  assert.match(row("Still going"), /^<li class="st-row is-running">/);
  assert.doesNotMatch(row("Still going"), /st-end/);
});

test("a row omits what its source did not report instead of drawing a zero", () => {
  const degraded = entry({ startedAt: 0, endedAt: null, toolUses: null, tokens: null, lastTool: null });
  assert.equal(subagentRowDetail(degraded, 48_000), "48s");
  assert.equal(subagentRowDetail(entry({ startedAt: 0, toolUses: 18, lastTool: "Grep" }), 134_000), "2m 14s · 18 tools · Grep");
  assert.equal(subagentRowDetail(entry({ startedAt: 0, endedAt: 65_000, toolUses: 1 }), 999_000), "1m 05s · 1 tool");
});
