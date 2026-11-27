import { unexpectedActiveSdkDelivery } from "./helpers/pending-turn-sender.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const home = mkdtempSync(join(tmpdir(), "mission-review-snooze-"));
process.env.HARNESS_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

// The reviews table as it shipped before "Remind me later": the migration has to widen an
// operator's existing table, which a fresh database alone cannot prove.
const legacy = new DatabaseSync(join(home, "harness.db"));
legacy.exec(`
  CREATE TABLE reviews (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL,
    response TEXT,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  )
`);
legacy.close();

const {
  inTransaction, openDb, loadPendingReviews, listPendingTurns, createPendingTurn,
  claimNextPendingTurn, markPendingTurnUncertain,
} = await import("../src/server/db.ts");
const { PendingTurnManager } = await import("../src/server/pending-turns.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager, ReviewResolutionError, SnoozeActorRefusal } = await import("../src/server/reviews.ts");
const { reviewToolResult } = await import("../src/shared/review-item.ts");
import type { PlanDecision } from "../src/shared/types.ts";

const HOUR = 60 * 60_000;
const linter: PlanDecision[] = [
  {
    id: "q",
    question: "Which linter should this repo use?",
    options: [
      { id: "o0", label: "biome" },
      { id: "o1", label: "eslint", recommended: true },
    ],
  },
];

let sequence = 0;

function fixture(prefix: string) {
  const suffix = `${prefix}-${++sequence}`;
  const id = `sdk:${suffix}`;
  const registry = new Registry();
  registry.registerSdkSession({
    id,
    agent: "claude",
    name: suffix,
    cwd: `/repo/${suffix}`,
    agentSessionId: `thread:${suffix}`,
  });
  registry.applyDriverEvent(id, { kind: "state", state: "working", activity: null });
  const pendingTurns = new PendingTurnManager(
    registry,
    { ...unexpectedActiveSdkDelivery, sendWhenIdle: async () => "started" },
    { idleSettleMs: 60_000 },
  );
  pendingTurns.start();
  const reviews = new ReviewManager(registry);
  const deliver = (review: { id: string; sessionId: string }, text: string, kind: "answer" | "snooze-instruction") =>
    pendingTurns.submitReviewContinuation(review.id, review.sessionId, text, kind).ok;
  reviews.startContinuationRecovery(deliver);
  const ask = (decisions: PlanDecision[] | null = linter, snoozable = true) =>
    reviews.create(id, "input", "Which linter should this repo use?", "Which linter should this repo use?", decisions, { snoozable });
  const turns = () => registry.getSession(id)?.pendingTurns ?? [];
  return { id, registry, reviews, ask, turns, deliver };
}

test("an existing reviews table gains the snooze columns", () => {
  const names = new Set(
    (openDb().prepare(`PRAGMA table_info(reviews)`).all() as unknown as Array<{ name: string }>).map((c) => c.name),
  );
  for (const column of ["snoozable", "snoozed_at", "snoozed_until", "snooze_mode", "snooze_option_id", "snooze_reminded_at"]) {
    assert.ok(names.has(column), column);
  }
});

test("Remind me later releases the agent's wait with how to carry on, and parks the question", async () => {
  const f = fixture("release");
  const review = f.ask();
  assert.equal(review.snoozable, true);
  assert.equal(f.registry.getSession(f.id)?.pendingReviews, 1);

  const waiting = f.reviews.wait(review.id, 60_000);
  const snoozed = f.reviews.snooze(review.id, HOUR, { mode: "option", optionId: "o1" }, 1_000);
  const released = await waiting;

  assert.equal(released?.status, "snoozed");
  assert.deepEqual(snoozed?.snooze, { at: 1_000, until: 1_000 + HOUR, mode: "option", optionId: "o1", remindedAt: null });
  // Off the queue: the session no longer reads as waiting on a person.
  assert.equal(f.registry.getSession(f.id)?.pendingReviews, 0);

  const result = reviewToolResult(released!);
  assert.equal(result.isError, false);
  assert.match(result.text, /^Not answered yet: the operator chose "Remind me later"/);
  assert.match(result.text, /The operator chose "eslint" as a provisional answer/);
  assert.match(result.text, /Do not ask this question again yourself/);
});

test("only a request_input question can be snoozed, only while pending, and only with an offered option", () => {
  const f = fixture("refusals");
  const plain = f.ask(linter, false);
  assert.throws(() => f.reviews.snooze(plain.id, HOUR), ReviewResolutionError);

  const asked = f.reviews.create(f.id, "input", "Retry budget?", "Retry budget?", null, { snoozable: true });
  assert.throws(
    () => f.reviews.snooze(asked.id, HOUR, { mode: "option", optionId: "o0" }),
    /not one of this question's options/,
  );
  f.reviews.snooze(asked.id, HOUR, { mode: "hold" });
  assert.throws(() => f.reviews.snooze(asked.id, HOUR), /already snoozed/);
  assert.equal(f.reviews.snooze("no-such-review", HOUR), null);
});

test("the sweep brings a question back when it is due, as a reminder, and not before", () => {
  const f = fixture("sweep");
  const review = f.ask();
  f.reviews.snooze(review.id, HOUR, { mode: "judgment" }, 10_000);

  // Every Registry restores the database's outstanding rows, earlier tests' included, so the
  // sweep is read for this question alone.
  const mine = (woken: Array<{ id: string }>) => woken.filter((r) => r.id === review.id);
  assert.deepEqual(mine(f.reviews.sweepSnoozed(10_000 + HOUR - 1)), []);
  assert.equal(f.registry.getReview(review.id)?.status, "snoozed");

  const [woken] = mine(f.reviews.sweepSnoozed(10_000 + HOUR)) as Array<NonNullable<ReturnType<typeof f.registry.getReview>>>;
  assert.equal(woken?.id, review.id);
  assert.equal(woken?.status, "pending");
  assert.equal(woken?.snooze?.remindedAt, 10_000 + HOUR);
  assert.equal(f.registry.getSession(f.id)?.pendingReviews, 1, "back on the queue");
});

test("a second snooze moves the time but keeps what the agent was told", () => {
  const f = fixture("again");
  const review = f.ask();
  f.reviews.snooze(review.id, HOUR, { mode: "hold" }, 0);
  f.reviews.wake(review.id, HOUR);
  const again = f.reviews.snooze(review.id, 2 * HOUR, { mode: "option", optionId: "o0" }, HOUR);
  assert.equal(again?.snooze?.mode, "hold");
  assert.equal(again?.snooze?.optionId, null);
  assert.equal(again?.snooze?.until, 3 * HOUR);
});

test("an agent that re-asks a snoozed question gets the same parked row, not a second card", async () => {
  const f = fixture("reask");
  const review = f.ask();
  f.reviews.snooze(review.id, HOUR);
  const twin = f.ask();
  assert.equal(twin.id, review.id);
  assert.equal((await f.reviews.wait(twin.id, 60_000))?.status, "snoozed");
});

test("the answer to a snoozed question reaches the agent as a message about the work it did meanwhile", () => {
  const f = fixture("continuation");
  const review = f.ask();
  f.reviews.snooze(review.id, HOUR, { mode: "judgment" });
  f.reviews.wake(review.id);
  f.reviews.resolve(review.id, "answer", "→ eslint", "human");

  const turns = f.registry.getSession(f.id)?.pendingTurns ?? [];
  assert.equal(turns.length, 1);
  assert.match(turns[0]!.text, /now answered the question you were told to carry on without/);
  assert.match(turns[0]!.text, /→ eslint/);
});

test("answering while still snoozed settles it and delivers the answer", () => {
  const f = fixture("early");
  const review = f.ask();
  f.reviews.snooze(review.id, HOUR);
  const answered = f.reviews.resolve(review.id, "answer", "→ biome", "human");
  assert.equal(answered?.status, "answered");
  assert.equal(f.registry.getSession(f.id)?.pendingTurns?.length, 1);
});

test("a snoozed question survives a restart with its snooze, and is orphaned when its session goes", () => {
  const f = fixture("durable");
  const review = f.ask();
  f.reviews.snooze(review.id, HOUR, { mode: "option", optionId: "o0" }, 5);

  const reloaded = loadPendingReviews().find((r) => r.id === review.id);
  assert.equal(reloaded?.status, "snoozed");
  assert.equal(reloaded?.snoozable, true);
  assert.equal(reloaded?.snooze?.mode, "option");
  assert.equal(reloaded?.snooze?.optionId, "o0");

  f.registry.emit("event", { type: "session_remove", id: f.id });
  assert.equal(f.registry.getReview(review.id)?.status, "orphaned");
});

test("a reminder that fell due while the daemon was down comes back the moment the clock starts", () => {
  const f = fixture("overdue");
  const review = f.ask();
  const snoozedAt = Date.now() - 2 * HOUR;
  f.reviews.snooze(review.id, HOUR, { mode: "hold" }, snoozedAt);

  // A restart: a fresh registry restores the parked row from disk, still snoozed and overdue.
  const registry = new Registry();
  assert.equal(registry.getReview(review.id)?.status, "snoozed");
  const reviews = new ReviewManager(registry);
  // An interval far longer than the test, so only the immediate startup sweep can wake it.
  const stop = reviews.startSnoozeClock(24 * HOUR);
  try {
    const back = registry.getReview(review.id);
    assert.equal(back?.status, "pending");
    assert.equal(typeof back?.snooze?.remindedAt, "number");
    assert.ok(back!.snooze!.remindedAt! >= snoozedAt + HOUR, "stamped when it came back, after it fell due");
    assert.equal(back?.snooze?.mode, "hold", "what the agent was told survives the restart");
    assert.equal(loadPendingReviews().find((r) => r.id === review.id)?.status, "pending", "and the wake is durable");
  } finally {
    stop();
  }
});

test("only the operator may snooze: a delegated actor is refused and the question stays open", async () => {
  const f = fixture("operator-only");
  const review = f.ask();
  let released = false;
  const waiting = f.reviews.wait(review.id, 60_000).then((r) => { released = true; return r; });

  for (const by of ["session:sdk:controller", "foreman"] as const) {
    assert.throws(() => f.reviews.snooze(review.id, HOUR, { mode: "judgment" }, Date.now(), by), SnoozeActorRefusal);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(released, false, "the agent is still waiting on its answer");
  assert.equal(f.registry.getReview(review.id)?.status, "pending");
  assert.equal(f.registry.getReview(review.id)?.snooze, undefined);
  assert.equal(f.registry.getSession(f.id)?.pendingReviews, 1);

  f.reviews.snooze(review.id, HOUR);
  assert.equal((await waiting)?.status, "snoozed", "the operator's own snooze still releases it");
});

test("dismissing a snoozed question tells the agent so, and to keep what it chose meanwhile", () => {
  const f = fixture("dismissed");
  const review = f.ask();
  f.reviews.snooze(review.id, HOUR, { mode: "option", optionId: "o1" });
  f.reviews.resolve(review.id, "dismiss", null, "human");

  const turns = f.registry.getSession(f.id)?.pendingTurns ?? [];
  assert.equal(turns.length, 1);
  assert.match(turns[0]!.text, /^The operator has now dismissed the question you were told to carry on without/);
  assert.match(turns[0]!.text, /Keep what you chose meanwhile\./);
  assert.match(turns[0]!.text, /Input request dismissed without a response\./);
  assert.doesNotMatch(turns[0]!.text, /Reconcile/);
});

test("a snoozed question moves to the successor session with its reminder and instruction intact", () => {
  const f = fixture("transfer");
  const review = f.ask();
  const at = Date.now();
  f.reviews.snooze(review.id, 2 * HOUR, { mode: "option", optionId: "o1" }, at);
  const successor = `${f.id}-successor`;
  f.registry.registerSdkSession({
    id: successor,
    agent: "claude",
    name: "successor",
    cwd: `/repo/${f.id}-successor`,
    agentSessionId: `thread:${f.id}-successor`,
  });

  // The transfer coordinator's order: move inside the ownership transaction, publish after it.
  const moved = inTransaction(() => f.reviews.persistRuntimeTransfer(f.id, successor));
  f.reviews.publishRuntimeTransfer(moved);

  const expected = { at, until: at + 2 * HOUR, mode: "option", optionId: "o1", remindedAt: null };
  const carried = moved.find((r) => r.id === review.id);
  assert.equal(carried?.sessionId, successor);
  assert.equal(carried?.status, "snoozed");
  assert.deepEqual(carried?.snooze, expected);

  const persisted = loadPendingReviews().find((r) => r.id === review.id);
  assert.equal(persisted?.sessionId, successor, "the successor owns the persisted question");
  assert.equal(persisted?.status, "snoozed");
  assert.equal(persisted?.snoozable, true);
  assert.deepEqual(persisted?.snooze, expected, "its reminder time and interim instruction survive the move");

  assert.deepEqual(f.registry.outstandingReviews(successor).map((r) => r.id), [review.id]);
  assert.deepEqual(f.registry.outstandingReviews(f.id), []);

  // And it still comes back on time, to the successor.
  const [back] = f.reviews.sweepSnoozed(at + 2 * HOUR).filter((r) => r.id === review.id);
  assert.equal(back?.sessionId, successor);
  assert.equal(back?.status, "pending");
  assert.equal(f.registry.getSession(successor)?.pendingReviews, 1);
});

test("a snooze made after the agent's wait ended sends its instruction as a message, and the answer still follows", () => {
  const f = fixture("owed-instruction");
  const review = f.ask();
  // The MCP host gave up on the call before the operator chose: nothing is listening now.
  f.reviews.detachWait(review.id, f.id);
  f.reviews.snooze(review.id, HOUR, { mode: "hold" });

  assert.deepEqual(f.turns().map((t) => t.id), [`review-continuation:snooze:${review.id}`]);
  const instruction = f.turns()[0]!.text;
  assert.match(instruction, /^Your earlier request_input question "Which linter should this repo use\?"/);
  assert.match(instruction, /ended before the operator chose/);
  assert.match(instruction, /Do not do any work that depends on this answer/);
  assert.match(instruction, /Do not ask this question again yourself/);

  // Its own marker: the answer's continuation is not suppressed by the instruction having gone.
  f.reviews.resolve(review.id, "answer", "→ eslint", "human");
  assert.deepEqual(f.turns().map((t) => t.id), [
    `review-continuation:snooze:${review.id}`,
    `review-continuation:${review.id}`,
  ]);
  assert.match(f.turns()[1]!.text, /now answered the question you were told to carry on without/);
});

test("a snooze the agent hears as its tool result sends no second copy, and a later snooze sends none", async () => {
  const f = fixture("heard-instruction");
  const review = f.ask();
  const waiting = f.reviews.wait(review.id, 60_000);
  f.reviews.snooze(review.id, HOUR, { mode: "judgment" });
  assert.equal((await waiting)?.status, "snoozed");
  assert.deepEqual(f.turns(), [], "the tool result carried it");

  // Detached by now (the call returned); a reminder and a second snooze tell the agent nothing new.
  f.reviews.detachWait(review.id, f.id);
  f.reviews.wake(review.id);
  f.reviews.snooze(review.id, HOUR);
  assert.deepEqual(f.turns(), []);
});

test("withdrawing a message-mode question cancels only its unclaimed snooze instruction, including after recovery", () => {
  const f = fixture("withdraw-snooze");
  const review = f.reviews.create(f.id, "input", "Still needed?", "Still needed?", null, {
    snoozable: true, waitMode: "message",
  });
  f.reviews.snooze(review.id, HOUR, { mode: "hold" });
  const instruction = f.turns()[0]!;
  assert.equal(instruction.id, `review-continuation:snooze:${review.id}`);
  assert.equal(instruction.claimedAt, null);
  assert.match(instruction.text, /Not answered yet/);

  const other = f.ask();
  f.reviews.detachWait(other.id, f.id);
  f.reviews.snooze(other.id, HOUR);
  createPendingTurn({ id: `ordinary:${review.id}`, noteKey: instruction.noteKey, text: "Keep working", now: Date.now() });
  f.registry.refreshPendingTurns(instruction.noteKey);
  const retained = f.turns().filter((turn) => turn.id !== instruction.id);
  assert.equal(retained.length, 2);

  f.reviews.withdrawQuestion(f.id, review.id, "The dependent work was removed");
  assert.equal(f.registry.getReview(review.id)?.status, "withdrawn");
  assert.deepEqual(listPendingTurns(instruction.noteKey), retained, "the canceled instruction is removed durably");
  assert.deepEqual(f.turns(), retained, "the live outbox also loses the instruction without an answer replacing it");
  new ReviewManager(f.registry).startContinuationRecovery(f.deliver);
  assert.deepEqual(f.turns(), retained, "recovery does not requeue a withdrawn question's instruction");
});

test("a failed snooze-instruction deletion rolls back withdrawal and leaves the question and instruction open", () => {
  const f = fixture("withdraw-snooze-fails");
  const review = f.reviews.create(f.id, "input", "Still needed?", "Still needed?", null, {
    snoozable: true, waitMode: "message",
  });
  f.reviews.snooze(review.id, HOUR, { mode: "hold" });
  const instruction = f.turns()[0]!;
  assert.equal(instruction.id, `review-continuation:snooze:${review.id}`);
  assert.equal(instruction.state, "queued");
  assert.equal(instruction.claimedAt, null);
  const before = f.registry.getReview(review.id);
  const db = openDb();
  const stored = db.prepare("SELECT status, response, resolved_at FROM reviews WHERE id = ?");
  const beforeStored = stored.get(review.id);
  assert.equal(beforeStored?.status, "snoozed");

  db.exec(`CREATE TRIGGER refuse_snooze_delete BEFORE DELETE ON pending_turns
    WHEN OLD.id = '${instruction.id}' BEGIN SELECT RAISE(ABORT, 'snooze instruction deletion refused'); END`);
  try {
    assert.throws(
      () => f.reviews.withdrawQuestion(f.id, review.id, "The dependent work was removed"),
      /snooze instruction deletion refused/,
    );
    assert.deepEqual(stored.get(review.id), beforeStored, "the question's settlement is rolled back on disk");
    assert.deepEqual(f.registry.getReview(review.id), before, "no withdrawal is published to the live registry");
    assert.deepEqual(f.reviews.openQuestions(f.id).map((r) => r.id), [review.id]);
    assert.deepEqual(listPendingTurns(instruction.noteKey), [instruction], "the instruction stays queued with no answer replacing it");
    assert.deepEqual(f.turns(), [instruction], "the live outbox retains the same unclaimed instruction");
  } finally {
    db.exec("DROP TRIGGER refuse_snooze_delete");
  }
});

for (const state of ["sending", "uncertain"] as const) {
  test(`withdrawing a message-mode question preserves its ${state} snooze instruction`, () => {
    const f = fixture(`withdraw-snooze-${state}`);
    const review = f.reviews.create(f.id, "input", "Still needed?", "Still needed?", null, {
      snoozable: true, waitMode: "message",
    });
    // Hold, because a message-mode judgment snooze ("Keep doing what it said") sends nothing.
    f.reviews.snooze(review.id, HOUR, { mode: "hold" });
    const noteKey = f.turns()[0]!.noteKey;
    const claimed = claimNextPendingTurn(noteKey, Date.now())!;
    assert.equal(claimed.id, `review-continuation:snooze:${review.id}`);
    if (state === "uncertain") markPendingTurnUncertain(claimed.id, claimed.revision, "Delivery not confirmed", Date.now());
    f.registry.refreshPendingTurns(noteKey);
    const before = f.turns();

    f.reviews.withdrawQuestion(f.id, review.id, "The dependent work was removed");
    assert.equal(f.registry.getReview(review.id)?.status, "withdrawn");
    assert.deepEqual(listPendingTurns(noteKey), before, "do not discard a record of a message that may have reached the agent");
    assert.deepEqual(f.turns(), before);
  });
}

test("an owed instruction that could not be handed over yet is delivered when recovery starts", () => {
  const f = fixture("owed-later");
  const review = f.ask();
  f.reviews.detachWait(review.id, f.id);
  // A manager that has no outbox yet, as in the moments before startup recovery.
  const early = new ReviewManager(f.registry);
  early.snooze(review.id, HOUR, { mode: "option", optionId: "o0" });
  assert.deepEqual(f.turns(), []);

  early.startContinuationRecovery(f.deliver);
  assert.deepEqual(f.turns().map((t) => t.id), [`review-continuation:snooze:${review.id}`]);
  assert.match(f.turns()[0]!.text, /chose "biome" as a provisional answer/);

  // Delivered once: recovery running again finds nothing owed.
  new ReviewManager(f.registry).startContinuationRecovery(f.deliver);
  assert.equal(f.turns().length, 1);
});


test("a message-mode judgment snooze sends nothing, and the resolved answer arrives on its own", () => {
  // "Keep doing what it said": the agent was told to carry on when it filed the question, so a
  // snooze that changes nothing about its work owes it no message (`snoozeReviewRow`).
  const f = fixture("message-snooze-judgment");
  const review = f.reviews.create(f.id, "input", "Which linter?", "Which linter?", linter, {
    snoozable: true, waitMode: "message", meanwhile: "Prepare tests without applying the configuration",
  });
  f.reviews.snooze(review.id, HOUR, { mode: "judgment" });
  assert.equal(f.registry.getReview(review.id)?.status, "snoozed");
  assert.deepEqual(f.registry.outstandingReviews(f.id).map((r) => r.id), [review.id]);
  assert.deepEqual(f.turns(), [], "no instruction is queued");
  const stored = openDb().prepare("SELECT snooze_instruction_owed_at, continuation_queued_at FROM reviews WHERE id = ?").get(review.id);
  assert.deepEqual({ ...stored }, { snooze_instruction_owed_at: null, continuation_queued_at: null });

  f.reviews.resolve(review.id, "answer", "Use eslint", "human");
  assert.deepEqual(f.turns().map((turn) => turn.id), [`review-continuation:answer:${review.id}`]);
  // The marker line, then exactly the answer text the agent always received.
  assert.match(f.turns()[0]!.text, new RegExp(`^\\[mission-control:answer review=${review.id}\\]\n\nMission Control answer to question`));
  assert.match(f.turns()[0]!.text, /Use eslint/);
  assert.deepEqual(f.registry.outstandingReviews(f.id), []);
});

for (const mode of ["option", "hold"] as const) {
  test(`a message-mode snooze sends an unanswered ${mode} instruction, then a separate resolved answer`, () => {
    const f = fixture(`message-snooze-${mode}`);
    const review = f.reviews.create(f.id, "input", "Which linter?", "Which linter?", linter, {
      snoozable: true, waitMode: "message", meanwhile: "Prepare tests without applying the configuration",
    });
    f.reviews.snooze(review.id, HOUR, mode === "option" ? { mode, optionId: "o1" } : { mode });
    assert.equal(f.registry.getReview(review.id)?.status, "snoozed");
    assert.deepEqual(f.registry.outstandingReviews(f.id).map((r) => r.id), [review.id]);
    assert.deepEqual(f.turns().map((turn) => turn.id), [`review-continuation:snooze:${review.id}`]);
    const instruction = f.turns()[0]!.text;
    assert.match(instruction, new RegExp(`^\\[mission-control:remind-later review=${review.id}\\]\n\n`));
    assert.match(instruction, /Not answered yet/);
    assert.doesNotMatch(instruction, /Mission Control answer to question/);
    assert.match(instruction, mode === "hold" ? /Do not do any work that depends on this answer/
      : /"eslint" as a provisional answer/);
    const stored = openDb().prepare("SELECT status, continuation_queued_at FROM reviews WHERE id = ?").get(review.id);
    assert.equal(stored?.status, "snoozed");
    assert.equal(stored?.continuation_queued_at, null, "the snooze does not claim an answer was queued");

    f.reviews.resolve(review.id, "answer", "Use eslint", "human");
    assert.deepEqual(f.turns().map((turn) => turn.id), [
      `review-continuation:snooze:${review.id}`,
      `review-continuation:answer:${review.id}`,
    ]);
    assert.equal(f.turns()[0]!.text, instruction, "answering does not rewrite or combine with the instruction");
    assert.match(f.turns()[1]!.text, new RegExp(`^\\[mission-control:answer review=${review.id}\\]\n\nMission Control answer to question`));
    assert.match(f.turns()[1]!.text, /Use eslint/);
    assert.match(f.turns()[1]!.text, /Prepare tests without applying the configuration/);
    assert.deepEqual(f.registry.outstandingReviews(f.id), []);
  });
}
