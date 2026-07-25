import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkMuxHandle } from "./helpers/session-fixture.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";

// What is at stake: a topbar reading "8 reviews" over a fleet with nothing to review.
//
// A review is durable state BOUND TO A SESSION, and it was the one such piece with no
// eviction path at all. `Registry.remove` clears seven session-scoped maps and never
// touched `reviews`, and `loadPendingReviews()` restores every pending row at boot
// regardless of whether the agent that asked still exists. Observed on a live install:
// eight pending reviews belonging to five sessions that had exited days earlier, carried
// across restart after restart, while all six live sessions reported `pendingReviews: 0`.
//
// The chip that counts them is worse than wrong, it is a dead end. `openReviews` picks
// `pendingReviews[0]` and opens the modal keyed on ITS session - which is not in the
// session list any more, so `modalOpen` is false and the click does nothing. The operator
// is told eight agents are blocked on them and handed no way to reach any of them.
//
// The rule these pin: a session going away settles its reviews, through the same two
// halves every other session-bound subscriber needs - `session_remove` while the daemon is
// up, and the first completed sweep for the ones that went away while it was down. A
// review nobody can answer must not be counted as one somebody is waiting on.
//
// Every case uses its own session ids: these share one HARNESS_HOME, so each `new Registry`
// reloads every pending row the file has written so far, and a bare "nothing is pending"
// assertion would be answering for its neighbours.

const home = mkdtempSync(join(tmpdir(), "mission-review-orphan-"));
process.env.HARNESS_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");

after(() => rmSync(home, { recursive: true, force: true }));

function mkDiscovered(id: string, over: Partial<DiscoveredSession> = {}): DiscoveredSession {
  return {
    syntheticId: id,
    agent: "claude",
    name: "work",
    nameSource: "process",
    cwd: "/wt/task-1",
    gitBranch: "harness/task-1",
    nomistakesGated: false,
    pid: 1,
    tty: "ttys015",
    terminals: [mkMuxHandle({ session: "s", windowName: "w", windowIndex: 0, paneId: "%1" })],
    startedAt: 0,
    ...over,
  } as DiscoveredSession;
}

/** A registry with a ReviewManager wired to it, which is what subscribes. */
function wired(): {
  registry: InstanceType<typeof Registry>;
  reviews: InstanceType<typeof ReviewManager>;
} {
  const registry = new Registry();
  return { registry, reviews: new ReviewManager(registry) };
}

/** Pending review ids for ONE session - see the note on shared state above. */
const pendingFor = (r: InstanceType<typeof Registry>, sessionId: string): string[] =>
  r
    .snapshot()
    .reviews.filter((x) => x.status === "pending" && x.sessionId === sessionId)
    .map((x) => x.id);

test("a killed session's pending review is orphaned, not left pending forever", () => {
  const { registry, reviews } = wired();
  registry.applyDiscovery([mkDiscovered("kill-1")]);
  const review = reviews.create("kill-1", "plan-decisions", "Swarm strategies", "body");
  assert.deepEqual(pendingFor(registry, "kill-1"), [review.id]);

  registry.emit("event", { type: "session_remove", id: "kill-1" });

  const settled = registry.getReview(review.id)!;
  assert.equal(settled.status, "orphaned");
  // A terminal status is a resolution, so it carries the moment it happened like every
  // other one - a row with no `resolvedAt` reads as still open to anything scanning them.
  assert.ok((settled.resolvedAt ?? 0) > 0);
  // And nothing was invented on the operator's behalf: the agent went away, it did not
  // get an answer.
  assert.equal(settled.response, null);
  assert.deepEqual(pendingFor(registry, "kill-1"), [], "nothing is waiting on the operator");
});

test("another session's pending review is left alone", () => {
  const { registry, reviews } = wired();
  registry.applyDiscovery([mkDiscovered("pair-a"), mkDiscovered("pair-b", { pid: 2 })]);
  const mine = reviews.create("pair-a", "input", "mine", "body");
  const theirs = reviews.create("pair-b", "input", "theirs", "body");

  registry.emit("event", { type: "session_remove", id: "pair-a" });

  assert.equal(registry.getReview(mine.id)!.status, "orphaned");
  assert.deepEqual(pendingFor(registry, "pair-b"), [theirs.id]);
});

test("the real eviction path drives it - a session that stops being discovered", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { registry, reviews } = wired();
  registry.applyDiscovery([mkDiscovered("evict-1")]);
  const review = reviews.create("evict-1", "plan-decisions", "Integrating Codex", "body");

  // Gone from the process table. `exited` is provisional - one hiccuping sweep must not
  // throw away a question a live agent is still blocked on.
  registry.applyDiscovery([]);
  assert.equal(registry.getReview(review.id)!.status, "pending", "still inside the exit linger");

  t.mock.timers.tick(10_000);
  assert.equal(registry.getReview(review.id)!.status, "orphaned");
});

test("a session that comes back inside the linger keeps its review", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { registry, reviews } = wired();
  registry.applyDiscovery([mkDiscovered("hiccup-1")]);
  const review = reviews.create("hiccup-1", "input", "still here", "body");

  registry.applyDiscovery([]);
  registry.applyDiscovery([mkDiscovered("hiccup-1")]);
  t.mock.timers.tick(10_000);

  assert.equal(registry.getReview(review.id)!.status, "pending", "the sweep was a hiccup");
});

test("the restart twin: a pending review no sweep can account for is orphaned", () => {
  // The half that produced the eight. The daemon went down, the agents went with it, and
  // the rows came back at boot bound to synthetic ids - tty, pid and start time - that can
  // never name a process again.
  const first = wired();
  first.registry.applyDiscovery([mkDiscovered("restart-dead")]);
  const dead = first.reviews.create("restart-dead", "plan-decisions", "carried across", "b");

  // Restart: a fresh Registry reloads every pending row from SQLite, and a fresh
  // ReviewManager subscribes to it.
  const { registry } = wired();
  assert.deepEqual(
    pendingFor(registry, "restart-dead"),
    [dead.id],
    "reloaded, and nothing has swept yet",
  );

  // Sessions are rebuilt from the process table, so no review is judgeable until the first
  // COMPLETED sweep says what is out there. Settling before it would throw away the
  // questions of every agent that survived the restart.
  registry.applyDiscovery([mkDiscovered("restart-someone-else")]);

  assert.equal(registry.getReview(dead.id)!.status, "orphaned");
  assert.deepEqual(pendingFor(registry, "restart-dead"), []);
});

test("the first sweep leaves a review whose agent is still there alone", () => {
  const first = wired();
  first.registry.applyDiscovery([mkDiscovered("restart-live")]);
  const live = first.reviews.create("restart-live", "input", "survived the restart", "b");

  const { registry } = wired();
  // The same session: a synthetic id is tty + pid + start time, so a process that outlived
  // the daemon is rediscovered under the id its review is already bound to.
  registry.applyDiscovery([mkDiscovered("restart-live")]);

  assert.equal(registry.getReview(live.id)!.status, "pending");
  assert.deepEqual(pendingFor(registry, "restart-live"), [live.id]);
});

test("orphaning is durable - the next restart does not resurrect it", () => {
  const first = wired();
  first.registry.applyDiscovery([mkDiscovered("durable-1")]);
  const review = first.reviews.create("durable-1", "input", "gone for good", "b");
  first.registry.emit("event", { type: "session_remove", id: "durable-1" });

  // `loadPendingReviews` is a SQL filter on status, so an in-memory-only settle would come
  // straight back at the next boot and count all over again.
  const { registry } = wired();
  assert.equal(registry.getReview(review.id), undefined);
  assert.deepEqual(pendingFor(registry, "durable-1"), []);
});

test("a blocked agent's long poll is released rather than left to time out", async () => {
  const { registry, reviews } = wired();
  registry.applyDiscovery([mkDiscovered("poll-1")]);
  const review = reviews.create("poll-1", "input", "who is waiting", "body");

  const waiting = reviews.wait(review.id, 5_000);
  registry.emit("event", { type: "session_remove", id: "poll-1" });

  const settled = await waiting;
  assert.equal(settled?.status, "orphaned");
});

test("every open dashboard is told, rather than finding out on reload", () => {
  const { registry, reviews } = wired();
  registry.applyDiscovery([mkDiscovered("sse-1")]);
  const review = reviews.create("sse-1", "input", "who is watching", "body");

  const seen: string[] = [];
  registry.subscribe((e) => {
    if (e.type === "review_upsert" && e.review.id === review.id) seen.push(e.review.status);
  });
  registry.emit("event", { type: "session_remove", id: "sse-1" });

  // The live channel is SSE only - the web app does not poll - so a settle nobody emits
  // leaves the chip reading eight until someone reloads the page.
  assert.deepEqual(seen, ["orphaned"]);
});
