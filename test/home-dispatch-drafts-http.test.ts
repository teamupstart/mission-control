// F3, F16: drafts hold the person's picks, and only Start now starts a task.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "mission-home-dispatch-drafts-home-"));
const repos = mkdtempSync(join(tmpdir(), "mission-home-dispatch-drafts-repos-"));
process.env.HARNESS_HOME = home;
process.env.HARNESS_WORKSPACE_DIRS = repos;
process.env.HARNESS_REPOS_CACHE_MS = "0";

const { ensureToken } = await import("../src/server/auth.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { openDb, closeDb } = await import("../src/server/db.ts");
const flags = await import("../src/server/feature-flags/index.ts");
const { resetDraftsForTest } = await import("../src/server/home-dispatch/drafts.ts");
const { DISPATCH_FEATURE_DISABLED, DRAFT_TTL_MS } = await import("../src/shared/home-dispatch.ts");
const { taskKindBacklogRefusal } = await import("../src/shared/task.ts");

const FLAG = "headless-mode" as const;

/** A workflow manager that answers only what a test scripts; every other method is a no-op. */
function fakeWorkflows(scripted: unknown): unknown {
  const table = scripted as Record<string, unknown>;
  return new Proxy(table, { get: (target, prop) => (prop in target ? target[prop as string] : () => undefined) });
}

after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
  rmSync(repos, { recursive: true, force: true });
});
beforeEach(() => {
  resetDraftsForTest();
  openDb().exec("DELETE FROM tasks");
  flags.applyFeatureFlagIntent({ kind: "flag", id: FLAG, enabled: true });
});
afterEach(() => {
  flags.applyFeatureFlagIntent({ kind: "flag", id: FLAG, enabled: false });
  openDb().exec("DELETE FROM app_config");
});

function gitRepo(name: string): string {
  const dir = join(repos, name);
  mkdirSync(dir, { recursive: true });
  if (!realpathSync(dir)) throw new Error("no dir");
  execFileSync("git", ["-C", dir, "init", "-q"]);
  return realpathSync(dir);
}

interface Rig {
  app: ReturnType<typeof buildApp>;
  tasks: InstanceType<typeof TaskManager>;
  dispatched: Array<{ id: string; overrideDisabled?: boolean; overridePauseHold?: boolean }>;
  refuse: { with: string | null };
}

function rig(workflows?: unknown): Rig {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const dispatched: Rig["dispatched"] = [];
  const refuse: Rig["refuse"] = { with: null };
  // The route under test must never launch a real agent. Everything up to the launch is real.
  tasks.dispatch = (async (id: string, options: { overrideDisabled?: boolean; overridePauseHold?: boolean } = {}) => {
    dispatched.push({ id, ...options });
    return refuse.with === null ? { ok: true, task: tasks.get(id)! } : { ok: false, error: refuse.with };
  }) as typeof tasks.dispatch;
  const app = buildApp({ registry, reviews: new ReviewManager(registry), tasks, queues: new QueueManager(registry), workflows: (workflows === undefined ? undefined : fakeWorkflows(workflows)) as never });
  return { app, tasks, dispatched, refuse };
}

const headers = () => ({ host: "127.0.0.1:7317", "content-type": "application/json", "x-harness-token": ensureToken() });
async function post(r: Rig, path: string, body: unknown) {
  const res = await r.app.request("/mcp/dispatch" + path, { method: "POST", headers: headers(), body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}
const caller = (repo: string, sessionId = "s1") => ({ sessionId, cwd: repo });
const create = (r: Rig, repo: string, extra: Record<string, unknown> = {}, sessionId = "s1") =>
  post(r, "/drafts", { ...caller(repo, sessionId), kind: "ship", ...extra });
const originRow = (taskId: string) =>
  openDb().prepare("SELECT origin_surface s, origin_repo r, origin_session_id sid, origin_terminal t, enabled e, status st, intent FROM tasks WHERE id = ?").get(taskId) as
    { s: string | null; r: string | null; sid: string | null; t: string | null; e: number; st: string; intent: string };

test("F3 drafts flag off: every draft route answers the disabled body and creates nothing", async () => {
  flags.applyFeatureFlagIntent({ kind: "flag", id: FLAG, enabled: false });
  const r = rig();
  const repo = gitRepo("off");
  for (const path of ["/drafts", "/drafts/x", "/drafts/x/confirm"]) {
    const res = await post(r, path, { ...caller(repo), kind: "ship", choice: "start" });
    assert.equal(res.status, 404, path);
    assert.deepEqual(res.body, DISPATCH_FEATURE_DISABLED, path);
  }
  assert.equal(r.tasks.list().length, 0);
});

test("F3 drafts: the summary shows the repo, kind, after work and the words exactly, and says what is missing", async () => {
  const r = rig();
  const repo = gitRepo("summary");
  const empty = await create(r, repo);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.needs, ["words"]);
  assert.equal(empty.body.repoRoot, repo);
  const filled = await post(r, "/drafts/" + empty.body.draftId, { ...caller(repo), words: "  add retries\nto the client  ", context: "see client.ts" });
  assert.equal(filled.status, 200);
  assert.deepEqual(filled.body.needs, []);
  assert.equal(filled.body.words, "  add retries\nto the client  ", "the person's words are never trimmed or rewritten");
  assert.equal(filled.body.brief, "  add retries\nto the client  \n\n## Context Claude added\nsee client.ts");
  assert.ok(filled.body.text.startsWith("Repo: " + repo + "\nKind: ship\nAfter work: "));
  assert.ok(filled.body.text.includes("\n\nDescription:\n  add retries\nto the client  \n\nContext Claude added:\nsee client.ts"));
  assert.equal(filled.body.afterWorkApplies, true);
});

test("F3 drafts: changing the kind without a workflow resets after work to the new kind's default", async () => {
  const r = rig();
  const repo = gitRepo("reset");
  const draft = await create(r, repo, { workflowId: null, words: "x" });
  assert.equal(draft.body.afterWork, null, "None was chosen");
  const bugfix = await post(r, "/drafts/" + draft.body.draftId, { ...caller(repo), kind: "bugfix" });
  assert.equal(bugfix.body.kind, "bugfix");
  assert.ok(bugfix.body.afterWork, "bugfix arms its own review again");
  const same = await post(r, "/drafts/" + draft.body.draftId, { ...caller(repo), workflowId: null });
  assert.equal(same.body.afterWork, null);
  const scout = await post(r, "/drafts/" + draft.body.draftId, { ...caller(repo), kind: "scout" });
  assert.equal(scout.body.afterWorkApplies, false);
  assert.ok(scout.body.text.includes("After work: None (no diff)"));
});

test("F3 drafts: a kind that cannot go to the backlog is a 400 with the registry's sentence", async () => {
  const r = rig();
  const repo = gitRepo("chat");
  const refused = await create(r, repo, { kind: "chat" });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, taskKindBacklogRefusal("chat"));
  const draft = await create(r, repo);
  const update = await post(r, "/drafts/" + draft.body.draftId, { ...caller(repo), kind: "chat" });
  assert.equal(update.status, 400);
});

test("F3 confirm start: creates a shelved task with its origin and the exact brief, then starts it once", async () => {
  const r = rig();
  const repo = gitRepo("start");
  const other = gitRepo("elsewhere");
  const draft = await create(r, repo, { repo: other, words: "add retries", context: "ctx" });
  const done = await post(r, "/drafts/" + draft.body.draftId + "/confirm", { ...caller(repo), choice: "start" });
  assert.equal(done.status, 200);
  assert.equal(done.body.outcome, "started");
  assert.equal(done.body.refusal, null);
  const row = originRow(done.body.taskId);
  assert.equal(row.s, "home-session");
  assert.equal(row.r, repo, "origin_repo is the session's own repository, even for a task in another one");
  assert.equal(row.sid, "s1");
  assert.equal(row.e, 0, "created disabled");
  assert.equal(row.intent, "add retries\n\n## Context Claude added\nctx");
  assert.equal(r.tasks.get(done.body.taskId)!.repoRoot, other);
  assert.deepEqual(r.dispatched, [{ id: done.body.taskId, overrideDisabled: true }]);
  const again = await post(r, "/drafts/" + draft.body.draftId + "/confirm", { ...caller(repo), choice: "start" });
  assert.equal(again.status, 404, "a second confirm is a 404");
  assert.equal(r.tasks.list().length, 1, "one draft makes at most one task");
});

test("F3 confirm backlog: the task is saved shelved and never started", async () => {
  const r = rig();
  const repo = gitRepo("backlog");
  const draft = await create(r, repo, { words: "later" });
  const done = await post(r, "/drafts/" + draft.body.draftId + "/confirm", { ...caller(repo), choice: "backlog" });
  assert.deepEqual([done.status, done.body.outcome], [200, "saved"]);
  const row = originRow(done.body.taskId);
  assert.deepEqual([row.st, row.e, row.s], ["backlog", 0, "home-session"]);
  assert.deepEqual(r.dispatched, []);
});

test("F3 confirm cancel: nothing is created and the draft is gone", async () => {
  const r = rig();
  const repo = gitRepo("cancel");
  const draft = await create(r, repo, { words: "never mind" });
  const done = await post(r, "/drafts/" + draft.body.draftId + "/confirm", { ...caller(repo), choice: "cancel" });
  assert.deepEqual(done.body, { outcome: "cancelled", taskId: null, refusal: null });
  assert.equal(r.tasks.list().length, 0);
  assert.equal((await post(r, "/drafts/" + draft.body.draftId + "/confirm", { ...caller(repo), choice: "start" })).status, 404);
});

test("F3 confirm: a refused start leaves the task saved and says why", async () => {
  const r = rig();
  const repo = gitRepo("refused");
  r.refuse.with = "launches are paused";
  const draft = await create(r, repo, { words: "go" });
  const done = await post(r, "/drafts/" + draft.body.draftId + "/confirm", { ...caller(repo), choice: "start" });
  assert.equal(done.status, 200);
  assert.deepEqual([done.body.outcome, done.body.refusal], ["saved", "launches are paused"]);
  assert.ok(done.body.taskId);
});

test("F3 confirm: a draft missing its words or repo is a 400 and is kept", async () => {
  const r = rig();
  const repo = gitRepo("missing");
  const noWords = await create(r, repo);
  const first = await post(r, "/drafts/" + noWords.body.draftId + "/confirm", { ...caller(repo), choice: "start" });
  assert.deepEqual([first.status, first.body.error], [400, "the task needs a description"]);
  const fixed = await post(r, "/drafts/" + noWords.body.draftId, { ...caller(repo), words: "now there are words" });
  assert.equal(fixed.status, 200, "the draft was kept");

  const outside = mkdtempSync(join(tmpdir(), "mission-not-a-repo-"));
  try {
    const noRepo = await create(r, outside, { words: "words" });
    assert.deepEqual(noRepo.body.needs, ["repo"]);
    const second = await post(r, "/drafts/" + noRepo.body.draftId + "/confirm", { ...caller(outside), choice: "backlog" });
    assert.deepEqual([second.status, second.body.error], [400, "the task needs a repo"]);
    const chosen = await post(r, "/drafts/" + noRepo.body.draftId, { ...caller(outside), repo });
    assert.equal(chosen.body.repoRoot, repo);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
  assert.equal(r.tasks.list().length, 0);
});

test("F16 drafts repository: a name, a path, an unknown name and an ambiguous name", async () => {
  const r = rig();
  const here = gitRepo("here");
  const named = gitRepo("agent-platform");
  mkdirSync(join(repos, "team"), { recursive: true });
  const twinA = gitRepo("team/twin");
  const twinB = gitRepo("twin");

  const byName = await create(r, here, { repo: "Agent-Platform" });
  assert.equal(byName.body.repoRoot, named, "exact name, case-insensitive");
  const byPath = await create(r, here, { repo: named });
  assert.equal(byPath.body.repoRoot, named);
  const unknown = await create(r, here, { repo: "nope" });
  assert.deepEqual([unknown.status, unknown.body.error], [400, "unknown repository nope"]);
  const ambiguous = await create(r, here, { repo: "twin" });
  assert.equal(ambiguous.status, 400);
  assert.equal(ambiguous.body.error, "twin matches " + [twinA, twinB].sort().join(", "));
  const notRepo = await create(r, here, { repo: tmpdir() });
  assert.deepEqual([notRepo.status, notRepo.body.error], [400, "not a repository: " + tmpdir()]);
});

test("F3 drafts: a new draft replaces the session's earlier one, and another session cannot touch it", async () => {
  const r = rig();
  const repo = gitRepo("owner");
  const first = await create(r, repo, { words: "one" });
  const second = await create(r, repo, { words: "two" });
  assert.notEqual(first.body.draftId, second.body.draftId);
  assert.equal((await post(r, "/drafts/" + first.body.draftId, { ...caller(repo), words: "x" })).status, 404, "replaced");
  const stranger = await post(r, "/drafts/" + second.body.draftId, { ...caller(repo, "someone-else"), words: "stolen" });
  assert.equal(stranger.status, 404);
  const stolenConfirm = await post(r, "/drafts/" + second.body.draftId + "/confirm", { ...caller(repo, "someone-else"), choice: "start" });
  assert.equal(stolenConfirm.status, 404);
  assert.equal((await post(r, "/drafts/" + second.body.draftId, { ...caller(repo), words: "mine" })).body.words, "mine");
  const theirs = await create(r, repo, { words: "theirs" }, "someone-else");
  assert.equal((await post(r, "/drafts/" + second.body.draftId, { ...caller(repo), words: "still" })).status, 200, "two sessions each hold one");
  assert.equal(theirs.status, 200);
});

test("F3 drafts: an abandoned draft expires 24 hours after its last change", async () => {
  let now = 1_000_000;
  resetDraftsForTest(() => now);
  const r = rig();
  const repo = gitRepo("expiry");
  const draft = await create(r, repo, { words: "w" });
  now += DRAFT_TTL_MS - 1;
  const touched = await post(r, "/drafts/" + draft.body.draftId, { ...caller(repo), words: "w2" });
  assert.equal(touched.status, 200, "still alive just before the limit, and the change renews it");
  now += DRAFT_TTL_MS - 1;
  assert.equal((await post(r, "/drafts/" + draft.body.draftId, { ...caller(repo), words: "w3" })).status, 200);
  now += DRAFT_TTL_MS + 1;
  assert.equal((await post(r, "/drafts/" + draft.body.draftId + "/confirm", { ...caller(repo), choice: "start" })).status, 404);
  assert.equal(r.tasks.list().length, 0);
});

test("F3 drafts: bodies are validated", async () => {
  const r = rig();
  const repo = gitRepo("validate");
  assert.equal((await post(r, "/drafts", { ...caller(repo) })).status, 400, "kind is required");
  assert.equal((await post(r, "/drafts", { ...caller(repo), kind: "pipeline" })).status, 400, "only dispatch kinds");
  assert.equal((await post(r, "/drafts/x/confirm", { ...caller(repo), choice: "maybe" })).status, 400);
});

test("F3 confirm: the chosen after-work workflow reaches the created task (default, explicit, None)", async () => {
  const { NO_MISTAKES_REVIEW_WORKFLOW_ID } = await import("../src/shared/builtin-workflow.ts");
  const r = rig({ list: () => [], workflowSelectionBlock: () => null });
  const repo = gitRepo("workflow-choice");
  const confirmed = async (extra: Record<string, unknown>) => {
    const draft = await create(r, repo, { words: "w", ...extra });
    const done = await post(r, "/drafts/" + draft.body.draftId + "/confirm", { ...caller(repo), choice: "backlog" });
    assert.equal(done.status, 200);
    return r.tasks.get(done.body.taskId)!.workflowId;
  };
  assert.equal(await confirmed({}), NO_MISTAKES_REVIEW_WORKFLOW_ID, "the kind's default");
  assert.equal(await confirmed({ workflowId: "w-explicit" }), "w-explicit");
  assert.equal(await confirmed({ workflowId: null }), null, "explicit None");
  const { getWorkflowPolicy, setWorkflowPolicy } = await import("../src/server/workflows/config.ts");
  setWorkflowPolicy({ ...getWorkflowPolicy(), kindWorkflowDefaults: { ship: "w-configured" } });
  assert.equal(await confirmed({}), "w-configured", "an operator-configured default for the kind");
  assert.equal(await confirmed({ workflowId: null }), null, "explicit None still beats the configured default");
  assert.equal(await confirmed({ kind: "bugfix" }), "builtin-workflow:bug-fix-review");
});

test("F3 confirm: a refusal before the task exists keeps the draft, creates nothing, and can be corrected", async () => {
  let block: { message: string } | null = { message: "that workflow cannot launch" };
  const r = rig({ list: () => [], workflowSelectionBlock: () => block });
  const repo = gitRepo("refusal-keep");
  const draft = await create(r, repo, { words: "go", workflowId: "w-bad" });
  const refused = await post(r, "/drafts/" + draft.body.draftId + "/confirm", { ...caller(repo), choice: "start" });
  assert.deepEqual([refused.status, refused.body.error], [409, "that workflow cannot launch"]);
  assert.equal(r.tasks.list().length, 0, "no task was created");
  assert.deepEqual(r.dispatched, []);
  const fixed = await post(r, "/drafts/" + draft.body.draftId, { ...caller(repo), workflowId: null });
  assert.equal(fixed.status, 200, "the same draft is still there");
  block = null;
  const done = await post(r, "/drafts/" + draft.body.draftId + "/confirm", { ...caller(repo), choice: "start" });
  assert.equal(done.body.outcome, "started");
  assert.equal(r.tasks.list().length, 1);
  const outside = mkdtempSync(join(tmpdir(), "mission-not-a-repo-"));
  try {
    const bad = await create(r, repo, { words: "x" });
    await post(r, "/drafts/" + bad.body.draftId, { ...caller(repo), repo });
    // A preparation refusal: the repo vanishes between choosing it and confirming.
    rmSync(repo, { recursive: true, force: true });
    const gone = await post(r, "/drafts/" + bad.body.draftId + "/confirm", { ...caller(outside), choice: "backlog" });
    assert.equal(gone.status, 400);
    assert.equal((await post(r, "/drafts/" + bad.body.draftId, { ...caller(outside), words: "y" })).status, 200, "kept after a preparation refusal");
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});
