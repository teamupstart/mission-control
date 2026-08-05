import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkMuxHandle } from "./helpers/session-fixture.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { PlanDecision } from "../src/shared/types.ts";

// The review half of retiring a spent Foreman note.
//
// `test/foreman-note-retire.test.ts` pins the registry rule; this pins the wiring, on the
// channel where the note used to survive longest. A review's marker is `review:<id>`, and
// resolving it left the note `escalated` forever - measured on a real database as two notes
// pinned against a `plan` their human had approved and a `plan-decisions` they had answered
// hours before. The dashboard degrades such a note to "already resolved, nothing to send it
// to" and hides Approve, so the operator was left with a banner whose only remaining control
// was the Dismiss they should never have had to press.
//
// Hung off `settle` rather than off `resolve`, because settle is the one writer of a terminal
// status. What that buys is the two cases below that must NOT retire: Foreman answering on
// its own behalf, and the daemon orphaning reviews for a session that went away.

const home = mkdtempSync(join(tmpdir(), "mission-note-retire-review-"));
process.env.HARNESS_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");

after(() => rmSync(home, { recursive: true, force: true }));

function mkDiscovered(id: string): DiscoveredSession {
  return {
    syntheticId: id,
    agent: "claude",
    name: "work",
    nameSource: "process",
    cwd: `/wt/${id}`,
    gitBranch: null,
    pid: 1,
    tty: "ttys015",
    terminals: [mkMuxHandle({ session: "s", windowName: "w", windowIndex: 0, paneId: "%1" })],
    startedAt: 0,
  } as DiscoveredSession;
}

/**
 * A session blocked on a review, with the escalated note Foreman pins about it.
 *
 * The note's marker is built from the review's real id, because that agreement is the thing
 * under test: `classifyPending` mints `review:<id>` and `settle` has to rebuild the same
 * string to find the note again.
 */
function blockedOnReview(
  id: string,
  kind: "input" | "plan" = "input",
  decisions: PlanDecision[] | null = null,
): {
  registry: InstanceType<typeof Registry>;
  reviews: InstanceType<typeof ReviewManager>;
  reviewId: string;
} {
  const registry = new Registry();
  const reviews = new ReviewManager(registry);
  registry.applyDiscovery([mkDiscovered(id)]);
  const review = reviews.create(
    id,
    kind,
    "Should I publish the artifacts?",
    "Should I publish the artifacts and schedule the two phase tasks?",
    decisions,
  );
  const marker = `review:${review.id}`;
  registry.recordEpisode(
    id,
    {
      marker,
      situation: kind === "input" ? "input-review" : "non-input-review",
      surface: "input-review",
      question: "Should I publish the artifacts and schedule the two phase tasks?",
      reviewId: review.id,
      recommendation: 'Choose "Push and PR, but no tasks yet".',
      disposition: "escalated",
    },
    1000,
  );
  registry.upsertNote(
    id,
    {
      purpose: "Whether to publish the plan artifacts now.",
      recommendation: 'Choose "Push and PR, but no tasks yet".',
      disposition: "escalated",
      lastAction: "escalated for your decision",
      handledMarker: marker,
    },
    1000,
  );
  return { registry, reviews, reviewId: review.id };
}

test("answering the review yourself retires the note about it", () => {
  const { registry, reviews, reviewId } = blockedOnReview("rv-answer");

  reviews.resolve(reviewId, "answer", "Yes - push, PR, and schedule");

  const note = registry.getNote("rv-answer")!;
  assert.equal(note.disposition, "skipped", "nothing is owed, so nothing stays pinned");
  assert.equal(note.lastAction, "you answered this yourself");
  assert.equal(note.recommendation, null);
});

test("approving a plan retires it too - the ask is closed either way", () => {
  // Not just `answer`. A `plan` review is the shape Foreman can never deliver a reply to, so
  // its note is always an escalation, and approving the plan is exactly as final an answer as
  // choosing an option is. One of the two notes stuck on the real database was this case.
  const { registry, reviews, reviewId } = blockedOnReview("rv-approve", "plan");

  reviews.resolve(reviewId, "approve", null);

  assert.equal(registry.getNote("rv-approve")!.disposition, "skipped");
});

test("dismissing the question retires the note as well", () => {
  // Declining to choose is still closing the ask: the child is released and Foreman's
  // suggestion answers nothing. Leaving the note up would ask the human to decide something
  // they have just explicitly declined to decide.
  // Only a review with selectable options may be dismissed, so it is created with some.
  const { registry, reviews, reviewId } = blockedOnReview("rv-dismiss", "input", [
    {
      id: "q",
      question: "Publish?",
      options: [{ id: "o0", label: "Yes" }, { id: "o1", label: "No" }],
    },
  ]);

  reviews.resolve(reviewId, "dismiss", null);

  assert.equal(registry.getNote("rv-dismiss")!.disposition, "skipped");
});

test("Foreman resolving its own review does not credit you with the answer", () => {
  // Foreman's `applyVerdict` writes the note itself, after the send. Retiring it here would
  // race that write and file the decision as one nobody delivered - and the ledger would show
  // the human dismissing an answer Foreman had in fact sent on their behalf.
  const { registry, reviews, reviewId } = blockedOnReview("rv-foreman");

  reviews.resolve(reviewId, "answer", "Push and PR, but no tasks yet", "foreman");

  const note = registry.getNote("rv-foreman")!;
  assert.equal(note.disposition, "escalated", "left exactly as Foreman's own write found it");
  assert.equal(note.lastAction, "escalated for your decision");
});

test("a review orphaned by its session going away is nobody's answer", () => {
  // The daemon tidying up after a session that exited, not a decision anyone made. There is
  // no answer of the human's to credit, so the note must not be rewritten to claim one - the
  // session's own teardown is what clears it.
  // The manager is built inside the fixture and subscribes there; nothing calls it directly.
  const { registry, reviewId } = blockedOnReview("rv-orphan");
  assert.equal(registry.getReview(reviewId)!.status, "pending");

  // The event the ReviewManager subscribes to, which is how a real eviction reaches it.
  registry.emit("event", { type: "session_remove", id: "rv-orphan" });

  assert.equal(registry.getReview(reviewId)!.status, "orphaned", "the review was settled");
  // Read off the store rather than the session, which has gone.
  const note = registry.listNotes().find((n) => n.handledMarker === `review:${reviewId}`)!;
  assert.equal(note.disposition, "escalated", "not restamped as your decision");
});
