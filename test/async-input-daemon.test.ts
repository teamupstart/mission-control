import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { PlanDecision, ReviewItem } from "../src/shared/types.ts";
import { mkMuxHandle, mkTaskSummary } from "./helpers/session-fixture.ts";

// The asynchronous input inbox, Phase 1, at the daemon: how `/mcp/reviews` negotiates the wait,
// what a born-detached question counts toward, who its answer is delivered from, and every
// completion gate an outstanding request_input question holds - and the rows it deliberately
// does not hold. docs/plans/async-input-inbox/plan.md section 4 is the table these pin.

const home = mkdtempSync(join(tmpdir(), "mission-async-input-daemon-"));
process.env.MISSION_HOME = home;

const {
  openDb, markWorkCycleActive, completeWorkCycle, workCycleFor, getQueueRow, createReviewContinuationPendingTurn, MESSAGE_ANSWER_TURN_PREFIX,
  insertReview, updateReviewStatus, markReviewWaitDetached, loadReviewContinuationCandidates,
} = await import("../src/server/db.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const { applyFeatureFlagIntent } = await import("../src/server/feature-flags/index.ts");
const { resolvedSessionIntent } = await import("../src/shared/goal.ts");
const { asyncInputReceipt } = await import("../src/shared/async-input.ts");
const { reviewToolResult, deliversContinuation } = await import("../src/shared/review-item.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { buildApp } = await import("../src/server/routes.ts");

after(() => rmSync(home, { recursive: true, force: true }));
openDb();
const TOKEN = ensureToken();
const setFlag = (enabled: boolean) => {
  const result = applyFeatureFlagIntent({ kind: "flag", id: "async-input", enabled });
  assert.equal(result.ok, true);
};
afterEach(() => setFlag(false));

let seq = 0;
function mkDiscovered(over: Partial<DiscoveredSession> = {}): DiscoveredSession {
  const n = ++seq;
  return {
    syntheticId: `proc:ttys20${n}:${n}:0`,
    agent: "claude",
    name: "work",
    nameSource: "process",
    cwd: `/wt/async-${n}`,
    gitBranch: "harness/async",
    gitRoot: null,
    repoRoot: null,
    pid: 2000 + n,
    tty: `ttys20${n}`,
    terminals: [mkMuxHandle({ session: "s", windowName: "w", windowIndex: 0, paneId: `%${200 + n}` })],
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

const LOOPBACK = { host: "127.0.0.1:7317" };
const authed = { ...LOOPBACK, "content-type": "application/json", "x-harness-token": TOKEN };

type Created = { id: string; sessionId: string; wait: "call" | "message"; receipt?: string };

async function post(app: ReturnType<typeof fleet>["app"], cwd: string | null, extra: Record<string, unknown>) {
  const question = (extra.title as string | undefined) ?? `Which linter should this repo use? (${++seq})`;
  return app.request("/mcp/reviews", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({
      env: {}, cwd, kind: "input", title: question, body: question, decisions: decisions(question), ...extra,
    }),
  });
}

async function created(res: Response): Promise<Created> {
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()) as Created;
}

test("POST /mcp/reviews negotiates the wait: message only for a capable child, a messageable session and the flag on", async () => {
  const { registry, app } = fleet();
  const d = mkDiscovered();
  const paneless = mkDiscovered({ terminals: [] });
  registry.applyDiscovery([d, paneless]);

  // Flag off: exactly today's answer, even from a capable child.
  const off = await created(await post(app, d.cwd, { snoozable: true, asyncCapable: true }));
  assert.equal(off.wait, "call");
  assert.equal(off.receipt, undefined);
  assert.equal(registry.getReview(off.id)?.waitMode, undefined);

  setFlag(true);
  const oldChild = await created(await post(app, d.cwd, { snoozable: true }));
  assert.equal(oldChild.wait, "call", "a child that never said asyncCapable keeps long-polling");
  const unreachable = await created(await post(app, paneless.cwd, { snoozable: true, asyncCapable: true }));
  assert.equal(unreachable.wait, "call", "an answer message could never reach a session with no pane");
  const gate = await created(await post(app, d.cwd, { asyncCapable: true }));
  assert.equal(gate.wait, "call", "a confirmation another tool raised is a gate");

  const filed = await created(await post(app, d.cwd, {
    title: "Which linter?", body: "Which linter?", decisions: decisions("Which linter?"),
    snoozable: true, asyncCapable: true, meanwhile: "proceeding with eslint;\nthe config is one file",
  }));
  assert.equal(filed.wait, "message");
  assert.equal(filed.receipt, asyncInputReceipt({ id: filed.id }));
  const stored = registry.getReview(filed.id)!;
  assert.equal(stored.waitMode, "message");
  assert.equal(stored.meanwhile, "proceeding with eslint; the config is one file");
  assert.equal(stored.status, "pending", "still pending, so the inbox, drafts and Remind me later work on it unchanged");

  // Born detached, in the insert itself.
  const row = openDb().prepare("SELECT wait_mode, meanwhile, mcp_wait_detached_at, created_at FROM reviews WHERE id = ?")
    .get(filed.id) as { wait_mode: string; meanwhile: string; mcp_wait_detached_at: number; created_at: number };
  assert.equal(row.wait_mode, "message");
  assert.equal(row.mcp_wait_detached_at, row.created_at);

  // An exact duplicate re-attaches to the open row and is handed the same receipt.
  const again = await created(await post(app, d.cwd, {
    title: "Which linter?", body: "Which linter?", decisions: decisions("Which linter?"), snoozable: true, asyncCapable: true,
  }));
  assert.deepEqual(again, filed);

  // Turned off with the question open: new asks block again, the open one keeps its mode.
  setFlag(false);
  const later = await created(await post(app, d.cwd, { snoozable: true, asyncCapable: true }));
  assert.equal(later.wait, "call");
  assert.equal(registry.getReview(filed.id)?.waitMode, "message");
});

test("counts: a message-mode question is an open question, never a pending review, and a snoozed one is in neither", () => {
  const { registry, reviews } = fleet();
  const d = mkDiscovered();
  registry.applyDiscovery([d]);
  const id = d.syntheticId;
  const q1 = reviews.create(id, "input", "First?", "First?", decisions("First?"), { snoozable: true, waitMode: "message" });
  reviews.create(id, "input", "Second?", "Second?", decisions("Second?"), { snoozable: true, waitMode: "message" });
  assert.deepEqual(pick(registry.getSession(id)!), { pendingReviews: 0, openQuestions: 2 });
  reviews.create(id, "input", "Blocking?", "Blocking?", decisions("Blocking?"), { snoozable: true });
  assert.deepEqual(pick(registry.getSession(id)!), { pendingReviews: 1, openQuestions: 2 });
  reviews.snooze(q1.id, 60_000);
  assert.deepEqual(pick(registry.getSession(id)!), { pendingReviews: 1, openQuestions: 1 });
  // waitMode is honored only on request_input's own asks.
  const plan = reviews.create(id, "plan-decisions", "Plan", "Plan", decisions("Plan?"), { waitMode: "message" });
  assert.equal(plan.waitMode, undefined);
});

function pick(s: { pendingReviews: number; openQuestions: number }) {
  return { pendingReviews: s.pendingReviews, openQuestions: s.openQuestions };
}

test("a later, similar question never withdraws a message-mode one, while a message-mode retry still withdraws a timed-out call", () => {
  const { registry, reviews } = fleet();
  const d = mkDiscovered();
  registry.applyDiscovery([d]);
  const FIRST = "Approve this rollout and release authority before I create the four drafted tasks? Phase 1 migrates workspace access, phases 2 and 3 run in parallel, and I merge each PR after checks pass.";
  const RETRY = "The previous prompt timed out. May I proceed with the four drafted tasks and merge each PR after checks pass? Phase 1 migrates workspace access, then phases 2 and 3 run in parallel.";
  const options = (question: string): PlanDecision[] => [{ id: "q", question, options: [{ id: "o0", label: "Approve" }, { id: "o1", label: "Hold" }] }];
  const T0 = 1_800_000_000_000;
  const later = T0 + 6 * 60_000;
  const filed = reviews.create(d.syntheticId, "input", FIRST, FIRST, options(FIRST), { snoozable: true, waitMode: "message", now: T0 });
  const similar = reviews.create(d.syntheticId, "input", RETRY, RETRY, options(RETRY), { snoozable: true, now: later });
  assert.equal(registry.getReview(filed.id)?.status, "pending", "a call-mode ask does not withdraw a filed question");

  const second = fleet();
  const e = mkDiscovered();
  second.registry.applyDiscovery([e]);
  const blocking = second.reviews.create(e.syntheticId, "input", FIRST, FIRST, options(FIRST), { snoozable: true, now: T0 });
  second.reviews.create(e.syntheticId, "input", RETRY, RETRY, options(RETRY), { snoozable: true, waitMode: "message", now: later });
  // The call timed out (the flag was turned on meanwhile) and the agent re-asked it in new words:
  // the stale call-mode card is withdrawn so the operator answers only the live one.
  assert.equal(second.registry.getReview(blocking.id)?.status, "superseded", "a reworded retry of a timed-out call replaces it");
  assert.equal(registry.getReview(similar.id)?.status, "pending");
});

for (const actor of ["foreman", "standing-approval"] as const) {
  test(`${actor}'s answer to a message-mode question is queued as a message; to a detached call-mode question it is not`, () => {
    const { registry, reviews } = fleet();
    const d = mkDiscovered();
    registry.applyDiscovery([d]);
    const delivered: Array<{ id: string; kind: string; text: string }> = [];
    // The real outbox insert, so the SQL eligibility (`CONTINUATION_ACTOR_SQL`) is what decides.
    reviews.startContinuationRecovery((review, text, kind) => {
      const turn = createReviewContinuationPendingTurn({ reviewId: review.id, noteKey: `note-${review.sessionId}`, text, now: Date.now() });
      if (turn) delivered.push({ id: review.id, kind, text });
      return turn !== null;
    });
    const filed = reviews.create(d.syntheticId, "input", "Filed?", "Filed?", decisions("Filed?"), { snoozable: true, waitMode: "message" });
    const blocking = reviews.create(d.syntheticId, "input", "Blocking?", "Blocking?", decisions("Blocking?"), { snoozable: true });
    // Detached, so the only thing keeping its answer out of the outbox is the wait-mode rule:
    // a call-mode call that is still listening would have returned this actor's answer itself.
    assert.ok(reviews.detachWait(blocking.id, d.syntheticId));
    reviews.resolve(filed.id, "answer", "eslint", actor);
    reviews.resolve(blocking.id, "answer", "biome", actor);
    assert.deepEqual(delivered.map((x) => [x.id, x.kind]), [[filed.id, "answer"]]);
    assert.match(delivered[0]!.text, /eslint/);
    // Its own daemon-authored id, still under the review-continuation: prefix resident pacing reads.
    const turn = openDb().prepare("SELECT id FROM pending_turns WHERE id = ?").get(`${MESSAGE_ANSWER_TURN_PREFIX}${filed.id}`);
    assert.ok(turn, "the answer was queued under the message-answer id");
    assert.ok(MESSAGE_ANSWER_TURN_PREFIX.startsWith("review-continuation:"));
    assert.equal(openDb().prepare("SELECT 1 AS n FROM pending_turns WHERE id LIKE ?").get(`%${blocking.id}`), undefined);
  });
}

test("report_blocker is accepted beside a message-mode question and refused beside a call-mode one", () => {
  const { registry, reviews } = fleet();
  const d = mkDiscovered();
  const e = mkDiscovered();
  registry.applyDiscovery([d, e]);
  const body = {
    kind: "question" as const, reason: "Need the retention window", waitingOn: "Dana in #data-platform",
    resumeWhen: "Dana answers", referenceUrl: "https://example.com/t/1", details: "",
  };
  reviews.create(d.syntheticId, "input", "Filed?", "Filed?", decisions("Filed?"), { snoozable: true, waitMode: "message" });
  assert.equal(registry.reportBlocker(d.syntheticId, body).ok, true);
  reviews.create(e.syntheticId, "input", "Blocking?", "Blocking?", decisions("Blocking?"), { snoozable: true });
  const refused = registry.reportBlocker(e.syntheticId, body);
  assert.equal(refused.ok, false);
});

/** A stopped session with exactly one consumable settled generation, as prompted completion sees it. */
function eligible(registry: InstanceType<typeof Registry>, over: Partial<DiscoveredSession> = {}) {
  const noteKey = `agent-async-${++seq}`;
  const d = mkDiscovered({ agentSessionId: noteKey, ...over } as Partial<DiscoveredSession>);
  registry.applyDiscovery([d]);
  registry.upsertGoal(d.syntheticId, {
    prompt: "Implement the fix", text: "Implement the fix", objective: "Implement the fix",
    focus: "Implement the fix", relationship: "initial", rationale: "Initial task objective",
    objectiveVersion: 1, promptRevision: 1, resolvedPromptRevision: 1, pendingPrompts: [], source: "heuristic",
  }, Date.now() - 3 * 60_000);
  const session = registry.getSession(d.syntheticId)!;
  Object.assign(session, { hooksSeen: true, instrumented: true, stateConfirmed: true, state: "idle", pendingTurns: [] });
  assert.equal(registry.ensureQueue(d.syntheticId), noteKey);
  markWorkCycleActive(noteKey, Date.now() - 3 * 60_000);
  completeWorkCycle(noteKey, Date.now() - 2 * 60_000, Date.now() - 2 * 60_000);
  session.workCycle = workCycleFor(noteKey) ?? undefined;
  const intent = resolvedSessionIntent(registry.getGoal(d.syntheticId))!;
  const request = {
    logicalKey: noteKey, generation: 1,
    expectedIntent: {
      objective: intent.objective, objectiveVersion: intent.objectiveVersion,
      promptRevision: intent.promptRevision, episodeKey: intent.episodeKey,
    },
    ask: false, directHandoff: null, decision: null,
  };
  return { id: d.syntheticId, noteKey, session, request };
}

test("with the flag on, every outstanding request_input question holds prompted completion: call or message, pending or snoozed, working or stopped", () => {
  setFlag(true);
  for (const waitMode of ["call", "message"] as const) {
    for (const status of ["pending", "snoozed"] as const) {
      for (const state of ["working", "idle"] as const) {
        const { registry, reviews } = fleet();
        const s = eligible(registry);
        const q = reviews.create(s.id, "input", "Which linter?", "Which linter?", decisions("Which linter?"), {
          snoozable: true, ...(waitMode === "message" ? { waitMode } : {}),
        });
        if (status === "snoozed") reviews.snooze(q.id, 60 * 60_000);
        Object.assign(registry.getSession(s.id)!, { state });
        const label = `${waitMode} ${status} ${state}`;
        assert.equal(registry.completionHeldByQuestion(registry.getSession(s.id)!), true, `${label}: held`);
        assert.equal(registry.consumePromptedGeneration(s.id, s.request), false, `${label}: prompted completion refused`);
        assert.equal(getQueueRow(s.noteKey)?.promptedConsumedGeneration ?? null, null, `${label}: the refusal spent the generation`);
        // Once answered, the very same generation is consumed: the hold refuses, it never spends.
        Object.assign(registry.getSession(s.id)!, { state: "idle" });
        reviews.resolve(q.id, "answer", "eslint", "human");
        assert.equal(registry.completionHeldByQuestion(registry.getSession(s.id)!), false, `${label}: released`);
        assert.equal(registry.consumePromptedGeneration(s.id, s.request), true, `${label}: consumed once answered`);
      }
    }
  }
});

test("with the flag off a snoozed call-mode question holds nothing, as today, while an open message-mode question keeps the hold", () => {
  const { registry, reviews } = fleet();
  const s = eligible(registry);
  const call = reviews.create(s.id, "input", "Blocking?", "Blocking?", decisions("Blocking?"), { snoozable: true });
  reviews.snooze(call.id, 60 * 60_000);
  assert.equal(registry.completionHeldByQuestion(registry.getSession(s.id)!), false);

  const t = eligible(registry);
  const filed = reviews.create(t.id, "input", "Filed?", "Filed?", decisions("Filed?"), { snoozable: true, waitMode: "message" });
  reviews.snooze(filed.id, 60 * 60_000);
  assert.equal(registry.completionHeldByQuestion(registry.getSession(t.id)!), true, "a filed question keeps its rule after the flag is off");
  assert.equal(registry.consumePromptedGeneration(t.id, t.request), false);
});

test("a resident is never held by its open questions, and the snoozed-question exceptions hold nothing beyond completion", () => {
  setFlag(true);
  const { registry, reviews } = fleet();
  const s = eligible(registry);
  reviews.create(s.id, "input", "Filed?", "Filed?", decisions("Filed?"), { snoozable: true, waitMode: "message" });
  const session = registry.getSession(s.id)!;
  assert.equal(registry.completionHeldByQuestion({ ...session, task: mkTaskSummary({ kind: "resident" }) }), false);

  // Only a snoozed question: not needs-you (queue sends and backlog assignment read that bucket),
  // and not counted by the rebind and reassign readers - yet completion is still held.
  const t = eligible(registry);
  const parked = reviews.create(t.id, "input", "Parked?", "Parked?", decisions("Parked?"), { snoozable: true, waitMode: "message" });
  reviews.snooze(parked.id, 60 * 60_000);
  const parkedSession = registry.getSession(t.id)!;
  assert.deepEqual(pick(parkedSession), { pendingReviews: 0, openQuestions: 0 });
  assert.equal(registry.completionHeldByQuestion(parkedSession), true);
});

test("a merge closes every outstanding request_input question with the reason merged, and leaves gates alone", async () => {
  setFlag(true);
  const { registry, reviews } = fleet();
  const d = mkDiscovered();
  registry.applyDiscovery([d]);
  const id = d.syntheticId;
  const filed = reviews.create(id, "input", "Filed?", "Filed?", decisions("Filed?"), { snoozable: true, waitMode: "message" });
  const blocking = reviews.create(id, "input", "Blocking?", "Blocking?", decisions("Blocking?"), { snoozable: true });
  const parked = reviews.create(id, "input", "Parked?", "Parked?", decisions("Parked?"), { snoozable: true, waitMode: "message" });
  reviews.snooze(parked.id, 60 * 60_000);
  const gate = reviews.create(id, "plan-decisions", "Plan", "Plan", decisions("Plan?"));
  const waiting = reviews.wait(blocking.id, 60_000);

  const closed = reviews.closeQuestionsForMerge(id, true);
  assert.deepEqual(closed.map((r) => r.id).sort(), [filed.id, blocking.id, parked.id].sort());
  for (const r of closed) {
    assert.equal(registry.getReview(r.id)?.status, "orphaned");
    assert.equal(registry.getReview(r.id)?.closedReason, "merged");
  }
  const rows = openDb().prepare("SELECT id, closed_reason FROM reviews WHERE session_id = ? AND closed_reason = 'merged'").all(id);
  assert.equal(rows.length, 3, "the reason is durable");
  assert.deepEqual(registry.outstandingReviews(id).map((r) => r.id), [gate.id]);
  assert.equal(registry.completionHeldByQuestion(registry.getSession(id)!), false);
  // A call still listening hears why, rather than a generic channel loss.
  // The waiter itself is released with the closure, not just the registry row.
  const waited = await waiting;
  assert.ok(waited);
  assert.match(reviewToolResult(waited).text, /pull request merged/);
});

test("with the flag off a merge closes only message-mode questions and records no reason on call-mode ones", () => {
  const { registry, reviews } = fleet();
  const d = mkDiscovered();
  registry.applyDiscovery([d]);
  const filed = reviews.create(d.syntheticId, "input", "Filed?", "Filed?", decisions("Filed?"), { snoozable: true, waitMode: "message" });
  const call = reviews.create(d.syntheticId, "input", "Blocking?", "Blocking?", decisions("Blocking?"), { snoozable: true });
  reviews.snooze(call.id, 60 * 60_000);
  assert.deepEqual(reviews.closeQuestionsForMerge(d.syntheticId, false).map((r) => r.id), [filed.id]);
  assert.equal(registry.getReview(call.id)?.status, "snoozed");
  assert.equal(registry.getReview(call.id)?.closedReason, undefined);
});

test("the outbox's SQL eligibility and the publish predicate are one actor policy", () => {
  // Every actor, wait mode and settled status: a detached row is a queue candidate exactly when
  // `deliversContinuation` says its answer is owed. Both are built from CONTINUATION_ACTOR_POLICY.
  const actors = ["human", "foreman", "standing-approval", "session:other", null] as const;
  const statuses = ["answered", "approved", "rejected", "dismissed", "orphaned", "superseded", "withdrawn"] as const;
  let n = 0;
  for (const resolvedBy of actors) {
    for (const waitMode of [undefined, "message"] as const) {
      for (const status of statuses) {
        const id = `policy-${++n}`;
        insertReview({
          id, sessionId: "sdk:policy", kind: "input", title: "Q?", body: "Q?", status: "pending", response: null,
          snoozable: true, ...(waitMode ? { waitMode } : {}), createdAt: n, resolvedAt: null,
        });
        markReviewWaitDetached(id, n);
        updateReviewStatus(id, status, null, n + 1, null, resolvedBy);
        const queued = loadReviewContinuationCandidates(id).length === 1;
        const owed = deliversContinuation({
          id, sessionId: "sdk:policy", kind: "input", title: "Q?", body: "Q?", status, response: null,
          snoozable: true, ...(waitMode ? { waitMode } : {}), resolvedBy, createdAt: n, resolvedAt: n + 1,
        });
        assert.equal(queued, owed, `${resolvedBy ?? "nobody"} ${waitMode ?? "call"} ${status}`);
      }
    }
  }
});

/** An older MCP child re-asks a filed question word for word, is handed the open row, and long-polls it. */
async function olderChildReattaches() {
  setFlag(true);
  const { registry, reviews, app } = fleet();
  const d = mkDiscovered();
  registry.applyDiscovery([d]);
  const delivered: string[] = [];
  reviews.startContinuationRecovery((review, text) => {
    const turn = createReviewContinuationPendingTurn({ reviewId: review.id, noteKey: `note-${review.sessionId}`, text, now: Date.now() });
    if (turn) delivered.push(review.id);
    return turn !== null;
  });
  const ask = { title: "Which linter?", body: "Which linter?", decisions: decisions("Which linter?"), snoozable: true };
  const filed = await created(await post(app, d.cwd, { ...ask, asyncCapable: true }));
  assert.equal(filed.wait, "message");
  const again = await created(await post(app, d.cwd, ask));
  assert.equal(again.id, filed.id, "the identical ask re-attaches to the filed row");
  // From here it is the call-mode question the older child is blocked on.
  assert.equal(again.wait, "call");
  assert.equal(registry.getReview(filed.id)?.waitMode, undefined);
  assert.deepEqual(pick(registry.getSession(d.syntheticId)!), { pendingReviews: 1, openQuestions: 0 });
  const call = app.request(`/mcp/reviews/${filed.id}/wait`, { headers: authed });
  // Until the long-poll is actually attached, nothing is waiting in a call.
  for (let i = 0; i < 200 && !reviews.blockedInRequestInputCall(d.syntheticId, true); i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(reviews.blockedInRequestInputCall(d.syntheticId, true), true, "the older child is waiting in its call");
  return { registry, reviews, app, d, filed, delivered, call };
}

test("an older child long-polling a filed question it re-asked hears the answer once, as its call's result", async () => {
  const { reviews, filed, delivered, call } = await olderChildReattaches();
  reviews.resolve(filed.id, "answer", "eslint", "human");
  const result = (await (await call).json()) as ReviewItem;
  assert.equal(result.status, "answered");
  assert.equal(result.response, "eslint");
  assert.deepEqual(delivered.filter((id) => id === filed.id), [], "no second copy through the outbox");
  assert.equal(openDb().prepare("SELECT 1 AS n FROM pending_turns WHERE id LIKE ?").get(`%${filed.id}`), undefined);
  assert.deepEqual(loadReviewContinuationCandidates(filed.id), [], "and none owed after a daemon restart either");
});

test("an older child whose call on a filed question is cancelled hears the answer once, as a message", async () => {
  const { reviews, app, d, filed, delivered } = await olderChildReattaches();
  const detached = await app.request(`/mcp/reviews/${filed.id}/detach`, {
    method: "POST", headers: authed, body: JSON.stringify({ env: {}, cwd: d.cwd }),
  });
  assert.equal(detached.status, 200, await detached.clone().text());
  reviews.resolve(filed.id, "answer", "eslint", "human");
  // Recovery also hands on rows earlier tests in this file left owed; count only this question.
  assert.deepEqual(delivered.filter((id) => id === filed.id), [filed.id], "delivered exactly once, through the outbox");
  reviews.resolve(filed.id, "answer", "eslint", "human");
  assert.deepEqual(delivered.filter((id) => id === filed.id), [filed.id]);
});

test("an answer given between an older child's duplicate ask and its first poll still reaches it once", async () => {
  setFlag(true);
  const { registry, reviews, app } = fleet();
  const d = mkDiscovered();
  registry.applyDiscovery([d]);
  const delivered: string[] = [];
  reviews.startContinuationRecovery((review, text) => {
    const turn = createReviewContinuationPendingTurn({ reviewId: review.id, noteKey: `note-${review.sessionId}`, text, now: Date.now() });
    if (turn) delivered.push(review.id);
    return turn !== null;
  });
  const ask = { title: "Which formatter?", body: "Which formatter?", decisions: decisions("Which formatter?"), snoozable: true };
  const filed = await created(await post(app, d.cwd, { ...ask, asyncCapable: true }));
  assert.equal(filed.wait, "message");
  // The older child's duplicate ask is answered with the filed row ...
  assert.equal((await created(await post(app, d.cwd, ask))).id, filed.id);
  // ... the operator answers before that child's first long-poll arrives ...
  reviews.resolve(filed.id, "answer", "prettier", "human");
  assert.deepEqual(delivered.filter((id) => id === filed.id), [], "not queued as a message: a call is about to collect it");
  // ... and that first poll collects it, the one and only delivery.
  const result = (await (await app.request(`/mcp/reviews/${filed.id}/wait`, { headers: authed })).json()) as ReviewItem;
  assert.equal(result.status, "answered");
  assert.equal(result.response, "prettier");
  assert.deepEqual(loadReviewContinuationCandidates(filed.id), [], "nothing owed after a restart either");
  assert.equal(openDb().prepare("SELECT 1 AS n FROM pending_turns WHERE id LIKE ?").get(`%${filed.id}`), undefined);
});

test("ten questions include snoozed rows, an exact duplicate reattaches, and the eleventh is refused with titles", async () => {
  setFlag(true);
  const { registry, reviews, app } = fleet();
  const d = mkDiscovered(); registry.applyDiscovery([d]);
  const ids: string[] = [];
  for (let n = 0; n < 10; n++) {
    const result = await created(await post(app, d.cwd, { title: `Question ${n}?`, snoozable: true, asyncCapable: true }));
    ids.push(result.id);
  }
  reviews.snooze(ids[0]!, 60_000);
  const duplicate = await created(await post(app, d.cwd, { title: "Question 0?", snoozable: true, asyncCapable: true }));
  assert.equal(duplicate.id, ids[0]);
  const refused = await post(app, d.cwd, { title: "Eleventh?", snoozable: true, asyncCapable: true });
  assert.equal(refused.status, 409);
  const error = await refused.text();
  for (let n = 0; n < 10; n++) assert.ok(error.includes(`Question ${n}?`));
  assert.match(error, /Work on what you can or end your turn/);
  assert.equal(reviews.openQuestions(d.syntheticId).length, 10);
  reviews.withdrawQuestion(d.syntheticId, ids[0]!, "No longer needed");
  assert.equal((await post(app, d.cwd, { title: "Replacement?", snoozable: true, asyncCapable: true })).status, 200);
});

test("question tools gate on the flag, list both wait modes, and withdraw only the caller's open message questions", async () => {
  const { registry, reviews, app } = fleet();
  const d = mkDiscovered(); const e = mkDiscovered(); registry.applyDiscovery([d, e]);
  const filed = reviews.create(d.syntheticId, "input", "Filed?", "Filed?", null, { snoozable: true, waitMode: "message", meanwhile: "Prepare tests" });
  const call = reviews.create(d.syntheticId, "input", "Call?", "Call?", null, { snoozable: true });
  const other = reviews.create(e.syntheticId, "input", "Other?", "Other?", null, { snoozable: true, waitMode: "message" });
  reviews.create(d.syntheticId, "plan-decisions", "Gate", "Gate");
  reviews.snooze(filed.id, 60_000);
  const request = (path: string, extra = {}) => app.request(path, {
    method: "POST", headers: authed, body: JSON.stringify({ env: {}, cwd: d.cwd, ...extra }),
  });
  assert.equal((await request("/mcp/questions/list")).status, 403);
  assert.equal((await request(`/mcp/questions/${filed.id}/withdraw`, { reason: "Obsolete" })).status, 403);
  setFlag(true);
  const listing = await request("/mcp/questions/list");
  assert.equal(listing.status, 200);
  const { questions } = await listing.json() as { questions: Array<Record<string, unknown>> };
  assert.deepEqual(questions.map((q) => q.id).sort(), [filed.id, call.id].sort());
  assert.deepEqual(questions.find((q) => q.id === filed.id), { id: filed.id, title: "Filed?", createdAt: filed.createdAt, meanwhile: "Prepare tests", status: "snoozed" });
  for (const id of [call.id, other.id, "missing"]) assert.equal((await request(`/mcp/questions/${id}/withdraw`, { reason: "Obsolete" })).status, 409);
  assert.equal((await request(`/mcp/questions/${filed.id}/withdraw`, { reason: " " })).status, 400);
  assert.equal((await request(`/mcp/questions/${filed.id}/withdraw`, { reason: "No longer needed" })).status, 200);
  assert.equal(registry.getReview(filed.id)!.status, "withdrawn");
  assert.equal(registry.getReview(filed.id)!.response, "No longer needed");
  assert.equal(registry.getReview(filed.id)!.resolvedBy, null);
  assert.equal((await request(`/mcp/questions/${filed.id}/withdraw`, { reason: "Again" })).status, 409);
  assert.deepEqual(loadReviewContinuationCandidates(filed.id), []);
});

test("withdrawal releases completion without an answer and persists a non-human terminal status", () => {
  setFlag(true);
  const { registry, reviews } = fleet();
  const s = eligible(registry);
  const q = reviews.create(s.id, "input", "Necessary?", "Necessary?", null, { snoozable: true, waitMode: "message" });
  assert.equal(registry.consumePromptedGeneration(s.id, s.request), false);
  reviews.withdrawQuestion(s.id, q.id, "The task no longer needs this choice");
  assert.equal(registry.completionHeldByQuestion(registry.getSession(s.id)!), false);
  assert.equal(registry.consumePromptedGeneration(s.id, s.request), true);
  assert.deepEqual(loadReviewContinuationCandidates(q.id), []);
  const stored = openDb().prepare("SELECT status, response, resolved_by FROM reviews WHERE id = ?").get(q.id);
  assert.equal(stored?.status, "withdrawn");
  assert.equal(stored?.resolved_by, null);
});

test("withdrawal accepts a 2000-character reason and rejects 2001 without settling the question", async () => {
  setFlag(true);
  const { registry, reviews, app } = fleet();
  const d = mkDiscovered(); registry.applyDiscovery([d]);
  const filed = reviews.create(d.syntheticId, "input", "Still needed?", "Still needed?", null, {
    snoozable: true, waitMode: "message",
  });
  const request = (reason: string) => app.request(`/mcp/questions/${filed.id}/withdraw`, {
    method: "POST", headers: authed, body: JSON.stringify({ env: {}, cwd: d.cwd, reason }),
  });
  const reason = "x".repeat(2000);

  assert.equal((await request(`${reason}x`)).status, 400);
  assert.deepEqual(registry.getReview(filed.id), filed, "the rejected reason leaves the live question open");
  assert.deepEqual(reviews.openQuestions(d.syntheticId).map((q) => q.id), [filed.id]);
  const pending = openDb().prepare("SELECT status, response, resolved_at FROM reviews WHERE id = ?").get(filed.id);
  assert.equal(pending?.status, "pending");
  assert.equal(pending?.response, null);
  assert.equal(pending?.resolved_at, null);

  assert.equal((await request(reason)).status, 200);
  assert.equal(registry.getReview(filed.id)?.status, "withdrawn");
  assert.equal(registry.getReview(filed.id)?.response, reason);
  const withdrawn = openDb().prepare("SELECT status, response FROM reviews WHERE id = ?").get(filed.id);
  assert.equal(withdrawn?.status, "withdrawn");
  assert.equal(withdrawn?.response, reason, "the maximum-length reason is persisted intact");
});

test("the review manager sends the full filed question and meanwhile plan through the durable answer row", () => {
  const { registry, reviews } = fleet();
  const d = mkDiscovered(); registry.applyDiscovery([d]);
  const full = "Which of the proposed storage options should we choose? The current choice is reversible.";
  const meanwhile = "Prepare the migration without applying it";
  let text = "";
  reviews.startContinuationRecovery((review, answer) => {
    const turn = createReviewContinuationPendingTurn({ reviewId: review.id, noteKey: `full-${d.syntheticId}`, text: answer, now: Date.now() });
    if (review.sessionId === d.syntheticId) text = turn?.text ?? "";
    return true;
  });
  const q = reviews.create(d.syntheticId, "input", "Short title", full, null, { snoozable: true, waitMode: "message", meanwhile });
  reviews.resolve(q.id, "answer", "Use SQLite", "foreman");
  assert.ok(text.includes(full));
  assert.ok(text.includes(meanwhile));
  assert.match(text, /Use SQLite/);
  assert.match(text, /Reconcile/);
});


test("withdrawal during an active runtime transfer returns 409 and leaves the question open without an answer queued", async (t) => {
  const { reserveSessionTransfer, updateSessionTransfer } = await import("../src/server/session-transfers/store.ts");
  setFlag(true);
  const { registry, reviews, app } = fleet();
  const d = mkDiscovered();
  registry.applyDiscovery([d]);
  const noteKey = `withdraw-transfer-${d.syntheticId}`;
  reviews.startContinuationRecovery((review, text) => {
    if (review.sessionId !== d.syntheticId) return false;
    return createReviewContinuationPendingTurn({ reviewId: review.id, noteKey, text, now: Date.now() }) !== null;
  });
  const filed = reviews.create(d.syntheticId, "input", "Still needed?", "Still needed?", null, {
    snoozable: true, waitMode: "message",
  });
  const transfer = reserveSessionTransfer({ sourceSessionId: d.syntheticId, noteKey, taskId: null,
    facts: { agent: "claude", nativeId: d.syntheticId, sourceName: "Transfer", sourceRuntime: "sdk", sourceEpisodeId: null,
      cwd: d.cwd!, repoRoot: null, taskIdentity: null, taskEpisodeId: null, bindings: [], leaseRoot: "/unused",
      leaseId: "unused", backend: null, home: null, sourceStopped: false, stopStarted: false, sourceProcess: null,
      launchAt: null, launchOutcome: "not_started", canEnd: false } });
  t.after(() => updateSessionTransfer(transfer, { state: "aborted" }));
  // Ordinary lookup already hides transferring sessions. Isolate the resolved-caller
  // boundary so this test reaches withdrawal's own transfer guard, not that earlier 404.
  t.mock.method(registry, "findSessionByEnv", () => registry.getSession(d.syntheticId));

  const response = await app.request(`/mcp/questions/${filed.id}/withdraw`, {
    method: "POST", headers: authed,
    body: JSON.stringify({ env: {}, cwd: d.cwd, reason: "No longer needed" }),
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "This session is mid runtime transfer." });
  assert.deepEqual(registry.getReview(filed.id), filed, "the refusal does not change the live question");
  assert.deepEqual(reviews.openQuestions(d.syntheticId).map((q) => q.id), [filed.id]);
  const stored = openDb().prepare("SELECT status, response, resolved_at, continuation_queued_at FROM reviews WHERE id = ?").get(filed.id);
  assert.equal(stored?.status, "pending");
  assert.equal(stored?.response, null);
  assert.equal(stored?.resolved_at, null);
  assert.equal(stored?.continuation_queued_at, null);
  assert.deepEqual(loadReviewContinuationCandidates(filed.id), [], "no answer is owed after the refusal");
  assert.equal(openDb().prepare("SELECT 1 FROM pending_turns WHERE note_key = ?").get(noteKey), undefined,
    "no answer was queued for the session");
});

for (const mix of ["snoozed-call", "pending-call", "mixed"] as const) {
  test(`the session limit includes ${mix} questions for new asks in either wait mode`, async () => {
    setFlag(true);
    const { registry, reviews, app } = fleet();
    const d = mkDiscovered();
    registry.applyDiscovery([d]);
    reviews.create(d.syntheticId, "plan-decisions", "Gate", "Gate");
    const ids: string[] = [];
    for (let n = 0; n < 10; n++) {
      const result = await created(await post(app, d.cwd, {
        title: `Limit ${mix} ${n}?`, snoozable: true, asyncCapable: mix === "mixed" && n % 2 === 0,
      }));
      ids.push(result.id);
      if (mix === "snoozed-call" || (mix === "mixed" && n % 2 === 1)) reviews.snooze(result.id, 60_000);
    }
    for (const asyncCapable of [false, true]) {
      const duplicate = await created(await post(app, d.cwd, { title: `Limit ${mix} 1?`, snoozable: true, asyncCapable }));
      assert.equal(duplicate.id, ids[1], "the same call-mode question reattaches even at the limit");
      const refused = await post(app, d.cwd, { title: `Another ${mix}?`, snoozable: true, asyncCapable });
      assert.equal(refused.status, 409);
      const error = await refused.text();
      for (let n = 0; n < 10; n++) assert.ok(error.includes(`Limit ${mix} ${n}?`));
    }
    assert.equal(reviews.openQuestions(d.syntheticId).length, 10);
  });
}

test("enabling async-input bounds existing call-mode questions without changing flag-off behavior", async () => {
  const { registry, reviews, app } = fleet();
  const d = mkDiscovered();
  registry.applyDiscovery([d]);
  for (let n = 0; n < 11; n++) {
    const result = await created(await post(app, d.cwd, { title: `Legacy ${n}?`, snoozable: true }));
    reviews.snooze(result.id, 60_000);
  }
  setFlag(true);
  for (const asyncCapable of [false, true]) {
    assert.equal((await post(app, d.cwd, { title: "New after enabling?", snoozable: true, asyncCapable })).status, 409);
  }
  assert.equal(reviews.openQuestions(d.syntheticId).length, 11, "existing questions are retained, but cannot grow");
});
