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
  refreshAlerts,
  reconcileReports,
  rollupLine,
  tally,
} from "../src/shared/away-buffer.ts";
import { mkReport } from "./helpers/report-fixture.ts";
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

test("a refresh re-words an event WITHOUT counting it as happening again", () => {
  // The distinction the digest depends on: a stall that has been quiet for 40
  // minutes is one continuous stall described more accurately, not forty stalls.
  let buf = foldAlerts(
    emptyBuffer(0),
    [mkAlert({ id: "stuck:a:silent-working", kind: "stuck", body: "silent for 10m" })],
    100,
  );
  buf = refreshAlerts(buf, [
    mkAlert({ id: "stuck:a:silent-working", kind: "stuck", body: "silent for 40m" }),
  ]);
  assert.equal(buf.events.length, 1);
  assert.equal(buf.events[0]?.body, "silent for 40m");
  assert.equal(buf.events[0]?.count, 1);
  assert.deepEqual(digestLines(buf), ["auth went idle - silent for 40m"]);
});

test("a refresh leaves the event's own timestamps alone", () => {
  // lastAt means "when this last happened", and re-reading a stall is not it
  // happening again - the digest orders lines by it.
  let buf = foldAlerts(emptyBuffer(0), [mkAlert()], 100);
  buf = refreshAlerts(buf, [mkAlert({ body: "reworded" })]);
  assert.equal(buf.events[0]?.firstAt, 100);
  assert.equal(buf.events[0]?.lastAt, 100);
});

test("a refresh never INSERTS - a stall that cleared is not resurrected", () => {
  // refreshAlerts is fed the live stall set, so an event absent from it has
  // resolved. It must not be dragged back into a window it never belonged to.
  const buf = refreshAlerts(emptyBuffer(0), [mkAlert({ id: "stuck:b:silent-working" })]);
  assert.deepEqual(buf.events, []);
  assert.equal(hasAnything(buf), false);
});

test("an event nobody refreshed keeps the wording it had while it was real", () => {
  let buf = foldAlerts(emptyBuffer(0), [mkAlert({ body: "silent for 10m" })], 100);
  buf = refreshAlerts(buf, [mkAlert({ id: "idle:other", body: "something else" })]);
  assert.equal(buf.events[0]?.body, "silent for 10m");
});

test("refreshing against nothing returns the buffer untouched", () => {
  const buf = foldAlerts(emptyBuffer(0), [mkAlert()], 100);
  assert.equal(refreshAlerts(buf, []), buf);
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
      mkAlert({ id: "workflow:run:completed", kind: "workflow" }),
    ],
    100,
  );
  assert.deepEqual(tally(buf), { idle: 2, stuck: 1, workflow: 1 });
  assert.match(rollupLine(buf), /1 workflow update/);
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

// ---- Agent reports in the digest (`inbox` flag) ----
//
// While away a report does not interrupt; the return digest says how many are waiting and from
// whom, each name once, in the order its first report arrived.

const reportAlert = (id: string, agentName: string): Alert => mkAlert({
  id: `report:${id}`, kind: "report", title: `${agentName}'s back: ${id}`, body: "", agentName,
});

test("the reports rollup names who posted: one, two, three, and many", () => {
  let buf = foldAlerts(emptyBuffer(0), [reportAlert("r-1", "Steve")], 10);
  assert.equal(rollupLine(buf), "1 report waiting: Steve");
  buf = foldAlerts(buf, [reportAlert("r-2", "Carol")], 20);
  assert.equal(rollupLine(buf), "2 reports waiting: Steve and Carol");
  // A second report from the same agent counts, and names it once.
  buf = foldAlerts(buf, [reportAlert("r-3", "Steve")], 30);
  assert.equal(rollupLine(buf), "3 reports waiting: Steve and Carol");
  buf = foldAlerts(buf, [reportAlert("r-4", "Dana")], 40);
  assert.equal(rollupLine(buf), "4 reports waiting: Steve, Carol and Dana");
  buf = foldAlerts(buf, [reportAlert("r-5", "Eve"), reportAlert("r-6", "Finn")], 50);
  assert.equal(rollupLine(buf), "6 reports waiting: Steve, Carol and 3 others");
});

test("a waiting report changes its buffered attribution without counting another announcement", () => {
  const before = foldAlerts(emptyBuffer(0), [reportAlert("r-1", "Alice")], 10);
  const report = mkReport({ id: "r-1", author: { key: "session:a", name: "Check the parser", residentProfileId: null } });
  const updated = reconcileReports(before, [report], 20, false);
  assert.equal(rollupLine(updated), "1 report waiting: Check the parser");
  assert.equal(updated.events[0]?.lastAt, 10);
  assert.equal(updated.events[0]?.count, 1);
});

test("reports take their place in the rollup beside everything else, and keep their names across a merge", () => {
  const first = foldAlerts(emptyBuffer(0), [reportAlert("r-1", "Steve"), mkAlert({ id: "stuck:a", kind: "stuck", title: "a looks stuck", severity: "attention" })], 10);
  const second = foldAlerts(emptyBuffer(100), [reportAlert("r-2", "Carol"), mkAlert()], 110);
  assert.equal(rollupLine(mergeBuffers(closeBuffer(first, 50), second)), "1 stuck · 2 reports waiting: Steve and Carol · 1 finished");
});

test("the digest's reports are the reports waiting: read and replaced ones leave, unannounced ones join on close", () => {
  const author = (name: string) => ({ key: `session:${name}`, name, residentProfileId: null });
  // Buffered while away: Steve's and Carol's announcements.
  let buf = foldAlerts(emptyBuffer(1_000), [reportAlert("r-1", "Steve"), reportAlert("r-2", "Carol"), mkAlert()], 2_000);
  const steve = mkReport({ id: "r-1", createdAt: 1_500, author: author("Steve") });
  // Carol's was replaced by r-3, still in its grace period; Dana posted r-4 a moment ago; Erin's
  // r-5 was posted before you left and never announced, so it is not this window's.
  const carolNext = mkReport({ id: "r-3", createdAt: 2_500, rootId: "r-2", version: 2, author: author("Carol") });
  const dana = mkReport({ id: "r-4", createdAt: 2_800, title: "Late finding", author: author("Dana") });
  const erin = mkReport({ id: "r-5", createdAt: 500, author: author("Erin") });
  const waiting = [steve, carolNext, dana, erin];

  // While the window is open, only what left is pruned.
  const open = reconcileReports(buf, waiting, 3_000, false);
  assert.equal(rollupLine(open), "1 report waiting: Steve · 1 finished");
  // On close, what is waiting and was posted during the window joins, worded as posted.
  buf = reconcileReports(buf, waiting, 3_000, true);
  assert.equal(rollupLine(buf), "3 reports waiting: Steve, Carol and Dana · 1 finished");
  assert.ok(digestLines(buf).includes("Dana posted a report: Late finding - What I found."));
  // A report read since leaves.
  assert.equal(rollupLine(reconcileReports(buf, [carolNext, dana], 3_100, true)), "2 reports waiting: Carol and Dana · 1 finished");
  // The flag off: no reports at all, so every report event leaves and every other event stays.
  const off = reconcileReports(buf, [], 3_100, true);
  assert.equal(rollupLine(off), "1 finished");
  assert.deepEqual(off.events.map((e) => e.kind), ["idle"]);
});

test("a full buffer still counts every report waiting, and names who posted", () => {
  // Fill the buffer to its cap with other events before any report arrives.
  const others = Array.from({ length: AWAY_BUFFER_CAP }, (_, i) => mkAlert({ id: `idle:s${i}`, sessionId: `s${i}` }));
  let buf = foldAlerts(emptyBuffer(1_000), others, 2_000);
  assert.equal(buf.events.length, AWAY_BUFFER_CAP);
  // Another ordinary event is still turned away and counted as dropped.
  buf = foldAlerts(buf, [mkAlert({ id: "idle:extra", sessionId: "extra" })], 2_100);
  assert.equal(buf.dropped, 1);
  // A report announced into the full buffer is kept.
  buf = foldAlerts(buf, [reportAlert("r-1", "Steve")], 2_200);
  // One still in its grace period on return joins through reconciliation.
  const author = (name: string) => ({ key: `session:${name}`, name, residentProfileId: null });
  const waiting = [
    mkReport({ id: "r-1", createdAt: 1_500, author: author("Steve") }),
    mkReport({ id: "r-2", createdAt: 2_900, author: author("Carol") }),
  ];
  buf = reconcileReports(buf, waiting, 3_000, true);
  assert.equal(buf.dropped, 1, "reports took nothing from the dropped count");
  assert.match(rollupLine(buf), /^2 reports waiting: Steve and Carol · 200 finished · \+1 more$/);
  // A merge into another full window keeps them too.
  const full = foldAlerts(emptyBuffer(0), others.map((a) => ({ ...a, id: `${a.id}:older` })), 500);
  assert.match(rollupLine(mergeBuffers(closeBuffer(full, 900), buf)), /^2 reports waiting: Steve and Carol · /);
});

test("reports buffered first take no place from other events: the 200 others are all kept", () => {
  const reports = Array.from({ length: 5 }, (_, i) => reportAlert(`r-${i + 1}`, `Agent ${i + 1}`));
  const others = Array.from({ length: AWAY_BUFFER_CAP }, (_, i) => mkAlert({ id: `idle:s${i}`, sessionId: `s${i}` }));
  let buf = foldAlerts(emptyBuffer(0), reports, 100);
  buf = foldAlerts(buf, others, 200);
  assert.equal(buf.events.length, AWAY_BUFFER_CAP + 5);
  assert.equal(buf.dropped, 0, "every ordinary event fits, exactly as before reports existed");
  // The 201st ordinary event is the first turned away.
  buf = foldAlerts(buf, [mkAlert({ id: "idle:extra", sessionId: "extra" })], 300);
  assert.equal(buf.dropped, 1);
  // The same allowance across a merge: a window of reports alone does not shrink the other's room.
  const reportsOnly = foldAlerts(emptyBuffer(0), reports.map((r) => ({ ...r, id: `${r.id}-old` })), 50);
  const merged = mergeBuffers(closeBuffer(reportsOnly, 60), foldAlerts(emptyBuffer(100), others, 200));
  assert.equal(merged.dropped, 0);
  assert.equal(merged.events.length, AWAY_BUFFER_CAP + 5);
});
