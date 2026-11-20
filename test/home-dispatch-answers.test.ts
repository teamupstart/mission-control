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
const { closeDb, openDb, loadHumanResolvedReviews, loadConversationResolvedReviews, loadReviewContinuationCandidates } =
  await import("../src/server/db.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const flags = await import("../src/server/feature-flags/index.ts");
const { HomeDispatchReceiptSchema } = await import("../src/shared/home-dispatch.ts");
const { isApprovingActor } = await import("../src/shared/review-item.ts");
const { receiptLine, HOME_DISPATCH_CHAT_FIRST_TEXT } = await import("../src/shared/home-dispatch-inbox.ts");
const { mkTask, mkMuxHandle } = await import("./helpers/session-fixture.ts");
const { revisionHashFor } = await import("../src/server/home-dispatch/approval.ts");
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
  const worker = liveSession(`w-${id}`);
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
