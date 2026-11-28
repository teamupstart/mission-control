import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { REPORT_LIMITS } from "../src/shared/reports.ts";
import { withReportUpserted } from "../src/web/lib/report-state.ts";
import { mkReport } from "./helpers/report-fixture.ts";

// The dashboard holds only the reports waiting to be read. A long-open window sees every report
// posted and read for as long as it stays open, so a read or replaced report has to leave its
// state, or that state grows without bound and every attention fold walks all of it.

test("a report waiting to be read is stored, and a later version of it replaces the stored one", () => {
  const first = withReportUpserted(new Map(), mkReport({ id: "r-1" }));
  assert.deepEqual([...first.keys()], ["r-1"]);
  const opened = withReportUpserted(first, mkReport({ id: "r-1", openedAt: 5 }));
  assert.equal(opened.get("r-1")?.openedAt, 5);
  assert.equal(opened.size, 1);
});

test("a read report leaves the dashboard's state", () => {
  const held = withReportUpserted(withReportUpserted(new Map(), mkReport({ id: "r-1" })), mkReport({ id: "r-2" }));
  const after = withReportUpserted(held, mkReport({ id: "r-1", readAt: 9, readBy: "mark-read" }));
  assert.deepEqual([...after.keys()], ["r-2"]);
  assert.equal(held.size, 2, "the previous state is not mutated");
});

test("a replaced report leaves and its successor takes its place", () => {
  const held = withReportUpserted(new Map(), mkReport({ id: "r-1" }));
  // The daemon sends the replaced report first, then its successor.
  const replaced = withReportUpserted(held, mkReport({ id: "r-1", supersededBy: "r-2" }));
  const next = withReportUpserted(replaced, mkReport({ id: "r-2", rootId: "r-1", version: 2 }));
  assert.deepEqual([...next.keys()], ["r-2"]);
});

test("many reports posted and read while the window stays open leave nothing behind", () => {
  let state: ReadonlyMap<string, ReturnType<typeof mkReport>> = new Map();
  for (let n = 1; n <= 500; n++) {
    state = withReportUpserted(state, mkReport({ id: `r-${n}` }));
    state = withReportUpserted(state, mkReport({ id: `r-${n}`, readAt: n, readBy: "mark-read" }));
  }
  assert.equal(state.size, 0);
});

test("a read report the window never held changes nothing, so nothing re-renders", () => {
  const held = withReportUpserted(new Map(), mkReport({ id: "r-1" }));
  assert.equal(withReportUpserted(held, mkReport({ id: "r-9", readAt: 1, readBy: "mark-read" })), held);
});

test("the event stream applies report_upsert through withReportUpserted", () => {
  const source = readFileSync(new URL("../src/web/useEventStream.ts", import.meta.url), "utf8");
  assert.match(source, /case "report_upsert":\s*setReports\(\(prev\) => withReportUpserted\(prev, msg\.report\)\);/);
});

test("a report body is capped at its own 4,000 characters, not borrowed from the question limit", () => {
  assert.equal(REPORT_LIMITS.body, 4000);
  const source = readFileSync(new URL("../src/shared/reports.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /decision-asks|DECISION_CONTEXT_MAX_CHARS/);
});

test("markAllReportsRead sends each id once, in bounded batches, and stops at the first refused batch", async () => {
  const { markAllReportsRead } = await import("../src/web/lib/report-state.ts");
  const { REPORT_READ_ALL_BATCH } = await import("../src/shared/reports.ts");
  const ids = Array.from({ length: REPORT_READ_ALL_BATCH * 2 + 1 }, (_, n) => `r-${n + 1}`);
  const sent: string[][] = [];
  assert.equal(await markAllReportsRead([...ids, "r-1"], async (batch) => { sent.push(batch); return { ok: true }; }), null);
  assert.deepEqual(sent.map((batch) => batch.length), [REPORT_READ_ALL_BATCH, REPORT_READ_ALL_BATCH, 1]);
  assert.deepEqual(sent.flat(), ids, "each listed id once, in order");
  // A refused batch ends the press with its reason; later batches are not sent.
  const tried: number[] = [];
  const refused = await markAllReportsRead(ids, async (batch) => {
    tried.push(batch.length);
    return tried.length === 2 ? { ok: false, error: "nope" } : { ok: true };
  });
  assert.equal(refused, "nope");
  assert.equal(tried.length, 2);
  assert.equal(await markAllReportsRead([], async () => { throw new Error("nothing to send"); }), null);
});
