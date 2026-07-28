import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyBuffer,
  foldAlerts,
  summarizeBuffer,
  AWAY_PREVIEW_LINES,
} from "../src/shared/away-buffer.ts";
import type { Alert } from "../src/shared/alerts.ts";

/**
 * What is at stake: reading how much is waiting must not destroy it.
 *
 * The away card shows a buffered count while you are away, and the only route that
 * previously touched the buffer was `/api/away/digest` - which cannot answer this
 * question twice, and in fact cannot answer it at all during an away window. It hands
 * the buffer over exactly once (`takePending` nulls it) precisely because there is
 * nowhere to recover a digest from afterwards, and it reads the PENDING slot, which only
 * fills when the window closes. So a panel polling it for a live figure would read
 * nothing for the whole time you were away and then eat the digest on the one read that
 * finally worked.
 *
 * `summarizeBuffer` is the non-destructive half. These pin that it only ever looks, that
 * it agrees with the digest's own rollup rather than counting independently, and that
 * "not away" is a real state it answers rather than an error.
 */

const alert = (id: string, title: string): Alert => ({
  id,
  kind: "idle",
  title,
  body: "",
  sessionId: null,
  severity: "info",
});

test("not away is a state, not an error - all zeroes, no throw", () => {
  const s = summarizeBuffer(null);
  assert.deepEqual(s, { since: null, count: 0, dropped: 0, rollup: "", lines: [] });
});

test("an open window with nothing in it reports zero rather than a stale figure", () => {
  const s = summarizeBuffer(emptyBuffer(1000));
  assert.equal(s.since, 1000);
  assert.equal(s.count, 0);
  assert.deepEqual(s.lines, []);
});

test("counts distinct events and previews them", () => {
  let buf = emptyBuffer(1000);
  buf = foldAlerts(buf, [alert("a", "one finished"), alert("b", "two finished")], 2000);
  const s = summarizeBuffer(buf);
  assert.equal(s.count, 2);
  assert.equal(s.lines.length, 2);
  assert.match(s.rollup, /2 finished/);
});

// The figure on the card and the sentence beside it read the same buffer, so they must
// count the same unit. A repeat coalesces into ONE event with a count - it must not
// inflate the card's figure past the number of lines the digest will show.
test("a repeat coalesces rather than incrementing the card's figure", () => {
  let buf = emptyBuffer(1000);
  buf = foldAlerts(buf, [alert("a", "one finished")], 2000);
  buf = foldAlerts(buf, [alert("a", "one finished again")], 3000);
  const s = summarizeBuffer(buf);
  assert.equal(s.count, 1, "one subject, seen twice, is one buffered thing");
  assert.equal(s.lines.length, 1);
});

test("reading twice returns the same thing - a peek consumes nothing", () => {
  let buf = emptyBuffer(1000);
  buf = foldAlerts(buf, [alert("a", "one finished")], 2000);
  const first = summarizeBuffer(buf);
  const second = summarizeBuffer(buf);
  assert.deepEqual(first, second);
  assert.equal(buf.events.length, 1, "the buffer itself is untouched");
});

test("the preview is capped for a popover, and says what it left out", () => {
  let buf = emptyBuffer(1000);
  const many = Array.from({ length: 12 }, (_, i) => alert(`k${i}`, `session ${i} finished`));
  buf = foldAlerts(buf, many, 2000);
  const s = summarizeBuffer(buf);
  assert.equal(s.count, 12, "the count is the truth, uncapped");
  assert.equal(s.lines.length, AWAY_PREVIEW_LINES, "the preview is not");
  assert.match(s.lines.at(-1) ?? "", /more/, "truncation is stated, never silent");
});
