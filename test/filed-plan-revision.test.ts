import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { PlanDecision, ReviewItem, ReviewStatus, ServerEvent } from "../src/shared/types.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";

// Filed plan decisions, Phase 2, at the daemon: `request_plan_decisions` with `revises`. Which
// forms are valid targets (an open filed plan form of the same session, or one its own agent
// withdrew, decided from the mode stored on the row now), every refusal and that it writes
// nothing, the atomic replacement of an open form through the one agent-withdrawal writer,
// numbering, and the link surviving a restart. docs/plans/filed-plan-decisions/phase-2-revised-forms.md
// is the specification these pin.

const home = mkdtempSync(join(tmpdir(), "mission-filed-plan-revision-"));
process.env.MISSION_HOME = home;

const { openDb, insertReview, loadReview, reviewRevisedBy } = await import("../src/server/db.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const { applyFeatureFlagIntent } = await import("../src/server/feature-flags/index.ts");
const { withdrawnByItsAgent } = await import("../src/shared/async-input.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager, RevisionRefusal } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { buildApp } = await import("../src/server/routes.ts");

after(() => rmSync(home, { recursive: true, force: true }));
openDb();
const TOKEN = ensureToken();
function flags(enabled: boolean): void {
  for (const id of ["async-input", "filed-plan-decisions"]) {
    assert.equal(applyFeatureFlagIntent({ kind: "flag", id, enabled }).ok, true);
  }
}
afterEach(() => flags(false));

let seq = 0;
function mkDiscovered(over: Partial<DiscoveredSession> = {}): DiscoveredSession {
  const n = ++seq;
  return {
    syntheticId: `proc:ttys40${n}:${n}:0`,
    agent: "claude",
    name: "work",
    nameSource: "process",
    cwd: `/wt/revise-${n}`,
    gitBranch: "harness/revise",
    gitRoot: null,
    repoRoot: null,
    pid: 4000 + n,
    tty: `ttys40${n}`,
    terminals: [mkMuxHandle({ session: "s", windowName: "w", windowIndex: 0, paneId: `%${400 + n}` })],
    startedAt: 0,
    ...over,
  } as DiscoveredSession;
}

const decisions = (question: string): PlanDecision[] => [
  { id: "q", question, options: [{ id: "o0", label: "biome" }, { id: "o1", label: "eslint", recommended: true }] },
];

function fleet() {
  const registry = new Registry();
  const reviews = new ReviewManager(registry);
  const app = buildApp({ registry, reviews, tasks: new TaskManager(registry), queues: new QueueManager(registry) });
  return { registry, reviews, app };
}
type Fleet = ReturnType<typeof fleet>;

const headers = { host: "127.0.0.1:7317", "content-type": "application/json", "x-harness-token": TOKEN };
type Created = { id: string; sessionId: string; wait: "call" | "message"; receipt?: string };

/** File a plan the way the MCP tool does: capable, so it is filed when both flags are on. */
function postPlan(app: Fleet["app"], cwd: string | null, extra: Record<string, unknown> = {}) {
  const title = (extra.title as string | undefined) ?? `Plan ${++seq}`;
  return app.request("/mcp/reviews", {
    method: "POST",
    headers,
    body: JSON.stringify({ env: {}, cwd, kind: "plan-decisions", title, body: `# ${title}\n\nThe plan.`, decisions: decisions(`${title}?`), asyncCapable: true, ...extra }),
  });
}

async function file(app: Fleet["app"], cwd: string | null, extra: Record<string, unknown> = {}): Promise<Created> {
  const res = await postPlan(app, cwd, extra);
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()) as Created;
}

const withdraw = (app: Fleet["app"], cwd: string | null, id: string, reason: string) =>
  app.request(`/mcp/questions/${id}/withdraw`, { method: "POST", headers, body: JSON.stringify({ env: {}, cwd, reason }) });

const reviewCount = () => (openDb().prepare("SELECT COUNT(*) AS n FROM reviews").get() as { n: number }).n;
const row = (id: string) => openDb().prepare("SELECT status, response, resolved_by, revises_review_id, revision FROM reviews WHERE id = ?").get(id) as
  { status: string; response: string | null; resolved_by: string | null; revises_review_id: string | null; revision: number | null };

/** A `revises` the daemon must refuse: 409 with its reason, and not one row written or changed. */
async function refused(app: Fleet["app"], cwd: string | null, revises: string, why: RegExp): Promise<void> {
  const before = reviewCount();
  const target = loadReview(revises);
  const res = await postPlan(app, cwd, { revises, title: `Revision attempt ${++seq}` });
  const body = await res.text();
  assert.equal(res.status, 409, body);
  const { error } = JSON.parse(body) as { error: string };
  assert.match(error, /^Not filed: revises names /);
  assert.match(error, why);
  assert.match(error, /Nothing was filed\.$/);
  assert.equal(reviewCount(), before, "nothing was filed");
  assert.deepEqual(loadReview(revises), target, "the target is exactly as it was");
}

/** A filed plan form row built directly, for states no path produces. */
function seedFiled(sessionId: string, status: ReviewStatus, over: Partial<ReviewItem> = {}): ReviewItem {
  const review: ReviewItem = {
    id: `seed-${++seq}`, sessionId, kind: "plan-decisions", title: `Seeded ${seq}`, body: "# Seeded", status, response: null,
    decisions: decisions("Seeded?"), waitMode: "message", createdAt: Date.now(), resolvedAt: null, ...over,
  };
  insertReview(review);
  if (status !== "pending") {
    openDb().prepare("UPDATE reviews SET status = ?, resolved_by = ?, resolved_at = ? WHERE id = ?")
      .run(status, review.resolvedBy ?? null, Date.now(), review.id);
  }
  return review;
}

test("a form its agent withdrew with withdraw_question is linked and numbered 2, and the link is stored on the new row", async () => {
  flags(true);
  const { registry, app } = fleet();
  const d = mkDiscovered(); registry.applyDiscovery([d]);
  const first = await file(app, d.cwd, { title: "Linter plan" });
  assert.equal((await withdraw(app, d.cwd, first.id, "Scope changed: add formatting")).status, 200);
  const second = await file(app, d.cwd, { title: "Linter and formatter plan", revises: first.id });
  assert.equal(second.wait, "message");
  assert.match(second.receipt!, /^Filed, not answered: your plan/);
  assert.deepEqual(registry.getReview(second.id)?.revision, { number: 2, previousId: first.id });
  assert.deepEqual({ ...row(second.id) }, { status: "pending", response: null, resolved_by: null, revises_review_id: first.id, revision: 2 });
  assert.equal(reviewRevisedBy(first.id), second.id);
  assert.equal(registry.getReview(first.id)?.response, "Scope changed: add formatting", "the agent's own reason is kept");
  assert.equal(registry.getReview(first.id)?.revision, undefined, "a form that revises nothing carries no revision");
});

test("revising an open form withdraws it in the same step through the one writer, so the inbox never holds both", async () => {
  flags(true);
  const { registry, reviews, app } = fleet();
  const d = mkDiscovered(); registry.applyDiscovery([d]);
  const first = await file(app, d.cwd, { title: "Rollout plan" });
  const upserts: ReviewItem[] = [];
  // What a dashboard that renders each event would hold: the open cards for this plan at every upsert.
  let maxOpen = 0;
  const unsubscribe = registry.subscribe((e: ServerEvent) => {
    if (e.type !== "review_upsert") return;
    upserts.push(e.review);
    maxOpen = Math.max(maxOpen, registry.outstandingReviews(d.syntheticId).length);
  });
  const second = await file(app, d.cwd, { title: "Rollout plan, revised", revises: first.id });
  unsubscribe();

  const withdrawn = registry.getReview(first.id)!;
  assert.equal(withdrawn.status, "withdrawn");
  assert.equal(withdrawn.response, "Revised: replaced by revision 2 of this plan.");
  assert.equal(withdrawn.resolvedBy, null, "the agent's own act records no actor");
  assert.equal(withdrawnByItsAgent(withdrawn), true);
  assert.deepEqual(registry.outstandingReviews(d.syntheticId).map((r) => r.id), [second.id], "one card");
  assert.deepEqual(upserts.map((r) => `${r.id === first.id ? "first" : "second"}:${r.status}`), ["first:withdrawn", "second:pending"],
    "the one withdrawal, then the new card, both after the commit, so no subscriber ever holds two open cards");
  // At every published event the registry held at most one open card for this plan.
  assert.equal(maxOpen, 1);
  // No call waits on a filed form: a long poll converts it to call mode (`attachCall`), and a
  // converted form is refused as a target (below), so there is never a waiter left to release.
  const polled = await file(app, d.cwd, { title: "Polled plan" });
  const poll = reviews.wait(polled.id, 60_000);
  await refused(app, d.cwd, polled.id, /waits for its answer inside a tool call/);
  reviews.resolve(polled.id, "dismiss", null, "human");
  assert.equal((await poll)?.status, "dismissed");
  const session = registry.getSession(d.syntheticId)!;
  assert.deepEqual({ pendingReviews: session.pendingReviews, openQuestions: session.openQuestions }, { pendingReviews: 1, openQuestions: 0 });
});

test("a withdrawal by withdraw_question and one by revises settle the same way, differing only in the reason", async () => {
  flags(true);
  const { registry, app } = fleet();
  const d = mkDiscovered(); registry.applyDiscovery([d]);
  const byTool = await file(app, d.cwd);
  const byRevision = await file(app, d.cwd);
  const upserts: ReviewItem[] = [];
  const unsubscribe = registry.subscribe((e: ServerEvent) => { if (e.type === "review_upsert") upserts.push(e.review); });
  assert.equal((await withdraw(app, d.cwd, byTool.id, "No longer needed")).status, 200);
  await file(app, d.cwd, { revises: byRevision.id });
  unsubscribe();
  const shape = (id: string) => {
    const { id: _id, title: _title, body: _body, decisions: _decisions, createdAt: _createdAt, resolvedAt, response, ...rest } = registry.getReview(id)!;
    assert.equal(typeof resolvedAt, "number");
    return { rest, response };
  };
  assert.deepEqual(shape(byTool.id).rest, shape(byRevision.id).rest);
  assert.deepEqual(shape(byTool.id).rest, { sessionId: d.syntheticId, kind: "plan-decisions", status: "withdrawn", selections: null, resolvedBy: null, waitMode: "message" });
  assert.equal(shape(byTool.id).response, "No longer needed");
  assert.equal(shape(byRevision.id).response, "Revised: replaced by revision 2 of this plan.");
  assert.equal(upserts.filter((r) => r.id === byTool.id).length, 1, "one published update for withdraw_question");
  assert.equal(upserts.filter((r) => r.id === byRevision.id).length, 1, "one published update for revises");
});

test("a failed insert leaves the earlier form open and files nothing", async () => {
  flags(true);
  const { registry, app } = fleet();
  const d = mkDiscovered(); registry.applyDiscovery([d]);
  const first = await file(app, d.cwd);
  const before = reviewCount();
  openDb().exec(`CREATE TRIGGER fail_revision BEFORE INSERT ON reviews WHEN NEW.revises_review_id IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'disk refused the revision'); END;`);
  try {
    const res = await postPlan(app, d.cwd, { revises: first.id });
    assert.equal(res.status, 409);
    assert.match(await res.text(), /disk refused the revision/);
  } finally {
    openDb().exec("DROP TRIGGER fail_revision");
  }
  assert.equal(reviewCount(), before, "no new form");
  assert.equal(row(first.id).status, "pending", "no withdrawal on disk");
  assert.equal(registry.getReview(first.id)?.status, "pending", "and none published");
  assert.deepEqual(registry.outstandingReviews(d.syntheticId).map((r) => r.id), [first.id]);
});

test("a withdrawal that fails after the insert rolls the revision back: nothing on disk, the earlier form open, nothing published", async () => {
  flags(true);
  const { registry, app } = fleet();
  const d = mkDiscovered(); registry.applyDiscovery([d]);
  const first = await file(app, d.cwd);
  const before = reviewCount();
  const upserts: ReviewItem[] = [];
  const unsubscribe = registry.subscribe((e: ServerEvent) => { if (e.type === "review_upsert") upserts.push(e.review); });
  // The insert succeeds; the withdrawal of the earlier form, later in the same transaction, does not.
  openDb().exec(`CREATE TRIGGER fail_withdrawal BEFORE UPDATE OF status ON reviews WHEN NEW.status = 'withdrawn'
    BEGIN SELECT RAISE(ABORT, 'disk refused the withdrawal'); END;`);
  try {
    const res = await postPlan(app, d.cwd, { revises: first.id });
    assert.equal(res.status, 409);
    assert.match(await res.text(), /disk refused the withdrawal/);
  } finally {
    openDb().exec("DROP TRIGGER fail_withdrawal");
    unsubscribe();
  }
  assert.equal(reviewCount(), before, "the inserted revision was rolled back");
  assert.equal(reviewRevisedBy(first.id), null, "no link survives");
  assert.equal(row(first.id).status, "pending", "the earlier form is still open on disk");
  assert.equal(registry.getReview(first.id)?.status, "pending");
  assert.deepEqual(upserts, [], "neither the revision nor a withdrawal was published");
  assert.deepEqual(registry.outstandingReviews(d.syntheticId).map((r) => r.id), [first.id]);
});

test("an ask identical to an open form but carrying revises is validated and replaces its target, rather than re-attaching", async () => {
  flags(true);
  const { registry, app } = fleet();
  const d = mkDiscovered(); registry.applyDiscovery([d]);
  const ask = { title: "Same words", body: "# Same words\n\nThe plan.", decisions: decisions("Same words?") };
  const first = await file(app, d.cwd, ask);

  // The same words, now named as its revision: a new form, linked and numbered, and the open target withdrawn.
  const revised = await file(app, d.cwd, { ...ask, revises: first.id });
  assert.notEqual(revised.id, first.id, "not handed the open identical form");
  assert.deepEqual(registry.getReview(revised.id)?.revision, { number: 2, previousId: first.id });
  assert.equal(registry.getReview(first.id)?.status, "withdrawn");
  assert.deepEqual(registry.outstandingReviews(d.syntheticId).map((r) => r.id), [revised.id]);
  // A retry of that same revision request is the one form it already filed.
  const before = reviewCount();
  assert.equal((await file(app, d.cwd, { ...ask, revises: first.id })).id, revised.id);
  assert.equal(reviewCount(), before);

  // An invalid revises on an ask identical to an open form is refused, not re-attached.
  const other = { title: "Other words", body: "# Other words", decisions: decisions("Other words?") };
  await file(app, d.cwd, other);
  const res = await postPlan(app, d.cwd, { ...other, revises: "no-such-review" });
  assert.equal(res.status, 409);
  assert.match(await res.text(), /is not a review Mission Control knows/);
  // And one naming a form already revised is refused even with the revision's own words.
  await refused(app, d.cwd, first.id, new RegExp(`was already revised by ${revised.id}`));
});

test("a chain reaches revision 3, each form is revised once, and an identical re-ask re-attaches", async () => {
  flags(true);
  const { registry, app } = fleet();
  const d = mkDiscovered(); registry.applyDiscovery([d]);
  const one = await file(app, d.cwd, { title: "Chain plan" });
  const two = await file(app, d.cwd, { title: "Chain plan, two", revises: one.id });
  const threeAsk = { title: "Chain plan, three", revises: two.id };
  const three = await file(app, d.cwd, threeAsk);
  assert.deepEqual(registry.getReview(two.id)?.revision, { number: 2, previousId: one.id });
  assert.deepEqual(registry.getReview(three.id)?.revision, { number: 3, previousId: two.id });
  assert.equal(registry.getReview(two.id)?.response, "Revised: replaced by revision 3 of this plan.");
  assert.deepEqual(registry.outstandingReviews(d.syntheticId).map((r) => r.id), [three.id]);

  // The MCP client retried the third call word for word: the same form, nothing changed.
  const before = reviewCount();
  const retried = await file(app, d.cwd, threeAsk);
  assert.equal(retried.id, three.id);
  assert.equal(reviewCount(), before);

  // A form this path replaced satisfies withdrawnByItsAgent, and is refused because it already has a revision.
  assert.equal(withdrawnByItsAgent(registry.getReview(one.id)!), true);
  await refused(app, d.cwd, one.id, new RegExp(`was already revised by ${two.id}\\. Revise the latest form instead: revises ${two.id}\\.`));
  await refused(app, d.cwd, two.id, new RegExp(`was already revised by ${three.id}`));
});

test("a target withdrawn before a daemon restart still validates", async () => {
  flags(true);
  const before = fleet();
  const d = mkDiscovered(); before.registry.applyDiscovery([d]);
  const first = await file(before.app, d.cwd, { title: "Restart plan" });
  assert.equal((await withdraw(before.app, d.cwd, first.id, "Scope changed")).status, 200);

  const after = fleet();
  after.registry.applyDiscovery([d]);
  assert.equal(after.registry.getReview(first.id), undefined, "a withdrawn form is not restored into the registry");
  const second = await file(after.app, d.cwd, { title: "Restart plan, revised", revises: first.id });
  assert.deepEqual(after.registry.getReview(second.id)?.revision, { number: 2, previousId: first.id });
  // The dashboard's read reaches the settled earlier form all the same.
  const read = await after.app.request(`/api/reviews/${first.id}`, { headers: { host: "127.0.0.1:7317" } });
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), { ...loadReview(first.id) });
  assert.equal((await after.app.request("/api/reviews/no-such-review", { headers: { host: "127.0.0.1:7317" } })).status, 404);
});

test("every target that is not this session's open or agent-withdrawn filed plan form is refused with its reason and nothing is written", async () => {
  flags(true);
  const { registry, reviews, app } = fleet();
  const d = mkDiscovered(); const other = mkDiscovered();
  registry.applyDiscovery([d, other]);

  await refused(app, d.cwd, "no-such-review", /is not a review Mission Control knows\./);

  const othersOpen = await file(app, other.cwd);
  await refused(app, d.cwd, othersOpen.id, /belongs to another session/);
  const othersWithdrawn = await file(app, other.cwd);
  assert.equal((await withdraw(app, other.cwd, othersWithdrawn.id, "Theirs")).status, 200);
  assert.equal(withdrawnByItsAgent(registry.getReview(othersWithdrawn.id)!), true, "withdrawn by its own agent, but not this one");
  await refused(app, d.cwd, othersWithdrawn.id, /belongs to another session/);

  const question = await (await app.request("/mcp/reviews", { method: "POST", headers, body: JSON.stringify({
    env: {}, cwd: d.cwd, kind: "input", title: "Which linter?", body: "Which linter?", decisions: decisions("Which linter?"), snoozable: true, asyncCapable: true,
  }) })).json() as Created;
  assert.equal(question.wait, "message");
  await refused(app, d.cwd, question.id, /is not a plan form/);

  const callMode = reviews.create(d.syntheticId, "plan-decisions", "Call plan", "# Call plan", decisions("Call?"));
  await refused(app, d.cwd, callMode.id, /waits for its answer inside a tool call/);

  // A filed form an older MCP child re-asked word for word is a call-mode form now.
  const convertedAsk = { title: "Converted plan", body: "# Converted plan", decisions: decisions("Converted?") };
  const converted = await file(app, d.cwd, convertedAsk);
  const reasked = await (await postPlan(app, d.cwd, { ...convertedAsk, asyncCapable: undefined })).json() as Created;
  assert.equal(reasked.id, converted.id);
  assert.equal(registry.getReview(converted.id)?.waitMode, undefined);
  await refused(app, d.cwd, converted.id, /waits for its answer inside a tool call/);

  const answered = await file(app, d.cwd);
  reviews.resolve(answered.id, "answer", "Which?\n→ eslint", "human", [{ decisionId: "q", selected: ["o1"], other: null }]);
  await refused(app, d.cwd, answered.id, /was already answered/);

  const dismissed = await file(app, d.cwd);
  reviews.resolve(dismissed.id, "dismiss", null, "human");
  await refused(app, d.cwd, dismissed.id, /the operator dismissed/);

  const merged = await file(app, d.cwd);
  assert.ok(reviews.closeQuestionsForMerge(d.syntheticId, true).some((r) => r.id === merged.id));
  await refused(app, d.cwd, merged.id, /was closed when the task's pull request merged/);

  const superseded = seedFiled(d.syntheticId, "superseded");
  await refused(app, d.cwd, superseded.id, /was replaced by a reworded retry/);

  // Withdrawn, but recording an actor: no path writes this, and it is not its agent's withdrawal.
  const notByItsAgent = seedFiled(d.syntheticId, "withdrawn", { resolvedBy: "human" });
  assert.equal(withdrawnByItsAgent(loadReview(notByItsAgent.id)!), false);
  await refused(app, d.cwd, notByItsAgent.id, /was not withdrawn by its own agent/);

  // Orphaned by an eviction and by a runtime-transfer settle. The events reach the review manager
  // while the session itself stays registered, so the same session can still ask.
  const evicted = await file(app, d.cwd);
  registry.emit("event", { type: "session_remove", id: d.syntheticId });
  assert.equal(registry.getReview(evicted.id)?.status, "orphaned");
  await refused(app, d.cwd, evicted.id, /was closed when its session went away/);
  const transferred = await file(app, d.cwd);
  reviews.settleRuntimeTransfer(d.syntheticId);
  assert.equal(registry.getReview(transferred.id)?.status, "orphaned");
  await refused(app, d.cwd, transferred.id, /was closed when its session went away/);

  // The review manager refuses for any caller, not only the route.
  assert.throws(() => reviews.create(d.syntheticId, "input", "Q?", "Q?", null, { revises: answered.id }), RevisionRefusal);
  // And the wire refuses revises on every other kind before it reaches the manager.
  const wrongKind = await app.request("/mcp/reviews", { method: "POST", headers, body: JSON.stringify({
    env: {}, cwd: d.cwd, kind: "input", title: "Q?", body: "Q?", revises: answered.id,
  }) });
  assert.equal(wrongKind.status, 400);
  assert.match(await wrongKind.text(), /only kind 'plan-decisions' can revise an earlier form/);
});

test("only the agent's own withdrawal makes a settled form a valid target; every other way a filed form closes does not", async () => {
  flags(true);
  const { registry, reviews, app } = fleet();
  const d = mkDiscovered(); registry.applyDiscovery([d]);
  const settledBy = new Map<string, ReviewItem>();
  const note = (label: string, id: string) => settledBy.set(label, (registry.getReview(id) ?? loadReview(id))!);

  const tool = await file(app, d.cwd); await withdraw(app, d.cwd, tool.id, "Not needed"); note("withdraw_question", tool.id);
  const replaced = await file(app, d.cwd); await file(app, d.cwd, { revises: replaced.id }); note("revises", replaced.id);
  const dismissed = await file(app, d.cwd); reviews.resolve(dismissed.id, "dismiss", null, "human"); note("operator dismiss", dismissed.id);
  const answered = await file(app, d.cwd);
  reviews.resolve(answered.id, "answer", "→ eslint", "human", [{ decisionId: "q", selected: ["o1"], other: null }]);
  note("answer", answered.id);
  const foreman = await file(app, d.cwd);
  reviews.resolve(foreman.id, "answer", "→ eslint", "foreman", [{ decisionId: "q", selected: ["o1"], other: null }]);
  note("foreman answer", foreman.id);
  const merged = await file(app, d.cwd); reviews.closeQuestionsForMerge(d.syntheticId, true); note("merge closure", merged.id);
  const transfer = await file(app, d.cwd); reviews.settleRuntimeTransfer(d.syntheticId); note("runtime-transfer settle", transfer.id);
  const evicted = await file(app, d.cwd); registry.emit("event", { type: "session_remove", id: d.syntheticId }); note("eviction", evicted.id);
  const flagOff = await file(app, d.cwd); flags(false); note("flags switched off", flagOff.id);

  const verdicts = Object.fromEntries([...settledBy].map(([label, review]) => [label, `${review.status}:${withdrawnByItsAgent(review)}`]));
  assert.deepEqual(verdicts, {
    "withdraw_question": "withdrawn:true",
    "revises": "withdrawn:true",
    "operator dismiss": "dismissed:false",
    "answer": "answered:false",
    "foreman answer": "answered:false",
    "merge closure": "orphaned:false",
    "runtime-transfer settle": "orphaned:false",
    "eviction": "orphaned:false",
    "flags switched off": "pending:false",
  });
  // A switch of the flags changes no stored mode: the form is still an open filed form and so
  // still a valid target, and the new form waits however this ask is decided now.
  const after = await file(app, d.cwd, { revises: flagOff.id });
  assert.equal(after.wait, "call", "with the flags off the new ask blocks, as Phase 1 says");
  assert.deepEqual(registry.getReview(after.id)?.revision, { number: 2, previousId: flagOff.id });
  assert.equal(registry.getReview(flagOff.id)?.status, "withdrawn");
});
