import test from "node:test";
import assert from "node:assert/strict";

import type { ScoutArchiveSummary } from "../src/shared/scouts.ts";
import {
  appendArchives,
  continuationApplies,
} from "../src/web/components/scouts/useScoutsCatalog.ts";

/**
 * What is at stake: the Scouts rail must never show rows that the address bar does not
 * describe.
 *
 * The catalog paginates with a server cursor, so a "Load more" is a second request against a
 * window that may no longer be the window on screen. The first version of this hook built an
 * `AbortController` for that request that nothing else could reach, under a comment claiming
 * the list effect aborted it - it did not. Loading page two of one search and then changing
 * the search before it landed appended the OLD search's archives to the NEW search's list and
 * replaced the cursor, so the next page was fetched for the wrong query.
 *
 * The rule is stated once, here, as a plain function, because the bug was not in the fetching
 * - it was in believing a resolved response still belonged to the screen.
 */

function summary(key: string): ScoutArchiveSummary {
  return {
    key,
    producerId: "7aa704fd-d2ab-48b3-a726-0c2643ed91d2",
    producerLabel: null,
    archiveId: key,
    status: "ready",
    captureStatus: "complete",
    title: `Archive ${key}`,
    question: null,
    summary: null,
    tags: [],
    agent: null,
    model: null,
    source: null,
    repositories: [],
    createdAt: null,
    completedAt: null,
    indexedAt: 0,
    artifactCount: 1,
    bytes: 1,
    hasPrimaryReport: true,
    missingCount: 0,
    error: null,
    snippet: null,
  };
}

test("a continuation applies only to the window it was started for", () => {
  // The ordinary case: same window, not cancelled.
  assert.equal(continuationApplies(4, 4, false), true);

  // The regression. The operator typed a new search while page two was in flight, so the
  // window moved on. Its rows and its cursor belong to a query nobody is looking at.
  assert.equal(continuationApplies(4, 5, false), false);

  // Cancelled is cancelled, even when the window has not moved - a superseding "Load more"
  // aborts the one before it.
  assert.equal(continuationApplies(4, 4, true), false);

  // Both at once is still a refusal, and the generation alone is enough: a fetch that has
  // already resolved cannot be aborted, which is exactly why the generation check exists
  // beside the signal rather than instead of it.
  assert.equal(continuationApplies(4, 9, true), false);
});

test("a continuation's rows are appended once, in order, with repeats dropped", () => {
  const page1 = [summary("a"), summary("b")];
  const page2 = [summary("c"), summary("d")];
  assert.deepEqual(
    appendArchives(page1, page2).map((archive) => archive.key),
    ["a", "b", "c", "d"],
  );

  // A bundle reconciled between the two requests shifts the window boundary and repeats a
  // row. Left alone that is a duplicate React key AND the same archive listed twice.
  const overlapping = [summary("b"), summary("c")];
  assert.deepEqual(
    appendArchives(page1, overlapping).map((archive) => archive.key),
    ["a", "b", "c"],
  );

  // The rows already on screen are never reordered or dropped by a continuation.
  assert.deepEqual(appendArchives(page1, []).map((archive) => archive.key), ["a", "b"]);
  assert.deepEqual(appendArchives([], page2).map((archive) => archive.key), ["c", "d"]);
});
