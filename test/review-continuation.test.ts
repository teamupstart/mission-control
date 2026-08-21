import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const home = mkdtempSync(join(tmpdir(), "mission-review-continuation-"));
process.env.HARNESS_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

// Seed the exact pre-feature shape before `openDb` runs. The migration must widen this
// existing table; a fresh database alone cannot prove an operator's database still opens.
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

const { openDb } = await import("../src/server/db.ts");
const { PendingTurnManager } = await import("../src/server/pending-turns.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");

let sequence = 0;

test("an existing reviews table gains the durable continuation columns", () => {
  const columns = openDb().prepare(`PRAGMA table_info(reviews)`).all() as unknown as Array<{
    name: string;
  }>;
  const names = new Set(columns.map((column) => column.name));
  assert.ok(names.has("mcp_wait_detached_at"));
  assert.ok(names.has("continuation_queued_at"));
});

function fixture(prefix: string) {
  const suffix = `${prefix}-${++sequence}`;
  const id = `sdk:${suffix}`;
  const registry = new Registry();
  registry.registerSdkSession({
    id,
    agent: "codex",
    name: suffix,
    cwd: `/repo/${suffix}`,
    agentSessionId: `thread:${suffix}`,
  });
  registry.applyDriverEvent(id, { kind: "state", state: "working", activity: null });
  const pendingTurns = new PendingTurnManager(
    registry,
    { sendWhenIdle: async () => "started" },
    { idleSettleMs: 60_000 },
  );
  pendingTurns.start();
  const reviews = new ReviewManager(registry);
  reviews.startContinuationRecovery(
    (review, text) => pendingTurns.submitReviewContinuation(review.id, review.sessionId, text).ok,
  );
  return { id, registry, reviews, pendingTurns };
}

test("a human answer after MCP cancellation is queued to the owning session", () => {
  const f = fixture("after-cancel");
  const review = f.reviews.create(f.id, "input", "Which path?", "Which path?");

  assert.equal(f.reviews.detachWait(review.id, f.id)?.id, review.id);
  f.reviews.resolve(review.id, "answer", "Take the durable path", "human");

  const turns = f.registry.getSession(f.id)?.pendingTurns ?? [];
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.id, `review-continuation:${review.id}`);
  assert.match(turns[0]?.text ?? "", /Take the durable path/);
  assert.match(turns[0]?.text ?? "", new RegExp(review.id));
  f.pendingTurns.stop();
});

test("detachment after resolution closes the same race", () => {
  const f = fixture("answer-first");
  const review = f.reviews.create(f.id, "diff", "Review the patch", "diff");
  f.reviews.resolve(review.id, "approve", "ship it", "human");
  assert.equal(f.registry.getSession(f.id)?.pendingTurns.length, 0);

  f.reviews.detachWait(review.id, f.id);

  const turn = f.registry.getSession(f.id)?.pendingTurns[0];
  assert.match(turn?.text ?? "", /APPROVED/);
  assert.match(turn?.text ?? "", /Reviewer note: ship it/);
  f.pendingTurns.stop();
});

test("continuation enqueue is idempotent and session-bound", () => {
  const f = fixture("idempotent");
  const review = f.reviews.create(f.id, "input", "One answer", "One answer");

  assert.equal(f.reviews.detachWait(review.id, "sdk:someone-else"), null);
  f.reviews.resolve(review.id, "answer", "accepted", "human");
  assert.equal(f.registry.getSession(f.id)?.pendingTurns.length, 0);

  f.reviews.detachWait(review.id, f.id);
  f.reviews.detachWait(review.id, f.id);
  f.reviews.resolve(review.id, "answer", "accepted", "human");
  assert.equal(f.registry.getSession(f.id)?.pendingTurns.length, 1);
  f.pendingTurns.stop();
});

test("a pending review restored after restart is treated as detached", () => {
  const first = fixture("restart");
  const review = first.reviews.create(first.id, "input", "Still there?", "Still there?");
  first.pendingTurns.stop();

  const registry = new Registry();
  registry.registerSdkSession({
    id: first.id,
    agent: "codex",
    name: "restart-restored",
    cwd: "/repo/restart-restored",
    agentSessionId: "thread:restart-restored",
  });
  registry.applyDriverEvent(first.id, { kind: "state", state: "working", activity: null });
  const pendingTurns = new PendingTurnManager(
    registry,
    { sendWhenIdle: async () => "started" },
    { idleSettleMs: 60_000 },
  );
  pendingTurns.start();
  const reviews = new ReviewManager(registry);
  reviews.startContinuationRecovery(
    (item, text) => pendingTurns.submitReviewContinuation(item.id, item.sessionId, text).ok,
  );

  reviews.resolve(review.id, "answer", "yes", "human");

  assert.match(registry.getSession(first.id)?.pendingTurns[0]?.text ?? "", /yes/);
  const row = openDb()
    .prepare(
      `SELECT mcp_wait_detached_at, continuation_queued_at FROM reviews WHERE id = ?`,
    )
    .get(review.id) as unknown as {
    mcp_wait_detached_at: number | null;
    continuation_queued_at: number | null;
  };
  assert.ok(row.mcp_wait_detached_at);
  assert.ok(row.continuation_queued_at);
  pendingTurns.stop();
});
