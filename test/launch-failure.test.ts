import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";
import type { Task } from "../src/shared/types.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { QueueManager } from "../src/server/queue.ts";

// A dispatch that never started, from the record the dispatcher writes to the routes that act
// on it. What is at stake is the failure the operator could not see: the placeholder tile left
// the board, the status said `failed` or `backlog`, and a chime was the only signal. So:
//
//  - only a LAUNCH failure carries the record - a session that ran and was lost does not, or
//    every restart would bury the board in "did not start";
//  - the record is cleared by the next attempt and answered when the same work later starts;
//  - one reason is one report, and the report's facts are built by the daemon.

const home = mkdtempSync(join(tmpdir(), "mission-launch-failure-"));
process.env.HARNESS_HOME = home;
// A binary that exists, so bin resolution is not what fails the dispatches below.
process.env.MISSION_CLAUDE_BIN = "/bin/echo";

const db = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { Dispatcher, resolveDispatchBase, resolveTaskBases } = await import("../src/server/dispatcher.ts");
const { run, stubRun } = await import("../src/server/util/exec.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { detectAlerts } = await import("../src/shared/alerts.ts");
const lf = await import("../src/shared/launch-failure.ts");
const { applySkillsConfig } = await import("../src/server/skills/config.ts");

after(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.MISSION_CLAUDE_BIN;
});

function failure(over: Partial<NonNullable<Task["launchFailure"]>> = {}): NonNullable<Task["launchFailure"]> {
  return { at: 100, phase: "launch", dismissedAt: null, reportTaskId: null, residentProfileId: null, sessionKept: false, ...over };
}

function mkRepo(name: string): string {
  const repo = join(home, name);
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@test"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
  writeFileSync(join(repo, "f.txt"), "x\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "first"]);
  // The spelling the dispatch route stores, so a task filed here and one filed through the
  // route name the same repository the same way.
  return realpathSync(repo);
}

// ---- the shared reading ----------------------------------------------------------------

test("where a launch failure is drawn follows where the task ended up", () => {
  assert.equal(lf.launchFailureOutcome(mkTask({ status: "failed" })), null, "no record, no launch failure");
  assert.equal(lf.launchFailureOutcome(mkTask({ status: "failed", launchFailure: failure() })), "not-started");
  assert.equal(lf.launchFailureOutcome(mkTask({ status: "backlog", launchFailure: failure() })), "returned");
  assert.equal(
    lf.launchFailureOutcome(mkTask({ status: "failed", sessionId: "s1", launchFailure: failure() })),
    "kept",
  );
  // Moved on - settled by the operator, or running again - and a stale record draws nothing.
  assert.equal(lf.launchFailureOutcome(mkTask({ status: "cancelled", launchFailure: failure() })), null);
  assert.equal(lf.launchFailureOutcome(mkTask({ status: "running", launchFailure: failure() })), null);
  assert.equal(lf.hasOpenLaunchFailure(mkTask({ status: "failed", launchFailure: failure({ dismissedAt: 5 }) })), false);
});

test("attempts of the same work failing the same way are one group, newest first", () => {
  const resident = (id: string, at: number, workspace: string, error = "could not connect to its MCP server commonroom") =>
    mkTask({
      id,
      kind: "resident",
      workspaceKind: "resident-workspace",
      title: "Agent Wrangler",
      repoRoot: workspace,
      status: "failed",
      error,
      launchFailure: failure({ at }),
    });
  const groups = lf.openLaunchFailureGroups([
    // Every resident launch gets its own private workspace; it is still the same work.
    resident("a", 1, "/runs/a/workspace"),
    resident("b", 3, "/runs/b/workspace"),
    resident("c", 2, "/runs/c/workspace", "a different reason"),
    resident("dismissed", 4, "/runs/d/workspace"),
    mkTask({ id: "ran-and-died", status: "failed", error: "the agent's session did not survive a restart" }),
  ].map((t) => (t.id === "dismissed" ? { ...t, launchFailure: failure({ at: 4, dismissedAt: 9 }) } : t)));
  assert.deepEqual(groups.map((g) => g.tasks.map((t) => t.id)), [["b", "a"], ["c"]]);
  assert.equal(lf.latestLaunchFailure(groups[0]!).id, "b");
});

test("an unreadable stored record reads as none rather than throwing", () => {
  assert.equal(lf.parseLaunchFailure(null), null);
  assert.equal(lf.parseLaunchFailure("{not json"), null);
  assert.equal(lf.parseLaunchFailure(JSON.stringify({ at: 1, phase: "sideways" })), null);
  assert.deepEqual(lf.parseLaunchFailure(JSON.stringify(failure())), failure());
});

// ---- the dispatcher writes it ----------------------------------------------------------

const failingBases = async (): Promise<never> => {
  throw new Error("could not freeze the remote default branch: git fetch origin failed");
};

test("a backlog kind that fails while provisioning returns to the Backlog carrying the record", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  const registry = new Registry();
  registry.upsertTask(mkTask({ id: "ship-1", kind: "ship", status: "dispatching", repoRoot: mkRepo("ship-repo") }));
  await new Dispatcher(registry, undefined, { resolveBases: failingBases }).dispatch("ship-1");

  const task = registry.getTask("ship-1")!;
  assert.equal(task.status, "backlog");
  assert.match(task.error ?? "", /git fetch origin failed/);
  assert.equal(task.launchFailure?.phase, "prepare");
  assert.equal(task.launchFailure?.dismissedAt, null);
  assert.equal(lf.launchFailureOutcome(task), "returned");
  const entries = log.mock.calls.map(({ arguments: args }) => String(args[0]))
    .filter((line) => line.startsWith("[dispatch] {"))
    .map((line) => JSON.parse(line.slice("[dispatch] ".length)));
  assert.equal(entries.length, 1, "even an early prepare refusal must reach the daemon log");
  assert.equal(entries[0].event, "dispatch_failed");
  assert.equal(entries[0].taskId, task.id);
  assert.equal(entries[0].phase, "prepare");
  assert.equal(entries[0].repoRoot, task.repoRoot);
  assert.equal(entries[0].error, task.error);
  assert.equal(Date.parse(entries[0].timestamp), task.launchFailure!.at);
});

for (const scenario of [
  { name: "origin probe timeout", step: "remote", secondary: false, script: "setInterval(() => {}, 1000)", timeoutMs: 80, exitCode: null, signal: "SIGTERM", timedOut: true },
  { name: "fetch timeout", step: "fetch", secondary: false, script: "setInterval(() => {}, 1000)", timeoutMs: 80, exitCode: null, signal: "SIGTERM", timedOut: true },
  { name: "attached repository fetch refusal", step: "fetch", secondary: true, script: 'process.stderr.write("remote refused\\nsecond line\\n"); process.exit(128)', timeoutMs: 5000, exitCode: 128, signal: null, timedOut: false },
  { name: "remote HEAD probe killed externally", step: "ls-remote", secondary: false, script: 'process.kill(process.pid, "SIGTERM")', timeoutMs: 5000, exitCode: null, signal: "SIGTERM", timedOut: false },
]) {
  test(`prepare logs process facts for ${scenario.name} before returning to Backlog`, async (t) => {
    const log = t.mock.method(console, "error", () => {});
    const repo = mkRepo(`diagnostic-${scenario.step}-${scenario.secondary}-${scenario.timedOut}`);
    const attached = mkRepo(`attached-${scenario.step}-${scenario.secondary}-${scenario.timedOut}`);
    const failedRepo = scenario.secondary ? attached : repo;
    const registry = new Registry();
    const id = `diagnostic-${scenario.name}`;
    registry.upsertTask(mkTask({
      id, kind: "ship", status: "dispatching", repoRoot: repo,
      extraRepos: [{
        repoRoot: attached, worktreePath: null, branch: null, provider: null,
        worktreeLeaseId: null, baseSha: null, prUrl: null, prState: null, mergedAt: null,
      }],
    }));
    let failedCommands = 0;
    const execute: typeof run = async (bin, args, opts) => {
      if (args[1] !== failedRepo) return run(bin, args, opts);
      if (args.includes(scenario.step)) {
        failedCommands++;
        assert.equal(opts?.timeoutMs, scenario.step === "remote" ? 15_000 : 30_000,
          "the production local-probe and network budgets stay bounded");
        // Exercise the real executor's timeout, signal and exit handling with a local child.
        // The shorter fixture budget avoids a 30-second wait or any network/agent access.
        return run(process.execPath, ["-e", scenario.script], { timeoutMs: scenario.timeoutMs });
      }
      if (args.includes("remote")) return stubRun({ code: 0, stdout: "origin\n", stderr: "" });
      if (args.includes("for-each-ref")) return stubRun({ code: 0, stdout: "refs/heads/main\n", stderr: "" });
      if (args.includes("fetch")) return stubRun({ code: 0, stdout: "", stderr: "" });
      assert.fail(`unexpected command ${args.join(" ")}`);
    };
    await new Dispatcher(registry, undefined, {
      resolveBases: (roots, pinned) => resolveTaskBases(roots, pinned, (root) => resolveDispatchBase(root, execute)),
    }).dispatch(id);

    const task = registry.getTask(id)!;
    assert.equal(task.status, "backlog");
    assert.match(task.error!, scenario.step === "remote"
      ? /could not determine whether .* has an origin remote: git remote was stopped/
      : /could not freeze .*remote default branch/);
    assert.equal(task.worktreePath, null);
    assert.equal(task.sessionId, null);
    assert.equal(task.extraRepos[0]!.worktreePath, null);
    assert.equal(failedCommands, 1, "timeouts, signals and ordinary refusals are not retried");
    for (const root of [repo, attached]) {
      assert.equal(execFileSync("git", ["-C", root, "worktree", "list", "--porcelain"], { encoding: "utf8" })
        .split("\n").filter((line) => line.startsWith("worktree ")).length, 1);
    }
    const lines = log.mock.calls.map(({ arguments: args }) => String(args[0]))
      .filter((line) => line.startsWith("[dispatch] {"));
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.includes("\n"), false, "stderr newlines cannot split the structured log record");
    const entry = JSON.parse(lines[0]!.slice("[dispatch] ".length));
    assert.equal(entry.event, "dispatch_failed");
    assert.equal(entry.taskId, id);
    assert.equal(entry.phase, "prepare");
    assert.equal(entry.repoRoot, failedRepo, "an attached failure must name the attached repository");
    assert.equal(entry.error, task.error);
    assert.equal(Date.parse(entry.timestamp), task.launchFailure!.at);
    assert.deepEqual(entry.git.command, ["git", "-C", failedRepo, ...(
      scenario.step === "remote" ? ["remote"]
        : scenario.step === "fetch" ? ["fetch", "origin"] : ["ls-remote", "--symref", "origin", "HEAD"]
    )]);
    assert.ok(entry.git.elapsedMs >= (scenario.timedOut ? scenario.timeoutMs - 1 : 0));
    assert.equal(entry.git.timeoutMs, scenario.timeoutMs);
    assert.equal(entry.git.exitCode, scenario.exitCode);
    assert.equal(entry.git.signal, scenario.signal);
    assert.equal(entry.git.timedOut, scenario.timedOut);
    assert.equal(entry.git.outcomeUnknown, scenario.signal !== null);
    assert.equal(entry.git.overflowed, false);
  });
}

test("a chat, which has no backlog, fails as not-started, and its next attempt starts with no record", async () => {
  const registry = new Registry();
  registry.upsertTask(mkTask({ id: "chat-1", kind: "chat", status: "dispatching", repoRoot: mkRepo("chat-repo") }));
  const dispatcher = new Dispatcher(registry, undefined, { resolveBases: failingBases });
  await dispatcher.dispatch("chat-1");
  assert.equal(registry.getTask("chat-1")!.status, "failed");
  assert.equal(lf.launchFailureOutcome(registry.getTask("chat-1")!), "not-started");

  // The next attempt clears it before it does anything else: what it sees is its own state.
  let seenDuringRetry: unknown = "unread";
  const observing = new Dispatcher(registry, undefined, {
    resolveBases: async () => {
      seenDuringRetry = registry.getTask("chat-1")!.launchFailure;
      return failingBases();
    },
  });
  registry.upsertTask({ ...registry.getTask("chat-1")!, status: "dispatching" });
  await observing.dispatch("chat-1");
  assert.equal(seenDuringRetry, null);
  assert.equal(lf.launchFailureOutcome(registry.getTask("chat-1")!), "not-started", "and it failed again, freshly");
});

// ---- it survives a restart, and an upgrade ----------------------------------------------

test("the record round-trips through the database and reads back after a restart", () => {
  db.upsertTask(mkTask({ id: "persisted", status: "failed", launchFailure: failure({ residentProfileId: "p1" }) }));
  assert.deepEqual(new Registry().getTask("persisted")!.launchFailure, failure({ residentProfileId: "p1" }));
  db.upsertTask(mkTask({ id: "plain", status: "failed" }));
  assert.equal(db.getTask("plain")!.launchFailure, null);
});

test("a database from before the column upgrades, keeping its rows and drawing none as launch failures", () => {
  db.upsertTask(mkTask({ id: "historical", status: "failed", error: "an old failure" }));
  db.closeDb();
  const raw = new DatabaseSync(join(home, "harness.db"));
  raw.exec("ALTER TABLE tasks DROP COLUMN launch_failure; PRAGMA user_version = 14;");
  raw.close();
  const backups = join(home, "backups", "database");
  const before = new Set(existsSync(backups) ? readdirSync(backups) : []);
  const opened = db.openDb();
  const columns = opened.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  assert.ok(columns.some((c) => c.name === "launch_failure"));
  const task = db.getTask("historical")!;
  assert.equal(task.error, "an old failure");
  assert.equal(task.launchFailure, null);
  assert.equal(
    readdirSync(backups).filter((name) => !before.has(name) && name.startsWith("pre-migration-")).length,
    1,
    "the upgrade captured its own recovery point",
  );
});

// ---- the alert -------------------------------------------------------------------------

test("a dispatch put back in the Backlog now alerts, where it used to move columns in silence", () => {
  const before = mkTask({ id: "back", status: "dispatching" });
  const after = mkTask({ id: "back", status: "backlog", error: "git fetch origin failed", launchFailure: failure() });
  const scope = (t: Task) => ({ sessions: [], tasks: [t], reviews: [] }) as unknown as Parameters<typeof detectAlerts>[0];
  const alerts = detectAlerts(scope(before), scope(after));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.severity, "attention");
  assert.match(alerts[0]!.title, /Did not start, back in Backlog/);
  const failed = detectAlerts(scope(before), scope({ ...after, status: "failed" }));
  assert.match(failed[0]!.title, /^Did not start: /);
});

// ---- the routes ------------------------------------------------------------------------

function setup() {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const dispatched: string[] = [];
  (tasks as unknown as { dispatcher: { dispatch(id: string): Promise<void> } }).dispatcher = {
    dispatch: async (id: string) => {
      dispatched.push(id);
    },
  };
  const app = buildApp({
    registry,
    reviews: {} as unknown as ReviewManager,
    tasks,
    queues: {} as unknown as QueueManager,
  });
  const post = async (path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await app.request(path, {
      method: "POST",
      headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { registry, tasks, dispatched, post };
}

function wrangler(id: string, at: number): Task {
  return mkTask({
    id,
    kind: "resident",
    workspaceKind: "resident-workspace",
    title: "Agent Wrangler",
    repoRoot: `/runs/${id}/workspace`,
    status: "failed",
    error: "this resident's Claude Code session could not connect to its MCP server commonroom",
    launchFailure: failure({ at, phase: "launch", residentProfileId: "profile-1" }),
  });
}

test("Dismiss answers every attempt it names, once", async () => {
  const { registry, post } = setup();
  registry.upsertTask(wrangler("w1", 1));
  registry.upsertTask(wrangler("w2", 2));
  const first = await post("/api/launch-failures/dismiss", { taskIds: ["w1", "w2"] });
  assert.equal(first.status, 200);
  assert.equal(first.body.dismissed, 2);
  assert.equal(lf.openLaunchFailureGroups(registry.listTasks()).length, 0);
  assert.equal((await post("/api/launch-failures/dismiss", { taskIds: ["w1"] })).body.dismissed, 0);
  assert.equal((await post("/api/launch-failures/dismiss", { taskIds: [] })).status, 400);
});

test("Report bug starts one Claude chat with a daemon-built brief, and a second press opens it", async () => {
  const { registry, dispatched, post } = setup();
  registry.upsertTask(wrangler("w1", 1));
  registry.upsertTask(wrangler("w2", 2));
  const repo = mkRepo("report-repo");

  const started = await post("/api/launch-failures/report", { taskId: "w2", repoRoot: repo });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.existing, false);
  const report = started.body.task as Task;
  assert.equal(report.kind, "chat");
  assert.equal(report.agent, "claude");
  assert.equal(report.workflowId, null, "a report is not reviewed work");
  assert.equal(report.title, "Report: Agent Wrangler did not start");
  assert.match(report.intent, /pressed Report bug/);
  assert.match(report.intent, /could not connect to its MCP server commonroom/);
  assert.match(report.intent, /report_product_issue/);
  assert.match(report.intent, /PUBLIC/);
  assert.match(report.intent, /Attempts that failed the same way \(2\)/);
  assert.deepEqual(dispatched, [report.id]);
  // Recorded on every attempt in the group, so each tile can open the same session.
  assert.equal(registry.getTask("w1")!.launchFailure!.reportTaskId, report.id);
  assert.equal(registry.getTask("w2")!.launchFailure!.reportTaskId, report.id);

  const again = await post("/api/launch-failures/report", { taskId: "w1", repoRoot: repo });
  assert.equal(again.body.existing, true);
  assert.equal((again.body.task as Task).id, report.id);
  assert.equal(dispatched.length, 1, "one reason, one report session");

  assert.equal((await post("/api/launch-failures/report", { taskId: "nope", repoRoot: repo })).status, 404);
});

test("Retry dispatches a backlog kind as the same task, files a chat again, and refuses a resident", async () => {
  const { registry, dispatched, post } = setup();
  const repo = mkRepo("retry-repo");
  registry.upsertTask(mkTask({ id: "ship-f", kind: "ship", status: "failed", repoRoot: repo, error: "boom", launchFailure: failure() }));
  registry.upsertTask(mkTask({ id: "chat-f", kind: "chat", status: "failed", repoRoot: repo, title: "Talk", intent: "Talk it over", error: "boom", launchFailure: failure() }));
  registry.upsertTask(wrangler("w1", 1));

  const ship = await post("/api/launch-failures/retry", { taskId: "ship-f" });
  assert.equal(ship.status, 200, JSON.stringify(ship.body));
  assert.equal((ship.body.task as Task).id, "ship-f");

  const chat = await post("/api/launch-failures/retry", { taskId: "chat-f" });
  assert.equal(chat.status, 200, JSON.stringify(chat.body));
  const clone = chat.body.task as Task;
  assert.notEqual(clone.id, "chat-f");
  assert.equal(clone.kind, "chat");
  assert.equal(clone.intent, "Talk it over");
  assert.equal(lf.launchWorkKey(clone), lf.launchWorkKey(registry.getTask("chat-f")!), "the same work, so its start answers the failure");

  assert.deepEqual(dispatched, ["ship-f", clone.id]);
  const resident = await post("/api/launch-failures/retry", { taskId: "w1" });
  assert.equal(resident.status, 409);
  assert.match(String(resident.body.error), /from its profile/);
});

test("Retry files a chat again with its own Grill me first pin, not the kind's current default", async () => {
  const { registry, post } = setup();
  const repo = mkRepo("retry-grill-repo");
  applySkillsConfig({ grillFirstKinds: ["chat"] });
  try {
    registry.upsertTask(mkTask({
      id: "chat-off", kind: "chat", status: "failed", repoRoot: repo, title: "Talk", intent: "Talk it over",
      grillFirst: false, error: "boom", launchFailure: failure(),
    }));
    const retried = await post("/api/launch-failures/retry", { taskId: "chat-off" });
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.equal((retried.body.task as Task).grillFirst, false);
  } finally {
    applySkillsConfig({ grillFirstKinds: [] });
  }
});

test("when the same work starts, its earlier launch failures are answered, and unrelated ones are not", () => {
  const registry = new Registry();
  const dispatcher = new Dispatcher(registry, undefined, {});
  registry.upsertTask(mkTask({ id: "old", kind: "chat", title: "Talk", status: "failed", error: "boom", launchFailure: failure() }));
  registry.upsertTask(mkTask({ id: "other", kind: "chat", title: "Something else", status: "failed", error: "boom", launchFailure: failure() }));
  registry.upsertTask(mkTask({ id: "retry", kind: "chat", title: "Talk", status: "dispatching" }));
  // Every launch arm - terminal, embedded, managed pipeline host - reaches `running` through
  // the one patch, which is why the answer is read off that transition.
  (dispatcher as unknown as { patch(id: string, fields: Partial<Task>): void }).patch("retry", { status: "running", sessionId: "s1" });
  assert.notEqual(registry.getTask("old")!.launchFailure!.dismissedAt, null);
  assert.equal(registry.getTask("other")!.launchFailure!.dismissedAt, null);
});

test("Retry refuses a kept failure at the server, dispatching nothing and reclaiming nothing", async () => {
  const { registry, dispatched, post } = setup();
  const repo = mkRepo("kept-repo");
  // Both ways a failure is kept: the dispatcher recorded it, or the task is still bound to
  // its session. Either way the agent may be working in that worktree.
  registry.upsertTask(mkTask({
    id: "kept-recorded", kind: "ship", status: "failed", repoRoot: repo, worktreePath: "/pool/kept/1", provider: "git",
    error: "boom - its session and worktree were kept; open or Cancel it", launchFailure: failure({ sessionKept: true }),
  }));
  registry.upsertTask(mkTask({
    id: "kept-bound", kind: "ship", status: "failed", repoRoot: repo, worktreePath: "/pool/kept/2", provider: "git",
    sessionId: "s-live", error: "boom", launchFailure: failure(),
  }));
  for (const id of ["kept-recorded", "kept-bound"]) {
    const before = registry.getTask(id)!;
    const refused = await post("/api/launch-failures/retry", { taskId: id });
    assert.equal(refused.status, 409, id);
    assert.match(String(refused.body.error), /only a launch that failed with no session/, id);
    const after = registry.getTask(id)!;
    assert.equal(after.status, "failed", id);
    assert.equal(after.worktreePath, before.worktreePath, `${id}: its worktree is untouched`);
    assert.equal(after.sessionId, before.sessionId, id);
    assert.deepEqual(after.launchFailure, before.launchFailure, id);
  }
  assert.deepEqual(dispatched, []);
});

test("Retry of a failed Backlog task that kept a worktree reclaims it first, and refuses when it cannot", async () => {
  const { registry, tasks, dispatched, post } = setup();
  const repo = mkRepo("retained-repo");
  const tree = realpathSync(mkdtempSync(join(home, "retained-tree-"))) + "/wt";
  execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "harness/retained", tree]);
  const failed = mkTask({
    id: "retained", kind: "ship", status: "failed", repoRoot: repo, worktreePath: tree, branch: "harness/retained",
    provider: "git", error: "boom", launchFailure: failure(),
  });

  // The refusal first: a cleanup already holding this task's resources stops the re-file, and
  // with it the dispatch - the tree and the failure stay exactly as they were.
  registry.upsertTask(failed);
  const reservations = (tasks as unknown as { cleanupReservations: Set<string> }).cleanupReservations;
  reservations.add("retained");
  const refused = await post("/api/launch-failures/retry", { taskId: "retained" });
  reservations.delete("retained");
  assert.equal(refused.status, 409);
  assert.match(String(refused.body.error), /being cleaned up/);
  assert.deepEqual(dispatched, []);
  assert.equal(registry.getTask("retained")!.worktreePath, tree);
  assert.ok(existsSync(tree), "a refused retry reclaims nothing");
  assert.equal(lf.launchFailureOutcome(registry.getTask("retained")!), "not-started");

  // Then the retry: the retained tree is reclaimed by the re-file, and the clean row dispatched.
  const retried = await post("/api/launch-failures/retry", { taskId: "retained" });
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.deepEqual(dispatched, ["retained"]);
  const after = registry.getTask("retained")!;
  assert.equal(after.worktreePath, null, "the re-file released the retained worktree");
  assert.equal(existsSync(tree), false, "and the checkout itself is gone");
  assert.equal(after.launchFailure, null, "the re-file answered the failure");
});

test("resident failures are keyed by profile: same-named profiles stay apart, and only the launched profile is cleared", () => {
  const resident = (id: string, profile: string, title = "Agent Wrangler") => mkTask({
    id, kind: "resident", workspaceKind: "resident-workspace", title, repoRoot: `/runs/${id}/workspace`,
    status: "failed", error: "could not connect to its MCP server commonroom",
    launchFailure: failure({ residentProfileId: profile }),
  });
  // Two profiles that share a name and a failure reason are two problems, not one tile.
  const groups = lf.openLaunchFailureGroups([resident("a1", "profile-a"), resident("b1", "profile-b")]);
  assert.equal(groups.length, 2);

  const registry = new Registry();
  registry.upsertTask(resident("a1", "profile-a"));
  // Renamed since it failed: still the same profile, so still the same work.
  registry.upsertTask(resident("a2", "profile-a", "Agent Wrangler (renamed)"));
  registry.upsertTask(resident("b1", "profile-b"));
  registry.upsertTask(mkTask({ id: "a-new", kind: "resident", workspaceKind: "resident-workspace", title: "Agent Wrangler", repoRoot: "/runs/a-new/workspace", status: "dispatching" }));
  registry.upsertTask(mkTask({ id: "unknown-new", kind: "resident", workspaceKind: "resident-workspace", title: "Agent Wrangler", repoRoot: "/runs/u/workspace", status: "dispatching" }));
  const profiles: Record<string, string | null> = { "a-new": "profile-a", "unknown-new": null };
  const dispatcher = new Dispatcher(registry, undefined, { residentProfileId: (task: Task) => profiles[task.id] ?? null });
  const patch = (dispatcher as unknown as { patch(id: string, fields: Partial<Task>): void }).patch.bind(dispatcher);

  // A resident whose profile cannot be named clears nothing - least of all a same-named one.
  patch("unknown-new", { status: "running", sessionId: "s-u" });
  for (const id of ["a1", "a2", "b1"]) assert.equal(registry.getTask(id)!.launchFailure!.dismissedAt, null, id);

  patch("a-new", { status: "running", sessionId: "s-a" });
  assert.notEqual(registry.getTask("a1")!.launchFailure!.dismissedAt, null);
  assert.notEqual(registry.getTask("a2")!.launchFailure!.dismissedAt, null, "a rename does not hide its own failure from the profile");
  assert.equal(registry.getTask("b1")!.launchFailure!.dismissedAt, null, "another profile with the same name is left alone");
});

test("a report session carries its own identity, through its original's retry and through its own", async () => {
  const { registry, post } = setup();
  const repo = mkRepo("identity-repo");
  registry.upsertTask(mkTask({ id: "orig", kind: "ship", status: "failed", repoRoot: repo, title: "Ship it", error: "boom", launchFailure: failure() }));
  const started = await post("/api/launch-failures/report", { taskId: "orig", repoRoot: repo });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const reportId = (started.body.task as Task).id;
  assert.equal(registry.getTask(reportId)!.launchReportFor, "orig");
  assert.equal(lf.isLaunchFailureReport(registry.getTask(reportId)!), true);

  // The original is retried. The route hands it to the dispatcher (stubbed here), whose first
  // write clears the record - and with it the only pointer from the original to the report.
  assert.equal((await post("/api/launch-failures/retry", { taskId: "orig" })).status, 200);
  registry.upsertTask({ ...registry.getTask("orig")!, status: "running", sessionId: "s-orig", launchFailure: null });
  assert.equal(lf.isLaunchFailureReport(registry.getTask(reportId)!), true, "the report is still a report");

  // The report itself fails to start and is retried: the chat filed again is still a report.
  registry.upsertTask({ ...registry.getTask(reportId)!, status: "failed", error: "boom", launchFailure: failure() });
  const retried = await post("/api/launch-failures/retry", { taskId: reportId });
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  const clone = retried.body.task as Task;
  assert.notEqual(clone.id, reportId);
  assert.equal(registry.getTask(clone.id)!.launchReportFor, "orig");
});

test("two Report bug presses for one reason at the same moment start one report session", async () => {
  const { registry, dispatched, post } = setup();
  const repo = mkRepo("concurrent-report-repo");
  registry.upsertTask(wrangler("c1", 1));
  registry.upsertTask(wrangler("c2", 2));
  // Both presses are in flight together, so neither can have seen the other's report id.
  const [first, second] = await Promise.all([
    post("/api/launch-failures/report", { taskId: "c1", repoRoot: repo }),
    post("/api/launch-failures/report", { taskId: "c2", repoRoot: repo }),
  ]);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const ids = [(first.body.task as Task).id, (second.body.task as Task).id];
  assert.equal(ids[0], ids[1], "both presses are answered with the same session");
  assert.deepEqual([first.body.existing, second.body.existing].sort(), [false, true]);
  assert.equal(dispatched.length, 1, "one reason, one report session");
  // Scoped to this case's failures: the file's other cases share the test database.
  const reports = registry.listTasks().filter((t) => t.launchReportFor === "c1" || t.launchReportFor === "c2");
  assert.equal(reports.length, 1);
});

test("a repo-less resident's failure is recorded at launch, not while provisioning", () => {
  // Nothing is provisioned for it, so the dispatch phase would otherwise always read "prepare" -
  // and an MCP server that would not connect is a launch failure.
  const repoLess = mkTask({ kind: "resident", workspaceKind: "resident-workspace", repoRoot: "/runs/r/workspace", worktreePath: null });
  assert.equal(lf.newLaunchFailure(repoLess, 1, "p").phase, "launch");
  const repoBacked = mkTask({ kind: "resident", repoRoot: "/repo", worktreePath: null });
  assert.equal(lf.newLaunchFailure(repoBacked, 1, "p").phase, "prepare", "a repository-backed resident keeps the phase it reached");
});

test("a chat retry files one replacement, however many presses arrive before it starts", async () => {
  const { registry, dispatched, post } = setup();
  const repo = mkRepo("retry-once-repo");
  registry.upsertTask(mkTask({ id: "chat-once", kind: "chat", status: "failed", repoRoot: repo, title: "Talk once", intent: "Talk", error: "boom", launchFailure: failure() }));
  const [a, b] = await Promise.all([
    post("/api/launch-failures/retry", { taskId: "chat-once" }),
    post("/api/launch-failures/retry", { taskId: "chat-once" }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(dispatched.length, 1);
  // The replacement is still starting; a later press is refused too rather than filing another.
  const again = await post("/api/launch-failures/retry", { taskId: "chat-once" });
  assert.equal(again.status, 409);
  assert.match(String(again.body.error), /already starting/);
  assert.equal(dispatched.length, 1);
});
