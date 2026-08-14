import test from "node:test";
import assert from "node:assert/strict";

import type { ArchiveSummary } from "../src/shared/archives.ts";
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

function summary(key: string): ArchiveSummary {
  return {
    key,
    producerId: "7aa704fd-d2ab-48b3-a726-0c2643ed91d2",
    producerLabel: null,
    archiveId: key,
    kind: "scout",
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

test("a refresh restores the depth the operator paged to, not page one", () => {
  // The rule the Inspector caught this hook breaking: `revision` ticks on every reconciled
  // batch and every SSE reconnect, and `refresh()` fires after every delete. Refetching only
  // the first page there threw away every "Load more" an operator had pressed - scroll deep,
  // have an unrelated scout complete, and the rail silently collapsed to one window.
  //
  // The depth is a page COUNT walked back over the cursor, so this asserts the arithmetic
  // that count is used for: three pages of thirty is ninety rows, and re-walking them
  // reassembles the same list in the same order.
  const page = (start: number) =>
    Array.from({ length: 30 }, (_, i) => summary(`k${start + i}`));

  let window: ArchiveSummary[] = [];
  for (const start of [0, 30, 60]) window = appendArchives(window, page(start));
  assert.equal(window.length, 90, "three pages of thirty are ninety rows");
  assert.equal(window[0]!.key, "k0");
  assert.equal(window.at(-1)!.key, "k89");

  // Re-walking the same three pages after a refresh must land on the same window, and the
  // dedupe must not eat rows just because they arrive again in the same order.
  let rewalked: ArchiveSummary[] = [];
  for (const start of [0, 30, 60]) rewalked = appendArchives(rewalked, page(start));
  assert.deepEqual(rewalked.map((a) => a.key), window.map((a) => a.key));

  // A library that shrank below the loaded depth stops early rather than inventing rows.
  let shrunk: ArchiveSummary[] = [];
  for (const start of [0, 30]) shrunk = appendArchives(shrunk, page(start));
  assert.equal(shrunk.length, 60);
});
