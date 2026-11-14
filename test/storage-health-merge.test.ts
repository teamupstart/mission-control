import assert from "node:assert/strict";
import test from "node:test";
import { mergeStorageHealth } from "../src/web/useStorage.ts";
import { storageHealthFixture } from "./helpers/storage-fixtures.ts";

// What is at stake: Measure now starts a walk, and the page learns it finished from the stream.
// The route read the button also triggers can be answered while the walk is still running and
// be delivered AFTER the stream's "finished": shown as delivered, the page would sit on
// "Measuring…" for good, because nothing further arrives to correct it.

const at = (measuredAt: number | null, measuring: boolean) => {
  const base = storageHealthFixture();
  return { ...base, usage: { ...base.usage, measuredAt, measuring } };
};

test("a stale read cannot put back a walk the stream already said finished", () => {
  const finished = at(2_000, false);
  const staleRead = at(1_000, true);
  const shown = mergeStorageHealth(finished, staleRead);
  assert.equal(shown.usage.measuring, false);
  assert.equal(shown.usage.measuredAt, 2_000);
});

test("a newer measurement, or a new walk starting, still replaces what is shown", () => {
  assert.equal(mergeStorageHealth(at(1_000, true), at(2_000, false)).usage.measuredAt, 2_000);
  const started = mergeStorageHealth(at(2_000, false), at(2_000, true));
  assert.equal(started.usage.measuring, true, "the same last measurement, with a new walk under way");
  assert.equal(mergeStorageHealth(null, at(null, true)).usage.measuring, true);
});

test("everything but the measurement is taken from the newer delivery", () => {
  const finished = at(2_000, false);
  const staleRead = { ...at(1_000, true), problems: [] };
  const shown = mergeStorageHealth(finished, staleRead);
  assert.equal(shown.problems, staleRead.problems);
});
