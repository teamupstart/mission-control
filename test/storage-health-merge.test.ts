import assert from "node:assert/strict";
import test from "node:test";
import { mergeStorageHealth } from "../src/web/useStorage.ts";
import { storageHealthFixture } from "./helpers/storage-fixtures.ts";

// What is at stake: Measure now starts a walk, and the page learns where it is from two sources,
// the stream and a route read, which can be delivered in either order. Shown as delivered, a
// stale answer can put the page back on "Measuring…" after the walk finished, or back on idle
// after a new walk began - and nothing further arrives to correct either.

/** A health whose measurement describes the walk that started at `startedAt`. */
const walk = (startedAt: number | null, measuring: boolean, measuredAt: number | null, error: string | null = null) => {
  const base = storageHealthFixture();
  return { ...base, usage: { ...base.usage, startedAt, measuring, measuredAt, error } };
};

test("a read taken mid-walk cannot put back a walk the stream already said finished", () => {
  const finished = walk(10, false, 20);
  const midWalk = walk(10, true, 5);
  const shown = mergeStorageHealth(finished, midWalk);
  assert.equal(shown.usage.measuring, false);
  assert.equal(shown.usage.measuredAt, 20);
});

test("an idle answer from before a new walk cannot put back idle after the stream said measuring", () => {
  // A new walk leaves `measuredAt` where the last one left it, so it cannot order these two.
  const measuring = walk(30, true, 20);
  const staleIdle = walk(10, false, 20);
  assert.equal(mergeStorageHealth(measuring, staleIdle).usage.measuring, true);
});

test("a walk that failed ends its measuring, though it moved no measuredAt", () => {
  const measuring = walk(30, true, 20);
  const failed = walk(30, false, 20, "du: permission denied");
  const shown = mergeStorageHealth(measuring, failed);
  assert.equal(shown.usage.measuring, false, "the page is not left on Measuring…");
  assert.equal(shown.usage.error, "du: permission denied");
});

test("a newer walk, starting or finished, still replaces what is shown", () => {
  assert.equal(mergeStorageHealth(walk(10, false, 20), walk(30, true, 20)).usage.measuring, true, "a new walk starting");
  assert.equal(mergeStorageHealth(walk(30, true, 20), walk(30, false, 40)).usage.measuredAt, 40, "that walk finishing");
  assert.equal(mergeStorageHealth(null, walk(null, true, null)).usage.measuring, true);
});

test("everything but the measurement is taken from the newer delivery", () => {
  const finished = walk(10, false, 20);
  const midWalk = { ...walk(10, true, 5), problems: [] };
  assert.equal(mergeStorageHealth(finished, midWalk).problems, midWalk.problems);
});
