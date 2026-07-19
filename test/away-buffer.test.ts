import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AWAY_BUFFER_CAP,
  closeBuffer,
  digestLines,
  emptyBuffer,
  eventLines,
  foldAlerts,
  hasAnything,
  mergeBuffers,
  rollupLine,
  tally,
} from "../src/shared/away-buffer.ts";
import type { Alert, AlertKind } from "../src/shared/alerts.ts";

function mkAlert(over: Partial<Alert> = {}): Alert {
  return {
    id: "idle:a",
    kind: "idle" as AlertKind,
    title: "auth went idle",
    body: "idle",
    sessionId: "a",
    severity: "info",
    ...over,
  };
}

test("an empty buffer has nothing to say", () => {
  const buf = emptyBuffer(0);
  assert.equal(hasAnything(buf), false);
  assert.equal(rollupLine(buf), "");
  assert.deepEqual(digestLines(buf), []);
});

test("folding no alerts returns the buffer untouched", () => {
  const buf = emptyBuffer(0);
  assert.equal(foldAlerts(buf, [], 100), buf);
});

test("a new alert lands as one event", () => {
  const buf = foldAlerts(emptyBuffer(0), [mkAlert()], 100);
  assert.equal(buf.events.length, 1);
  const e = buf.events[0]!;
  assert.equal(e.key, "idle:a");
  assert.equal(e.count, 1);
  assert.equal(e.firstAt, 100);
  assert.equal(e.lastAt, 100);
});

test("a REPEAT coalesces rather than appending", () => {
  // The core of the design: a session that finishes, restarts and finishes again
  // is one line with a count, not two lines.
  let buf = foldAlerts(emptyBuffer(0), [mkAlert()], 100);
  buf = foldAlerts(buf, [mkAlert()], 200);
  assert.equal(buf.events.length, 1);
  assert.equal(buf.events[0]?.count, 2);
});

test("a repeat keeps firstAt but advances lastAt", () => {
  let buf = foldAlerts(emptyBuffer(0), [mkAlert()], 100);
  buf = foldAlerts(buf, [mkAlert()], 500);
  assert.equal(buf.events[0]?.firstAt, 100);
  assert.equal(buf.events[0]?.lastAt, 500);
});

test("a repeat takes the NEWEST wording - a longer stall supersedes a shorter one", () => {
  let buf = foldAlerts(
    emptyBuffer(0),
    [mkAlert({ id: "stuck:a:silent-working", kind: "stuck", body: "silent for 10m" })],
    100,
  );
  buf = foldAlerts(
    buf,
    [mkAlert({ id: "stuck:a:silent-working", kind: "stuck", body: "silent for 40m" })],
    200,
  );
  assert.equal(buf.events[0]?.body, "silent for 40m");
});

test("different subjects stay separate", () => {
  const buf = foldAlerts(
    emptyBuffer(0),
    [mkAlert({ id: "idle:a", sessionId: "a" }), mkAlert({ id: "idle:b", sessionId: "b" })],
    100,
  );
  assert.equal(buf.events.length, 2);
});

test("ATTENTION alerts are buffered too - the digest is a record of the window", () => {
  // They interrupted you, but you may have missed the notification; "2 needed you
  // while you were out" is exactly what the summary is for.
  const buf = foldAlerts(
    emptyBuffer(0),
    [mkAlert({ id: "input:a", kind: "needs-input", severity: "attention" })],
    100,
  );
  assert.equal(buf.events.length, 1);
  assert.equal(hasAnything(buf), true);
});

test("the buffer caps and REPORTS what it dropped rather than silently truncating", () => {
  const many = Array.from({ length: AWAY_BUFFER_CAP + 5 }, (_, i) =>
    mkAlert({ id: `idle:s${i}`, sessionId: `s${i}` }),
  );
  const buf = foldAlerts(emptyBuffer(0), many, 100);
  assert.equal(buf.events.length, AWAY_BUFFER_CAP);
  assert.equal(buf.dropped, 5);
  assert.match(rollupLine(buf), /\+5 more/);
});

test("a repeat of an already-held event still coalesces once the cap is reached", () => {
  // Otherwise a full buffer would start counting known events as dropped.
  const many = Array.from({ length: AWAY_BUFFER_CAP }, (_, i) => mkAlert({ id: `idle:s${i}` }));
  let buf = foldAlerts(emptyBuffer(0), many, 100);
  buf = foldAlerts(buf, [mkAlert({ id: "idle:s0" })], 200);
  assert.equal(buf.dropped, 0);
  assert.equal(buf.events.find((e) => e.key === "idle:s0")?.count, 2);
});

test("tally counts by kind", () => {
  const buf = foldAlerts(
    emptyBuffer(0),
    [
      mkAlert({ id: "idle:a" }),
      mkAlert({ id: "idle:b" }),
      mkAlert({ id: "stuck:c:silent-working", kind: "stuck" }),
    ],
    100,
  );
  assert.deepEqual(tally(buf), { idle: 2, stuck: 1 });
});

test("the rollup reads as a summary, with stuck leading", () => {
  const buf = foldAlerts(
    emptyBuffer(0),
    [
      mkAlert({ id: "idle:a" }),
      mkAlert({ id: "idle:b" }),
      mkAlert({ id: "idle:c" }),
      mkAlert({ id: "stuck:d:silent-working", kind: "stuck" }),
    ],
    100,
  );
  assert.equal(rollupLine(buf), "1 stuck · 3 finished");
});

test("the rollup pluralises", () => {
  const one = foldAlerts(emptyBuffer(0), [mkAlert({ id: "input:a", kind: "needs-input" })], 100);
  assert.equal(rollupLine(one), "1 needs you");
  const two = foldAlerts(
    one,
    [mkAlert({ id: "input:b", kind: "needs-input" })],
    100,
  );
  assert.equal(rollupLine(two), "2 need you");
});

test("digest lines lead with what needs you, not with what merely finished", () => {
  // A digest that buries the blocker under six finished sessions has failed.
  const buf = foldAlerts(
    emptyBuffer(0),
    [
      mkAlert({ id: "idle:a", title: "a went idle" }),
      mkAlert({ id: "idle:b", title: "b went idle" }),
      mkAlert({ id: "input:c", kind: "needs-input", title: "c needs you", severity: "attention" }),
      mkAlert({ id: "stuck:d:silent-working", kind: "stuck", title: "d looks stuck" }),
    ],
    100,
  );
  const lines = digestLines(buf);
  assert.match(lines[0]!, /d looks stuck/);
  assert.match(lines[1]!, /c needs you/);
});

test("digest lines show a repeat count and respect the limit", () => {
  let buf = foldAlerts(emptyBuffer(0), [mkAlert()], 100);
  buf = foldAlerts(buf, [mkAlert()], 200);
  assert.match(digestLines(buf)[0]!, /\(x2\)/);

  const many = foldAlerts(
    emptyBuffer(0),
    Array.from({ length: 20 }, (_, i) => mkAlert({ id: `idle:s${i}` })),
    100,
  );
  assert.equal(digestLines(many, 5).length, 5);
});

test("what doesn't fit is COUNTED, not silently dropped", () => {
  // Twelve lines that say nothing about the other eighteen read as "that's all that
  // happened" - the same reason `dropped` is surfaced at all.
  const buf = foldAlerts(
    emptyBuffer(0),
    Array.from({ length: 30 }, (_, i) => mkAlert({ id: `idle:s${i}` })),
    100,
  );
  const lines = digestLines(buf);
  assert.equal(lines.length, 12); // the cap stays a cap
  assert.equal(lines.at(-1), "+19 more"); // the 11 shown, and every one that isn't
});

test("a window that fits says nothing about overflow", () => {
  const buf = foldAlerts(
    emptyBuffer(0),
    Array.from({ length: 12 }, (_, i) => mkAlert({ id: `idle:s${i}` })),
    100,
  );
  assert.equal(digestLines(buf).length, 12);
  assert.doesNotMatch(digestLines(buf).join("\n"), /more/);
});

test("the raw event lines carry no overflow marker - the model must not narrate one", () => {
  // The digest prompt fences these as data and says every line is something that
  // happened, so a synthetic "+N more" in there reads to the model as an event.
  const buf = foldAlerts(
    emptyBuffer(0),
    Array.from({ length: 30 }, (_, i) => mkAlert({ id: `idle:s${i}` })),
    100,
  );
  const lines = eventLines(buf, 12);
  assert.equal(lines.length, 12);
  assert.doesNotMatch(lines.join("\n"), /more/);
});

// ---- merging two closed windows ----

test("merging two windows coalesces repeats across both", () => {
  const first = foldAlerts(emptyBuffer(0), [mkAlert()], 100);
  const second = foldAlerts(emptyBuffer(500), [mkAlert()], 600);
  const merged = mergeBuffers(first, second);
  assert.equal(merged.events.length, 1);
  assert.equal(merged.events[0]?.count, 2);
  assert.equal(merged.events[0]?.firstAt, 100);
  assert.equal(merged.events[0]?.lastAt, 600);
});

test("a merged window covers from the EARLIER window's start", () => {
  const merged = mergeBuffers(emptyBuffer(100), emptyBuffer(500));
  assert.equal(merged.since, 100);
});

test("merged away time is SUMMED, so the desk time between two breaks isn't billed as away", () => {
  const first = closeBuffer(emptyBuffer(0), 10 * 60_000);
  const second = closeBuffer(emptyBuffer(60 * 60_000), 70 * 60_000);
  assert.equal(mergeBuffers(first, second).awayMs, 20 * 60_000);
});

test("closing a window banks exactly what it covered", () => {
  assert.equal(closeBuffer(emptyBuffer(1000), 5000).awayMs, 4000);
  // An open window has banked nothing yet - callers measure it to now instead.
  assert.equal(emptyBuffer(1000).awayMs, 0);
});

test("folding events into an open window leaves its away time alone", () => {
  const buf = foldAlerts(closeBuffer(emptyBuffer(0), 4000), [mkAlert()], 100);
  assert.equal(buf.awayMs, 4000);
});

test("merging keeps distinct events from both windows, and their dropped counts", () => {
  const first = { ...foldAlerts(emptyBuffer(0), [mkAlert({ id: "idle:a" })], 100), dropped: 2 };
  const second = { ...foldAlerts(emptyBuffer(0), [mkAlert({ id: "idle:b" })], 200), dropped: 3 };
  const merged = mergeBuffers(first, second);
  assert.deepEqual(merged.events.map((e) => e.key).sort(), ["idle:a", "idle:b"]);
  assert.equal(merged.dropped, 5);
});

test("merging respects the buffer cap rather than growing without bound", () => {
  const full = foldAlerts(
    emptyBuffer(0),
    Array.from({ length: AWAY_BUFFER_CAP }, (_, i) => mkAlert({ id: `idle:a${i}` })),
    100,
  );
  const more = foldAlerts(emptyBuffer(0), [mkAlert({ id: "idle:new" })], 200);
  const merged = mergeBuffers(full, more);
  assert.equal(merged.events.length, AWAY_BUFFER_CAP);
  assert.equal(merged.dropped, 1);
});

test("the window the buffer covers survives folding", () => {
  const buf = foldAlerts(emptyBuffer(42), [mkAlert()], 100);
  assert.equal(buf.since, 42);
});
