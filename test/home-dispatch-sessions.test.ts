// F3/F4: home sessions (spec 7.2) and the once-per-session launcher decision (spec 7.4).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

const home = realpathSync(mkdtempSync(join(tmpdir(), "mission-home-dispatch-sessions-")));
process.env.MISSION_HOME = home;

const { openDb, closeDb } = await import("../src/server/db.ts");
const sessions = await import("../src/server/home-dispatch/sessions.ts");
const launcher = await import("../src/server/home-dispatch/launcher.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const flags = await import("../src/server/feature-flags/index.ts");
const { DISPATCH_COMMAND, DISPATCH_LAUNCHER_PROMPT_SETTING } = await import("../src/shared/home-dispatch.ts");

after(() => { closeDb(); rmSync(home, { recursive: true, force: true }); });

const repo = join(home, "repo");
mkdirSync(repo);
execFileSync("git", ["init", "-q", repo]);
mkdirSync(join(repo, "packages", "web"), { recursive: true });
const outside = join(home, "not-a-repo");
mkdirSync(outside);

beforeEach(() => {
  const d = openDb();
  for (const table of ["home_dispatch_sessions", "home_dispatch_turns", "home_dispatch_receipts", "tasks", "sdk_sessions", "session_agent_bindings", "task_repos", "app_config"]) {
    d.exec(`DELETE FROM ${table}`);
  }
  flags.applyFeatureFlagIntent({ kind: "flag", id: "headless-mode", enabled: true });
});

type Reg = Parameters<typeof sessions.registerHomeSession>[0];
const reg = (over: Partial<Reg> = {}): Reg => ({
  sessionId: "s1", harness: "claude", cwd: repo, hookVersion: "1", claudePid: 4242,
  source: "startup", entrypoint: "cli", launcherDisabled: false, terminal: null, ...over,
});
const must = (r: ReturnType<typeof sessions.registerHomeSession>) => { assert.ok(r.ok, "registered"); return r.row; };

function insertTask(over: Record<string, unknown> = {}): void {
  const row = { id: "t1", title: "t", intent: "i", kind: "ship", agent: "claude", repo_root: repo, status: "running", created_at: 1, updated_at: 1, ...over };
  const cols = Object.keys(row);
  openDb().prepare(`INSERT INTO tasks (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...Object.values(row) as never[]);
}

test("F3 sessions: a hook registration records the session and resolves repo_root from cwd, including a subfolder", () => {
  const row = must(sessions.registerHomeSession(reg({ cwd: join(repo, "packages", "web") }), 1_000));
  assert.equal(row.repoRoot, realpathSync(repo));
  assert.equal(row.harness, "claude");
  assert.equal(row.startSource, "startup");
  assert.equal(row.entrypoint, "cli");
  assert.equal(row.claudePid, 4242);
  assert.equal(row.startedAt, 1_000);
  assert.equal(row.launcherOfferedAt, null);
});

test("F3 sessions: outside a repository the repo_root is null", () => {
  assert.equal(must(sessions.registerHomeSession(reg({ cwd: outside }))).repoRoot, null);
});

test("F3 sessions: the terminal and launcherDisabled are stored", () => {
  const terminal = { backend: "tmux" as const, pane: "%3", server: "/tmp/tmux-1/default" };
  const row = must(sessions.registerHomeSession(reg({ terminal, launcherDisabled: true })));
  assert.deepEqual(row.terminal, terminal);
  assert.equal(row.launcherDisabled, true);
});

test("F3 sessions: only a hook registration sets started_at, start_source and entrypoint; an MCP registration only fills a missing row", () => {
  const first = sessions.registerHomeSession(reg({ source: null, entrypoint: "cli" }), 500);
  assert.ok(first.ok && first.created);
  assert.equal(first.row.startedAt, null, "an MCP registration is not a start");
  assert.equal(first.row.startSource, null);
  assert.equal(first.row.entrypoint, null, "the MCP server does not know the entrypoint");

  const hook = sessions.registerHomeSession(reg({ source: "startup", entrypoint: "cli" }), 900);
  assert.ok(hook.ok && !hook.created);
  assert.equal(hook.row.startedAt, 900);
  assert.equal(hook.row.startSource, "startup");

  const again = sessions.registerHomeSession(reg({ source: null, entrypoint: "sdk-cli", cwd: outside }), 2_000);
  assert.ok(again.ok && !again.created);
  assert.equal(again.row.startSource, "startup", "a later MCP registration never rewrites the hook's record");
  assert.equal(again.row.entrypoint, "cli");
  assert.equal(again.row.cwd, repo);
  assert.equal(again.row.startedAt, 900);
});

test("F3 sessions: a missed SessionStart registers on a later event with an unknown source, which keeps the launcher off", () => {
  const row = must(sessions.registerHomeSession(reg({ source: null, entrypoint: "cli" })));
  assert.equal(row.startSource, null);
  assert.equal(launcher.launcherOfferable(row), false);
});

test("F3 sessions: a resume of a known session keeps its id and launcher record but updates the source", () => {
  sessions.registerHomeSession(reg(), 100);
  openDb().prepare("UPDATE home_dispatch_sessions SET launcher_offered_at = 150 WHERE session_id = 's1'").run();
  const row = must(sessions.registerHomeSession(reg({ source: "resume" }), 200));
  assert.equal(row.startSource, "resume");
  assert.equal(row.launcherOfferedAt, 150);
  assert.equal(row.startedAt, 100);
});

test("F3 sessions: workers are refused with 403 by session id, harness session id, binding and worktree", async () => {
  insertTask({ id: "t1", session_id: "sdk:abc" });
  assert.equal(sessions.isWorkerSession("sdk:abc", repo), true, "a task's own Mission session id");

  openDb().prepare("INSERT INTO sdk_sessions (id, agent, agent_session_id, cwd, status, created_at, updated_at) VALUES ('sdk:def', 'claude', 'claude-xyz', ?, 'running', 1, 1)").run(repo);
  const refusedSdk = sessions.registerHomeSession(reg({ sessionId: "claude-xyz" }));
  assert.ok(!refusedSdk.ok && refusedSdk.status === 403, "an SDK session's harness id");

  openDb().prepare("INSERT INTO session_agent_bindings (session_id, agent_session_id, updated_at) VALUES ('proc:1', 'bound-id', 1)").run();
  insertTask({ id: "t2", session_id: "proc:1" });
  const refusedBound = sessions.registerHomeSession(reg({ sessionId: "bound-id" }));
  assert.ok(!refusedBound.ok && refusedBound.status === 403, "a terminal session bound to a task");

  const res = await (await import("../src/server/home-dispatch/sessions.ts")).handleRegisterSession(reg({ sessionId: "claude-xyz", source: null }));
  assert.equal(res.status, 403);
  assert.equal(openDb().prepare("SELECT COUNT(*) n FROM home_dispatch_sessions").get()!.n, 0, "a refused worker leaves no row");
});

test("F3 sessions: a folder inside a live task's worktree is refused, comparing real paths; a finished task's is not", () => {
  const tree = join(home, "worktree-a");
  mkdirSync(join(tree, "src"), { recursive: true });
  const link = join(home, "link-to-tree");
  symlinkSync(tree, link);
  insertTask({ id: "live", worktree_path: tree, status: "running" });
  for (const cwd of [tree, join(tree, "src"), join(link, "src")]) {
    const refused = sessions.registerHomeSession(reg({ sessionId: "w-" + cwd.length, cwd }));
    assert.ok(!refused.ok && refused.status === 403, cwd);
  }
  openDb().prepare("UPDATE tasks SET status = 'done' WHERE id = 'live'").run();
  must(sessions.registerHomeSession(reg({ sessionId: "after-done", cwd: tree })));
});

test("F3 sessions: a secondary repository's worktree of a live task is refused too", () => {
  const tree = join(home, "worktree-b");
  mkdirSync(tree);
  insertTask({ id: "multi", status: "dispatching" });
  openDb().prepare("INSERT INTO task_repos (task_id, repo_root, worktree_path, position) VALUES ('multi', ?, ?, 1)").run(outside, tree);
  assert.equal(sessions.isWorkerSession("anyone", tree), true);
});

test("F3 sessions: a terminal session the daemon only discovered, with no task, may register", () => {
  assert.equal(sessions.isWorkerSession("loose", repo), false);
  must(sessions.registerHomeSession(reg({ sessionId: "loose" })));
});

test("F3 sessions: a harness that cannot be a home session yet is refused with 400", () => {
  const res = sessions.registerHomeSession(reg({ harness: "codex" }));
  assert.ok(!res.ok && res.status === 400);
});

test("F3 sessions: after /clear the newer hook registration for the same pid is the caller", () => {
  sessions.registerHomeSession(reg({ sessionId: "old", claudePid: 77 }), 100);
  assert.equal(sessions.resolveHomeSession("old", 77)!.sessionId, "old");
  sessions.registerHomeSession(reg({ sessionId: "new", claudePid: 77, source: "clear" }), 200);
  assert.equal(sessions.resolveHomeSession("old", 77)!.sessionId, "new", "the stale id from the MCP server's environment resolves forward");
  assert.equal(sessions.resolveHomeSession("old")!.sessionId, "new", "the row's own pid is enough");
  assert.equal(sessions.resolveHomeSession("new", 77)!.sessionId, "new");
  sessions.registerHomeSession(reg({ sessionId: "other", claudePid: 88 }), 300);
  assert.equal(sessions.resolveHomeSession("old", 77)!.sessionId, "new", "another pid never captures it");
});

test("F3 sessions: a request naming an unregistered id with a known pid resolves to that pid's session", () => {
  sessions.registerHomeSession(reg({ sessionId: "live", claudePid: 91 }), 100);
  assert.equal(sessions.resolveHomeSession("never-registered", 91)!.sessionId, "live");
  assert.equal(sessions.resolveHomeSession("never-registered"), null);
});

test("F3 sessions route: POST /mcp/dispatch/sessions registers, is idempotent, and 403s a worker", async () => {
  const registry = new Registry();
  const app = buildApp({ registry, reviews: new ReviewManager(registry), tasks: new TaskManager(registry), queues: new QueueManager(registry) });
  const headers = { host: "127.0.0.1:7317", "content-type": "application/json", "x-harness-token": ensureToken() };
  const post = (body: unknown) => app.request("/mcp/dispatch/sessions", { method: "POST", headers, body: JSON.stringify(body) });
  const body = { sessionId: "s9", harness: "claude", cwd: repo };
  const first = await post(body);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { sessionId: "s9", repoRoot: realpathSync(repo), created: true });
  const second = await post(body);
  assert.deepEqual(await second.json(), { sessionId: "s9", repoRoot: realpathSync(repo), created: false });
  insertTask({ id: "tw", session_id: "sdk:w" });
  assert.equal((await post({ ...body, sessionId: "sdk:w" })).status, 403);
  flags.applyFeatureFlagIntent({ kind: "flag", id: "headless-mode", enabled: false });
  assert.equal((await post({ ...body, sessionId: "s10" })).status, 404, "flag off: the route gate answers before the handler");
  assert.equal(sessions.getHomeSession("s10"), null);
});

// ---- the launcher (7.4) ---------------------------------------------------------------

const offerable = () => must(sessions.registerHomeSession(reg()));
const claim = (prompt: string, firstTurn = true, row = sessions.getHomeSession("s1")!) => launcher.claimLauncher(row, prompt, firstTurn, 5_000);

test("F3 launcher: offered on the first plain message of a fresh interactive startup, and recorded", () => {
  offerable();
  assert.equal(claim("fix the login timeout"), "offer");
  assert.equal(sessions.getHomeSession("s1")!.launcherOfferedAt, 5_000);
});

test("F3 launcher: never offered twice in one session", () => {
  offerable();
  assert.equal(claim("one"), "offer");
  assert.equal(claim("two"), "none");
  assert.equal(launcher.claimLauncher({ ...sessions.getHomeSession("s1")!, launcherOfferedAt: null }, "three", true), "none", "a racing second claim loses the compare-and-set");
});

test("F3 launcher: never on resume, clear, compact, or a missed start", () => {
  for (const source of ["resume", "clear", "compact", null] as const) {
    sessions.registerHomeSession(reg({ sessionId: `s-${source}`, source }));
    assert.equal(claim("hello", true, sessions.getHomeSession(`s-${source}`)!), "none", String(source));
  }
});

test("F3 launcher: never in a non-interactive run or a session that is not the first turn", () => {
  sessions.registerHomeSession(reg({ sessionId: "sdk", entrypoint: "sdk-cli" }));
  assert.equal(claim("hello", true, sessions.getHomeSession("sdk")!), "none");
  offerable();
  assert.equal(claim("hello", false), "none");
});

test("F3 launcher: never when the session reported it off, or the setting is false", () => {
  sessions.registerHomeSession(reg({ sessionId: "off", launcherDisabled: true }));
  assert.equal(claim("hello", true, sessions.getHomeSession("off")!), "none");
  offerable();
  openDb().prepare("INSERT INTO app_config (key, value) VALUES (?, 'false')").run(DISPATCH_LAUNCHER_PROMPT_SETTING);
  assert.equal(launcher.launcherPromptEnabled(), false);
  assert.equal(claim("hello"), "none");
  openDb().prepare("UPDATE app_config SET value = 'true' WHERE key = ?").run(DISPATCH_LAUNCHER_PROMPT_SETTING);
  assert.equal(claim("hello"), "offer", "read for each decision, never cached");
});

test("F3 launcher: an empty prompt or a slash command is not offered, and a slash command spends the first turn", () => {
  offerable();
  assert.equal(claim("   "), "none");
  assert.equal(claim("/clear"), "none");
  assert.equal(claim("/help me"), "none");
  assert.equal(sessions.getHomeSession("s1")!.launcherOfferedAt, null, "nothing recorded for an empty or slash prompt");
  assert.equal(claim("a plain message", false), "none", "the next turn is not the first, so the session is never offered");
});

test("F3 launcher: the first prompt exactly the command records the offer but does not offer", () => {
  offerable();
  assert.equal(claim(`  ${DISPATCH_COMMAND}  `), "command-spent");
  assert.equal(sessions.getHomeSession("s1")!.launcherOfferedAt, 5_000);
  assert.equal(claim("then a message"), "none");
});

test("F3 launcher: the command with arguments is a slash command and is not offered", () => {
  offerable();
  assert.equal(claim(`${DISPATCH_COMMAND} bugfix login times out`), "none");
});

test("F3 launcher: the setting defaults to on when unset or unreadable", () => {
  assert.equal(launcher.launcherPromptEnabled(), true);
  openDb().prepare("INSERT INTO app_config (key, value) VALUES (?, 'not json')").run(DISPATCH_LAUNCHER_PROMPT_SETTING);
  assert.equal(launcher.launcherPromptEnabled(), true);
});

test("F3 launcher: launcherOfferable is the prompt-free half of the rule, for the banner's hint", () => {
  const row = offerable();
  assert.equal(launcher.launcherOfferable(row), true);
  assert.equal(launcher.launcherOfferable({ ...row, launcherOfferedAt: 1 }), false);
  assert.equal(launcher.launcherOfferable({ ...row, startSource: "resume" }), false);
  assert.equal(launcher.launcherOfferable(row, false), false);
});
