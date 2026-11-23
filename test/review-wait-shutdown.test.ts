import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// An MCP agent blocked on `request_input` holds `/mcp/reviews/:id/wait` open for up to the
// long-poll timeout. When the daemon stops, that request is answered the way its timeout would
// answer it, with the still-pending row, so the agent long-polls the next daemon rather than
// holding the quit open or having its connection cut. See `src/server/http-shutdown.ts`.

const home = mkdtempSync(join(tmpdir(), "mission-review-wait-shutdown-"));
process.env.HARNESS_HOME = home;
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");

openDb();

let n = 0;
function pendingReview() {
  const registry = new Registry();
  const reviews = new ReviewManager(registry);
  const review = reviews.create(`sdk:review-wait-shutdown-${++n}`, "input", "Ship it?", "Ship it?", null);
  return { reviews, review };
}

test("aborting a review wait answers it at once with the still-pending row", async () => {
  const { reviews, review } = pendingReview();
  const ended = new AbortController();
  const waiting = reviews.wait(review.id, 60_000, ended.signal);

  const started = Date.now();
  ended.abort();
  const answered = await waiting;

  assert.ok(Date.now() - started < 1_000, "the wait held on after its signal");
  assert.equal(answered?.id, review.id);
  assert.equal(answered?.status, "pending");
});

test("a wait whose signal is already aborted does not block", async () => {
  const { reviews, review } = pendingReview();
  const ended = new AbortController();
  ended.abort();
  assert.equal((await reviews.wait(review.id, 60_000, ended.signal))?.status, "pending");
});

test("a decision still reaches a wait that carries a signal", async () => {
  const { reviews, review } = pendingReview();
  const ended = new AbortController();
  const waiting = reviews.wait(review.id, 60_000, ended.signal);
  reviews.resolve(review.id, "answer", "yes", "human");
  assert.equal((await waiting)?.response, "yes");
});
