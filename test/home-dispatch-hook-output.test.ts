// F3/F4/F16/F17: what the daemon adds to the hook route's response (spec 7.3, 7.4, 7.9, 7.20, 7.21).
// The hook script's own tests live in home-dispatch-hook.test.ts (WP4); this file drives the daemon side.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

const home = realpathSync(mkdtempSync(join(tmpdir(), "mission-home-dispatch-hook-")));
process.env.MISSION_HOME = home;

const { openDb, closeDb } = await import("../src/server/db.ts");
const out = await import("../src/server/home-dispatch/hook-output.ts");
const sessions = await import("../src/server/home-dispatch/sessions.ts");
const turns = await import("../src/server/home-dispatch/turns.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const flags = await import("../src/server/feature-flags/index.ts");
const { DISPATCH_STANDING_LINE } = await import("../src/shared/home-dispatch.ts");
const { HookIngestSchema } = await import("../src/shared/protocol.ts");

after(() => { closeDb(); rmSync(home, { recursive: true, force: true }); });

const repo = join(home, "repo");
mkdirSync(repo);
execFileSync("git", ["init", "-q", repo]);

beforeEach(() => {
  const d = openDb();
  for (const table of ["home_dispatch_sessions", "home_dispatch_turns", "home_dispatch_receipts", "tasks", "app_config"]) d.exec(`DELETE FROM ${table}`);
  flags.applyFeatureFlagIntent({ kind: "flag", id: "headless-mode", enabled: true });
});

type Deps = import("../src/server/home-dispatch/hook-output.ts").HomeDispatchHookDeps;
const hook = (event: string, over: Record<string, unknown> = {}) =>
  HookIngestSchema.parse({ event, sessionId: "s1", cwd: repo, entrypoint: "cli", claudePid: 4242, ...over });

interface Recorded { banners: Array<Parameters<Deps["banner"]>[0]>; receiptCalls: string[] }
function fakeDeps(over: Partial<Deps> = {}): { deps: Deps; seen: Recorded } {
  const seen: Recorded = { banners: [], receiptCalls: [] };
  const deps: Deps = {
    ...out.DEFAULT_HOOK_DEPS,
    now: () => 10_000,
    daemonVersion: "1.2.3",
    banner: (input) => { seen.banners.push(input); return "BANNER-1\nBANNER-2\nBANNER-3"; },
    inbox: {
      counts: () => ({ running: 2, waiting: 1 }),
      cards: () => ({ full: [], reminders: [] }),
      summary: () => null,
    },
    receiptLine: (_s, tool) => { seen.receiptCalls.push(tool); return 'sent "Keep" to task mc-91c2'; },
    ...over,
  };
  return { deps, seen };
}
const start = (deps: Deps, over: Record<string, unknown> = {}) => out.homeDispatchHookOutput(hook("SessionStart", { source: "startup", ...over }), deps);
const prompt = (deps: Deps, text: string, over: Record<string, unknown> = {}) => out.homeDispatchHookOutput(hook("UserPromptSubmit", { prompt: text, ...over }), deps);

const CARD = {
  shown: { key: "r1", changedAt: 5, state: "waiting", revisionHash: null },
  systemLine: "mission-control: mc-91c2 asks a question (logging cleanup)",
  context: "<worker-question>\nKeep the old logger?\n</worker-question>",
};

test("F17 start: a fresh startup returns the banner as systemMessage, with the counts and the menu hint inputs", () => {
  const { deps, seen } = fakeDeps();
  const result = start(deps);
  assert.equal(result!.systemMessage, "BANNER-1\nBANNER-2\nBANNER-3");
  assert.deepEqual(seen.banners, [{ harness: "claude", counts: { running: 2, waiting: 1 }, menuOffered: true, versionMismatch: false, color: true }]);
});

test("F17 start: noColor from the hook asks for the plain banner", () => {
  const { deps, seen } = fakeDeps();
  start(deps, { noColor: true });
  assert.equal(seen.banners[0]!.color, false);
});

test("F17 start: resume, clear and compact register the session but print no banner", () => {
  for (const source of ["resume", "clear", "compact"]) {
    const { deps, seen } = fakeDeps();
    const result = start(deps, { source, sessionId: `s-${source}` });
    assert.equal(result!.systemMessage, undefined, source);
    assert.equal(seen.banners.length, 0, source);
    assert.ok(sessions.getHomeSession(`s-${source}`), `${source} still registers the session`);
    assert.match(result!.additionalContext!, /mission-dispatch skill\.$/, `${source} still carries the standing line`);
  }
});

test("F17 start: the menu hint is off when the launcher cannot be offered (disabled, non-interactive, setting off)", () => {
  for (const over of [{ launcherDisabled: true }, { entrypoint: "sdk-cli" }]) {
    const { deps, seen } = fakeDeps();
    start(deps, { sessionId: "x" + JSON.stringify(over).length, ...over });
    assert.equal(seen.banners[0]!.menuOffered, false, JSON.stringify(over));
  }
  openDb().prepare("INSERT INTO app_config (key, value) VALUES ('dispatch.launcher.prompt', 'false')").run();
  const { deps, seen } = fakeDeps();
  start(deps, { sessionId: "setting-off" });
  assert.equal(seen.banners[0]!.menuOffered, false);
});

test("F17 start: a hook and daemon version mismatch is passed to the banner; a matching or silent hook is not a mismatch", () => {
  const cases: Array<[string | undefined, boolean]> = [["1.2.3", false], ["0.9.0", true], [undefined, false]];
  for (const [hookVersion, expected] of cases) {
    const { deps, seen } = fakeDeps();
    start(deps, { sessionId: `v-${hookVersion}`, ...(hookVersion ? { hookVersion } : {}) });
    assert.equal(seen.banners[0]!.versionMismatch, expected, String(hookVersion));
  }
});

test("F17 start: with no builder wired the start prints no banner text of its own", () => {
  const result = out.homeDispatchHookOutput(hook("SessionStart", { source: "startup" }));
  assert.equal(result!.systemMessage, undefined);
});

test("F4 start: the summary card leads additionalContext, the standing line always ends it, and the card turn is recorded", () => {
  const cards = [{ key: "r1", changedAt: 1, state: "waiting", revisionHash: "7a1c2d" }];
  const { deps } = fakeDeps({ inbox: { counts: () => ({ running: 0, waiting: 0 }), cards: () => ({ full: [], reminders: [] }), summary: () => ({ cards, context: "SUMMARY CARD" }) } });
  const result = start(deps);
  assert.equal(result!.additionalContext, `SUMMARY CARD\n\n${DISPATCH_STANDING_LINE}`);
  const recorded = turns.listTurns("s1");
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.excerpt, "");
  assert.deepEqual(recorded[0]!.cardsShown, cards);
  assert.equal(sessions.getHomeSession("s1")!.lastTurnAt, null, "the summary card does not count as the first turn");
});

test("F3 prompt: the first plain message of a startup session gets the launcher instruction, once", () => {
  const { deps } = fakeDeps();
  start(deps);
  const first = prompt(deps, "fix the login timeout");
  assert.equal(first!.additionalContext, out.LAUNCHER_INSTRUCTION);
  assert.match(out.LAUNCHER_INSTRUCTION, /start_dispatch.*entry: "first-message".*mission-dispatch skill/);
  assert.equal(prompt(deps, "another message"), null, "never offered twice");
});

test("F3 prompt: the summary card turn does not use up the first turn", () => {
  const { deps } = fakeDeps({ inbox: { counts: () => ({ running: 0, waiting: 0 }), cards: () => ({ full: [], reminders: [] }), summary: () => ({ cards: [{ key: "k", changedAt: 1, state: "ready", revisionHash: null }], context: "S" }) } });
  start(deps);
  assert.equal(prompt(deps, "hello")!.additionalContext, out.LAUNCHER_INSTRUCTION);
});

test("F3 prompt: a failing inbox on the first prompt still offers the menu, and a later prompt is not offered it again", () => {
  const { deps } = fakeDeps({ inbox: { counts: () => ({ running: 0, waiting: 0 }), cards: () => { throw new Error("inbox down"); }, summary: () => null } });
  start(deps);
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal(prompt(deps, "fix the login timeout")!.additionalContext, out.LAUNCHER_INSTRUCTION);
    assert.equal(prompt(deps, "next"), null);
  } finally { console.error = original; }
});

test("F3 prompt: pruning old turns never gives a long-lived session a second first turn", () => {
  let clock = 1_000;
  const { deps } = fakeDeps({ now: () => clock });
  start(deps);
  assert.equal(prompt(deps, "/review"), null, "a slash command spends the first turn");
  const week = 7 * 24 * 60 * 60 * 1000;
  clock += week + 1;
  turns.pruneExpiredHomeDispatchLog(clock);
  assert.equal(turns.listTurns("s1").length, 0, "the first turn aged out of the log");
  assert.equal(prompt(deps, "a plain message much later"), null, "the session is still not offered the menu");
});

test("F3 prompt: never on resume, clear, compact, or for a slash command", () => {
  for (const source of ["resume", "clear", "compact"]) {
    const { deps } = fakeDeps();
    start(deps, { source, sessionId: `n-${source}` });
    assert.equal(prompt(deps, "hello", { sessionId: `n-${source}` }), null, source);
  }
  const { deps } = fakeDeps();
  start(deps, { sessionId: "slash" });
  assert.equal(prompt(deps, "/review", { sessionId: "slash" }), null);
  assert.equal(prompt(deps, "now a plain message", { sessionId: "slash" }), null, "a slash command spent the first turn");
});

test("F3 prompt: exactly /mission-dispatch spends the offer without printing the instruction", () => {
  const { deps } = fakeDeps();
  start(deps);
  assert.equal(prompt(deps, "/mission-dispatch"), null);
  assert.ok(sessions.getHomeSession("s1")!.launcherOfferedAt !== null);
  assert.equal(prompt(deps, "hello"), null);
});

test("F3 prompt: a non-interactive entrypoint is never offered the menu", () => {
  const { deps } = fakeDeps();
  start(deps, { entrypoint: "sdk-cli" });
  assert.equal(prompt(deps, "hello", { entrypoint: "sdk-cli" }), null);
});

test("F4 prompt: new cards come first, with their system lines, then reminders, then the launcher", () => {
  const delta = { full: [CARD], reminders: [{ shown: { key: "r2", changedAt: 6, state: "waiting", revisionHash: null }, systemLine: "mission-control: reminder, mc-5555 still waiting" }] };
  const { deps } = fakeDeps({ inbox: { counts: () => ({ running: 0, waiting: 0 }), cards: () => delta, summary: () => null } });
  start(deps);
  const result = prompt(deps, "hello there");
  assert.equal(result!.systemMessage, `${CARD.systemLine}\n${delta.reminders[0]!.systemLine}`);
  assert.equal(result!.additionalContext, `${CARD.context}\n\n${out.LAUNCHER_INSTRUCTION}`);
  const shown = turns.latestTurn("s1")!.cardsShown.map((c) => c.key);
  assert.deepEqual(shown, ["r1", "r2"], "everything shown is recorded in cards_shown");
});

test("F16 prompt: the nudge fires when the launcher is not offered and the prompt asks to run or schedule", () => {
  const { deps } = fakeDeps();
  start(deps, { source: "resume" });
  const now = prompt(deps, "run this in Mission Control now");
  assert.match(now!.additionalContext!, /^The person asked to run this now in Mission Control\. .* intent now\. Then return to what you were doing\.$/);
  const later = prompt(deps, "schedule a task in Mission Control's backlog to add retries");
  assert.match(later!.additionalContext!, /save this to the backlog in Mission Control\. .* intent backlog/);
  assert.equal(prompt(deps, "no dispatch here"), null);
});

test("F16 prompt: when the launcher is offered this turn, the nudge stays quiet; waiting cards still come first", () => {
  const { deps } = fakeDeps({ inbox: { counts: () => ({ running: 0, waiting: 0 }), cards: () => ({ full: [CARD], reminders: [] }), summary: () => null } });
  start(deps);
  const result = prompt(deps, "run this in Mission Control now");
  assert.equal(result!.additionalContext, `${CARD.context}\n\n${out.LAUNCHER_INSTRUCTION}`);
  const second = prompt(deps, "schedule it in MC");
  assert.match(second!.additionalContext!, /intent backlog/, "from the next turn the nudge works");
});

test("F16 prompt: a session whose SessionStart was missed registers on its first prompt, gets no launcher, and still gets the nudge", () => {
  const { deps } = fakeDeps();
  const plain = prompt(deps, "hello", { sessionId: "late" });
  assert.equal(plain, null);
  const row = sessions.getHomeSession("late")!;
  assert.equal(row.startSource, null);
  assert.equal(row.entrypoint, null, "only a hook registration with a source records the entrypoint");
  assert.match(prompt(deps, "start this in MC", { sessionId: "late" })!.additionalContext!, /intent now/);
});

test("F3 prompt: the turn is opened with the excerpt and approval flag, never the full prompt", () => {
  const { deps } = fakeDeps();
  start(deps);
  prompt(deps, `approve 7a1c2d ${"x".repeat(500)}`);
  const turn = turns.latestTurn("s1")!;
  assert.equal(turn.containsApproval, true);
  assert.deepEqual(turn.mentionedHashes, ["7a1c2d"]);
  assert.ok(Array.from(turn.excerpt).length <= 120);
});

test("F5 stop: Stop closes the open turn and prints nothing", () => {
  const { deps } = fakeDeps();
  start(deps);
  prompt(deps, "hello");
  assert.equal(turns.latestTurn("s1")!.closedAt, null);
  assert.equal(out.homeDispatchHookOutput(hook("Stop"), deps), null);
  assert.notEqual(turns.latestTurn("s1")!.closedAt, null);
});

test("F4 post-tool: answer_task and checkin print the receipt line with the mission-control prefix; other tools print nothing", () => {
  const { deps, seen } = fakeDeps();
  start(deps);
  prompt(deps, "answer it");
  const answered = out.homeDispatchHookOutput(hook("PostToolUse", { toolName: "mcp__mission-control__answer_task" }), deps);
  assert.deepEqual(answered, { systemMessage: 'mission-control: sent "Keep" to task mc-91c2' });
  assert.ok(out.homeDispatchHookOutput(hook("PostToolUse", { toolName: "mcp__mission-control__checkin" }), deps));
  assert.equal(out.homeDispatchHookOutput(hook("PostToolUse", { toolName: "Bash" }), deps), null);
  assert.equal(out.homeDispatchHookOutput(hook("PostToolUse", { toolName: "mcp__mission-control__read_inbox" }), deps), null);
  assert.deepEqual(seen.receiptCalls, ["mcp__mission-control__answer_task", "mcp__mission-control__checkin"]);
  const none = fakeDeps({ receiptLine: () => null });
  assert.equal(out.homeDispatchHookOutput(hook("PostToolUse", { toolName: "mcp__mission-control__answer_task" }), none.deps), null, "no receipt, no output");
});

test("F4 events: only SessionStart, UserPromptSubmit and PostToolUse ever print", () => {
  const { deps } = fakeDeps();
  start(deps);
  for (const event of ["PreToolUse", "SubagentStart", "SubagentStop", "Notification", "SessionEnd", "PreCompact"]) {
    assert.equal(out.homeDispatchHookOutput(hook(event), deps), null, event);
  }
});

test("F1 hook output: flag off returns null and writes nothing, for every event", () => {
  flags.applyFeatureFlagIntent({ kind: "flag", id: "headless-mode", enabled: false });
  const { deps } = fakeDeps();
  for (const event of ["SessionStart", "UserPromptSubmit", "Stop", "PostToolUse"]) {
    assert.equal(out.homeDispatchHookOutput(hook(event, { source: "startup", prompt: "hi", toolName: "mcp__mission-control__answer_task" }), deps), null, event);
  }
  const d = openDb();
  for (const table of ["home_dispatch_sessions", "home_dispatch_turns"]) {
    assert.equal(Number((d.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n), 0, table);
  }
});

test("F3 hook output: a worker's hooks print nothing and register nothing", () => {
  openDb().prepare("INSERT INTO tasks (id, title, intent, kind, agent, repo_root, status, created_at, updated_at, session_id) VALUES ('t', 't', 'i', 'ship', 'claude', ?, 'running', 1, 1, 'sdk:w')").run(repo);
  const { deps, seen } = fakeDeps();
  assert.equal(start(deps, { sessionId: "sdk:w" }), null);
  assert.equal(prompt(deps, "run this in MC now", { sessionId: "sdk:w" }), null);
  assert.equal(seen.banners.length, 0);
  assert.equal(sessions.getHomeSession("sdk:w"), null);
});

test("F3 hook output: a session that becomes a worker after registering gets no output and no further turns", () => {
  const { deps } = fakeDeps();
  start(deps, { source: "resume" });
  assert.equal(prompt(deps, "run this in MC now")!.additionalContext !== undefined, true, "a home session is nudged");
  const before = turns.listTurns("s1").length;
  openDb().prepare("INSERT INTO tasks (id, title, intent, kind, agent, repo_root, status, created_at, updated_at, session_id) VALUES ('t', 't', 'i', 'ship', 'claude', ?, 'running', 1, 1, 's1')").run(repo);
  assert.equal(prompt(deps, "run this in MC now"), null);
  assert.equal(out.homeDispatchHookOutput(hook("PostToolUse", { toolName: "mcp__mission-control__answer_task" }), deps), null);
  assert.equal(turns.listTurns("s1").length, before, "no turn is written for a worker");
  const openBefore = turns.latestTurn("s1")!;
  assert.equal(openBefore.closedAt, null, "the turn opened before the session became a worker is still open");
  const stopAtBefore = sessions.getHomeSession("s1")!.lastStopAt;
  assert.equal(out.homeDispatchHookOutput(hook("Stop"), deps), null);
  assert.equal(turns.latestTurn("s1")!.closedAt, null, "Stop leaves a worker's turn state alone");
  assert.equal(sessions.getHomeSession("s1")!.lastStopAt, stopAtBefore);
});

test("F3 hook output: a Stop from inside a live task's worktree leaves the home session's turn state alone", () => {
  const { deps } = fakeDeps();
  start(deps, { source: "resume" });
  prompt(deps, "hello");
  const tree = join(home, "task-tree");
  mkdirSync(tree);
  openDb().prepare("INSERT INTO tasks (id, title, intent, kind, agent, repo_root, status, created_at, updated_at, worktree_path) VALUES ('tw', 't', 'i', 'ship', 'claude', ?, 'running', 1, 1, ?)").run(repo, tree);
  const stopAtBefore = sessions.getHomeSession("s1")!.lastStopAt;
  assert.equal(out.homeDispatchHookOutput(hook("Stop", { cwd: tree }), deps), null);
  assert.equal(turns.latestTurn("s1")!.closedAt, null, "the registered folder is not the one the event came from");
  assert.equal(sessions.getHomeSession("s1")!.lastStopAt, stopAtBefore);
  out.homeDispatchHookOutput(hook("Stop"), deps);
  assert.notEqual(turns.latestTurn("s1")!.closedAt, null, "a Stop from the registered folder still closes it");
});

test("F3 hook output: events with no session id or folder are ignored", () => {
  const { deps } = fakeDeps();
  assert.equal(out.homeDispatchHookOutput(hook("UserPromptSubmit", { sessionId: null, prompt: "hi" }), deps), null);
  assert.equal(out.homeDispatchHookOutput(hook("UserPromptSubmit", { cwd: null, prompt: "hi" }), deps), null);
});

test("F3 hook output: a failure inside prints nothing instead of failing the hook", () => {
  const { deps } = fakeDeps({ banner: () => { throw new Error("boom"); } });
  const original = console.error;
  console.error = () => {};
  try { assert.equal(start(deps), null); } finally { console.error = original; }
});

test("F3 hook fields: the new fields ride the ingest schema, and a malformed one costs only itself", () => {
  const parsed = HookIngestSchema.parse({
    event: "SessionStart", sessionId: "a", cwd: "/x", source: "startup", entrypoint: "cli", claudePid: 9, launcherDisabled: true,
    noColor: true, hookVersion: "3", terminal: { backend: "tmux", pane: "%1", server: "/s" },
  });
  assert.deepEqual([parsed.entrypoint, parsed.claudePid, parsed.launcherDisabled, parsed.noColor, parsed.hookVersion], ["cli", 9, true, true, "3"]);
  assert.equal(parsed.terminal?.backend, "tmux");
  const bad = HookIngestSchema.parse({ event: "Stop", sessionId: "a", claudePid: "nope", terminal: { backend: "screen" }, noColor: "yes" });
  assert.equal(bad.claudePid, undefined);
  assert.equal(bad.terminal, undefined);
  assert.equal(bad.noColor, undefined);
  assert.equal(HookIngestSchema.parse({ event: "Stop" }).entrypoint, undefined, "an older hook sends none of them");
});

test("F3 hook route: through /hooks/:event the first plain message gets the launcher instruction in the dispatch field", async () => {
  const registry = new Registry();
  const app = buildApp({ registry, reviews: new ReviewManager(registry), tasks: new TaskManager(registry), queues: new QueueManager(registry) });
  const headers = { host: "127.0.0.1:7317", "content-type": "application/json", "x-harness-token": ensureToken() };
  const post = (event: string, body: Record<string, unknown>) =>
    app.request(`/hooks/${event}`, { method: "POST", headers, body: JSON.stringify({ sessionId: "route-s", cwd: repo, entrypoint: "cli", ...body }) });
  const started = await post("SessionStart", { source: "startup" });
  assert.equal(started.status, 200);
  assert.match(((await started.json()) as { dispatch: { additionalContext: string } }).dispatch.additionalContext, /mission-dispatch skill\.$/);
  const first = await post("UserPromptSubmit", { prompt: "fix the login timeout" });
  assert.deepEqual(await first.json(), { dispatch: { additionalContext: out.LAUNCHER_INSTRUCTION } });
  const second = await post("UserPromptSubmit", { prompt: "and another thing" });
  assert.equal(second.status, 204);
  const stop = await post("Stop", {});
  assert.equal(stop.status, 204);
  flags.applyFeatureFlagIntent({ kind: "flag", id: "headless-mode", enabled: false });
  const off = await post("UserPromptSubmit", { prompt: "run this in MC" });
  assert.equal(off.status, 204, "flag off: today's empty answer");
});

test("F3 hook output: the 95th percentile of a prompt event is well inside the hook's 100 ms budget", () => {
  const { deps } = fakeDeps();
  start(deps);
  const times: number[] = [];
  for (let i = 0; i < 200; i++) {
    const began = performance.now();
    prompt(deps, `message number ${i} for Mission Control, run it`);
    times.push(performance.now() - began);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(times.length * 0.95)]!;
  assert.ok(p95 < 100, `p95 was ${p95.toFixed(1)} ms`);
});
