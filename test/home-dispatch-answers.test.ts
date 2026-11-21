// Headless mode phase 4: POST /dispatch/answers, its receipts, and approval against an exact revision.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { PlanDecision } from "../src/shared/types.ts";

// Above the imports: `openDb` refuses a state dir this file did not name.
const home = realpathSync(mkdtempSync(join(tmpdir(), "mission-home-dispatch-answers-")));
process.env.MISSION_HOME = home;

const { buildApp } = await import("../src/server/routes.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
const {
  closeDb, openDb, loadHumanResolvedReviews, loadConversationResolvedReviews, loadReviewContinuationCandidates,
  createReviewContinuationPendingTurn,
} = await import("../src/server/db.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const flags = await import("../src/server/feature-flags/index.ts");
const { HomeDispatchReceiptSchema } = await import("../src/shared/home-dispatch.ts");
const { isApprovingActor, isHomeDispatchActor } = await import("../src/shared/review-item.ts");
const { receiptLine, HOME_DISPATCH_CHAT_FIRST_TEXT } = await import("../src/shared/home-dispatch-inbox.ts");
const { mkTask, mkMuxHandle } = await import("./helpers/session-fixture.ts");
const { revisionHashFor, taskOwningSession } = await import("../src/server/home-dispatch/approval.ts");
const { unattributedItems } = await import("../src/server/home-dispatch/inbox.ts");
const { PLAN_APPROVAL_DECISION } = await import("../src/shared/managed-plans.ts");

after(() => { closeDb(); rmSync(home, { recursive: true, force: true }); });

const registry = new Registry();
const reviews = new ReviewManager(registry);
const app = buildApp({
  registry, reviews, tasks: new TaskManager(registry), queues: new QueueManager(registry),
  workflows: { runs: () => [], localPlanPublication: () => null } as never,
});
const headers = { host: "127.0.0.1:7317", "x-harness-token": ensureToken(), "content-type": "application/json" };
const cliHeaders = { ...headers, "x-harness-surface": "cli" };

beforeEach(() => {
  assert.equal(flags.applyFeatureFlagIntent({ kind: "flag", id: "headless-mode", enabled: true }).ok, true);
});

// ---- fixtures ---------------------------------------------------------------------------

const discovered: DiscoveredSession[] = [];
function liveSession(id: string, repoRoot?: string): string {
  if (!discovered.some((d) => d.syntheticId === id)) {
    discovered.push({
      syntheticId: id, agent: "claude", name: id, nameSource: "process", cwd: join(home, "worker", id), gitBranch: "feature",
      pid: 1, tty: "ttys1", terminals: [mkMuxHandle({ session: id, windowName: "w", windowIndex: 0, paneId: `%${discovered.length + 1}` })],
      startedAt: 0,
      ...(repoRoot ? { repoRoot, gitRoot: repoRoot } : {}),
    } as DiscoveredSession);
    registry.applyDiscovery(discovered);
  }
  return id;
}

interface Home { dir: string; repo: string; sessionId: string }

async function homeIn(name: string, sessionId = `home-${name}`): Promise<Home> {
  const dir = join(home, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir]);
  const res = await app.request("/dispatch/sessions", {
    method: "POST", headers,
    body: JSON.stringify({
      sessionId, harness: "claude", cwd: dir, clientVersion: "1.0.0", source: "resume", entrypoint: "cli",
      interactive: true, beforeFirstPrompt: false, launcherDisabled: false,
    }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  return { dir, repo: realpathSync(dir), sessionId };
}

function addTask(id: string, repo: string, surface: "home-session" | "mctl" | null, over: Parameters<typeof mkTask>[0] = {}): string {
  const worker = liveSession(`w-${id}`, repo);
  registry.upsertTask(mkTask({ id, title: id, status: "running", sessionId: worker, createdAt: 1_000, updatedAt: 1_000, ...over }));
  openDb()
    .prepare(`UPDATE tasks SET origin_surface = ?, origin_repo = ?, origin_session_id = ? WHERE id = ?`)
    .run(surface, surface ? repo : null, null, id);
  return worker;
}

const QUESTION: PlanDecision = { id: "q", question: "Keep or delete?", options: [{ id: "keep", label: "Keep" }, { id: "del", label: "Delete" }] };
const BUNDLE: PlanDecision = {
  id: PLAN_APPROVAL_DECISION, question: "Approve?",
  options: [{ id: "approve", label: "Approve final bundle" }, { id: "revise", label: "Needs revision" }],
};

function managedPlan(worker: string, taskId: string, hash = "b".repeat(64)) {
  const review = reviews.create(worker, "plan-decisions", "Plan", "The plan", [BUNDLE]);
  openDb()
    .prepare(`INSERT INTO managed_plan_reviews (review_id, plan_id, revision, session_id, task_id, manifest_hash) VALUES (?, ?, 1, ?, ?, ?)`)
    .run(review.id, `plan-${review.id}`, worker, taskId, hash);
  return { review, hash };
}

const answer = (h: { sessionId: string; dir: string }, body: Record<string, unknown>, hdrs = headers) =>
  app.request("/dispatch/answers", { method: "POST", headers: hdrs, body: JSON.stringify({ sessionId: h.sessionId, cwd: h.dir, fromForm: true, ...body }) });
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;
const receiptOf = async (res: Response) => HomeDispatchReceiptSchema.parse(await res.json());
const row = (id: string) => registry.getReview(id)!;

// ---- answer -----------------------------------------------------------------------------

test("an option answer settles the review as the home session and returns its receipt", async () => {
  const h = await homeIn("opt");
  const worker = addTask("t-opt", h.repo, "home-session");
  const review = reviews.create(worker, "input", "Q", "Keep?", [QUESTION]);
  const res = await answer(h, { action: "answer", taskId: "t-opt", reviewId: review.id, option: "Keep" });
  assert.equal(res.status, 200);
  const receipt = await receiptOf(res);
  assert.deepEqual({ reviewId: receipt.reviewId, taskId: receipt.taskId, sent: receipt.sent }, { reviewId: review.id, taskId: "t-opt", sent: "Keep" });
  assert.equal(receiptLine(receipt), 'sent "Keep" to t-opt');
  const settled = row(review.id);
  assert.equal(settled.status, "answered");
  assert.equal(settled.resolvedBy, `home:${h.sessionId}`);
  assert.deepEqual(settled.selections, [{ decisionId: "q", selected: ["keep"], other: null }]);
  assert.match(settled.response ?? "", /Keep/);
});

test("the actor is the server's: an actor in the body is ignored", async () => {
  const h = await homeIn("actor");
  const worker = addTask("t-actor", h.repo, "home-session");
  const review = reviews.create(worker, "input", "Q", "Keep?", [QUESTION]);
  const res = await answer(h, { action: "answer", taskId: "t-actor", reviewId: review.id, option: "Delete", by: "human", actor: "human", resolvedBy: "human" });
  assert.equal(res.status, 200);
  assert.equal(row(review.id).resolvedBy, `home:${h.sessionId}`);
});

test("a retry from the same session returns its receipt; another session gets 409; one settle for two calls at once", async () => {
  const h = await homeIn("retry");
  const peer = await homeIn("retry", "home-retry-peer");
  const worker = addTask("t-retry", h.repo, "home-session");
  const review = reviews.create(worker, "input", "Q", "Keep?", [QUESTION]);
  const body = { action: "answer", taskId: "t-retry", reviewId: review.id, option: "Keep" };
  const [a, b] = await Promise.all([answer(h, body), answer(h, body)]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const [ra, rb] = [await receiptOf(a), await receiptOf(b)];
  assert.deepEqual(ra, rb, "the same receipt, so nothing was sent twice");
  const settledAt = row(review.id).resolvedAt;
  const again = await answer(h, { ...body, option: "Delete" });
  assert.equal(again.status, 200);
  assert.deepEqual(await receiptOf(again), ra, "a retry returns what was sent, not what it now says");
  assert.equal(row(review.id).resolvedAt, settledAt);
  const other = await answer(peer, body);
  assert.equal(other.status, 409, "settled by someone else");
  assert.equal((openDb().prepare(`SELECT count(*) AS n FROM home_dispatch_receipts WHERE review_id = ?`).get(review.id) as { n: number }).n, 1);
});

test("tasks sharing a worker session: the review belongs to the active one, and two active ones are ambiguous", async () => {
  const h = await homeIn("shared-session");
  const shared = addTask("t-old", h.repo, "home-session", { status: "done", completedAt: 5, updatedAt: 5 });
  addTask("t-new", h.repo, "home-session", { status: "running", sessionId: shared, updatedAt: 9_000 });
  const review = reviews.create(shared, "input", "Q", "Keep?", [QUESTION]);
  const body = { action: "answer", reviewId: review.id, option: "Keep" };

  const inbox = await (await app.request(`/dispatch/inbox?session=${h.sessionId}`, { headers })).json() as
    { items: Array<{ taskId: string; pending?: unknown }> };
  assert.equal(inbox.items.find((i) => i.taskId === "t-new")?.pending !== undefined, true, "the active task shows the question");
  assert.equal(inbox.items.find((i) => i.taskId === "t-old")?.pending, undefined, "the earlier task that shares the session does not");

  const wrong = await answer(h, { ...body, taskId: "t-old" });
  assert.equal(wrong.status, 409, "naming the earlier task is refused, not recorded against it");
  assert.equal(row(review.id).status, "pending");
  const ok = await answer(h, { ...body, taskId: "t-new" });
  assert.equal(ok.status, 200);
  assert.equal((await receiptOf(ok)).taskId, "t-new", "the receipt names the task that owns the review");

  // A question asked by one task, then the session taken over by another (the registry unbinds the
  // first): which task asked it can no longer be established, so it is answered against neither.
  const twin = addTask("t-twin-a", h.repo, "home-session");
  const twinReview = reviews.create(twin, "input", "Q2", "Which?", [QUESTION]);
  addTask("t-twin-b", h.repo, "home-session", { sessionId: twin, dispatchedAt: Date.now() + 10_000 });
  for (const taskId of ["t-twin-a", "t-twin-b"]) {
    const res = await answer(h, { action: "answer", reviewId: twinReview.id, taskId, option: "Keep" });
    assert.equal(res.status, 409, taskId);
    assert.match(await errorOf(res), /cannot be established/);
  }
  assert.equal(row(twinReview.id).status, "pending", "nothing was settled or receipted against the new holder");
  assert.equal((openDb().prepare(`SELECT count(*) AS n FROM home_dispatch_receipts WHERE review_id = ?`).get(twinReview.id) as { n: number }).n, 0);
  const after = await (await app.request(`/dispatch/inbox?session=${h.sessionId}`, { headers })).json() as
    { items: Array<{ taskId: string; state: string; pending?: { dashboardOnly: boolean; reviewId: string } }>; needsYou: string[]; dashboardOnly: number };
  assert.equal(after.items.find((i) => i.taskId === "t-twin-b")?.pending, undefined, "the new holder does not show the earlier task's question");
  // The question is still pending, so it must not vanish: it is listed on its own, for the dashboard.
  const orphan = after.items.find((i) => i.taskId === `review:${twinReview.id}`);
  assert.equal(orphan?.state, "waiting");
  assert.equal(orphan?.pending?.dashboardOnly, true);
  assert.equal(orphan?.pending?.reviewId, twinReview.id);
  assert.ok(after.needsYou.includes(`review:${twinReview.id}`));
  assert.ok(after.dashboardOnly >= 1);
  assert.equal(after.items.filter((i) => i.taskId === `review:${twinReview.id}`).length, 1, "listed once");
});

test("a failed or cancelled task that still has a pending request is in needsYou", async () => {
  const h = await homeIn("failed-pending");
  for (const status of ["failed", "cancelled"] as const) {
    const id = `t-${status}-pending`;
    const worker = addTask(id, h.repo, "home-session", { status, completedAt: Date.now(), updatedAt: Date.now() });
    reviews.create(worker, "input", `Q ${status}`, "Keep?", [QUESTION]);
    const inbox = await (await app.request(`/dispatch/inbox?session=${h.sessionId}`, { headers })).json() as
      { items: Array<{ taskId: string; state: string }>; needsYou: string[] };
    assert.equal(inbox.items.find((i) => i.taskId === id)?.state, "waiting", status);
    assert.ok(inbox.needsYou.includes(id), status);
  }
});

test("a finished task that still has a pending request is waiting, and is answerable", async () => {
  const h = await homeIn("done-pending");
  const worker = addTask("t-done-pending", h.repo, "home-session", { status: "done", completedAt: Date.now(), updatedAt: Date.now() });
  const review = reviews.create(worker, "input", "Q", "Keep?", [QUESTION]);
  const inbox = await (await app.request(`/dispatch/inbox?session=${h.sessionId}`, { headers })).json() as
    { items: Array<{ taskId: string; state: string }>; needsYou: string[] };
  assert.equal(inbox.items.find((i) => i.taskId === "t-done-pending")?.state, "waiting");
  assert.deepEqual(inbox.needsYou, ["t-done-pending"]);
  assert.equal((await answer(h, { action: "answer", taskId: "t-done-pending", reviewId: review.id, option: "Keep" })).status, 200);
});

test("every pending request on a task is listed and answerable, not only the oldest", async () => {
  const h = await homeIn("many-pending");
  const worker = addTask("t-many", h.repo, "home-session");
  const first = reviews.create(worker, "input", "First", "One?", [QUESTION], { now: Date.now() - 2_000 });
  const second = reviews.create(worker, "input", "Second", "Two?", [{ ...QUESTION, id: "q2" }], { now: Date.now() - 1_000 });
  const inbox = await (await app.request(`/dispatch/inbox?session=${h.sessionId}`, { headers })).json() as
    { items: Array<{ taskId: string; state: string; title: string; pending?: { reviewId: string; dashboardOnly: boolean } }>; needsYou: string[] };
  const main = inbox.items.find((i) => i.taskId === "t-many")!;
  const extra = inbox.items.find((i) => i.taskId === `review:${second.id}`)!;
  assert.equal(main.pending?.reviewId, first.id, "the oldest request is the task's own pending");
  assert.equal(extra.pending?.reviewId, second.id, "the next one is listed too");
  assert.equal(extra.state, "waiting");
  assert.equal(extra.title, main.title, "it names the same task");
  assert.equal(extra.pending?.dashboardOnly, false, "and it is answerable");
  assert.deepEqual(inbox.needsYou.filter((id) => id === "t-many" || id === `review:${second.id}`), ["t-many", `review:${second.id}`]);

  // The extra item's id answers the review it stands for, receipted against the owning task.
  const res = await answer(h, { action: "answer", taskId: `review:${second.id}`, reviewId: second.id, option: "Keep" });
  assert.equal(res.status, 200);
  assert.equal((await receiptOf(res)).taskId, "t-many");
  assert.equal(row(second.id).status, "answered");
  assert.equal((await answer(h, { action: "answer", taskId: `review:${first.id}`, reviewId: second.id, option: "Keep" })).status, 409, "an id for another review does not stand in");
});

test("a takeover question is shown only in the repository of the session that asked it", async () => {
  const a = await homeIn("takeover-a");
  const b = await homeIn("takeover-b");
  const session = liveSession("w-takeover", a.repo);
  registry.upsertTask(mkTask({ id: "t-takeover-a", title: "asked in A", status: "running", sessionId: session, createdAt: 1_000, updatedAt: 1_000 }));
  openDb().prepare(`UPDATE tasks SET origin_surface = 'home-session', origin_repo = ?, origin_session_id = NULL WHERE id = ?`).run(a.repo, "t-takeover-a");
  const review = reviews.create(session, "input", "Secret from A", "A's private question?", [QUESTION]);
  registry.upsertTask(mkTask({ id: "t-takeover-b", title: "now in B", status: "running", sessionId: session, createdAt: 1_000, updatedAt: 1_000, dispatchedAt: Date.now() + 10_000 }));
  openDb().prepare(`UPDATE tasks SET origin_surface = 'home-session', origin_repo = ?, origin_session_id = NULL WHERE id = ?`).run(b.repo, "t-takeover-b");

  const read = async (h: { sessionId: string }) => (await (await app.request(`/dispatch/inbox?session=${h.sessionId}`, { headers })).json()) as
    { items: Array<{ taskId: string; title: string }>; needsYou: string[] };
  const inB = await read(b);
  assert.equal(JSON.stringify(inB).includes("Secret from A"), false, "repository B never sees A's question");
  assert.equal(inB.needsYou.includes(`review:${review.id}`), false);
  const inA = await read(a);
  assert.ok(inA.items.some((i) => i.taskId === `review:${review.id}` && i.title === "Secret from A"), "repository A still sees what it asked");
  assert.ok(inA.needsYou.includes(`review:${review.id}`));
});

test("a session names one task at a time: a later task takes the pointer from an earlier one, so runs and questions cannot be shared", async () => {
  const h = await homeIn("exclusive");
  const shared = addTask("t-excl-a", h.repo, "home-session", { status: "done", completedAt: 1, updatedAt: 1 });
  assert.equal(registry.getTask("t-excl-a")?.sessionId, shared);
  addTask("t-excl-b", h.repo, "home-session", { sessionId: shared });
  assert.equal(registry.getTask("t-excl-a")?.sessionId, null, "the earlier task no longer holds the session");
  assert.equal((openDb().prepare(`SELECT session_id FROM tasks WHERE id = 't-excl-a'`).get() as { session_id: string | null }).session_id, null);
  // So a run found by session id can only be the holder's, however long ago the earlier task ended.
  assert.equal(registry.listTasks().filter((t) => t.sessionId === shared).map((t) => t.id).join(), "t-excl-b");
});

test("a request stranded by an ambiguous session is still listed, as dashboard-only, in the asking repository", async () => {
  const h = await homeIn("ambiguous");
  const other = await homeIn("ambiguous-other");
  const shared = addTask("t-amb-a", h.repo, "home-session");
  addTask("t-amb-b", h.repo, "home-session");
  const review = reviews.create(shared, "input", "Stranded", "Which?", [QUESTION]);
  // The registry cannot produce two active holders, so the ambiguity is simulated on its task list.
  const both = registry.listTasks().filter((t) => ["t-amb-a", "t-amb-b"].includes(t.id)).map((t) => ({ ...t, sessionId: shared }));
  const fake = { registry: Object.assign(Object.create(registry), { listTasks: () => both }) };
  const resolvedFor = (home: { sessionId: string; repo: string }) =>
    ({ caller: { surface: "home-session" as const, sessionId: home.sessionId, repoRoot: home.repo }, sessionId: home.sessionId, allRepos: false });

  const mine = unattributedItems(fake, resolvedFor(h));
  const item = mine.find((i) => i.taskId === `review:${review.id}`);
  assert.equal(item?.state, "waiting");
  assert.equal(item?.pending?.dashboardOnly, true);
  assert.equal(unattributedItems(fake, resolvedFor(other)).some((i) => i.taskId === `review:${review.id}`), false, "not shown to another repository");

  // A pair of dashboard tasks is not a home-dispatch matter, so its question is never exposed; a pair
  // with one home-dispatched task still is, and the dashboard one listed first does not decide it.
  const dashA = addTask("t-amb-dash-a", h.repo, null);
  addTask("t-amb-dash-b", h.repo, null);
  const dashReview = reviews.create(dashA, "input", "Dashboard only", "Private?", [QUESTION]);
  const pair = (ids: string[]) => ({
    registry: Object.assign(Object.create(registry), {
      listTasks: () => registry.listTasks().filter((t) => ids.includes(t.id)).map((t) => ({ ...t, sessionId: dashA })),
    }),
  });
  const seen = (ids: string[]) => unattributedItems(pair(ids), resolvedFor(h)).some((i) => i.taskId === `review:${dashReview.id}`);
  assert.equal(seen(["t-amb-dash-a", "t-amb-dash-b"]), false, "two dashboard tasks: nothing is exposed");
  assert.equal(seen(["t-amb-dash-a", "t-amb-b"]), true, "a dashboard task first, a home-dispatched one second: still listed");
});

test("taskOwningSession refuses to guess when two active tasks claim one session", () => {
  const t = (id: string, status: string) => ({ id, status, sessionId: "s-shared", updatedAt: 1 });
  const deps = (tasks: unknown[]) => ({ registry: { listTasks: () => tasks, taskForSession: () => undefined } }) as never;
  assert.deepEqual(
    taskOwningSession(deps([t("a", "running"), t("b", "dispatching")]), "s-shared"),
    { ambiguous: true, tasks: [t("a", "running"), t("b", "dispatching")] },
  );
  assert.deepEqual(taskOwningSession(deps([t("a", "running"), t("b", "done")]), "s-shared"), { task: t("a", "running") });
  assert.equal(taskOwningSession(deps([]), "s-shared"), undefined);
  const started = (id: string, dispatchedAt: number) => ({ id, status: "running", sessionId: "s-shared", dispatchedAt, createdAt: 1, updatedAt: 1 });
  assert.deepEqual(taskOwningSession(deps([started("a", 100)]), "s-shared", 200), { task: started("a", 100) }, "asked after it started");
  assert.deepEqual(taskOwningSession(deps([started("a", 300)]), "s-shared", 200), { unestablished: true, task: started("a", 300) }, "asked before it started");
});

test("a receipt that cannot be written settles nothing, so the retry still works and then has its receipt", async () => {
  const h = await homeIn("receipt-fail");
  const worker = addTask("t-receipt-fail", h.repo, "home-session");
  const review = reviews.create(worker, "input", "Q", "Keep?", [QUESTION]);
  const body = { action: "answer", taskId: "t-receipt-fail", reviewId: review.id, option: "Keep" };
  const db = openDb();
  db.exec(`CREATE TRIGGER fail_receipt BEFORE INSERT ON home_dispatch_receipts BEGIN SELECT RAISE(ABORT, 'receipt store is down'); END`);
  try {
    const failed = await answer(h, body);
    assert.equal(failed.status, 500, "the caller is told nothing was sent");
    assert.match(await errorOf(failed), /nothing was sent; answer again/);
    assert.equal(row(review.id).status, "pending", "the settle rolled back with the receipt");
    assert.equal((db.prepare(`SELECT status FROM reviews WHERE id = ?`).get(review.id) as { status: string }).status, "pending");
  } finally {
    db.exec(`DROP TRIGGER fail_receipt`);
  }
  const retry = await answer(h, body);
  assert.equal(retry.status, 200);
  const receipt = await receiptOf(retry);
  assert.equal(row(review.id).status, "answered");
  const again = await answer(h, body);
  assert.equal(again.status, 200, "a lost response is recoverable: the settled review has its receipt");
  assert.deepEqual(await receiptOf(again), receipt);
});

test("a dashboard answer to the review means a home session's retry is 409, not a receipt", async () => {
  const h = await homeIn("dash-first");
  const worker = addTask("t-dash", h.repo, "home-session");
  const review = reviews.create(worker, "input", "Q", "Keep?", [QUESTION]);
  reviews.resolve(review.id, "answer", "Keep", "human", null);
  const res = await answer(h, { action: "answer", taskId: "t-dash", reviewId: review.id, option: "Keep" });
  assert.equal(res.status, 409);
});

test("bad answers are refused with the reason and settle nothing", async () => {
  const h = await homeIn("bad");
  const worker = addTask("t-bad", h.repo, "home-session");
  const options = reviews.create(worker, "input", "Opts", "Keep?", [QUESTION]);
  const send = (r: { id: string }, extra: Record<string, unknown>) => answer(h, { action: "answer", taskId: "t-bad", reviewId: r.id, ...extra });

  assert.equal((await send(options, { option: "Maybe" })).status, 400, "an option that is not a label");
  assert.match(await errorOf(await send(options, { text: "keep it" })), /takes one of its options/, "text alone, no free-text field");
  assert.equal((await send(options, { option: "Keep", text: "and more" })).status, 400, "text beside an option, no free-text field");
  assert.equal((await send(options, {})).status, 400, "nothing at all");
  assert.equal((await answer(h, { action: "approve_review", taskId: "t-bad", reviewId: options.id, revisionHash: "x" })).status, 400, "an action that does not fit");
  assert.equal(row(options.id).status, "pending");

  const free = reviews.create(worker, "input", "Free", "What now?", null);
  assert.match(await errorOf(await send(free, { option: "Keep" })), /text, not an option/, "a question with no options refuses an option");
  assert.equal((await send(free, { text: "do the thing" })).status, 200);
  assert.equal(row(free.id).response, "do the thing");

  const withOther = reviews.create(worker, "input", "Other", "Which?", [{ ...QUESTION, id: "q2", allowOther: true }]);
  const res = await send(withOther, { text: "neither" });
  assert.equal(res.status, 200);
  assert.equal((await receiptOf(res)).sent, "neither");
  assert.deepEqual(row(withOther.id).selections, [{ decisionId: "q2", selected: [], other: "neither" }]);
});

test("an item only the dashboard can answer is refused with that text, and a replaced question is a 409", async () => {
  const h = await homeIn("dashonly");
  const worker = addTask("t-dashonly", h.repo, "home-session");
  const form = reviews.create(worker, "plan-decisions", "Decide", "Body", [BUNDLE, { ...BUNDLE, id: "two" }]);
  const res = await answer(h, { action: "answer", taskId: "t-dashonly", reviewId: form.id, option: "x" });
  assert.equal(res.status, 400);
  assert.equal(await errorOf(res), "answer this in the dashboard");
  const wrongTask = await answer(h, { action: "answer", taskId: "some-other-task", reviewId: form.id, option: "x" });
  assert.equal(wrongTask.status, 409);
  assert.equal((await answer(h, { action: "answer", taskId: "t-dashonly", reviewId: "no-such-review", option: "x" })).status, 404);
  assert.equal((await answer(h, { action: "nonsense", taskId: "t", reviewId: "r" })).status, 400);
});

// ---- who may answer ---------------------------------------------------------------------

test("who may answer: another repository, an unregistered session and a worker get 403", async () => {
  const h = await homeIn("who-a");
  const other = await homeIn("who-b");
  const worker = addTask("t-who", h.repo, "home-session");
  const review = reviews.create(worker, "input", "Q", "Keep?", [QUESTION]);
  const body = { action: "answer", taskId: "t-who", reviewId: review.id, option: "Keep" };
  const foreign = await answer(other, body);
  assert.equal(foreign.status, 403);
  assert.match(await errorOf(foreign), /different repository/);
  assert.equal((await answer({ sessionId: "never-registered", dir: h.dir }, body)).status, 403);
  registry.registerSdkSession({ id: "sdk:worker-x", agent: "claude", name: "w", cwd: h.dir, agentSessionId: "harness-x" });
  assert.equal((await answer({ sessionId: "sdk:worker-x", dir: h.dir }, body)).status, 403);
  const dashboard = addTask("t-who-dash", h.repo, null);
  const dashReview = reviews.create(dashboard, "input", "Q", "Keep?", [QUESTION]);
  assert.equal((await answer(h, { ...body, taskId: "t-who-dash", reviewId: dashReview.id })).status, 403, "a dashboard task is not answerable from a home session");
  assert.equal(row(review.id).status, "pending");
});

test("the command line answers only the tasks it started, as mctl, and never approves or chats", async () => {
  const h = await homeIn("cli");
  const homeWorker = addTask("t-cli-home", h.repo, "home-session");
  const mctlWorker = addTask("t-cli-mctl", h.repo, "mctl");
  const homeReview = reviews.create(homeWorker, "input", "Q", "Keep?", [QUESTION]);
  const mctlReview = reviews.create(mctlWorker, "input", "Q", "Keep?", [QUESTION]);
  const cli = (taskId: string, reviewId: string, extra: Record<string, unknown>) =>
    answer({ sessionId: "mctl", dir: h.dir }, { taskId, reviewId, ...extra }, cliHeaders);

  const refused = await cli("t-cli-home", homeReview.id, { action: "answer", option: "Keep" });
  assert.equal(refused.status, 403);
  assert.equal(await errorOf(refused), "answer this in the home session that started it");
  const ok = await cli("t-cli-mctl", mctlReview.id, { action: "answer", option: "Keep" });
  assert.equal(ok.status, 200);
  assert.equal(row(mctlReview.id).resolvedBy, "mctl");

  const plan = managedPlan(mctlWorker, "t-cli-mctl");
  const approvePlan = await cli("t-cli-mctl", plan.review.id, { action: "approve_plan", revisionHash: plan.hash });
  assert.equal(approvePlan.status, 403);
  assert.equal(await errorOf(approvePlan), "mctl does not approve plans; approve it in the home session or the dashboard");
  assert.equal((await cli("t-cli-mctl", plan.review.id, { action: "approve_review", revisionHash: plan.hash })).status, 403);
  assert.equal((await cli("t-cli-mctl", mctlReview.id, { action: "chat_first" })).status, 403);
  assert.equal(row(plan.review.id).status, "pending", "nothing was approved");
});

test("mctl retries return the receipt only for the same answer; a different command is refused", async () => {
  const h = await homeIn("cli-retry");
  const worker = addTask("t-cli-retry", h.repo, "mctl");
  const review = reviews.create(worker, "input", "Q", "Keep?", [{ ...QUESTION, allowOther: true }]);
  const cli = (extra: Record<string, unknown>) =>
    answer({ sessionId: "mctl", dir: h.dir }, { taskId: "t-cli-retry", reviewId: review.id, ...extra }, cliHeaders);

  const first = await cli({ action: "answer", option: "Keep" });
  assert.equal(first.status, 200);
  const receipt = await receiptOf(first);
  const same = await cli({ action: "answer", option: "Keep" });
  assert.equal(same.status, 200, "the same command again is a retry");
  assert.deepEqual(await receiptOf(same), receipt);

  for (const other of [
    { action: "answer", option: "Delete" }, { action: "answer", text: "something else" }, { action: "reject_review", text: "no" },
    { action: "answer", text: "Keep" }, // the same words typed as text are a different request from the option
  ]) {
    const res = await cli(other);
    assert.equal(res.status, 409, JSON.stringify(other));
    assert.match(await errorOf(res), /different answer; nothing was sent/);
  }
  assert.equal(row(review.id).response?.includes("Keep"), true, "the first answer stands");
  assert.equal((openDb().prepare(`SELECT count(*) AS n FROM home_dispatch_receipts WHERE review_id = ?`).get(review.id) as { n: number }).n, 1);
});

test("a visible resident's request is answered by a home session; one it cannot see is 403", async () => {
  const h = await homeIn("res-a");
  const other = await homeIn("res-b");
  const worker = addTask("t-res", h.repo, null, { kind: "resident", repoRoot: h.repo });
  registry.upsertResidentRun({
    id: "run-res", profileId: "p", profileRevision: 1, taskId: "t-res", launchState: "launched", personaName: "Res", loopState: "waiting",
    iteration: 1, lastSeq: 0, nextWakeAt: null, consumedGeneration: 0, pauseReason: null, wakeReason: null, runRequestedAt: null, createdAt: 1,
    compaction: { betweenIterations: true, nativeBackstop: false }, settings: {} as never,
  } as never);
  const review = reviews.create(worker, "input", "Rotate?", "Rotate keys?", [QUESTION]);
  const body = { action: "answer", taskId: "t-res", reviewId: review.id, option: "Keep" };
  assert.equal((await answer(other, body)).status, 403);
  assert.equal((await answer(h, body)).status, 200);
  assert.equal(row(review.id).resolvedBy, `home:${h.sessionId}`);
});

// ---- approvals --------------------------------------------------------------------------

test("approve_plan needs the plan's current revision: a stale hash is 409 and a current one is a human approval", async () => {
  const h = await homeIn("plan");
  const worker = addTask("t-plan", h.repo, "home-session");
  const { review, hash } = managedPlan(worker, "t-plan");
  const stale = await answer(h, { action: "approve_plan", taskId: "t-plan", reviewId: review.id, revisionHash: "c".repeat(64) });
  assert.equal(stale.status, 409);
  assert.equal(await errorOf(stale), "the plan changed; show the new revision before approving");
  assert.equal(row(review.id).status, "pending");

  const res = await answer(h, { action: "approve_plan", taskId: "t-plan", reviewId: review.id, revisionHash: hash });
  assert.equal(res.status, 200);
  assert.equal((await receiptOf(res)).sent, "approve plan revision bbbbbbb");
  const settled = row(review.id);
  assert.equal(settled.resolvedBy, `home-approval:${h.sessionId}`);
  assert.equal(settled.status, "answered");
  assert.deepEqual(settled.selections, [{ decisionId: PLAN_APPROVAL_DECISION, selected: ["approve"], other: null }]);
  assert.ok(isApprovingActor(settled.resolvedBy));
  const counted = loadHumanResolvedReviews(worker).find((r) => r.id === review.id);
  assert.equal(counted?.resolvedBy, `home-approval:${h.sessionId}`, "plan publication counts it as a human approval");
  assert.equal(loadConversationResolvedReviews(worker).some((r) => r.id === review.id), false, "but it is not the person's own conversation");
});

test("request_changes answers Needs revision with the text, and a later one beats an earlier approval", async () => {
  const h = await homeIn("changes");
  const worker = addTask("t-changes", h.repo, "home-session");
  const first = managedPlan(worker, "t-changes", "d".repeat(64));
  assert.equal((await answer(h, { action: "approve_plan", taskId: "t-changes", reviewId: first.review.id, revisionHash: first.hash })).status, 200);
  await new Promise((r) => setTimeout(r, 5));
  const second = managedPlan(worker, "t-changes", "e".repeat(64));
  const res = await answer(h, { action: "request_changes", taskId: "t-changes", reviewId: second.review.id, text: "split step 2" });
  assert.equal(res.status, 200);
  assert.equal((await receiptOf(res)).sent, "split step 2");
  const settled = row(second.review.id);
  assert.equal(settled.resolvedBy, `home:${h.sessionId}`);
  assert.deepEqual(settled.selections, [{ decisionId: PLAN_APPROVAL_DECISION, selected: ["revise"], other: null, note: "split step 2" }]);
  assert.match(settled.response ?? "", /split step 2/);
  const history = loadHumanResolvedReviews(worker).filter((r) => [first.review.id, second.review.id].includes(r.id));
  assert.deepEqual(history.map((r) => r.id), [first.review.id, second.review.id], "the refusal is in the evidence, last");
  assert.equal(isApprovingActor(history.at(-1)!.resolvedBy), false, "so the later refusal is what publication reads");
  assert.equal((await answer(h, { action: "request_changes", taskId: "t-changes", reviewId: "x", text: "" })).status, 400, "request_changes needs text");
});

test("approve_review and reject_review settle a diff, the first only at its current revision", async () => {
  const h = await homeIn("diff");
  const worker = addTask("t-diff", h.repo, "home-session");
  const diff = reviews.create(worker, "diff", "Diff", "--- a\n+++ b\n+hello", null);
  const hash = revisionHashFor(diff)!;
  const missing = await answer(h, { action: "approve_review", taskId: "t-diff", reviewId: diff.id });
  assert.equal(missing.status, 400, "the hash is part of the request");
  const stale = await answer(h, { action: "approve_review", taskId: "t-diff", reviewId: diff.id, revisionHash: "0".repeat(64) });
  assert.equal(stale.status, 409);
  assert.equal(await errorOf(stale), "the review changed; show the new revision before approving");

  const ok = await answer(h, { action: "approve_review", taskId: "t-diff", reviewId: diff.id, revisionHash: hash, text: "looks right" });
  assert.equal(ok.status, 200);
  assert.equal((await receiptOf(ok)).sent, `approve rev ${hash.slice(0, 7)}: looks right`);
  assert.equal(row(diff.id).status, "approved");
  assert.equal(row(diff.id).resolvedBy, `home-approval:${h.sessionId}`);
  assert.equal(row(diff.id).response, "looks right");

  const plain = reviews.create(worker, "plan", "Plan", "# A plan", null);
  const rejected = await answer(h, { action: "reject_review", taskId: "t-diff", reviewId: plain.id, text: "too big" });
  assert.equal(rejected.status, 200);
  assert.equal((await receiptOf(rejected)).sent, "reject: too big");
  assert.equal(row(plain.id).status, "rejected");
  assert.equal(row(plain.id).resolvedBy, `home:${h.sessionId}`);
  assert.equal(isApprovingActor(row(plain.id).resolvedBy), false, "a plain home answer never approves a plan");

  const bare = reviews.create(worker, "diff", "Diff 2", "+x", null);
  const bareRes = await answer(h, { action: "reject_review", taskId: "t-diff", reviewId: bare.id });
  assert.equal((await receiptOf(bareRes)).sent, "reject");
});

test("chat_first answers a question with the fixed text and a receipt that says so", async () => {
  const h = await homeIn("chat");
  const worker = addTask("t-chat", h.repo, "home-session");
  const review = reviews.create(worker, "input", "Q", "Keep?", [QUESTION]);
  const res = await answer(h, { action: "chat_first", taskId: "t-chat", reviewId: review.id });
  assert.equal(res.status, 200);
  const receipt = await receiptOf(res);
  assert.equal(receipt.sent, "chat first");
  assert.equal(receiptLine(receipt), 'sent "chat first" to t-chat');
  assert.equal(row(review.id).response, HOME_DISPATCH_CHAT_FIRST_TEXT);
  const diff = reviews.create(worker, "diff", "D", "+y", null);
  assert.equal((await answer(h, { action: "chat_first", taskId: "t-chat", reviewId: diff.id })).status, 400, "chat_first fits a question only");
});

test("a late answer reaches a worker whose wait already ended, through the continuation outbox", async () => {
  const h = await homeIn("late");
  const worker = addTask("t-late", h.repo, "home-session");
  const review = reviews.create(worker, "input", "Q", "Keep?", [QUESTION]);
  openDb().prepare(`UPDATE reviews SET mcp_wait_detached_at = ? WHERE id = ?`).run(Date.now(), review.id);
  assert.equal(loadReviewContinuationCandidates(review.id).length, 0, "still pending");
  assert.equal((await answer(h, { action: "answer", taskId: "t-late", reviewId: review.id, option: "Keep" })).status, 200);
  assert.deepEqual(loadReviewContinuationCandidates(review.id).map((r) => r.id), [review.id]);
});

test("a late answer from each home actor is queued as a continuation turn, once", async () => {
  const h = await homeIn("late-turn");
  const send = (a: Record<string, unknown>, hdrs = headers, who: { sessionId: string; dir: string } = h) => answer(who, a, hdrs);
  const detach = (id: string) => openDb().prepare(`UPDATE reviews SET mcp_wait_detached_at = ? WHERE id = ?`).run(Date.now(), id);
  const cases: Array<[string, string, (ids: { task: string; worker: string }) => Promise<string>]> = [
    ["home:", `home:${h.sessionId}`, async ({ task, worker }) => {
      const r = reviews.create(worker, "input", "Q", "Keep?", [QUESTION]);
      detach(r.id);
      assert.equal((await send({ action: "answer", taskId: task, reviewId: r.id, option: "Keep" })).status, 200);
      return r.id;
    }],
    ["home-approval:", `home-approval:${h.sessionId}`, async ({ task, worker }) => {
      const r = reviews.create(worker, "diff", "D", "+z", null);
      detach(r.id);
      const res = await send({ action: "approve_review", taskId: task, reviewId: r.id, revisionHash: revisionHashFor(r) });
      assert.equal(res.status, 200);
      return r.id;
    }],
    ["mctl", "mctl", async ({ task, worker }) => {
      const r = reviews.create(worker, "input", "Q", "Keep?", [QUESTION]);
      detach(r.id);
      assert.equal((await send({ action: "answer", taskId: task, reviewId: r.id, option: "Keep" }, cliHeaders, { sessionId: "mctl", dir: h.dir })).status, 200);
      return r.id;
    }],
  ];
  for (const [label, actor, run] of cases) {
    const task = `t-late-turn-${label.replace(/\W/g, "")}`;
    const worker = addTask(task, h.repo, label === "mctl" ? "mctl" : "home-session");
    const reviewId = await run({ task, worker });
    assert.equal(row(reviewId).resolvedBy, actor);
    const turn = createReviewContinuationPendingTurn({ reviewId, noteKey: `note-${task}`, text: "The person answered.", now: 1_000 });
    assert.ok(turn, `${label}: the continuation turn is created for this actor`);
    assert.equal(turn.state, "queued");
    assert.equal(turn.noteKey, `note-${task}`);
    assert.equal(turn.text, "The person answered.");
    const stored = openDb().prepare(`SELECT state FROM pending_turns WHERE id = ?`).get(turn.id) as { state: string } | undefined;
    assert.equal(stored?.state, "queued", `${label}: it is in the durable outbox`);
    assert.equal(createReviewContinuationPendingTurn({ reviewId, noteKey: `note-${task}`, text: "again", now: 2_000 }), null, `${label}: queued once`);
  }
});

test("the continuation SQL and the actor predicate come from one list and agree for every actor", () => {
  const worker = liveSession("w-actor-list");
  const actors: Array<[string, boolean, boolean]> = [
    // [resolved_by, can wake a detached session, is a home-dispatch actor]
    ["human", true, false], ["session:s1", true, false], ["home:s1", true, true], ["home-approval:s1", true, true],
    ["mctl", true, true], ["foreman", false, false], ["standing-approval", false, false], ["homework:s1", false, false],
  ];
  for (const [actor, wakes, isHome] of actors) {
    const review = reviews.create(worker, "input", `Q ${actor}`, `Which ${actor}?`, [QUESTION]);
    openDb()
      .prepare(`UPDATE reviews SET status = 'answered', resolved_by = ?, resolved_at = ?, mcp_wait_detached_at = ? WHERE id = ?`)
      .run(actor, Date.now(), Date.now(), review.id);
    assert.equal(loadReviewContinuationCandidates(review.id).length === 1, wakes, `${actor} wakes a detached session`);
    assert.equal(isHomeDispatchActor(actor as never), isHome, `${actor} is a home-dispatch actor`);
  }
});

test("a late answer from a home session is delivered to a detached wait as it settles", async () => {
  const h = await homeIn("late-live");
  const worker = addTask("t-late-live", h.repo, "home-session");
  const delivered: Array<{ id: string; by: string | null | undefined; text: string }> = [];
  reviews.startContinuationRecovery((review, text) => { delivered.push({ id: review.id, by: review.resolvedBy, text }); return true; });
  // Created after the recovery pass, so the wait is marked detached by hand, as a cancelled MCP call would.
  const review = reviews.create(worker, "input", "Q", "Keep?", [QUESTION]);
  openDb().prepare(`UPDATE reviews SET mcp_wait_detached_at = ? WHERE id = ?`).run(Date.now(), review.id);
  assert.equal((await answer(h, { action: "answer", taskId: "t-late-live", reviewId: review.id, option: "Keep" })).status, 200);
  // The recovery pass also replays other tests' detached reviews, so look only at this one.
  const mine = delivered.filter((d) => d.id === review.id);
  assert.deepEqual(mine.map((d) => d.by), [`home:${h.sessionId}`], "delivered live, not only on the next restart");
  assert.match(mine[0]!.text, /after its MCP wait ended/);
});

test("the dashboard's own resolve route still settles as the human, unchanged", async () => {
  const worker = liveSession("w-dashboard-resolve");
  const review = reviews.create(worker, "input", "Q", "Keep?", [QUESTION]);
  const res = await app.request(`/api/reviews/${review.id}/resolve`, {
    method: "POST", headers, body: JSON.stringify({ action: "answer", response: "Keep" }),
  });
  assert.equal(res.status, 200);
  assert.equal(row(review.id).resolvedBy, "human");
  assert.equal(isApprovingActor("home:abc"), false);
  assert.equal(isApprovingActor("session:abc"), false);
  assert.equal(isApprovingActor("mctl"), false);
  assert.equal(isApprovingActor("human"), true);
  assert.equal(isApprovingActor("standing-approval"), true);
  assert.equal(isApprovingActor("home-approval:abc"), true);
});
