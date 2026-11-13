import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { HookIngest } from "../src/shared/protocol.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";

// A terminal session's background sub-agents, from its hooks.
//
// Three layers, each pinned on its own: the harness-neutral reducer (`hook-subagents.ts`), each
// harness's reading of its own events into that reducer's signals (`HookSpec.subagentSignals`),
// and the registry, which applies them to terminal sessions only and leaves an SDK session's
// summary to its driver.

const home = mkdtempSync(join(tmpdir(), "mission-hook-subagents-"));
process.env.MISSION_HOME = home;
const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { HookIngestSchema } = await import("../src/shared/protocol.ts");
const { claudeHooks } = await import("../src/server/harness/claude/hooks.ts");
const { codexHooks } = await import("../src/server/harness/codex/hooks.ts");
const { piHooks } = await import("../src/server/harness/pi/hooks.ts");
const { emptyHookSubagents, hookSubagentSummary, reduceHookSubagents } = await import(
  "../src/server/harness/hook-subagents.ts"
);
const { SUBAGENT_LIMIT, subagentActivityLine } = await import("../src/shared/subagents.ts");
const { HOOK_BACKGROUND_TASKS_MAX, backgroundTaskList, backgroundTasksTruncated } = await import(
  "../src/shared/hook-subagents.mjs"
);
after(() => rmSync(home, { recursive: true, force: true }));
openDb();

type Signal = Parameters<typeof reduceHookSubagents>[1][number];

function run(steps: [Signal | Signal[], number][]) {
  let state = emptyHookSubagents();
  for (const [signals, at] of steps) state = reduceHookSubagents(state, Array.isArray(signals) ? signals : [signals], at);
  return state;
}

const launched = (id: string, type: string | null = "Explore", description: string | null = null): Signal => ({
  kind: "launched", id, type, description,
});

// --- the reducer ---------------------------------------------------------------------------

test("a launched agent is a degraded row: type, state and start, and every counter null", () => {
  const summary = hookSubagentSummary(run([[launched("a", "Explore", "Map call sites"), 1_000]]));
  assert.deepEqual(summary, {
    agents: [{
      id: "a", type: "Explore", description: "Map call sites", state: "running", startedAt: 1_000, endedAt: null,
      toolUses: null, tokens: null, lastTool: null, summary: null, launchTurnId: null,
    }],
    finishedFolded: 0,
  });
});

test("a started agent is not counted until it is known to be in the background", () => {
  const started = run([[{ kind: "started", id: "a", type: "Plan" }, 500]]);
  assert.equal(hookSubagentSummary(started), null, "a foreground agent blocks the parent; it never shows");
  // Moved to the background later: counted from the launch, but it keeps its real start and type.
  const after = reduceHookSubagents(started, [launched("a", null, "Plan the work")], 2_000);
  const [row] = hookSubagentSummary(after)!.agents;
  assert.equal(row?.startedAt, 500);
  assert.equal(row?.type, "Plan");
  // A foreground agent that just ends leaves nothing behind.
  assert.equal(hookSubagentSummary(reduceHookSubagents(started, [{ kind: "ended", id: "a", type: "Plan" }], 900)), null);
});

test("an end marks it completed and dated; nothing revives it", () => {
  let state = run([[launched("a"), 1_000], [{ kind: "ended", id: "a", type: "Explore" }, 4_000]]);
  assert.deepEqual(
    hookSubagentSummary(state)!.agents.map((a) => [a.state, a.endedAt]),
    [["completed", 4_000]],
  );
  // A late launch, or a late live set still listing it, is not a new start.
  state = reduceHookSubagents(state, [launched("a")], 4_100);
  state = reduceHookSubagents(state, [{ kind: "live", agents: [{ id: "a", type: null, description: null }] }], 4_200);
  assert.equal(hookSubagentSummary(state)!.agents[0]?.state, "completed");
});

test("an end that lands before its launch keeps the agent out", () => {
  const state = run([[{ kind: "ended", id: "fast", type: null }, 1_000], [launched("fast"), 900]]);
  assert.equal(hookSubagentSummary(state), null);
});

test("the live set adds agents no launch announced and stops the ones that left it", () => {
  let state = run([[launched("a"), 1_000], [launched("b"), 1_100]]);
  state = reduceHookSubagents(state, [{
    kind: "live",
    agents: [
      { id: "b", type: null, description: "Convert billing" },
      { id: "c", type: "general-purpose", description: "Lost launch" },
    ],
  }], 2_000);
  const rows = hookSubagentSummary(state)!.agents;
  assert.deepEqual(rows.map((r) => [r.id, r.state]), [["b", "running"], ["c", "running"], ["a", "stopped"]]);
  assert.equal(rows.find((r) => r.id === "b")?.description, "Convert billing", "fills what it did not know");
  // Its real end, arriving later, wins over the inferred stop.
  state = reduceHookSubagents(state, [{ kind: "ended", id: "a", type: null }], 2_100);
  assert.equal(hookSubagentSummary(state)!.agents.find((r) => r.id === "a")?.state, "completed");
});

test("a cut-short live set adds what it lists and stops nothing it omits", () => {
  let state = run([[launched("a"), 1_000], [launched("b"), 1_100]]);
  state = reduceHookSubagents(state, [{
    kind: "live", partial: true, agents: [{ id: "c", type: "Explore", description: null }],
  }], 2_000);
  assert.deepEqual(
    hookSubagentSummary(state)!.agents.map((r) => [r.id, r.state]),
    [["a", "running"], ["b", "running"], ["c", "running"]],
  );
  assert.equal(state.ended.size, 0, "nothing omitted is recorded as ended");
  // A complete set afterwards still stops what it omits.
  state = reduceHookSubagents(state, [{ kind: "live", agents: [{ id: "b", type: null, description: null }] }], 3_000);
  assert.deepEqual(
    hookSubagentSummary(state)!.agents.map((r) => `${r.id}:${r.state}`).sort(),
    ["a:stopped", "b:running", "c:stopped"],
  );
});

test("a live set taken before an agent was counted does not stop it", () => {
  const state = run([[launched("late"), 3_000], [{ kind: "live", agents: [] }, 2_500]]);
  assert.equal(hookSubagentSummary(state)!.agents[0]?.state, "running");
});

test("the next turn folds finished agents, and with nothing running the count goes too", () => {
  let state = run([[launched("a"), 1], [launched("b"), 2], [{ kind: "ended", id: "a", type: null }, 3]]);
  state = reduceHookSubagents(state, [{ kind: "fold" }], 4);
  assert.deepEqual(hookSubagentSummary(state), {
    agents: [hookSubagentSummary(state)!.agents[0]!],
    finishedFolded: 1,
  });
  assert.equal(hookSubagentSummary(state)!.agents[0]?.id, "b");
  state = reduceHookSubagents(state, [{ kind: "ended", id: "b", type: null }], 5);
  state = reduceHookSubagents(state, [{ kind: "fold" }], 6);
  assert.equal(hookSubagentSummary(state), null, "all done and acknowledged looks as it did before");
});

test("a reset forgets everything, including what had ended", () => {
  let state = run([[launched("a"), 1], [{ kind: "ended", id: "b", type: null }, 2]]);
  state = reduceHookSubagents(state, [{ kind: "reset" }], 3);
  assert.equal(hookSubagentSummary(state), null);
  // `b` may start again under the new process.
  state = reduceHookSubagents(state, [launched("b")], 4);
  assert.equal(hookSubagentSummary(state)!.agents[0]?.id, "b");
});

test("a hook from the previous process, landing after the new process starts, is ignored", () => {
  // The new process starts at 1000; the old process's last hooks were stamped before it.
  let state = run([[launched("old-a"), 500], [{ kind: "reset" }, 1_000]]);
  assert.equal(hookSubagentSummary(state), null);
  const stale: [Signal, number][] = [
    [{ kind: "live", agents: [{ id: "old-a", type: "Explore", description: null }, { id: "old-b", type: null, description: null }] }, 900],
    [launched("old-c"), 950],
    [{ kind: "started", id: "old-d", type: "Plan" }, 960],
  ];
  for (const [signal, at] of stale) state = reduceHookSubagents(state, [signal], at);
  assert.equal(hookSubagentSummary(state), null, "nothing from the previous process comes back");
  assert.equal(state.started.size, 0);

  // The new process's own agents count; an old end or fold cannot touch them.
  state = reduceHookSubagents(state, [launched("new-a")], 1_100);
  state = reduceHookSubagents(state, [{ kind: "ended", id: "new-a", type: null }], 990);
  state = reduceHookSubagents(state, [{ kind: "fold" }], 995);
  assert.deepEqual(hookSubagentSummary(state)!.agents.map((a) => [a.id, a.state]), [["new-a", "running"]]);
  // A reset older than the newest one is itself stale.
  state = reduceHookSubagents(state, [{ kind: "reset" }], 800);
  assert.deepEqual(hookSubagentSummary(state)!.agents.map((a) => a.id), ["new-a"]);
  // A signal stamped at the reset's own instant belongs to the new process.
  assert.equal(hookSubagentSummary(run([[{ kind: "reset" }, 1_000], [launched("same-ms"), 1_000]]))!.agents[0]?.id, "same-ms");
});

test("a reset that lands late keeps what the new process already reported", () => {
  // The new process starts at 1000, but its launch and an end are ingested before its SessionStart.
  let state = run([
    [launched("old"), 500],
    [{ kind: "ended", id: "old-done", type: null }, 600],
    [launched("new-a"), 1_010],
    [{ kind: "ended", id: "new-gone", type: null }, 1_020],
    [{ kind: "reset" }, 1_000],
  ]);
  assert.deepEqual(hookSubagentSummary(state)!.agents.map((a) => [a.id, a.state]), [["new-a", "running"]]);
  assert.equal(state.ended.has("old-done"), false, "the previous process's ends are forgotten");
  assert.equal(state.ended.has("new-gone"), true, "an end stamped after the reset is kept");
  // So a late launch for the agent that already ended under the new process stays out.
  state = reduceHookSubagents(state, [launched("new-gone")], 1_030);
  assert.deepEqual(hookSubagentSummary(state)!.agents.map((a) => a.id), ["new-a"]);
});

test("a stop stamped before the operator's next prompt folds at once when it lands late", () => {
  // The prompt at 300 is ingested before a SubagentStop stamped at 250.
  let state = run([[launched("a"), 100], [launched("b"), 110], [{ kind: "fold" }, 300]]);
  state = reduceHookSubagents(state, [{ kind: "ended", id: "a", type: null }], 250);
  assert.deepEqual(hookSubagentSummary(state), {
    agents: [hookSubagentSummary(state)!.agents[0]!],
    finishedFolded: 1,
  });
  assert.equal(hookSubagentSummary(state)!.agents[0]?.id, "b", "only the still-running agent is listed");
  // A live set stamped before the fold that drops `b` folds it too; nothing runs, so the count goes.
  state = reduceHookSubagents(state, [{ kind: "live", agents: [] }], 280);
  assert.equal(hookSubagentSummary(state), null);
  // A stop stamped after the fold lists as done until the next prompt, as before.
  state = run([[launched("c"), 100], [launched("d"), 110], [{ kind: "fold" }, 300], [{ kind: "ended", id: "c", type: null }, 400]]);
  assert.deepEqual(hookSubagentSummary(state)!.agents.map((x) => `${x.id}:${x.state}`).sort(), ["c:completed", "d:running"]);
});

test("a prompt that lands late folds only agents that had finished by its own stamp", () => {
  // `a` stopped at 200 and `b` at 400; the prompt stamped 300 is ingested after both stops.
  let state = run([
    [launched("a"), 100], [launched("b"), 110], [launched("c"), 120],
    [{ kind: "ended", id: "a", type: null }, 200],
    [{ kind: "ended", id: "b", type: null }, 400],
  ]);
  state = reduceHookSubagents(state, [{ kind: "fold" }], 300);
  const summary = hookSubagentSummary(state)!;
  assert.deepEqual(summary.agents.map((x) => `${x.id}:${x.state}`).sort(), ["b:completed", "c:running"]);
  assert.equal(summary.finishedFolded, 1, "only `a` folded");
  // The next prompt, stamped after `b` ended, folds it.
  state = reduceHookSubagents(state, [{ kind: "fold" }], 500);
  assert.deepEqual(hookSubagentSummary(state)!.agents.map((x) => x.id), ["c"]);
  assert.equal(hookSubagentSummary(state)!.finishedFolded, 2);
});

test("the list is capped: running first, the oldest finished fold", () => {
  const steps: [Signal, number][] = [];
  for (let i = 0; i < SUBAGENT_LIMIT + 3; i++) steps.push([launched(`f${i}`), i]);
  for (let i = 0; i < SUBAGENT_LIMIT + 3; i++) steps.push([{ kind: "ended", id: `f${i}`, type: null }, 100 + i]);
  steps.push([launched("live"), 500]);
  const summary = hookSubagentSummary(run(steps))!;
  assert.equal(summary.agents.length, SUBAGENT_LIMIT);
  assert.equal(summary.agents[0]?.id, "live");
  assert.equal(summary.finishedFolded, 4);
  assert.equal(summary.agents[1]?.id, `f${SUBAGENT_LIMIT + 2}`, "newest finished first");
});

test("at most 64 running agents are held; the 65th evicts the oldest-started", () => {
  // A hook stream whose stops are lost only ever launches, so the running set is bounded too.
  const steps: [Signal, number][] = [];
  for (let i = 0; i < 64; i++) steps.push([launched(`r${i}`), 1_000 + i]);
  const atLimit = run(steps);
  assert.equal(atLimit.agents.size, 64, "64 is within the bound: nothing is evicted");
  assert.ok(atLimit.agents.has("r0"));
  const full = hookSubagentSummary(atLimit)!;
  assert.equal(full.agents.length, SUBAGENT_LIMIT);
  assert.deepEqual(full.agents.map((a) => a.id), Array.from({ length: SUBAGENT_LIMIT }, (_, i) => `r${i}`));
  assert.equal(full.finishedFolded, 0);

  const over = reduceHookSubagents(atLimit, [launched("r64")], 1_064);
  assert.equal(over.agents.size, 64, "the 65th stays inside the bound");
  assert.equal(over.agents.has("r0"), false, "the oldest-started running agent is the one dropped");
  for (let i = 1; i <= 64; i++) assert.ok(over.agents.has(`r${i}`), `r${i} is retained`);
  const after = hookSubagentSummary(over)!;
  assert.deepEqual(after.agents.map((a) => a.id), Array.from({ length: SUBAGENT_LIMIT }, (_, i) => `r${i + 1}`));
  assert.ok(after.agents.every((a) => a.state === "running"));
  // A running agent dropped for room did not finish, so it is not counted as finished.
  assert.equal(after.finishedFolded, 0);
});

test("at most 32 uncounted starts are remembered; the 33rd forgets the oldest", () => {
  const start = (id: string): Signal => ({ kind: "started", id, type: "Plan" });
  const steps: [Signal, number][] = [];
  for (let i = 0; i < 32; i++) steps.push([start(`s${i}`), 100 + i]);
  const atLimit = run(steps);
  assert.equal(atLimit.started.size, 32, "32 is within the bound: nothing is forgotten");
  assert.equal(hookSubagentSummary(atLimit), null, "an uncounted start never shows");
  // At the limit the oldest start is still remembered, so its launch keeps the real start and type.
  const kept = hookSubagentSummary(reduceHookSubagents(atLimit, [launched("s0", null)], 5_000))!.agents[0]!;
  assert.deepEqual([kept.id, kept.startedAt, kept.type], ["s0", 100, "Plan"]);

  const over = reduceHookSubagents(atLimit, [start("s32")], 132);
  assert.equal(over.started.size, 32, "the 33rd stays inside the bound");
  assert.equal(over.started.has("s0"), false, "the oldest start is the one forgotten");
  for (let i = 1; i <= 32; i++) assert.ok(over.started.has(`s${i}`), `s${i} is remembered`);
  // The forgotten start's launch is counted from the launch itself, with no remembered type.
  const forgotten = hookSubagentSummary(reduceHookSubagents(over, [launched("s0", null)], 5_000))!.agents[0]!;
  assert.deepEqual([forgotten.startedAt, forgotten.type], [5_000, null]);
  // The next-oldest is still remembered.
  const next = hookSubagentSummary(reduceHookSubagents(over, [launched("s1", null)], 5_000))!.agents[0]!;
  assert.deepEqual([next.startedAt, next.type], [101, "Plan"]);
});

test("at most 64 ended ids are remembered; the 65th forgets the oldest", () => {
  const end = (id: string): Signal => ({ kind: "ended", id, type: null });
  const steps: [Signal, number][] = [];
  for (let i = 0; i < 64; i++) steps.push([end(`e${i}`), 100 + i]);
  const atLimit = run(steps);
  assert.equal(atLimit.ended.size, 64, "64 is within the bound: nothing is forgotten");
  // At the limit the oldest end still blocks a late launch.
  assert.equal(hookSubagentSummary(reduceHookSubagents(atLimit, [launched("e0")], 5_000)), null);

  const over = reduceHookSubagents(atLimit, [end("e64")], 164);
  assert.equal(over.ended.size, 64, "the 65th stays inside the bound");
  assert.equal(over.ended.has("e0"), false, "the oldest end is the one forgotten");
  for (let i = 1; i <= 64; i++) assert.ok(over.ended.has(`e${i}`), `e${i} is remembered`);
  // The forgotten end no longer blocks: a launch for it is counted as running.
  assert.deepEqual(
    hookSubagentSummary(reduceHookSubagents(over, [launched("e0")], 5_000))!.agents.map((a) => [a.id, a.state]),
    [["e0", "running"]],
  );
  // The next-oldest end still blocks its late launch.
  assert.equal(hookSubagentSummary(reduceHookSubagents(over, [launched("e1")], 5_000)), null);
});

test("signals that change nothing return the same state", () => {
  const live: Signal = { kind: "live", agents: [{ id: "a", type: "Explore", description: null }] };
  // The first complete live set is remembered; the same set again changes nothing.
  const state = run([[launched("a"), 1], [live, 2]]);
  assert.equal(reduceHookSubagents(state, [], 3), state);
  assert.equal(reduceHookSubagents(state, [launched("a")], 3), state);
  assert.equal(reduceHookSubagents(state, [live], 2), state);
  // A fold records when it happened; the same fold again changes nothing.
  const folded = reduceHookSubagents(emptyHookSubagents(), [{ kind: "fold" }], 2);
  assert.equal(hookSubagentSummary(folded), null);
  assert.equal(reduceHookSubagents(folded, [{ kind: "fold" }], 2), folded);
});

test("a SubagentStart that lands after its launch moves the start earlier, not the count time", () => {
  let state = run([[launched("a", null), 200]]);
  state = reduceHookSubagents(state, [{ kind: "started", id: "a", type: "Explore" }], 100);
  const [row] = hookSubagentSummary(state)!.agents;
  assert.deepEqual([row?.startedAt, row?.type], [100, "Explore"]);
  // A later start never moves it forward.
  state = reduceHookSubagents(state, [{ kind: "started", id: "a", type: "Explore" }], 300);
  assert.equal(hookSubagentSummary(state)!.agents[0]?.startedAt, 100);
  // Live sets still compare against when it was counted (200): a set taken at 150 says nothing
  // about it, so it stays running.
  state = reduceHookSubagents(state, [{ kind: "live", agents: [] }], 150);
  assert.equal(hookSubagentSummary(state)!.agents[0]?.state, "running");
});

test("a newer complete live set outranks a delayed launch or an older live set", () => {
  // The set taken at 300 is empty; a launch from 200 arriving afterwards is not running now.
  let state = run([[{ kind: "live", agents: [] }, 300], [launched("late"), 200]]);
  assert.equal(hookSubagentSummary(state), null);
  // Nor can an older complete or partial set bring it in.
  const stale: Signal = { kind: "live", agents: [{ id: "late", type: "Explore", description: null }] };
  state = reduceHookSubagents(state, [stale], 250);
  state = reduceHookSubagents(state, [{ ...stale, partial: true } as Signal], 260);
  assert.equal(hookSubagentSummary(state), null);
  // A launch the newer set DID name, or one newer than it, still counts.
  state = run([[{ kind: "live", agents: [{ id: "named", type: null, description: null }] }, 300], [launched("named"), 200]]);
  assert.deepEqual(hookSubagentSummary(state)!.agents.map((a) => a.id), ["named"]);
  state = reduceHookSubagents(state, [launched("fresh")], 400);
  assert.deepEqual(hookSubagentSummary(state)!.agents.map((a) => a.id).sort(), ["fresh", "named"]);
  // A reset forgets the remembered set and everything counted before it.
  state = reduceHookSubagents(state, [{ kind: "reset" }, launched("after")], 500);
  assert.equal(state.lastLive, null);
  assert.deepEqual(hookSubagentSummary(state)!.agents.map((a) => a.id), ["after"]);
});

// --- each harness's reading ----------------------------------------------------------------

const ingest = (over: Record<string, unknown>): HookIngest =>
  HookIngestSchema.parse({ env: {}, sessionId: "native-1", cwd: "/repo", ...over });

test("Claude: SubagentStart is seen, async_launched counts, SubagentStop ends", () => {
  assert.deepEqual(
    claudeHooks.subagentSignals(ingest({ event: "SubagentStart", agentId: "a1", agentType: "Explore" })),
    [{ kind: "started", id: "a1", type: "Explore" }],
  );
  assert.deepEqual(
    claudeHooks.subagentSignals(ingest({
      event: "PostToolUse", toolName: "Agent",
      agentTool: { agentId: "a1", status: "async_launched", subagentType: "Explore", description: "Map call sites" },
    })),
    [{ kind: "launched", id: "a1", type: "Explore", description: "Map call sites" }],
  );
  // A foreground Agent call returns `completed`, and it is not counted.
  assert.deepEqual(
    claudeHooks.subagentSignals(ingest({
      event: "PostToolUse", toolName: "Agent", agentTool: { agentId: "a2", status: "completed", subagentType: "Plan" },
    })),
    [],
  );
  assert.deepEqual(
    claudeHooks.subagentSignals(ingest({ event: "SubagentStop", agentId: "a1", agentType: "Explore" })),
    [{ kind: "ended", id: "a1", type: "Explore" }],
  );
});

test("Claude: background_tasks on Stop and SubagentStop is the live set, agents only", () => {
  const tasks = [
    { id: "a1", type: "subagent", description: "Map call sites", agentType: "Explore" },
    { id: "sh1", type: "shell", description: "npm test" },
    { id: "wf1", type: "workflow", description: "review" },
  ];
  const live = { kind: "live", agents: [{ id: "a1", type: "Explore", description: "Map call sites" }] };
  assert.deepEqual(claudeHooks.subagentSignals(ingest({ event: "Stop", backgroundTasks: tasks })), [live]);
  assert.deepEqual(
    claudeHooks.subagentSignals(ingest({ event: "SubagentStop", agentId: "a2", backgroundTasks: tasks })),
    [{ kind: "ended", id: "a2", type: null }, live],
    "the end first, so the live set cannot revive the agent that just stopped",
  );
  // A Stop from a Claude Code that predates the list says nothing about membership.
  assert.deepEqual(claudeHooks.subagentSignals(ingest({ event: "Stop" })), []);
  // And an empty list is a reading: nothing is running.
  assert.deepEqual(claudeHooks.subagentSignals(ingest({ event: "Stop", backgroundTasks: [] })), [{ kind: "live", agents: [] }]);
});

test("Claude: a list the bridge cut short is read as partial", () => {
  const tasks = [{ id: "a1", type: "subagent", agentType: "Explore" }];
  assert.deepEqual(
    claudeHooks.subagentSignals(ingest({ event: "Stop", backgroundTasks: tasks, backgroundTasksTruncated: true })),
    [{ kind: "live", partial: true, agents: [{ id: "a1", type: "Explore", description: null }] }],
  );
  assert.deepEqual(
    claudeHooks.subagentSignals(ingest({ event: "Stop", backgroundTasks: tasks })),
    [{ kind: "live", agents: [{ id: "a1", type: "Explore", description: null }] }],
  );
});

test("Claude and Codex: the operator's prompt folds, a sub-agent's does not; a new process resets", () => {
  for (const spec of [claudeHooks, codexHooks]) {
    assert.deepEqual(spec.subagentSignals(ingest({ event: "UserPromptSubmit", prompt: "next" })), [{ kind: "fold" }]);
    assert.deepEqual(spec.subagentSignals(ingest({ event: "UserPromptSubmit", prompt: "x", agentId: "a" })), []);
    assert.deepEqual(spec.subagentSignals(ingest({ event: "SessionStart", source: "startup" })), [{ kind: "reset" }]);
    assert.deepEqual(spec.subagentSignals(ingest({ event: "SessionStart", source: "resume" })), [{ kind: "reset" }]);
    assert.deepEqual(spec.subagentSignals(ingest({ event: "SessionStart", source: "compact" })), []);
  }
});

test("Codex: every child counts from SubagentStart to SubagentStop", () => {
  assert.deepEqual(
    codexHooks.subagentSignals(ingest({ agent: "codex", event: "SubagentStart", agentId: "t-1", agentType: "worker" })),
    [{ kind: "launched", id: "t-1", type: "worker", description: null }],
  );
  assert.deepEqual(
    codexHooks.subagentSignals(ingest({ agent: "codex", event: "SubagentStop", agentId: "t-1", agentType: "worker" })),
    [{ kind: "ended", id: "t-1", type: "worker" }],
  );
  // Without the child's id there is nothing to track.
  assert.deepEqual(codexHooks.subagentSignals(ingest({ agent: "codex", event: "SubagentStart" })), []);
});

test("Pi reports no sub-agents", () => {
  assert.deepEqual(piHooks.subagentSignals(ingest({ agent: "pi", event: "Stop", backgroundTasks: [] })), []);
});

test("Claude installs SubagentStart, and it never arms the parent's work cycle", () => {
  assert.ok(claudeHooks.events.includes("SubagentStart"));
  assert.equal(claudeHooks.workCycleSignal(ingest({ event: "SubagentStart", agentId: "a" })), null);
});

// --- the wire ------------------------------------------------------------------------------

test("a malformed sub-agent field costs that field, never the parent's hook", () => {
  const parsed = HookIngestSchema.parse({
    event: "Stop", env: {},
    agentType: "",
    agentTool: { status: 7 },
    backgroundTasks: [{ id: "" }],
  });
  assert.equal(parsed.event, "Stop");
  assert.equal(parsed.agentType, undefined);
  assert.equal(parsed.agentTool, undefined);
  assert.equal(parsed.backgroundTasks, undefined);
  const tooMany = HookIngestSchema.parse({
    event: "Stop", env: {}, backgroundTasks: Array.from({ length: 51 }, (_, i) => ({ id: `t${i}` })),
  });
  assert.equal(tooMany.backgroundTasks, undefined);
  // And an ingest without any of them parses as it always did.
  const bare = HookIngestSchema.parse({ event: "Stop", env: {} });
  assert.equal(bare.backgroundTasks, undefined);
});

// --- the registry --------------------------------------------------------------------------

function discovered(id: string, pane: string, agent: "claude" | "codex" = "claude"): DiscoveredSession {
  return {
    syntheticId: id, agent, name: "work", nameSource: "process", cwd: join(home, id), gitBranch: "feature",
    pid: 1, tty: "ttys1", terminals: [mkMuxHandle({ session: id, windowName: "w", windowIndex: 0, paneId: pane })],
    startedAt: 0,
  } as DiscoveredSession;
}

function terminalHook(pane: string, over: Record<string, unknown>): HookIngest {
  return HookIngestSchema.parse({ agent: "claude", sessionId: `native-${pane}`, cwd: null, env: { tmuxPane: pane }, ...over });
}

test("a terminal Claude session's background agents reach its card, and the parent stays idle", () => {
  const registry = new Registry();
  const id = "term-claude";
  const pane = "%41";
  registry.applyDiscovery([discovered(id, pane)]);
  const at = (ts: number, over: Record<string, unknown>) => registry.applyHook(terminalHook(pane, { ts, ...over }));

  at(1_000, { event: "UserPromptSubmit", prompt: "map the ledger" });
  at(1_100, { event: "SubagentStart", agentId: "a1", agentType: "Explore" });
  at(1_200, {
    event: "PostToolUse", toolName: "Agent",
    agentTool: { agentId: "a1", status: "async_launched", subagentType: "Explore", description: "Map call sites" },
  });
  at(1_300, { event: "Stop", backgroundTasks: [{ id: "a1", type: "subagent", agentType: "Explore" }] });
  const idle = registry.getSession(id)!;
  assert.equal(idle.state, "idle");
  assert.deepEqual(idle.subagents?.agents.map((a) => [a.id, a.type, a.description, a.state, a.startedAt]), [
    ["a1", "Explore", "Map call sites", "running", 1_100],
  ]);
  assert.equal(subagentActivityLine(idle), "idle · 1 agent still running");

  // The agent's own work and its stop never re-arm the idle parent.
  at(1_400, { event: "PreToolUse", toolName: "Grep", agentId: "a1" });
  at(1_500, { event: "SubagentStop", agentId: "a1", agentType: "Explore", backgroundTasks: [] });
  const done = registry.getSession(id)!;
  assert.equal(done.state, "idle");
  assert.equal(done.activity, idle.activity);
  assert.deepEqual(done.workCycle, idle.workCycle);
  assert.deepEqual(done.subagents?.agents.map((a) => [a.state, a.endedAt]), [["completed", 1_500]]);

  // A discovery sweep cannot see sub-agents, and must not blank them.
  registry.applyDiscovery([discovered(id, pane)]);
  assert.equal(registry.getSession(id)!.subagents?.agents.length, 1);

  // The operator's next prompt folds the finished agent, and with nothing running it is gone.
  at(2_000, { event: "UserPromptSubmit", prompt: "thanks" });
  assert.equal("subagents" in registry.getSession(id)!, false);
});

test("an agent past the bridge's background-task bound is not stopped by the cut list", () => {
  const registry = new Registry();
  const id = "term-claude-cut";
  const pane = "%44";
  registry.applyDiscovery([discovered(id, pane)]);
  const at = (ts: number, over: Record<string, unknown>) => registry.applyHook(terminalHook(pane, { ts, ...over }));
  at(1_000, {
    event: "PostToolUse", toolName: "Agent",
    agentTool: { agentId: "late-agent", status: "async_launched", subagentType: "Explore", description: "Past the cut" },
  });

  // Claude's Stop lists 51 in-flight tasks, the tracked agent last. The bridge forwards 50.
  const payload = {
    background_tasks: [
      ...Array.from({ length: HOOK_BACKGROUND_TASKS_MAX }, (_, i) => ({ id: `shell-${i}`, type: "shell", status: "running" })),
      { id: "late-agent", type: "subagent", status: "running", agent_type: "Explore" },
    ],
  };
  const forwarded = backgroundTaskList(payload)!;
  assert.equal(forwarded.length, HOOK_BACKGROUND_TASKS_MAX);
  assert.equal(forwarded.some((t) => t.id === "late-agent"), false, "the agent is past the cut");
  at(2_000, { event: "Stop", backgroundTasks: forwarded, backgroundTasksTruncated: backgroundTasksTruncated(payload) });

  const s = registry.getSession(id)!;
  assert.deepEqual(s.subagents?.agents.map((a) => [a.id, a.state]), [["late-agent", "running"]]);
  assert.equal(subagentActivityLine(s), "idle · 1 agent still running");
  // Not recorded as ended either: a later complete list that names it keeps it running, and its
  // real stop ends it as completed.
  at(3_000, { event: "Stop", backgroundTasks: [{ id: "late-agent", type: "subagent", agentType: "Explore" }] });
  assert.equal(registry.getSession(id)!.subagents?.agents[0]?.state, "running");
  at(4_000, { event: "SubagentStop", agentId: "late-agent", agentType: "Explore", backgroundTasks: [] });
  assert.equal(registry.getSession(id)!.subagents?.agents[0]?.state, "completed");
});

test("a terminal Codex session counts its children", () => {
  const registry = new Registry();
  const id = "term-codex";
  const pane = "%42";
  registry.applyDiscovery([discovered(id, pane, "codex")]);
  registry.applyHook(terminalHook(pane, { agent: "codex", event: "Stop", ts: 1_000 }));
  registry.applyHook(terminalHook(pane, { agent: "codex", event: "SubagentStart", agentId: "t-1", agentType: "worker", ts: 1_100 }));
  const s = registry.getSession(id)!;
  assert.equal(s.state, "idle", "a child starting does not re-arm the parent");
  assert.deepEqual(s.subagents?.agents.map((a) => [a.id, a.type, a.state]), [["t-1", "worker", "running"]]);
  registry.applyHook(terminalHook(pane, { agent: "codex", event: "SubagentStop", agentId: "t-1", ts: 1_200 }));
  assert.equal(registry.getSession(id)!.subagents?.agents[0]?.state, "completed");
  assert.equal(registry.getSession(id)!.state, "idle");
});

test("an SDK session's hook sub-agent signals are ignored: its driver owns the summary", () => {
  const registry = new Registry();
  const id = "sdk:hook-subagents";
  const cwd = join(home, "sdk");
  registry.registerSdkSession({ id, agent: "claude", name: id, cwd });
  registry.applyDriverEvent(id, { kind: "bound", agentSessionId: `${id}-native`, transcriptPath: null, modelId: null, pid: null });
  const hook = (over: Record<string, unknown>) =>
    registry.applyHook(HookIngestSchema.parse({ agent: "claude", sessionId: `${id}-native`, cwd, env: {}, ...over }));
  hook({ event: "SubagentStart", agentId: "a1", agentType: "Explore" });
  hook({
    event: "PostToolUse", toolName: "Agent",
    agentTool: { agentId: "a1", status: "async_launched", subagentType: "Explore" },
  });
  hook({ event: "Stop", backgroundTasks: [{ id: "a1", type: "subagent", agentType: "Explore" }] });
  assert.equal("subagents" in registry.getSession(id)!, false);
});

test("a removed session's hook state goes with it", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const registry = new Registry();
  const id = "term-removed";
  const pane = "%43";
  registry.applyDiscovery([discovered(id, pane)]);
  registry.applyHook(terminalHook(pane, {
    event: "PostToolUse", toolName: "Agent", ts: 1_000,
    agentTool: { agentId: "a1", status: "async_launched", subagentType: "Explore" },
  }));
  assert.equal(registry.getSession(id)!.subagents?.agents.length, 1);
  registry.applyDiscovery([]);
  t.mock.timers.tick(24 * 60 * 60 * 1000);
  assert.equal(registry.getSession(id), undefined);
  // The same pane discovered again under the same id starts clean.
  registry.applyDiscovery([discovered(id, pane)]);
  registry.applyHook(terminalHook(pane, { event: "Stop", ts: 2_000 }));
  assert.equal("subagents" in registry.getSession(id)!, false);
});
