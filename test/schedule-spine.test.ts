import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendSpineHistoryBridge,
  createSpineHistoryWindow,
} from "../src/web/lib/spine-history.ts";
import { buildSpineRows, type SpineRow } from "../src/web/lib/spine.ts";
import { mkOccurrence } from "./helpers/schedule-fixture.ts";

/**
 * The one thing the Recurring Missions surface DERIVES rather than reads.
 *
 * Everything else on that screen was decided by the daemon - the instants, the statuses,
 * the delays, the health - and the browser only spells it. The spine's rail is the
 * exception: where it BREAKS is a reading of the occurrence ledger, and the claim that
 * reading makes to an operator ("this occurrence waited 7h 20m") is the feature's central
 * honesty promise made visual. Mission Control runs on a laptop that sleeps and explicitly
 * does not promise wall-clock execution; a gap drawn in the wrong place, or one that appears
 * where the ledger says a run happened on time, turns that promise into a lie on screen.
 *
 * So what is pinned here is the boundary: a gap is derived from persisted columns only
 * (`scheduledFor`, `claimedAt`, `coveredById`) and never from an inference about what the
 * daemon was doing.
 */

const HOUR = 3_600_000;
const T0 = 1_753_600_000_000;

function kinds(rows: SpineRow[]): string[] {
  return rows.map((row) => row.kind);
}

test("an on-time ledger draws one unbroken rail", () => {
  const rows = buildSpineRows({
    occurrences: [
      mkOccurrence({ id: "a", scheduledFor: T0, claimedAt: T0, delayMs: 0 }),
      mkOccurrence({ id: "b", scheduledFor: T0 + 24 * HOUR, claimedAt: T0 + 24 * HOUR, delayMs: 0 }),
    ],
    now: T0 + 30 * HOUR,
    instants: [],
    stopReason: null,
  });
  assert.deepEqual(kinds(rows), ["past", "past", "now"]);
});

test("a delay too small to mean anything does not break the rail", () => {
  // `delayIsLate`'s one-minute band decides whether ONE run wears a late chip. A break is a
  // far louder claim - that an occurrence waited unclaimed for a window - and spending it on
  // two minutes of scheduler latency is how the signature stops meaning anything.
  const rows = buildSpineRows({
    occurrences: [
      mkOccurrence({ id: "a", scheduledFor: T0, claimedAt: T0 + 2 * 60_000, delayMs: 2 * 60_000 }),
    ],
    now: T0 + HOUR,
    instants: [],
    stopReason: null,
  });
  assert.deepEqual(kinds(rows), ["past", "now"]);
});

test("a late claim breaks the rail across the window it was actually unclaimed for", () => {
  const rows = buildSpineRows({
    occurrences: [
      mkOccurrence({
        id: "late",
        scheduledFor: T0,
        claimedAt: T0 + 7 * HOUR + 20 * 60_000,
        delayMs: 7 * HOUR + 20 * 60_000,
      }),
    ],
    now: T0 + 30 * HOUR,
    instants: [],
    stopReason: null,
  });
  assert.deepEqual(kinds(rows), ["gap", "past", "now"]);
  const gap = rows[0];
  assert.equal(gap?.kind, "gap");
  if (gap?.kind !== "gap") return;
  // The window is the occurrence's own two columns. Nothing wider, nothing invented.
  assert.equal(gap.from, T0);
  assert.equal(gap.to, T0 + 7 * HOUR + 20 * 60_000);
  assert.deepEqual(gap.waiting.map((entry) => entry.id), ["late"]);
  assert.deepEqual(gap.missed, []);
});

test("coalesced instants sit inside the covering run's gap, not in the main sequence", () => {
  // The ledger names its own folding (`coveredById`). Left in the sequence they would read
  // as three separate runs, two of which never happened.
  const covered = mkOccurrence({
    id: "missed-1",
    scheduledFor: T0,
    claimedAt: T0 + 8 * HOUR,
    delayMs: 8 * HOUR,
    status: "coalesced",
    coveredById: "resume",
    taskId: null,
  });
  const rows = buildSpineRows({
    occurrences: [
      covered,
      mkOccurrence({
        id: "resume",
        scheduledFor: T0 + 24 * HOUR,
        claimedAt: T0 + 24 * HOUR + 60_000,
        delayMs: 60_000,
      }),
    ],
    now: T0 + 30 * HOUR,
    instants: [],
    stopReason: null,
  });
  assert.deepEqual(kinds(rows), ["gap", "past", "now"]);
  const gap = rows[0];
  if (gap?.kind !== "gap") throw new Error("expected a gap");
  assert.deepEqual(
    gap.missed.map((entry) => entry.id),
    ["missed-1"],
  );
  // The window opens at the EARLIEST instant that came due, not at the covering run's own.
  assert.equal(gap.from, T0);
  assert.equal(gap.to, T0 + 24 * HOUR + 60_000);
  // The covering run's own delay (1m) is far below SPINE_GAP_MS, and it still gets a gap:
  // the ledger recording that it folded instants away IS the evidence, not the duration.
  const past = rows[1];
  if (past?.kind !== "past") throw new Error("expected a past run");
  assert.equal(past.occurrence.id, "resume");
});

test("one catch-up claim produces one gap for every due instant it accounts for", () => {
  const claimedAt = T0 + 8 * HOUR;
  const rows = buildSpineRows({
    occurrences: [
      mkOccurrence({
        id: "first",
        scheduledFor: T0,
        claimedAt,
        delayMs: 8 * HOUR,
        status: "created",
      }),
      mkOccurrence({
        id: "second",
        scheduledFor: T0 + HOUR,
        claimedAt,
        delayMs: 7 * HOUR,
        status: "skipped_overlap",
      }),
      mkOccurrence({
        id: "third",
        scheduledFor: T0 + 2 * HOUR,
        claimedAt,
        delayMs: 6 * HOUR,
        status: "skipped_overlap",
      }),
    ],
    now: T0 + 10 * HOUR,
    instants: [],
    stopReason: null,
  });
  assert.deepEqual(kinds(rows), ["gap", "past", "past", "past", "now"]);
  const gap = rows[0];
  if (gap?.kind !== "gap") throw new Error("expected a gap");
  assert.equal(gap.from, T0);
  assert.equal(gap.to, claimedAt);
  assert.deepEqual(gap.waiting.map((entry) => entry.id), ["first", "second", "third"]);
});

test("history arrives newest first and the axis still reads oldest to newest", () => {
  // The paged route returns descending order. Drawn in that order every gap would be
  // attached to the run on the wrong side of it.
  const rows = buildSpineRows({
    occurrences: [
      mkOccurrence({ id: "newer", scheduledFor: T0 + 24 * HOUR, claimedAt: T0 + 24 * HOUR }),
      mkOccurrence({ id: "older", scheduledFor: T0, claimedAt: T0 }),
    ],
    now: T0 + 30 * HOUR,
    instants: [],
    stopReason: null,
  });
  const ids = rows.filter((row) => row.kind === "past").map((row) => row.occurrence.id);
  assert.deepEqual(ids, ["older", "newer"]);
});

test("a deep-linked target keeps an explicit break until newest history connects", () => {
  const occurrence = (index: number) =>
    mkOccurrence({
      id: `occ-${index}`,
      scheduledFor: T0 + index * HOUR,
      claimedAt: T0 + index * HOUR,
    });
  const range = (from: number, through: number) =>
    Array.from({ length: from - through + 1 }, (_, offset) => occurrence(from - offset));

  let window = createSpineHistoryWindow(
    { occurrences: range(100, 76), nextCursor: T0 + 76 * HOUR },
    { occurrences: range(20, 0), nextCursor: null },
  );
  assert.equal(window.bridgeTargetAt, T0 + 20 * HOUR);
  assert.equal(window.bridgeBefore, T0 + 76 * HOUR);
  assert.equal(window.bridgeCursor, T0 + 76 * HOUR);

  window = appendSpineHistoryBridge(window, {
    occurrences: range(75, 51),
    nextCursor: T0 + 51 * HOUR,
  });
  window = appendSpineHistoryBridge(window, {
    occurrences: range(50, 26),
    nextCursor: T0 + 26 * HOUR,
  });
  assert.equal(window.bridgeTargetAt, T0 + 20 * HOUR);
  assert.equal(window.bridgeBefore, T0 + 26 * HOUR);

  window = appendSpineHistoryBridge(window, {
    occurrences: range(25, 1),
    nextCursor: T0 + HOUR,
  });
  assert.equal(window.bridgeTargetAt, null);
  assert.equal(window.bridgeBefore, null);
  assert.equal(window.bridgeCursor, null);
  assert.equal(new Set(window.occurrences.map((entry) => entry.id)).size, 101);
});

test("a refreshed catch-up window resets pagination beyond the newest 25 rows", () => {
  const occurrence = (index: number, status: "claimed" | "created" = "created") =>
    mkOccurrence({
      id: `catch-up-${index}`,
      scheduledFor: T0 + index * HOUR,
      claimedAt: T0 + 50 * HOUR,
      status,
    });
  const old = createSpineHistoryWindow({
    occurrences: Array.from({ length: 10 }, (_, index) =>
      occurrence(index, index === 0 ? "claimed" : "created"),
    ),
    nextCursor: null,
  });
  assert.equal(old.olderDone, true);
  assert.equal(old.occurrences.find((entry) => entry.id === "catch-up-0")?.status, "claimed");

  const refreshed = createSpineHistoryWindow({
    occurrences: Array.from({ length: 25 }, (_, offset) => occurrence(50 - offset)),
    nextCursor: T0 + 26 * HOUR,
  });
  assert.equal(refreshed.occurrences.length, 25);
  assert.equal(refreshed.olderDone, false);
  assert.equal(refreshed.olderCursor, T0 + 26 * HOUR);
  assert.equal(refreshed.occurrences.some((entry) => entry.id === "catch-up-0"), false);

  const recovered = createSpineHistoryWindow({
    occurrences: [occurrence(0, "created")],
    nextCursor: null,
  });
  assert.equal(recovered.occurrences[0]?.status, "created");
});

test("an unloaded history range is a row on the axis", () => {
  const rows = buildSpineRows({
    occurrences: [
      mkOccurrence({ id: "target", scheduledFor: T0, claimedAt: T0 }),
      mkOccurrence({ id: "newest", scheduledFor: T0 + 10 * HOUR, claimedAt: T0 + 10 * HOUR }),
    ],
    now: T0 + 11 * HOUR,
    instants: [],
    stopReason: null,
    historyBreak: { after: T0, before: T0 + 10 * HOUR },
  });
  assert.deepEqual(kinds(rows), ["past", "unloaded", "past", "now"]);
});

test("a mission with no future draws the reason instead of instants it will not act on", () => {
  const rows = buildSpineRows({
    occurrences: [],
    now: T0,
    instants: [
      { at: T0 + HOUR, offsetMinutes: 0, dstShift: false },
      { at: T0 + 2 * HOUR, offsetMinutes: 0, dstShift: false },
    ],
    stopReason: "Paused. No further occurrence is scheduled until it is resumed.",
  });
  assert.deepEqual(kinds(rows), ["now", "stop"]);
  const stop = rows[1];
  if (stop?.kind !== "stop") throw new Error("expected a stop");
  assert.match(stop.reason, /Paused/);
});

test("the future half starts below NOW, whatever the daemon enumerated", () => {
  // The preview is computed against the daemon's clock; an instant already behind ours is
  // history's business or nobody's, and must never render under the NOW marker.
  const rows = buildSpineRows({
    occurrences: [],
    now: T0 + 90 * 60_000,
    instants: [
      { at: T0, offsetMinutes: -240, dstShift: false },
      { at: T0 + 2 * HOUR, offsetMinutes: -240, dstShift: false },
      { at: T0 + 3 * HOUR, offsetMinutes: -300, dstShift: true },
    ],
    stopReason: null,
    collisionsByInstant: new Map([[T0 + 2 * HOUR, ["Dependency audit"]]]),
  });
  assert.deepEqual(kinds(rows), ["now", "future", "future"]);
  const first = rows[1];
  if (first?.kind !== "future") throw new Error("expected a future row");
  assert.equal(first.at, T0 + 2 * HOUR);
  assert.deepEqual(first.collisions, ["Dependency audit"]);
  const second = rows[2];
  if (second?.kind !== "future") throw new Error("expected a future row");
  assert.equal(second.dstShift, true, "a DST transition stays flagged on the axis");
});
