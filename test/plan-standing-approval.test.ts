import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedGitRepo } from "./helpers/git-fixture.ts";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkMuxHandle, mkTask } from "./helpers/session-fixture.ts";
import type { PlanIdentity } from "../src/shared/managed-plans.ts";
import type { ReviewItem } from "../src/shared/types.ts";
import { STANDING_APPROVAL_NOTE, isConversationResolvedReview, isHumanResolvedReview } from "../src/shared/review-item.ts";
import { reviewAnswerVerb } from "../src/web/lib/reviews.ts";

const home = realpathSync(mkdtempSync(join(tmpdir(), "mission-standing-approval-")));
process.env.MISSION_HOME = join(home, "state");
const { Registry } = await import("../src/server/registry.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const { PersonaManager } = await import("../src/server/workflows/personas.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const { closeDb, openDb, loadConversationResolvedReviews, loadPendingReviews } = await import("../src/server/db.ts");
const { savePlan } = await import("../src/server/plans/store.ts");
const { planAuthority } = await import("../src/server/plans/authority.ts");
const { STANDING_FOLLOW_UP_NOTE, describeFiledPlanIdentity } = await import("../src/server/plans/publication.ts");
const { applyFeatureFlagIntent } = await import("../src/server/feature-flags/index.ts");
const { filedPlanReceipt } = await import("../src/shared/async-input.ts");

/** Both flags on: `request_plan_decisions` files its form (`filed-plan-decisions`). */
function fileForms(enabled: boolean): void {
  for (const id of ["async-input", "filed-plan-decisions"]) {
    assert.equal(applyFeatureFlagIntent({ kind: "flag", id, enabled }).ok, true);
  }
}

const managers: InstanceType<typeof WorkflowManager>[] = [];
afterEach(async () => { for (const m of managers.splice(0)) await m.stop(); fileForms(false); });
after(() => { closeDb(); rmSync(home, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

async function fixture(options: { messageable?: boolean } = {}) {
  const id = randomUUID(), repo = join(home, id);
  seedGitRepo(repo, { branch: "main", files: {}, message: "initial", name: "Test", email: "test@example.com", storeIdentity: false });
  const registry = new Registry();
  registry.applyDiscovery([{ syntheticId: id, agent: "claude", name: id, nameSource: "process", cwd: repo, gitRoot: repo, repoRoot: repo, gitBranch: "main", pid: 1, tty: null,
    terminals: options.messageable ? [mkMuxHandle({ session: "s", windowName: "w", windowIndex: 0, paneId: `%${id.slice(0, 4)}` })] : [], startedAt: 1 }]);
  registry.applyHook({ agent: "claude", event: "Stop", sessionId: id, cwd: repo, transcriptPath: null, env: {} });
  const session = registry.getSession(id)!;
  const task = mkTask({ id: `task-${id}`, kind: "plan", status: "running", sessionId: id, repoRoot: repo, worktreePath: repo, baseSha: git(repo, "rev-parse", "HEAD"), workflowId: null,
    planPolicy: { version: 2, storage: "local", commitPlanHtml: true }, planInputs: [] });
  registry.upsertTask(task);
  const personas = new PersonaManager(registry), workflows = new WorkflowManager(registry, personas.store);
  managers.push(workflows);
  const tasks = new TaskManager(registry), reviews = new ReviewManager(registry);
  const app = buildApp({ registry, workflows, personas, tasks, reviews, queues: new QueueManager(registry) });
  const authority = planAuthority(registry, session, "repo-01");
  const files = [{ name: "plan.md", content: "# Exact local plan" }, { name: "plan.html", content: "<h1>Exact local plan</h1>" }];
  const saved = await savePlan(authority, { repoSlot: "repo-01", requestId: randomUUID(), slug: "local-plan", expectedRevision: 0, files });
  const input: PlanIdentity = { repoKey: saved.manifest.repoKey, planId: saved.manifest.planId, revision: 1 };
  const service = workflows.localPlanPublication(tasks);
  const headers = { host: "127.0.0.1:7317", "content-type": "application/json", "x-harness-token": ensureToken() };
  const send = (decisions?: object[], extra: object = {}) =>
    app.request("/mcp/v2/reviews", { method: "POST", headers, body: JSON.stringify({ env: {}, sessionId: id, cwd: repo,
      kind: "plan-decisions", title: "Approve bundle", body: "Inspect complete Markdown and HTML", decisions,
      managedPlan: { repoSlot: "repo-01", planId: input.planId, revision: input.revision }, ...extra }) });
  const post = async (decisions?: object[], extra: object = {}) => {
    const res = await send(decisions, extra);
    assert.equal(res.status, 200, await res.clone().text());
    return await res.json() as { id: string; sessionId: string; wait?: string; receipt?: string };
  };
  const ask = async (decisions?: object[]): Promise<ReviewItem> => registry.getReview((await post(decisions)).id)!;
  const resolve = (reviewId: string, body: object) => app.request(`/api/reviews/${reviewId}/resolve`, { method: "POST", headers, body: JSON.stringify(body) });
  const approve = { action: "answer", response: "Approved", selections: [{ decisionId: "approve-final-bundle", selected: ["approve"], other: null }] };
  const grants = () => openDb().prepare("SELECT task_id, review_id FROM managed_plan_standing_approvals WHERE task_id = ?").all(task.id).map((row) => ({ ...row }));
  return { id, task, registry, reviews, service, authority, input, ask, send, post, resolve, approve, grants };
}

test("ticking approve all future bundles approves later final bundles without prompting and logs them", async () => {
  const f = await fixture();
  const first = await f.ask();
  assert.equal(first.status, "pending", "the first bundle still asks the operator");
  assert.equal(first.standingApprovalEligible, true, "a task's bound final-bundle approval offers the checkbox");
  assert.equal(loadPendingReviews().find((r) => r.id === first.id)?.standingApprovalEligible, true, "and still does after a restart");

  const res = await f.resolve(first.id, { ...f.approve, approveFutureBundles: true });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(f.grants(), [{ task_id: f.task.id, review_id: first.id }]);

  const later = await f.ask();
  assert.equal(later.status, "answered", "a later bundle is settled at creation, never shown as pending");
  assert.equal(later.resolvedBy, "standing-approval");
  assert.deepEqual(later.selections, [{ decisionId: "approve-final-bundle", selected: ["approve"], other: null }]);
  assert.ok(later.response?.startsWith(STANDING_APPROVAL_NOTE), "the agent is told why it was approved");
  assert.equal(f.registry.pendingReviews(f.id).length, 0);

  // Logged in the session's conversation, attributed to the standing approval, not the human.
  assert.ok(loadConversationResolvedReviews(f.id).some((r) => r.id === later.id));
  assert.equal(isConversationResolvedReview(later), true);
  assert.equal(isHumanResolvedReview(later), false);
  assert.equal(reviewAnswerVerb(later), "auto-approved (all future bundles for this task)");

  // And it is the approval the publication gate accepts.
  assert.equal(f.service.readiness(f.input).state, "approved");

  // A retried identical ask (an MCP client timeout) reuses that approval instead of logging another.
  const retried = await f.ask();
  assert.equal(retried.id, later.id);
  assert.equal(loadConversationResolvedReviews(f.id).filter((r) => r.resolvedBy === "standing-approval").length, 1);
});

test("with a standing approval, a bundle's other open choices are asked on their own and the bundle is auto-approved", async () => {
  const f = await fixture();
  const first = await f.ask();
  assert.equal((await f.resolve(first.id, { ...f.approve, approveFutureBundles: true })).status, 200);
  const scope = { id: "scope", question: "Which scope?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] };
  const later = await f.ask([scope]);

  // The operator is asked only the remaining question; the bundle question is not shown again.
  assert.equal(later.status, "pending");
  assert.deepEqual(later.decisions?.map((d) => d.id), ["scope"]);
  assert.match(later.body, /approved automatically by your standing approval/);

  // The bundle approval was settled at creation and logged in the conversation.
  const logged = loadConversationResolvedReviews(f.id).filter((r) => r.resolvedBy === "standing-approval");
  assert.equal(logged.length, 1);
  assert.deepEqual(logged[0]!.decisions?.map((d) => d.id), ["approve-final-bundle"]);
  assert.equal(f.service.readiness(f.input).state, "approved", "the gate accepts it before the other question is answered");

  // A retry reuses both the approval and the pending follow-up.
  const retried = await f.ask([scope]);
  assert.equal(retried.id, later.id);
  assert.equal(loadConversationResolvedReviews(f.id).filter((r) => r.resolvedBy === "standing-approval").length, 1);

  // Answering the remaining question tells the agent the bundle is already approved.
  const answered = await f.resolve(later.id, { action: "answer", response: "Plan decisions submitted:\n\n• Which scope?\n  → A", selections: [{ decisionId: "scope", selected: ["a"], other: null }] });
  assert.equal(answered.status, 200, await answered.clone().text());
  const settled = f.registry.getReview(later.id)!;
  assert.ok(settled.response?.startsWith(STANDING_FOLLOW_UP_NOTE));
  assert.match(settled.response!, /→ A/);
  assert.equal(f.service.readiness(f.input).state, "approved", "answering the other question leaves the approval standing");

  // An answer carrying selections but no response text still tells the agent.
  const again = await f.ask([{ ...scope, question: "Which scope, again?" }]);
  assert.equal(again.status, "pending");
  const bare = await f.resolve(again.id, { action: "answer", selections: [{ decisionId: "scope", selected: ["b"], other: null }] });
  assert.equal(bare.status, 200, await bare.clone().text());
  assert.equal(f.registry.getReview(again.id)?.response, STANDING_FOLLOW_UP_NOTE);
});

test("without the checkbox, a later bundle is still asked", async () => {
  const f = await fixture();
  const first = await f.ask();
  assert.equal((await f.resolve(first.id, f.approve)).status, 200);
  assert.deepEqual(f.grants(), []);
  assert.equal((await f.ask()).status, "pending");
});

test("needs revision with the checkbox ticked does not grant a standing approval", async () => {
  const f = await fixture();
  const first = await f.ask();
  const revise = { action: "answer", response: "Needs revision", selections: [{ decisionId: "approve-final-bundle", selected: ["revise"], other: null }], approveFutureBundles: true };
  assert.equal((await f.resolve(first.id, revise)).status, 200);
  assert.equal(f.registry.getReview(first.id)?.status, "answered", "the revision answer itself still reaches the agent");
  assert.deepEqual(f.grants(), []);
  const next = await f.ask();
  assert.equal(next.status, "pending", "the next bundle still asks the operator");
  assert.equal(f.service.readiness(f.input).state, "blocked");
});

test("only the operator's submitted final-bundle answer can grant a standing approval", async () => {
  const f = await fixture();
  const bundle = await f.ask();

  const byForeman = await f.resolve(bundle.id, { ...f.approve, by: "foreman", approveFutureBundles: true });
  assert.equal(byForeman.status, 403);
  assert.equal(f.registry.getReview(bundle.id)?.status, "pending", "a refused grant leaves the question open");

  assert.equal((await f.resolve(bundle.id, { action: "dismiss", approveFutureBundles: true })).status, 200);
  assert.deepEqual(f.grants(), [], "a dismissal decided nothing");

  // A form that approves nothing ignores the flag; it never grants.
  const plain = f.reviews.create(f.id, "input", "Question", "Pick one", [{ id: "q", question: "Pick one", options: [{ id: "a", label: "A" }] }]);
  const ignored = await f.resolve(plain.id, { action: "answer", response: "A", selections: [{ decisionId: "q", selected: ["a"], other: null }], approveFutureBundles: true });
  assert.equal(ignored.status, 200);
  assert.deepEqual(f.grants(), []);

  // A review that is not a managed plan's bound final-bundle approval is refused even when its answer looks like one.
  const unbound = f.reviews.create(f.id, "plan-decisions", "Not a managed plan", "Pick", [{ id: "approve-final-bundle", question: "Approve?", options: [{ id: "approve", label: "Approve" }] }]);
  assert.notEqual(unbound.standingApprovalEligible, true, "so the dashboard does not offer the checkbox on it");
  assert.notEqual(loadPendingReviews().find((r) => r.id === unbound.id)?.standingApprovalEligible, true);
  const refused = await f.resolve(unbound.id, { ...f.approve, approveFutureBundles: true });
  assert.equal(refused.status, 400);
  assert.equal(f.registry.getReview(unbound.id)?.status, "pending");
  assert.deepEqual(f.grants(), []);
});

test("a standing approval stays with the task that granted it", async () => {
  const a = await fixture(), b = await fixture();
  const granted = await a.ask();
  assert.equal((await a.resolve(granted.id, { ...a.approve, approveFutureBundles: true })).status, 200);
  assert.equal(a.grants().length, 1);

  const other = await b.ask();
  assert.equal(other.status, "pending", "another task's bundle still asks the operator");
  assert.equal(other.resolvedBy, null);
  assert.deepEqual(b.grants(), []);
  assert.equal(b.service.readiness(b.input).state, "blocked");
});

test("a grant that fails to persist leaves the review pending so the checked approval can be retried", async () => {
  const f = await fixture();
  const bundle = await f.ask();
  const ddl = (openDb().prepare("SELECT sql FROM sqlite_master WHERE name = 'managed_plan_standing_approvals'").get() as { sql: string }).sql;
  openDb().exec("DROP TABLE managed_plan_standing_approvals");
  try {
    const failed = await f.resolve(bundle.id, { ...f.approve, approveFutureBundles: true });
    assert.ok(failed.status >= 400, `expected a failure, got ${failed.status}`);
    assert.equal(f.registry.getReview(bundle.id)?.status, "pending", "nothing was published as settled");
    assert.ok(loadPendingReviews().some((r) => r.id === bundle.id), "the status write rolled back with the grant");
  } finally {
    openDb().exec(ddl);
  }
  const retried = await f.resolve(bundle.id, { ...f.approve, approveFutureBundles: true });
  assert.equal(retried.status, 200, await retried.clone().text());
  assert.equal(f.registry.getReview(bundle.id)?.status, "answered");
  assert.equal(f.grants().length, 1);
});

// ---- Filed plan decisions (`filed-plan-decisions`): managed approval on the filed path ----

test("the filed answer's managed identity line is worded from the review and its binding alone, with no database", () => {
  const plan = { planId: "p-1", revision: 3, slug: "linter-rollout" };
  const approve = [{ decisionId: "approve-final-bundle", selected: ["approve"], other: null }];
  assert.equal(describeFiledPlanIdentity({ status: "answered", resolvedBy: "human", selections: approve }, { own: plan }),
    "Managed plan: linter-rollout (plan p-1, revision 3). This answer approved that exact final bundle.");
  for (const review of [
    { status: "answered" as const, resolvedBy: "human" as const, selections: [{ decisionId: "approve-final-bundle", selected: ["revise"], other: null }] },
    { status: "dismissed" as const, resolvedBy: "human" as const, selections: null },
    { status: "answered" as const, resolvedBy: "foreman" as const, selections: approve },
  ]) {
    assert.match(describeFiledPlanIdentity(review, { own: plan })!, /This answer did not approve that final bundle\.$/);
  }
  assert.equal(describeFiledPlanIdentity({ status: "answered", resolvedBy: "human", selections: null }, { own: { ...plan, slug: null } }),
    "Managed plan: managed plan (plan p-1, revision 3). This answer did not approve that final bundle.");
  assert.equal(describeFiledPlanIdentity({ status: "answered", resolvedBy: "human", selections: null }, { followUpOf: plan }),
    "Managed plan: linter-rollout (plan p-1, revision 3). Its final bundle was already approved by standing approval; this answer covers only the remaining decisions.");
  assert.equal(describeFiledPlanIdentity({ status: "answered", resolvedBy: "human", selections: null }, null), null);
});

test("a filed final-bundle approval is bound, approves, grants the standing approval, and its answer names the plan", async () => {
  fileForms(true);
  const f = await fixture({ messageable: true });
  const messages = new Map<string, string>();
  f.reviews.startContinuationRecovery((review, text) => { messages.set(review.id, text); return true; });
  const filed = await f.post(undefined, { asyncCapable: true });
  assert.equal(filed.wait, "message");
  assert.equal(filed.receipt, filedPlanReceipt({ id: filed.id }));
  const review = f.registry.getReview(filed.id)!;
  assert.equal(review.waitMode, "message");
  assert.equal(review.standingApprovalEligible, true, "the checkbox is still offered");
  assert.ok(openDb().prepare("SELECT 1 FROM managed_plan_reviews WHERE review_id = ?").get(filed.id), "bound at creation, as today");
  assert.equal(f.registry.getSession(f.id)!.pendingReviews, 1, "a gate the session stops on");
  assert.equal(f.service.readiness(f.input).state === "approved", false, "a receipt is not approval");

  const res = await f.resolve(filed.id, { ...f.approve, approveFutureBundles: true });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(f.grants(), [{ task_id: f.task.id, review_id: filed.id }], "the grant commits with the filed answer");
  assert.equal(f.service.readiness(f.input).state, "approved", "publication accepts the filed approval");
  const answer = messages.get(filed.id)!;
  assert.match(answer, /answer to your filed plan/);
  assert.match(answer, /\n\nApproved\n\n/, "the decision as the operator gave it");
  assert.match(answer, new RegExp(`Managed plan: local-plan \\(plan ${f.input.planId}, revision 1\\)\\. This answer approved that exact final bundle\\.`));

  // Standing approval with nothing remaining: unchanged, born settled and said as `call`.
  const later = await f.post(undefined, { asyncCapable: true });
  assert.equal(later.wait, "call");
  assert.equal(later.receipt, undefined);
  assert.equal(f.registry.getReview(later.id)?.resolvedBy, "standing-approval");

  // Standing approval with other decisions: the follow-up is filed, its receipt says the bundle is approved.
  const scope = { id: "scope", question: "Which scope?", options: [{ id: "a", label: "A" }] };
  const followUp = await f.post([scope], { asyncCapable: true });
  assert.equal(followUp.wait, "message");
  assert.equal(followUp.receipt, filedPlanReceipt({ id: followUp.id }, { bundleApproved: true }));
  assert.equal((await f.resolve(followUp.id, { action: "answer", response: "• Which scope?\n  → A", selections: [{ decisionId: "scope", selected: ["a"], other: null }] })).status, 200);
  const followUpAnswer = messages.get(followUp.id)!;
  assert.ok(followUpAnswer.includes(STANDING_FOLLOW_UP_NOTE), "the follow-up's answer keeps its note");
  assert.match(followUpAnswer, /already approved by standing approval; this answer covers only the remaining decisions/);
});

test("publishing after a filed final-bundle approval issues the receipt for that review, and nothing publishes before it is answered", async () => {
  fileForms(true);
  const f = await fixture({ messageable: true });
  // Withdrawn and dismissed filed forms leave publication refused.
  const withdrawn = await f.post(undefined, { asyncCapable: true });
  assert.equal(withdrawn.wait, "message");
  f.reviews.withdrawQuestion(f.id, withdrawn.id, "Scope changed");
  await assert.rejects(f.service.publish(f.authority, f.input), /explicit human approval/);
  const dismissed = await f.post(undefined, { asyncCapable: true, title: "Approve bundle again" });
  assert.equal((await f.resolve(dismissed.id, { action: "dismiss" })).status, 200);
  await assert.rejects(f.service.publish(f.authority, f.input), /explicit human approval/);

  // A filed form still open: the receipt is not approval, so publication refuses.
  const filed = await f.post(undefined, { asyncCapable: true, title: "Approve bundle, filed" });
  assert.equal(filed.wait, "message");
  assert.equal(f.registry.getReview(filed.id)?.waitMode, "message");
  await assert.rejects(f.service.publish(f.authority, f.input), /explicit human approval/);

  // Answered from the dashboard's resolve route: publication succeeds on the filed review.
  assert.equal((await f.resolve(filed.id, f.approve)).status, 200);
  const receipt = await f.service.publish(f.authority, f.input);
  assert.equal(receipt.reviewId, filed.id, "the receipt names the filed review that approved it");
  assert.equal(receipt.planId, f.input.planId);
  assert.equal(receipt.revision, f.input.revision);
  assert.equal(receipt.storage, "local");
  assert.deepEqual(await f.service.publish(f.authority, f.input), receipt, "publishing again returns the same receipt");
});

test("a withdrawn or dismissed filed final-bundle approval never approves", async () => {
  fileForms(true);
  const f = await fixture({ messageable: true });
  const messages = new Map<string, string>();
  f.reviews.startContinuationRecovery((review, text) => { messages.set(review.id, text); return true; });
  const withdrawn = await f.post(undefined, { asyncCapable: true });
  f.reviews.withdrawQuestion(f.id, withdrawn.id, "Scope changed");
  assert.equal(f.registry.getReview(withdrawn.id)?.status, "withdrawn");
  assert.equal(f.service.readiness(f.input).state === "approved", false);
  assert.equal(messages.has(withdrawn.id), false, "no answer message for a withdrawal");

  const dismissed = await f.post(undefined, { asyncCapable: true, title: "Approve bundle again" });
  assert.equal((await f.resolve(dismissed.id, { action: "dismiss" })).status, 200);
  assert.equal(f.service.readiness(f.input).state === "approved", false);
  assert.match(messages.get(dismissed.id)!, /did not approve that final bundle/);
  assert.match(messages.get(dismissed.id)!, /nothing was approved/);
});

test("with either flag off a managed final-bundle approval still blocks in the call", async () => {
  const f = await fixture({ messageable: true });
  const call = await f.post(undefined, { asyncCapable: true });
  assert.equal(call.wait, "call");
  assert.equal(f.registry.getReview(call.id)?.waitMode, undefined);
  assert.equal(applyFeatureFlagIntent({ kind: "flag", id: "async-input", enabled: true }).ok, true);
  const still = await f.post(undefined, { asyncCapable: true, title: "Approve bundle twice" });
  assert.equal(still.wait, "call", "filed-plan-decisions alone is off");
});

/** Save the fixture's plan again as revision 2, as a scope change would. */
async function reviseBundle(f: Awaited<ReturnType<typeof fixture>>): Promise<PlanIdentity> {
  const files = [{ name: "plan.md", content: "# Exact local plan, revised" }, { name: "plan.html", content: "<h1>Exact local plan, revised</h1>" }];
  await savePlan(f.authority, { repoSlot: "repo-01", requestId: randomUUID(), planId: f.input.planId, slug: "local-plan", expectedRevision: 1, files });
  return { ...f.input, revision: 2 };
}

test("a revised managed bundle form binds its own revision, approving it publishes that revision, and the withdrawn earlier form never approves", async () => {
  fileForms(true);
  const f = await fixture({ messageable: true });
  const first = await f.post(undefined, { asyncCapable: true });
  assert.equal(first.wait, "message");
  const next = await reviseBundle(f);
  const revised = await f.post(undefined, {
    asyncCapable: true, title: "Approve bundle, revised", revises: first.id,
    managedPlan: { repoSlot: "repo-01", planId: next.planId, revision: next.revision },
  });
  assert.equal(revised.wait, "message");
  assert.deepEqual(f.registry.getReview(revised.id)?.revision, { number: 2, previousId: first.id });
  assert.equal(f.registry.getReview(first.id)?.status, "withdrawn", "the open earlier form is withdrawn with the new one");
  const bound = openDb().prepare("SELECT review_id, revision FROM managed_plan_reviews WHERE review_id IN (?, ?) ORDER BY revision")
    .all(first.id, revised.id).map((row) => ({ ...row }));
  assert.deepEqual(bound, [{ review_id: first.id, revision: 1 }, { review_id: revised.id, revision: 2 }],
    "each form keeps its own binding; the earlier one stays as an unapproved record");
  assert.notEqual(f.service.readiness(f.input).state, "approved");
  assert.notEqual(f.service.readiness(next).state, "approved", "the link carries no approval forward");

  assert.equal((await f.resolve(revised.id, f.approve)).status, 200);
  assert.equal(f.service.readiness(next).state, "approved");
  assert.notEqual(f.service.readiness(f.input).state, "approved", "the withdrawn earlier form never approves");
  const receipt = await f.service.publish(f.authority, next);
  assert.equal(receipt.reviewId, revised.id);
  assert.equal(receipt.revision, 2);
  // Revision 1 can never publish now: it is stale, and its only form was withdrawn unapproved.
  await assert.rejects(f.service.publish(f.authority, f.input), /stale/);
});

test("a revised bundle a standing approval covers outright is recorded as the revision, and an invalid revises binds nothing", async () => {
  fileForms(true);
  const f = await fixture({ messageable: true });
  const open = await f.post(undefined, { asyncCapable: true, title: "Approve bundle, still open" });
  const granted = await f.post(undefined, { asyncCapable: true });
  assert.equal((await f.resolve(granted.id, { ...f.approve, approveFutureBundles: true })).status, 200);
  const next = await reviseBundle(f);
  const managedPlan = { repoSlot: "repo-01", planId: next.planId, revision: next.revision };

  // Refused before the approval is bound or recorded.
  const bindings = () => (openDb().prepare("SELECT COUNT(*) AS n FROM managed_plan_reviews").get() as { n: number }).n;
  const before = bindings();
  const bad = await f.send(undefined, { asyncCapable: true, revises: granted.id, managedPlan });
  assert.equal(bad.status, 409);
  assert.match(((await bad.json()) as { error: string }).error, /was already answered/);
  assert.equal(bindings(), before, "no approval was bound for a refused revision");

  const approved = await f.post(undefined, { asyncCapable: true, revises: open.id, managedPlan });
  assert.equal(approved.wait, "call", "born settled, as without revises");
  const record = f.registry.getReview(approved.id)!;
  assert.equal(record.resolvedBy, "standing-approval");
  assert.deepEqual(record.revision, { number: 2, previousId: open.id });
  assert.equal(f.registry.getReview(open.id)?.status, "withdrawn", "the open earlier form does not linger as a gate");
  assert.equal(f.service.readiness(next).state, "approved");
});


test("a reused standing approval answers a revision request only when it is that same revision; otherwise revises is checked and applied", async () => {
  fileForms(true);
  const f = await fixture({ messageable: true });
  const open = await f.post(undefined, { asyncCapable: true, title: "Approve bundle, still open" });
  const granted = await f.post(undefined, { asyncCapable: true });
  assert.equal((await f.resolve(granted.id, { ...f.approve, approveFutureBundles: true })).status, 200);
  // An approval recorded for this bundle without revises: the one a later identical ask reuses.
  const plain = await f.post(undefined, { asyncCapable: true });
  assert.equal(f.registry.getReview(plain.id)?.resolvedBy, "standing-approval");
  assert.equal(f.registry.getReview(plain.id)?.revision, undefined);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
  const reviewRows = () => (openDb().prepare("SELECT COUNT(*) AS n FROM reviews").get() as { n: number }).n;

  // Invalid: the reusable approval is not handed back, and the refusal writes nothing.
  const before = reviewRows();
  const bad = await f.send(undefined, { asyncCapable: true, revises: "no-such-review" });
  assert.equal(bad.status, 409);
  assert.match(((await bad.json()) as { error: string }).error, /is not a review Mission Control knows/);
  assert.equal(reviewRows(), before);

  // Valid: a new approval carries the link, and the open earlier form is withdrawn with it.
  await settle();
  const revised = await f.post(undefined, { asyncCapable: true, revises: open.id });
  assert.notEqual(revised.id, plain.id, "the unlinked approval is not reused for a revision");
  assert.deepEqual(f.registry.getReview(revised.id)?.revision, { number: 2, previousId: open.id });
  assert.equal(f.registry.getReview(revised.id)?.resolvedBy, "standing-approval");
  assert.equal(f.registry.getReview(open.id)?.status, "withdrawn");

  // A retry of that same revision request reuses the approval it already recorded.
  await settle();
  const rows = reviewRows();
  const retried = await f.post(undefined, { asyncCapable: true, revises: open.id });
  assert.equal(retried.id, revised.id);
  assert.equal(reviewRows(), rows, "nothing new is recorded");
});

test("a standing approval whose record fails takes its plan binding back, so no binding names a missing review", async () => {
  fileForms(true);
  const f = await fixture({ messageable: true });
  const granted = await f.post(undefined, { asyncCapable: true });
  assert.equal((await f.resolve(granted.id, { ...f.approve, approveFutureBundles: true })).status, 200);
  const bindings = () => (openDb().prepare("SELECT COUNT(*) AS n FROM managed_plan_reviews").get() as { n: number }).n;
  const dangling = () => (openDb().prepare(
    "SELECT COUNT(*) AS n FROM managed_plan_reviews m LEFT JOIN reviews r ON r.id = m.review_id WHERE r.id IS NULL").get() as { n: number }).n;
  const before = bindings();
  // The approval's binding is written, then recording the approval itself fails.
  openDb().exec(`CREATE TRIGGER fail_standing_record BEFORE INSERT ON reviews WHEN NEW.status = 'answered'
    BEGIN SELECT RAISE(ABORT, 'disk refused the approval'); END;`);
  try {
    const res = await f.send(undefined, { asyncCapable: true, title: "Approve bundle, record fails" });
    assert.notEqual(res.status, 200);
    assert.match(await res.text(), /disk refused the approval/);
  } finally {
    openDb().exec("DROP TRIGGER fail_standing_record");
  }
  assert.equal(bindings(), before, "the binding written for the failed record was taken back");
  assert.equal(dangling(), 0, "no binding names a review that does not exist");
  // And the next identical ask records its approval normally.
  const approved = await f.post(undefined, { asyncCapable: true, title: "Approve bundle, record fails" });
  assert.equal(f.registry.getReview(approved.id)?.resolvedBy, "standing-approval");
  assert.equal(bindings(), before + 1);
});
