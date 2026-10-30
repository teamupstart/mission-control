import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkTask } from "./helpers/session-fixture.ts";
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
const { closeDb, openDb, loadConversationResolvedReviews } = await import("../src/server/db.ts");
const { savePlan } = await import("../src/server/plans/store.ts");
const { planAuthority } = await import("../src/server/plans/authority.ts");
const { STANDING_FOLLOW_UP_NOTE } = await import("../src/server/plans/publication.ts");

const managers: InstanceType<typeof WorkflowManager>[] = [];
afterEach(async () => { for (const m of managers.splice(0)) await m.stop(); });
after(() => { closeDb(); rmSync(home, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

async function fixture() {
  const id = randomUUID(), repo = join(home, id);
  mkdirSync(repo); git(repo, "init", "-q", "-b", "main");
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "initial");
  const registry = new Registry();
  registry.applyDiscovery([{ syntheticId: id, agent: "claude", name: id, nameSource: "process", cwd: repo, gitRoot: repo, repoRoot: repo, gitBranch: "main", pid: 1, tty: null, terminals: [], startedAt: 1 }]);
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
  const ask = async (decisions?: object[]): Promise<ReviewItem> => {
    const res = await app.request("/mcp/v2/reviews", { method: "POST", headers, body: JSON.stringify({ env: {}, sessionId: id, cwd: repo,
      kind: "plan-decisions", title: "Approve bundle", body: "Inspect complete Markdown and HTML", decisions,
      managedPlan: { repoSlot: "repo-01", planId: input.planId, revision: input.revision } }) });
    assert.equal(res.status, 200, await res.clone().text());
    const { id: reviewId } = await res.json() as { id: string };
    return registry.getReview(reviewId)!;
  };
  const resolve = (reviewId: string, body: object) => app.request(`/api/reviews/${reviewId}/resolve`, { method: "POST", headers, body: JSON.stringify(body) });
  const approve = { action: "answer", response: "Approved", selections: [{ decisionId: "approve-final-bundle", selected: ["approve"], other: null }] };
  const grants = () => openDb().prepare("SELECT task_id, review_id FROM managed_plan_standing_approvals WHERE task_id = ?").all(task.id).map((row) => ({ ...row }));
  return { id, task, registry, reviews, service, input, ask, resolve, approve, grants };
}

test("ticking approve all future bundles approves later final bundles without prompting and logs them", async () => {
  const f = await fixture();
  const first = await f.ask();
  assert.equal(first.status, "pending", "the first bundle still asks the operator");

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

  // Answering the remaining question tells the agent the bundle is already approved.
  const answered = await f.resolve(later.id, { action: "answer", response: "Plan decisions submitted:\n\n• Which scope?\n  → A", selections: [{ decisionId: "scope", selected: ["a"], other: null }] });
  assert.equal(answered.status, 200, await answered.clone().text());
  const settled = f.registry.getReview(later.id)!;
  assert.ok(settled.response?.startsWith(STANDING_FOLLOW_UP_NOTE));
  assert.match(settled.response!, /→ A/);
  assert.equal(f.service.readiness(f.input).state, "approved", "answering the other question leaves the approval standing");
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
