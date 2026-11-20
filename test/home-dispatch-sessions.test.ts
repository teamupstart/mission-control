// Headless mode phase 3: home-session registration, the home-session rules every other
// /dispatch route calls, the launcher decision and the dispatch-intent detector.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

// Above the imports: `openDb` refuses a state dir this file did not name.
const home = realpathSync(mkdtempSync(join(tmpdir(), "mission-home-dispatch-sessions-")));
process.env.MISSION_HOME = home;

const { buildApp } = await import("../src/server/routes.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { closeDb, openDb } = await import("../src/server/db.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const flags = await import("../src/server/feature-flags/index.ts");
const shared = await import("../src/shared/home-dispatch.ts");
const sessions = await import("../src/server/home-dispatch/sessions.ts");
const { shouldOfferLauncher } = await import("../src/server/home-dispatch/launcher.ts");

after(() => { closeDb(); rmSync(home, { recursive: true, force: true }); });

const registry = new Registry();
const app = buildApp({
  registry, reviews: new ReviewManager(registry), tasks: new TaskManager(registry), queues: new QueueManager(registry),
});
const headers = { host: "127.0.0.1:7317", "x-harness-token": ensureToken(), "content-type": "application/json" };

function setFlag(enabled: boolean) {
  assert.equal(flags.applyFeatureFlagIntent({ kind: "flag", id: "headless-mode", enabled }).ok, true);
}
beforeEach(() => {
  setFlag(true);
  openDb().exec(`DELETE FROM home_dispatch_sessions`);
});

const repo = join(home, "repo");
mkdirSync(repo);
execFileSync("git", ["init", "-q", repo]);
const plain = join(home, "plain");
mkdirSync(plain);

const registration = (over: Record<string, unknown> = {}) => ({
  sessionId: "claude-session-1",
  harness: "claude",
  cwd: repo,
  clientVersion: "1.0.0",
  source: "startup",
  entrypoint: "cli",
  interactive: true,
  beforeFirstPrompt: true,
  launcherDisabled: false,
  ...over,
});
const register = (body: unknown) =>
  app.request("/dispatch/sessions", { method: "POST", headers, body: JSON.stringify(body) });

test("dispatchIntentFor needs Mission Control by name and a verb, and a schedule word wins", () => {
  const f = shared.dispatchIntentFor;
  assert.equal(f("run this in Mission Control"), "now");
  assert.equal(f("please KICK  OFF the refactor in mission-control"), "now");
  assert.equal(f("hand this to MC"), "now");
  assert.equal(f("delegate it to mission control"), "now");
  assert.equal(f("send this to Mission Control"), "now");
  assert.equal(f("save this to the Mission Control backlog"), "backlog");
  assert.equal(f("run this in Mission Control later"), "backlog");
  assert.equal(f("queue it in MC"), "backlog");
  assert.equal(f("park this in mission control"), "backlog");
  assert.equal(f("schedule that in Mission Control"), "backlog");
  assert.equal(f("run the tests"), null, "no Mission Control");
  assert.equal(f("what is Mission Control?"), null, "no verb");
  assert.equal(f("run this in the MCP server"), null, "MC only as a whole word");
  assert.equal(f("start in mcx"), null);
  assert.equal(f("a delegated mission control task"), null, "a verb is a whole word");
  assert.equal(f(""), null);
  assert.equal(sessions.dispatchIntentFor, shared.dispatchIntentFor, "one detector, re-exported");
});

const facts = (over: Record<string, unknown> = {}, reg: Record<string, unknown> = {}) => ({
  registration: { source: "startup" as const, entrypoint: "cli", interactive: true, beforeFirstPrompt: true, launcherDisabled: false, ...reg },
  alreadyOffered: false,
  promptSetting: true,
  registeredHomeSession: true,
  ...over,
});

test("the launcher is offered only when every condition of 7.4 holds", () => {
  assert.equal(shouldOfferLauncher(facts()), true);
  const refused: Array<[string, ReturnType<typeof facts>]> = [
    ["resume", facts({}, { source: "resume" })],
    ["clear", facts({}, { source: "clear" })],
    ["compact", facts({}, { source: "compact" })],
    ["sdk-cli", facts({}, { entrypoint: "sdk-cli" })],
    ["no entrypoint", facts({}, { entrypoint: null })],
    ["not interactive", facts({}, { interactive: false })],
    ["after the first prompt", facts({}, { beforeFirstPrompt: false })],
    ["already offered", facts({ alreadyOffered: true })],
    ["setting off", facts({ promptSetting: false })],
    ["launcher disabled", facts({}, { launcherDisabled: true })],
    ["not a home session", facts({ registeredHomeSession: false })],
  ];
  for (const [why, f] of refused) assert.equal(shouldOfferLauncher(f), false, why);
});

test("registration answers the 7.2 shape, offers the launcher once, and sets no runtime", async () => {
  const res = await register(registration());
  assert.equal(res.status, 200);
  const answer = shared.HomeSessionRegistrationAnswerSchema.parse(await res.json());
  assert.equal(answer.sessionId, "claude-session-1");
  assert.equal(answer.repoRoot, realpathSync(repo));
  assert.equal(answer.created, true);
  assert.equal(answer.offerLauncher, true);
  assert.deepEqual(answer.counts, { running: 0, waiting: 0 });
  assert.equal(answer.minModApi, shared.HOME_DISPATCH_MIN_MOD_API);
  assert.match(answer.dashboardUrl, /^http:\/\/127\.0\.0\.1:\d+\/$/);

  const again = shared.HomeSessionRegistrationAnswerSchema.parse(await (await register(registration())).json());
  assert.equal(again.created, false);
  assert.equal(again.offerLauncher, false, "never offered twice in one session");
  assert.ok(sessions.getHomeSession("claude-session-1")?.launcherOfferedAt, "the offer is recorded");

  const columns = (openDb().prepare(`PRAGMA table_info(home_dispatch_sessions)`).all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(!columns.some((c) => c.includes("runtime")), "the session record has no runtime");
  assert.equal(registry.snapshot().sessions.length, 0, "registering adds nothing to the session registry");
});

test("a /clear, a late registration and a non-repository cwd do not offer the launcher", async () => {
  const cleared = shared.HomeSessionRegistrationAnswerSchema.parse(
    await (await register(registration({ sessionId: "after-clear", source: "clear" }))).json());
  assert.equal(cleared.offerLauncher, false);
  const late = shared.HomeSessionRegistrationAnswerSchema.parse(
    await (await register(registration({ sessionId: "late", beforeFirstPrompt: false }))).json());
  assert.equal(late.offerLauncher, false);
  const outside = shared.HomeSessionRegistrationAnswerSchema.parse(
    await (await register(registration({ sessionId: "outside", cwd: plain }))).json());
  assert.equal(outside.repoRoot, null);
  assert.equal(outside.offerLauncher, true, "a launcher may be offered outside a repository");
  const disabled = shared.HomeSessionRegistrationAnswerSchema.parse(
    await (await register(registration({ sessionId: "off", launcherDisabled: true }))).json());
  assert.equal(disabled.offerLauncher, false);
});

test("a malformed registration is a 400 and writes nothing", async () => {
  assert.equal((await register({ sessionId: "x" })).status, 400);
  assert.equal((await register(registration({ source: "weird" }))).status, 400);
  assert.equal(sessions.getHomeSession("x"), null);
});

test("an SDK session is refused with 403 under its Mission id and its harness id, and leaves no row", async () => {
  registry.registerSdkSession({ id: "sdk:worker-1", agent: "claude", name: "worker", cwd: repo, agentSessionId: "harness-worker-1" });
  for (const sessionId of ["sdk:worker-1", "harness-worker-1"]) {
    const res = await register(registration({ sessionId }));
    assert.equal(res.status, 403, sessionId);
    assert.match(((await res.json()) as { error: string }).error, /Mission Control worker/);
    assert.equal(sessions.getHomeSession(sessionId), null);
  }
});

type Deps = Parameters<typeof sessions.workerRefusal>[0];
function depsWith(over: { sessions?: unknown[]; tasks?: unknown[] }): Deps {
  const list = (over.sessions ?? []) as Array<{ id: string; agentSessionId?: string | null; runtime: string }>;
  return {
    registry: {
      getSession: (id: string) => list.find((s) => s.id === id),
      snapshot: () => ({ sessions: list }),
      listTasks: () => over.tasks ?? [],
    },
  } as unknown as Deps;
}

test("worker rule: a task-bound terminal session is a worker, a discovered one is the person's", () => {
  const terminal = { id: "proc:t:1:1", runtime: "terminal", agentSessionId: "h-1" };
  const bound = depsWith({ sessions: [terminal], tasks: [{ sessionId: "proc:t:1:1", status: "running", worktreePath: null, extraRepos: [] }] });
  assert.match(sessions.workerRefusal(bound, "h-1", undefined)?.reason ?? "", /bound to a Mission Control task/);
  assert.equal(sessions.workerRefusal(depsWith({ sessions: [terminal] }), "h-1", undefined), null);
  for (const status of ["done", "failed", "cancelled"]) {
    const finished = depsWith({ sessions: [terminal], tasks: [{ sessionId: "proc:t:1:1", status, worktreePath: null, extraRepos: [] }] });
    assert.equal(sessions.workerRefusal(finished, "h-1", undefined), null, `a ${status} task no longer binds the session`);
  }
  const sdk = depsWith({ sessions: [{ id: "sdk:old", runtime: "sdk" }], tasks: [{ sessionId: "sdk:old", status: "done", worktreePath: null, extraRepos: [] }] });
  assert.ok(sessions.workerRefusal(sdk, "sdk:old", undefined), "an SDK session stays a worker after its task finishes");
  assert.equal(sessions.workerRefusal(depsWith({}), "never-seen", undefined), null);
});

test("worker rule: a cwd inside a live task worktree is refused by real path, a sibling or finished task is not", () => {
  const tree = join(home, "trees", "add");
  const sibling = join(home, "trees", "add-widgets");
  const extra = join(home, "trees", "extra");
  for (const d of [tree, sibling, extra, join(tree, "src")]) mkdirSync(d, { recursive: true });
  const task = (status: string, worktreePath: string | null, extraTree: string | null = null) => ({
    sessionId: null, status, worktreePath, extraRepos: extraTree ? [{ worktreePath: extraTree }] : [],
  });
  const live = depsWith({ tasks: [task("running", tree, extra)] });
  assert.ok(sessions.workerRefusal(live, "s", join(tree, "src")), "inside the worktree");
  assert.ok(sessions.workerRefusal(live, "s", tree), "the worktree itself");
  assert.ok(sessions.workerRefusal(live, "s", extra), "an attached repository's worktree");
  assert.equal(sessions.workerRefusal(live, "s", sibling), null, "a name prefix is not containment");
  for (const status of ["done", "failed", "cancelled"]) {
    assert.equal(sessions.workerRefusal(depsWith({ tasks: [task(status, tree)] }), "s", tree), null, status);
  }
});

test("registration from a symlink into a live task worktree is a 403 and leaves no row", async () => {
  const tree = join(home, "trees-link", "live");
  mkdirSync(join(tree, "src"), { recursive: true });
  const link = join(home, "innocent-looking-link");
  symlinkSync(join(tree, "src"), link);
  const liveTask = { sessionId: null, status: "running", worktreePath: tree, extraRepos: [] };
  const original = registry.listTasks;
  registry.listTasks = (() => [liveTask]) as unknown as typeof registry.listTasks;
  try {
    const res = await register(registration({ sessionId: "via-symlink", cwd: link }));
    assert.equal(res.status, 403);
    assert.match(((await res.json()) as { error: string }).error, /inside the worktree/);
    assert.equal(sessions.getHomeSession("via-symlink"), null);
    // The same task no longer holds the path once it is finished.
    liveTask.status = "done";
    assert.equal((await register(registration({ sessionId: "via-symlink", cwd: link }))).status, 200);
  } finally {
    registry.listTasks = original;
  }
});

test("task rules: a home session sees its repository, the cli names one and answers only mctl tasks", () => {
  const home1 = { surface: "home-session" as const, sessionId: "s", repoRoot: repo };
  const cli = { surface: "cli" as const, repoRoot: repo };
  const own = { originSurface: "home-session" as const, originRepo: repo };
  const other = { originSurface: "home-session" as const, originRepo: plain };
  const mctl = { originSurface: "mctl" as const, originRepo: repo };
  const dashboard = { originSurface: null, originRepo: null };

  assert.equal(sessions.canReadTask(home1, own), null);
  assert.equal(sessions.canReadTask(home1, mctl), null);
  assert.equal(sessions.canReadTask(home1, other)?.status, 403);
  assert.equal(sessions.canReadTask(home1, dashboard)?.status, 403);
  assert.equal(sessions.canReadTask(home1, other, { residentVisible: true }), null, "a resident run the session can see");
  assert.equal(sessions.canAnswerTask(home1, own), null);

  assert.equal(sessions.canReadTask(cli, own), null, "the cli reads home-session tasks of the named repository");
  assert.equal(sessions.canReadTask(cli, mctl), null);
  assert.equal(sessions.canReadTask(cli, other)?.status, 403);
  assert.equal(sessions.canReadTask(cli, dashboard)?.status, 403);
  assert.equal(sessions.canAnswerTask(cli, mctl), null);
  assert.equal(sessions.canAnswerTask(cli, own)?.status, 403, "the cli never answers a home session's task");
  assert.equal(sessions.canMessageTask(cli, mctl)?.status, 403, "the cli never messages a session");
  assert.equal(sessions.canMessageTask(home1, own), null);
  assert.equal(sessions.canMessageTask(home1, other)?.status, 403);
});

test("requireHomeSession refuses an unregistered id and a registered session that became a worker", async () => {
  const deps = depsWith({});
  const unknown = sessions.requireHomeSession(deps, "ghost");
  assert.equal(unknown.ok, false);
  await register(registration({ sessionId: "reg-1" }));
  assert.equal(sessions.requireHomeSession(deps, "reg-1").ok, true);
  const bound = depsWith({ sessions: [{ id: "reg-1", runtime: "sdk" }] });
  const refused = sessions.requireHomeSession(bound, "reg-1");
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.refusal.status, 403);
});

test("flag off: registration is the disabled 404 and writes nothing", async () => {
  setFlag(false);
  const res = await register(registration({ sessionId: "off-flag" }));
  assert.equal(res.status, 404);
  assert.equal(sessions.getHomeSession("off-flag"), null);
});
