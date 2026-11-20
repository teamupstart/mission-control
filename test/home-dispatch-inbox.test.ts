// Headless mode phase 4: the read-only inbox, the config view and the pure rules behind them.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";

// Above the imports: `openDb` refuses a state dir this file did not name.
const home = realpathSync(mkdtempSync(join(tmpdir(), "mission-home-dispatch-inbox-")));
process.env.MISSION_HOME = home;

const { buildApp } = await import("../src/server/routes.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { closeDb, openDb } = await import("../src/server/db.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const flags = await import("../src/server/feature-flags/index.ts");
const shared = await import("../src/shared/home-dispatch-inbox.ts");
const { HomeDispatchInboxSchema } = await import("../src/shared/home-dispatch.ts");
const { mkTask, mkMuxHandle } = await import("./helpers/session-fixture.ts");
const { HookIngestSchema } = await import("../src/shared/protocol.ts");
const { reviewerRowsFor, reviewerFailureClass, runChecksFor } = await import("../src/server/home-dispatch/reviewers.ts");
const { setLauncherPrompt } = await import("../src/server/home-dispatch/config.ts");
const { revisionHashFor } = await import("../src/server/home-dispatch/approval.ts");

after(() => { closeDb(); rmSync(home, { recursive: true, force: true }); });

const registry = new Registry();
const reviews = new ReviewManager(registry);
let fakeRuns: unknown[] = [];
const app = buildApp({
  registry, reviews, tasks: new TaskManager(registry), queues: new QueueManager(registry),
  workflows: { runs: () => fakeRuns, localPlanPublication: () => null } as never,
});
const headers = { host: "127.0.0.1:7317", "x-harness-token": ensureToken(), "content-type": "application/json" };
const cliHeaders = { ...headers, "x-harness-surface": "cli" };

beforeEach(() => {
  assert.equal(flags.applyFeatureFlagIntent({ kind: "flag", id: "headless-mode", enabled: true }).ok, true);
  fakeRuns = [];
});

// ---- fixtures ---------------------------------------------------------------------------

const discovered: DiscoveredSession[] = [];
/** A live terminal session the task can be bound to, found through discovery as the daemon finds one. */
function liveSession(id: string): string {
  if (!discovered.some((d) => d.syntheticId === id)) {
    discovered.push({
      syntheticId: id, agent: "claude", name: id, nameSource: "process", cwd: join(home, "worker", id), gitBranch: "feature",
      pid: 1, tty: "ttys1", terminals: [mkMuxHandle({ session: id, windowName: "w", windowIndex: 0, paneId: `%${discovered.length + 1}` })],
      startedAt: 0,
    } as DiscoveredSession);
    registry.applyDiscovery(discovered);
  }
  return id;
}

interface Home { dir: string; repo: string; sessionId: string }

const register = (body: unknown) => app.request("/dispatch/sessions", { method: "POST", headers, body: JSON.stringify(body) });

/** A git repository with a home session registered in it. */
async function homeIn(name: string, sessionId = `home-${name}`): Promise<Home> {
  const dir = join(home, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir]);
  const res = await register({
    sessionId, harness: "claude", cwd: dir, clientVersion: "1.0.0", source: "startup", entrypoint: "cli",
    interactive: true, beforeFirstPrompt: true, launcherDisabled: false,
  });
  assert.equal(res.status, 200, await res.clone().text());
  return { dir, repo: realpathSync(dir), sessionId };
}

type Origin = { surface: "home-session" | "mctl" | null; repo: string | null; session?: string | null };

function addTask(over: Parameters<typeof mkTask>[0] & { id: string }, origin: Origin | null): void {
  registry.upsertTask(mkTask({ title: over.id, createdAt: 1_000, updatedAt: 1_000, ...over }));
  const o = origin ?? { surface: null, repo: null };
  openDb()
    .prepare(`UPDATE tasks SET origin_surface = ?, origin_repo = ?, origin_session_id = ? WHERE id = ?`)
    .run(o.surface, o.repo, o.session ?? null, over.id);
}

const get = (path: string, h: Record<string, string> = headers) => app.request(path, { headers: h });
async function inboxFor(h: Home, extra = "") {
  const res = await get(`/dispatch/inbox?session=${h.sessionId}&repo=${encodeURIComponent(h.repo)}${extra}`);
  assert.equal(res.status, 200, await res.clone().text());
  return HomeDispatchInboxSchema.parse(await res.json());
}

const QUESTION = { id: "q", question: "Keep or delete?", options: [{ id: "keep", label: "Keep" }, { id: "del", label: "Delete" }] };

// ---- the pure rules ---------------------------------------------------------------------

test("inboxStateFor maps task facts to the seven states and drops what has aged out", () => {
  const now = 10 * 24 * 3600 * 1000;
  const f = (over: Partial<Parameters<typeof shared.inboxStateFor>[0]>) =>
    shared.inboxStateFor({ taskStatus: "running", enabled: true, hasPending: false, runStatus: null, settledAt: now, now, ...over });
  assert.equal(f({ hasPending: true }), "waiting");
  assert.equal(f({ taskStatus: "dispatching", hasPending: true }), "waiting");
  assert.equal(f({}), "running");
  assert.equal(f({ taskStatus: "dispatching" }), "running");
  assert.equal(f({ runStatus: "blocked" }), "blocked");
  assert.equal(f({ runStatus: "waiting_for_action" }), "blocked");
  assert.equal(f({ runStatus: "waiting_for_pr" }), "running", "a run in any other open status is still running");
  assert.equal(f({ hasPending: true, runStatus: "blocked" }), "waiting", "a pending question comes first");
  assert.equal(f({ taskStatus: "backlog" }), "queued");
  assert.equal(f({ taskStatus: "backlog", enabled: false }), "shelved");
  assert.equal(f({ taskStatus: "done" }), "ready");
  assert.equal(f({ taskStatus: "done", hasPending: true }), "waiting", "a finished task with an open request needs the person");
  assert.equal(f({ taskStatus: "done", hasPending: true, runStatus: "blocked" }), "waiting");
  assert.equal(f({ taskStatus: "done", runStatus: "running" }), "running", "its after-work run is still going");
  assert.equal(f({ taskStatus: "done", runStatus: "blocked" }), "blocked");
  assert.equal(f({ taskStatus: "done", runStatus: "completed" }), "ready");
  assert.equal(f({ taskStatus: "done", settledAt: now - 7 * 24 * 3600 * 1000 - 1 }), null, "ready lasts 7 days");
  assert.equal(f({ taskStatus: "failed", settledAt: now - 3600 * 1000 }), "failed");
  assert.equal(f({ taskStatus: "cancelled", settledAt: now - 24 * 3600 * 1000 - 1 }), null, "failed lasts 24 hours");
});

test("needsYouOrder sorts waiting then blocked, each oldest first, by age and never by type", () => {
  const item = (taskId: string, state: "waiting" | "blocked" | "running", changedAt: number) => ({ taskId, state, changedAt });
  assert.deepEqual(
    shared.needsYouOrder([
      item("blocked-old", "blocked", 1), item("waiting-new", "waiting", 90), item("running", "running", 0),
      item("waiting-old", "waiting", 10), item("resident-mid", "waiting", 50), item("blocked-new", "blocked", 5),
    ]),
    ["waiting-old", "resident-mid", "waiting-new", "blocked-old", "blocked-new"],
  );
  assert.deepEqual(shared.needsYouOrder([item("b", "waiting", 5), item("a", "waiting", 5)]), ["a", "b"], "a tie is stable");
});

test("workflowStages draws the strip from the state and the run", () => {
  const run = (status: "running" | "blocked" | "completed") => ({ status });
  assert.deepEqual(shared.workflowStages({ state: "queued" }), { start: "pending", work: "pending", review: "pending", pr: "pending", merge: "pending" });
  assert.deepEqual(shared.workflowStages({ state: "running" }), { start: "done", work: "running", review: "pending", pr: "pending", merge: "pending" });
  assert.equal(shared.workflowStages({ state: "waiting" }).work, "blocked");
  assert.deepEqual(shared.workflowStages({ state: "running", run: run("running") }), { start: "done", work: "done", review: "running", pr: "pending", merge: "pending" });
  assert.equal(shared.workflowStages({ state: "blocked", run: run("blocked") }).review, "blocked");
  const ready = shared.workflowStages({ state: "ready", run: run("completed"), pr: { number: 3, url: "u", checks: "passing" } });
  assert.deepEqual(ready, { start: "done", work: "done", review: "done", pr: "done", merge: "pending" });
  assert.equal(shared.workflowStages({ state: "failed" }).work, "blocked");
});

test("residentLoopLabel builds the 7.24 lines and sortResidents puts needs-you first", () => {
  const now = 1_000_000;
  const base = { name: "Janitor", builtIn: true, repos: 2, needsYou: false, iteration: 3, nextWakeAt: null, pauseReason: null, contextPercent: 41.6, costUsd: 0.4 };
  const label = (over: object, q?: string) => shared.residentLoopLabel({ ...base, loopState: "working", ...over } as never, now, q);
  assert.deepEqual(label({ needsYou: true }, "Rotate it?"), {
    mark: "▲", name: "Janitor", status: "waiting on you · iteration 3", asks: "asks: Rotate it?", extra: ["built-in", "2 repos", "ctx 42%"],
  });
  assert.equal(label({}).status, "working · iteration 3 · $0.40");
  assert.equal(label({ loopState: "waiting", nextWakeAt: now + 4 * 60_000 }).status, "waiting for wake · next wake 4m · iter 3");
  assert.equal(label({ loopState: "compacting" }).status, "compacting · iter 3");
  assert.equal(label({ loopState: "paused", pauseReason: "budget" }).status, "paused: budget · iter 3");
  assert.equal(label({ loopState: "paused", pauseReason: "budget" }).mark, "‖");
  assert.deepEqual(label({ repos: 0, builtIn: false, contextPercent: null }).extra, []);
  const sorted = shared.sortResidents([{ name: "b", needsYou: false }, { name: "z", needsYou: true }, { name: "a", needsYou: false }]);
  assert.deepEqual(sorted.map((r) => r.name), ["z", "a", "b"]);
});

test("receipts and approvals spell their lines as 7.8 does", () => {
  assert.equal(shared.receiptLine({ reviewId: "r", taskId: "t1", sent: "Keep", at: 1 }), 'sent "Keep" to t1');
  assert.equal(shared.approvalSent("plan", "abcdef0123"), "approve plan revision abcdef0");
  assert.equal(shared.approvalSent("review", "abcdef0123", "ship it"), "approve rev abcdef0: ship it");
  assert.equal(shared.approvalSent("reject", null), "reject");
  assert.equal(shared.approvalSent("reject", null, "no"), "reject: no");
  assert.equal(shared.workflowSlug("No-Mistakes Review (High Rigor)"), "no-mistakes-review-high-rigor");
  assert.match(shared.unreadableReceiptLine("r9"), /Answer delivered for review r9; the receipt could not be read\. Do not send it again\./);
});

// ---- the route --------------------------------------------------------------------------

test("flag off: the inbox, answers and config are the disabled 404", async () => {
  flags.applyFeatureFlagIntent({ kind: "flag", id: "headless-mode", enabled: false });
  for (const path of ["/dispatch/inbox?session=x", "/dispatch/config"]) {
    const res = await get(path);
    assert.equal(res.status, 404, path);
    assert.equal(((await res.json()) as { feature: string }).feature, "headless-mode");
  }
  const answer = await app.request("/dispatch/answers", { method: "POST", headers, body: "{}" });
  assert.equal(answer.status, 404);
});

test("the inbox refuses an unregistered session, a missing session and repo=* from the mod, and allows repo=* to the cli", async () => {
  const h = await homeIn("refusals");
  assert.equal((await get("/dispatch/inbox?session=never-registered")).status, 403);
  assert.equal((await get("/dispatch/inbox")).status, 400);
  const star = await get(`/dispatch/inbox?session=${h.sessionId}&repo=*`);
  assert.equal(star.status, 403);
  assert.match(((await star.json()) as { error: string }).error, /command line only/);
  const elsewhere = await get(`/dispatch/inbox?session=${h.sessionId}&repo=${encodeURIComponent(home)}`);
  assert.equal(elsewhere.status, 403, "a home session reads only its own repository");
  assert.equal((await get("/dispatch/inbox?repo=*", cliHeaders)).status, 200);
  assert.equal((await get("/dispatch/inbox", cliHeaders)).status, 400, "the cli must name a repository");
});

test("the inbox lists a repository's tasks by state, with needs-you ordered by age and counts that add up", async () => {
  const h = await homeIn("states");
  const mine = { surface: "home-session" as const, repo: h.repo, session: h.sessionId };
  const now = Date.now();
  addTask({ id: "run-1", status: "running", sessionId: liveSession("w-run"), dispatchedAt: now - 60_000, repoRoot: h.repo }, mine);
  addTask({ id: "ask-late", status: "running", sessionId: liveSession("w-ask-late"), updatedAt: now - 1_000 }, mine);
  addTask({ id: "ask-early", status: "running", sessionId: liveSession("w-ask-early"), updatedAt: now - 2_000 }, mine);
  addTask({ id: "q-2", status: "backlog", enabled: true, backlogRank: 2_000, createdAt: now - 10 }, mine);
  addTask({ id: "q-1", status: "backlog", enabled: true, backlogRank: 1_000, createdAt: now - 5 }, mine);
  addTask({ id: "shelf", status: "backlog", enabled: false }, mine);
  addTask({ id: "done-pr", status: "done", completedAt: now - 1000, updatedAt: now - 1000, outcomeUrl: "https://github.com/o/r/pull/77" }, mine);
  addTask({ id: "old-done", status: "done", completedAt: now - 8 * 24 * 3600 * 1000, updatedAt: now - 8 * 24 * 3600 * 1000 }, mine);
  addTask({ id: "failed-1", status: "failed", completedAt: now - 1000, updatedAt: now - 1000 }, { surface: "mctl", repo: h.repo });
  // The age is the later of the task's update and its request's creation, so both are pinned.
  reviews.create("w-ask-late", "input", "Late", "Late?", [{ ...QUESTION, id: "q-late" }], { now: now - 1_000 });
  reviews.create("w-ask-early", "input", "Early", "Early?", [{ ...QUESTION, id: "q-early" }], { now: now - 2_000 });

  const inbox = await inboxFor(h);
  const byId = Object.fromEntries(inbox.items.map((i) => [i.taskId, i]));
  assert.deepEqual(Object.keys(byId).sort(), ["ask-early", "ask-late", "done-pr", "failed-1", "q-1", "q-2", "run-1", "shelf"]);
  assert.equal(byId["run-1"]!.state, "running");
  assert.equal(byId["run-1"]!.origin, "home-session");
  assert.equal(byId["failed-1"]!.origin, "mctl");
  assert.equal(byId["q-1"]!.queuePosition, 1);
  assert.equal(byId["q-2"]!.queuePosition, 2);
  assert.equal(byId["shelf"]!.state, "shelved");
  assert.equal(byId["done-pr"]!.state, "ready");
  assert.deepEqual(byId["done-pr"]!.pr, { number: 77, url: "https://github.com/o/r/pull/77", checks: null });
  assert.equal(byId["failed-1"]!.state, "failed");
  assert.equal(byId["ask-early"]!.state, "waiting");
  assert.deepEqual(inbox.needsYou, ["ask-early", "ask-late"], "oldest first");
  assert.deepEqual(inbox.counts, { waiting: 2, blocked: 0, ready: 1, running: 1, queued: 2, shelved: 1, failed: 1 });
  assert.equal(inbox.dashboardOnly, 0);
  assert.ok(inbox.slots.ceiling >= 1 && inbox.slots.used >= 0);
  assert.equal(byId["run-1"]!.agent, "claude");
  assert.equal(byId["run-1"]!.runtime, "terminal");
  assert.equal(typeof byId["run-1"]!.canMessage, "boolean");
  assert.ok(byId["run-1"]!.elapsedMs! >= 60_000);
  const pending = byId["ask-early"]!.pending!;
  assert.deepEqual(
    { kind: pending.kind, question: pending.question, options: pending.options, allowsText: pending.allowsText, dashboardOnly: pending.dashboardOnly },
    { kind: "question", question: "Keep or delete?", options: ["Keep", "Delete"], allowsText: false, dashboardOnly: false },
  );
});

test("the inbox is a pure read: polling it settles nothing and writes nothing", async () => {
  const h = await homeIn("pure");
  addTask({ id: "pure-ask", status: "running", sessionId: liveSession("w-pure") }, { surface: "home-session", repo: h.repo });
  const review = reviews.create("w-pure", "input", "Q", "Why?", null);
  const before = JSON.stringify(openDb().prepare(`SELECT * FROM reviews WHERE id = ?`).get(review.id));
  const receipts = () => (openDb().prepare(`SELECT count(*) AS n FROM home_dispatch_receipts`).get() as { n: number }).n;
  const n = receipts();
  await inboxFor(h);
  await inboxFor(h);
  assert.equal(JSON.stringify(openDb().prepare(`SELECT * FROM reviews WHERE id = ?`).get(review.id)), before);
  assert.equal(registry.getReview(review.id)?.status, "pending");
  assert.equal(receipts(), n);
});

test("repository scoping: another repository's tasks and dashboard tasks are not listed, a session's own task always is", async () => {
  const a = await homeIn("scope-a");
  const b = await homeIn("scope-b");
  addTask({ id: "a-task", status: "running" }, { surface: "home-session", repo: a.repo, session: a.sessionId });
  addTask({ id: "b-task", status: "running" }, { surface: "home-session", repo: b.repo, session: b.sessionId });
  addTask({ id: "dash", status: "running" }, null);
  addTask({ id: "a-moved", status: "running" }, { surface: "home-session", repo: a.repo, session: b.sessionId });
  assert.deepEqual((await inboxFor(a)).items.map((i) => i.taskId).sort(), ["a-moved", "a-task"]);
  assert.deepEqual((await inboxFor(b)).items.map((i) => i.taskId).sort(), ["a-moved", "b-task"], "its own task from another repository");

  const cliA = await get(`/dispatch/inbox?repo=${encodeURIComponent(a.repo)}`, cliHeaders);
  assert.deepEqual(HomeDispatchInboxSchema.parse(await cliA.json()).items.map((i) => i.taskId).sort(), ["a-moved", "a-task"]);
  const all = HomeDispatchInboxSchema.parse(await (await get("/dispatch/inbox?repo=*", cliHeaders)).json());
  const ids = all.items.map((i) => i.taskId);
  for (const id of ["a-task", "b-task", "a-moved"]) assert.ok(ids.includes(id), id);
  assert.equal(ids.includes("dash"), false, "a dashboard task is never listed");
});

test("a blocked run puts its task in needs-you after the waiting ones, and the run block carries its rows", async () => {
  const h = await homeIn("blocked");
  const sid = liveSession("w-blocked");
  addTask({ id: "blk", status: "done", sessionId: sid, completedAt: Date.now(), updatedAt: 5_000 }, { surface: "home-session", repo: h.repo });
  addTask({ id: "wait", status: "running", sessionId: liveSession("w-wait"), updatedAt: Date.now() }, { surface: "home-session", repo: h.repo });
  reviews.create("w-wait", "input", "Q", "Q?", [QUESTION]);
  fakeRuns = [{
    id: "run-blk", sessionId: sid, workflowId: "wf-1", workflowName: "General Review", workflowVersion: 4,
    status: "blocked", phase: "round_limit", round: 3, actionWait: null, updatedAt: 1,
  }];
  const inbox = await inboxFor(h);
  assert.deepEqual(inbox.needsYou, ["wait", "blk"], "blocked after waiting, whatever its age");
  const blk = inbox.items.find((i) => i.taskId === "blk")!;
  assert.equal(blk.state, "blocked");
  assert.deepEqual(
    { slug: blk.run!.slug, version: blk.run!.version, status: blk.run!.status, phase: blk.run!.phase, step: blk.run!.step, blockedReason: blk.run!.blockedReason },
    { slug: "general-review", version: 4, status: "blocked", phase: "round_limit", step: 3, blockedReason: "round_limit" },
  );
  assert.equal(inbox.counts.blocked, 1);
});

test("a resident's pending request is an item with origin resident, visible by repository or with none", async () => {
  const h = await homeIn("resident");
  const other = await homeIn("resident-other");
  const mk = (id: string, repoRoot: string, over: object = {}) => {
    addTask({ id, status: "running", kind: "resident", repoRoot, sessionId: liveSession(`w-${id}`), ...over }, null);
    registry.upsertResidentRun({
      id: `run-${id}`, profileId: "p", profileRevision: 1, taskId: id, launchState: "launched", personaName: `Res ${id}`,
      loopState: "waiting", iteration: 2, lastSeq: 0, nextWakeAt: null, consumedGeneration: 0, pauseReason: null, wakeReason: null,
      runRequestedAt: null, createdAt: 1, compaction: { betweenIterations: true, nativeBackstop: false }, settings: {} as never,
    } as never);
    return reviews.create(`w-${id}`, "input", `Res ${id}`, "Rotate keys?", [QUESTION]);
  };
  mk("res-mine", h.repo);
  mk("res-none", h.repo, { workspaceKind: "resident-workspace", repoRoot: "", extraRepos: [] });
  mk("res-other", other.repo);
  // A resident workspace that names a primary repository belongs to that repository, not to everyone.
  mk("res-ws-other", other.repo, { workspaceKind: "resident-workspace", extraRepos: [] });
  addTask({ id: "res-idle", status: "running", kind: "resident", repoRoot: h.repo, sessionId: liveSession("w-idle") }, null);
  registry.upsertResidentRun({ id: "run-idle", profileId: "p", taskId: "res-idle", loopState: "working", iteration: 1 } as never);

  const inbox = await inboxFor(h);
  const ids = inbox.items.map((i) => i.taskId).sort();
  assert.deepEqual(ids, ["res-mine", "res-none"], "only residents with a request, in this repository or with none");
  const item = inbox.items.find((i) => i.taskId === "res-mine")!;
  assert.equal(item.origin, "resident");
  assert.equal(item.resident?.runId, "run-res-mine");
  assert.equal(item.pending?.kind, "resident-request");
  assert.equal(item.state, "waiting");
  const cli = HomeDispatchInboxSchema.parse(await (await get(`/dispatch/inbox?repo=${encodeURIComponent(h.repo)}`, cliHeaders)).json());
  assert.deepEqual(cli.items.map((i) => i.taskId), [], "the cli never sees a resident");
  const theirs = (await inboxFor(other)).items.map((i) => i.taskId).sort();
  assert.deepEqual(theirs, ["res-none", "res-other", "res-ws-other"], "the other repository sees its own residents, and the repository-less one");

  // The registration answer counts what the session's own inbox lists, residents' requests included.
  const res = await register({
    sessionId: "home-resident-again", harness: "claude", cwd: h.dir, clientVersion: "1.0.0", source: "resume", entrypoint: "cli",
    interactive: true, beforeFirstPrompt: false, launcherDisabled: false,
  });
  assert.equal(((await res.json()) as { counts: { waiting: number } }).counts.waiting, inbox.needsYou.length);
  assert.equal(inbox.needsYou.length, 2);
});

test("a managed plan, a diff, a plain plan and an unsupported form each carry the right pending block", async () => {
  const h = await homeIn("pending");
  const mine = { surface: "home-session" as const, repo: h.repo, session: h.sessionId };
  const bundle = { id: "approve-final-bundle", question: "Approve?", options: [{ id: "approve", label: "Approve final bundle" }, { id: "revise", label: "Needs revision" }] };
  const managedSid = liveSession("w-managed");
  addTask({ id: "t-managed", status: "running", sessionId: managedSid }, mine);
  const managed = reviews.create(managedSid, "plan-decisions", "Plan", "The plan body", [bundle]);
  openDb().prepare(`INSERT INTO managed_plan_reviews (review_id, plan_id, revision, session_id, task_id, manifest_hash) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(managed.id, "plan-9", 4, managedSid, "t-managed", "a".repeat(64));
  addTask({ id: "t-diff", status: "running", sessionId: liveSession("w-diff") }, mine);
  reviews.create("w-diff", "diff", "Diff", "--- a\n+++ b\n+hello", null);
  addTask({ id: "t-plain", status: "running", sessionId: liveSession("w-plain") }, mine);
  reviews.create("w-plain", "plan", "Plan", "# Plain plan", null);
  addTask({ id: "t-form", status: "running", sessionId: liveSession("w-form") }, mine);
  reviews.create("w-form", "plan-decisions", "Decide", "Body", [bundle, { ...bundle, id: "second" }, { ...bundle, id: "third" }]);

  const inbox = await inboxFor(h);
  const pending = (id: string) => inbox.items.find((i) => i.taskId === id)!.pending!;
  assert.deepEqual(
    { kind: pending("t-managed").kind, hash: pending("t-managed").revisionHash, link: pending("t-managed").link, dashboardOnly: pending("t-managed").dashboardOnly },
    { kind: "plan", hash: "a".repeat(64), link: "/?plan=plan-9&revision=4", dashboardOnly: false },
  );
  assert.equal(pending("t-diff").kind, "diff");
  assert.match(pending("t-diff").revisionHash ?? "", /^[0-9a-f]{64}$/);
  assert.equal(pending("t-plain").kind, "plan-review");
  assert.ok(pending("t-plain").revisionHash);
  assert.equal(pending("t-form").dashboardOnly, true);
  assert.equal(pending("t-form").decisions, 3);
  assert.equal(pending("t-form").kind, "plan-decisions");
  assert.equal(inbox.dashboardOnly, 1);
});

test("a review's revision hash changes with what the person is shown, and a question has none", () => {
  const review = (over: object) =>
    ({ id: "r", sessionId: "s", kind: "diff", title: "Diff", body: "+one", status: "pending", response: null, createdAt: 1, resolvedAt: null, ...over }) as never;
  const hash = (over: object) => revisionHashFor(review(over));
  assert.match(hash({}) ?? "", /^[0-9a-f]{64}$/);
  assert.equal(hash({}), hash({}), "stable for the same view");
  assert.notEqual(hash({}), hash({ body: "+two" }));
  assert.notEqual(hash({}), hash({ title: "Other" }));
  assert.notEqual(hash({}), hash({ kind: "plan" }), "a plain plan review hashes under its own kind");
  assert.equal(hash({ kind: "input" }), undefined);
});

test("subagent counts come from the SubagentStart and SubagentStop the registry recorded", async () => {
  const h = await homeIn("subs");
  const sid = "w-subs";
  liveSession(sid);
  const pane = discovered.find((d) => d.syntheticId === sid)!.terminals[0]!.paneId;
  const at = (ts: number, over: Record<string, unknown>) =>
    registry.applyHook(HookIngestSchema.parse({ agent: "claude", sessionId: `native-${sid}`, cwd: null, env: { tmuxPane: pane }, ts, ...over }));
  addTask({ id: "t-subs", status: "running", sessionId: sid }, { surface: "home-session", repo: h.repo });
  const counts = async () => (await inboxFor(h)).items.find((i) => i.taskId === "t-subs")!.subagents;
  assert.equal(await counts(), undefined, "no subagents recorded");
  for (const id of ["a1", "a2"]) {
    at(1_100, { event: "SubagentStart", agentId: id, agentType: "Explore" });
    at(1_200, { event: "PostToolUse", toolName: "Agent", agentTool: { agentId: id, status: "async_launched", subagentType: "Explore", description: id } });
  }
  assert.deepEqual(await counts(), { running: 2, finished: 0 });
  at(1_500, { event: "SubagentStop", agentId: "a1", agentType: "Explore", backgroundTasks: [{ id: "a2", type: "subagent", agentType: "Explore" }] });
  assert.deepEqual(await counts(), { running: 1, finished: 1 });
});

test("the registration answer's counts come from the inbox", async () => {
  const h = await homeIn("counts");
  addTask({ id: "c-run", status: "running" }, { surface: "home-session", repo: h.repo });
  addTask({ id: "c-ask", status: "running", sessionId: liveSession("w-count") }, { surface: "home-session", repo: h.repo });
  reviews.create("w-count", "input", "Q", "Q?", [QUESTION]);
  const res = await register({
    sessionId: "home-counts-2", harness: "claude", cwd: h.dir, clientVersion: "1.0.0", source: "resume", entrypoint: "cli",
    interactive: true, beforeFirstPrompt: false, launcherDisabled: false,
  });
  // Counted as the session's own inbox lists it: a repository-less resident's request from another
  // test is visible in every home session, so the expectation is read from the inbox, not hard coded.
  const own = await inboxFor(h);
  assert.deepEqual(((await res.json()) as { counts: unknown }).counts, { running: 1, waiting: own.needsYou.length });
  assert.ok(own.needsYou.includes("c-ask"), "the repository's own waiting task is counted");
});

test("config view shows the launcher setting, and switching it off stops the launcher offer", async () => {
  const on = await get("/dispatch/config", cliHeaders);
  assert.deepEqual(await on.json(), { launcher: { prompt: true } });
  const h = await homeIn("config");
  assert.equal((await get(`/dispatch/config?session=${h.sessionId}`)).status, 200);
  assert.equal((await get("/dispatch/config?session=nobody")).status, 403);
  assert.equal((await get("/dispatch/config")).status, 400, "the mod must name its session");
  setLauncherPrompt(false);
  try {
    assert.deepEqual(await (await get("/dispatch/config", cliHeaders)).json(), { launcher: { prompt: false } });
    const res = await register({
      sessionId: "home-no-launcher", harness: "claude", cwd: h.dir, clientVersion: "1.0.0", source: "startup", entrypoint: "cli",
      interactive: true, beforeFirstPrompt: true, launcherDisabled: false,
    });
    assert.equal(((await res.json()) as { offerLauncher: boolean }).offerLauncher, false);
  } finally {
    setLauncherPrompt(true);
  }
});

// ---- reviewer rows ----------------------------------------------------------------------

function seedRun(runId: string, personas: string[]): { attempts: string[]; submission: string } {
  const db = openDb();
  const submission = `sub-${runId}`;
  db.prepare(
    `INSERT INTO workflow_submissions (id, run_id, round, segment, mode, trigger_source, trigger_key, evidence_fingerprint, context_json, evidence_json, status, created_at, updated_at)
     VALUES (?, ?, 1, 0, 'full', 'manual', ?, 'f', '{}', '{}', 'running', 1, 1)`,
  ).run(submission, runId, `key-${runId}`);
  const attempts = personas.map((name, i) => {
    const id = `att-${runId}-${i}`;
    db.prepare(
      `INSERT INTO workflow_node_attempts (id, submission_id, node_id, attempt, state, persona_snapshot_json, input_fingerprint, created_at, updated_at)
       VALUES (?, ?, ?, 1, 'running', ?, 'fp', 1, 1)`,
    ).run(id, submission, `node-${i}`, JSON.stringify({ name }));
    return id;
  });
  return { attempts, submission };
}

function seedCall(runId: string, submission: string, attemptId: string, over: Record<string, unknown>): void {
  const c = { runner: "codex", model: "gpt-6-sol", attempt: 1, state: "running", started: 100, finished: null, error: null, ...over };
  openDb().prepare(
    `INSERT INTO workflow_llm_calls (id, run_id, submission_id, node_attempt_id, purpose, runner_id, model_id, attempt, state, started_at, finished_at, error_code)
     VALUES (?, ?, ?, ?, 'persona_review', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(`call-${attemptId}-${c.attempt}`, runId, submission, attemptId, c.runner, c.model, c.attempt, c.state, c.started, c.finished, c.error);
}

test("reviewer rows follow the workflow's reviewer order with the latest attempt of each", () => {
  const { attempts, submission } = seedRun("run-rows", ["Quality", "Design", "Security", "Tests", "Docs"]);
  seedCall("run-rows", submission, attempts[0]!, { state: "succeeded", finished: 150 });
  seedCall("run-rows", submission, attempts[1]!, { state: "failed", attempt: 1, finished: 120, error: "agent binary codex not found" });
  seedCall("run-rows", submission, attempts[1]!, { state: "running", attempt: 2, started: 130 });
  seedCall("run-rows", submission, attempts[2]!, { state: "running" });
  seedCall("run-rows", submission, attempts[3]!, { state: "failed", runner: "claude", finished: 140, error: "signed out" });
  const rows = reviewerRowsFor("run-rows");
  assert.deepEqual(rows.map((r) => [r.name, r.state, r.attempt]), [
    ["Quality", "passed", 1], ["Design", "retrying", 2], ["Security", "running", 1], ["Tests", "failed", 1], ["Docs", "queued", 0],
  ]);
  assert.equal(rows[0]!.runner, "codex");
  assert.equal(rows[0]!.model, "gpt-6-sol");
  assert.equal(rows[0]!.startedAt, 100);
  assert.equal(rows[0]!.endedAt, 150);
  assert.deepEqual(rows[3]!.failure, { class: "signed-out", fix: "Sign in to Claude Code, then retry the review." });
  assert.equal(rows[2]!.failure, null);
  assert.equal(rows[4]!.startedAt, null);
  assert.deepEqual(reviewerRowsFor("no-such-run"), []);
});

test("a retried node is one row showing its latest attempt, for reviewers and for checks", () => {
  const { attempts, submission } = seedRun("run-retry", ["First", "Second"]);
  const db = openDb();
  seedCall("run-retry", submission, attempts[0]!, { state: "failed", finished: 120, error: "timeout" });
  // The first reviewer's node was retried as a second node attempt that is now running.
  db.prepare(
    `INSERT INTO workflow_node_attempts (id, submission_id, node_id, attempt, state, persona_snapshot_json, input_fingerprint, created_at, updated_at)
     VALUES ('att-run-retry-0b', ?, 'node-0', 2, 'running', ?, 'fp', 2, 2)`,
  ).run(submission, JSON.stringify({ name: "First" }));
  seedCall("run-retry", submission, "att-run-retry-0b", { state: "running", started: 300 });
  seedCall("run-retry", submission, attempts[1]!, { state: "succeeded", finished: 150 });
  const rows = reviewerRowsFor("run-retry");
  assert.deepEqual(rows.map((r) => [r.name, r.state]), [["First", "running"], ["Second", "passed"]], "one row per reviewer, in order, with the retry's state");
  assert.equal(rows[0]!.startedAt, 300);

  for (const [att, state] of [["1", "error"], ["2", "completed"]] as const) {
    db.prepare(
      `INSERT INTO workflow_node_attempts (id, submission_id, node_id, attempt, state, input_fingerprint, created_at, updated_at)
       VALUES (?, ?, 'lint', ?, ?, 'fp', 3, 3)`,
    ).run(`chk-retry-${att}`, submission, Number(att), state);
  }
  assert.deepEqual(runChecksFor("run-retry"), [{ name: "lint", state: "passed" }], "a check that failed and was retried shows the retry");
});

test("reviewer failure classes, and check rows from the run's non-reviewer nodes", () => {
  assert.equal(reviewerFailureClass("agent binary codex not found"), "not-installed");
  assert.equal(reviewerFailureClass("ENOENT"), "not-installed");
  assert.equal(reviewerFailureClass("signed_out"), "signed-out");
  assert.equal(reviewerFailureClass("model_unavailable"), "model-unavailable");
  assert.equal(reviewerFailureClass("timeout"), "timeout");
  assert.equal(reviewerFailureClass("provider_overloaded"), "provider");
  assert.equal(reviewerFailureClass("kaboom"), "other");
  assert.equal(reviewerFailureClass(null), "other");
  const { submission } = seedRun("run-checks", ["Only reviewer"]);
  const db = openDb();
  for (const [node, state] of [["lint", "completed"], ["tests", "running"], ["build", "error"], ["docs", "queued"]] as const) {
    db.prepare(
      `INSERT INTO workflow_node_attempts (id, submission_id, node_id, attempt, state, input_fingerprint, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, 'fp', 1, 1)`,
    ).run(`chk-${node}`, submission, node, state);
  }
  assert.deepEqual(runChecksFor("run-checks"), [
    { name: "lint", state: "passed" }, { name: "tests", state: "running" }, { name: "build", state: "failed" }, { name: "docs", state: "pending" },
  ]);
  assert.equal(reviewerRowsFor("run-checks").length, 1, "a check is not a reviewer");
});
