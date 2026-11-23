import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReportItem } from "../src/shared/reports.ts";
import type { AttentionFold } from "../src/web/lib/attention.ts";
import { placeReport, reportToShow, resolvedReport } from "../src/web/lib/report-notification.ts";
import { mkReport } from "./helpers/report-fixture.ts";

// What a click on a report notification opens (`inbox` flag). A notification outlives the state it
// was raised in: by the click, its report may have been read or replaced, reports may be unlisted
// by the setting, or (once Phase 7 merges) its author muted. The click always opens a report:
// the notified one, or the latest of its chain when it was replaced, in its row when the fold
// lists it and on its own above the sections when it does not, whatever the reason.

const byId = (...reports: ReportItem[]) => new Map(reports.map((r) => [r.id, r]));

/** A fold listing exactly these reports, as one author's Reports row. */
function foldListing(...reports: ReportItem[]): AttentionFold {
  return {
    items: reports.length === 0 ? [] : [{
      kind: "agent_reports", id: "agent-reports:session:s1", authorKey: "session:s1", authorName: "Fix the parser", reports,
    }],
    total: 0,
    toRead: reports.length,
  };
}
const EMPTY: AttentionFold = { items: [], total: 0, toRead: 0 };

test("a listed report opens in its row", () => {
  const report = mkReport({ id: "r-1" });
  assert.deepEqual(reportToShow("r-1", byId(report), foldListing(report)), { where: "row", report });
});

test("an unread report the fold does not list opens on its own: unlisted by the setting", () => {
  const report = mkReport({ id: "r-1" });
  // "Agent reports are listed in the inbox" off: the fold carries no Reports row at all.
  assert.deepEqual(reportToShow("r-1", byId(report), EMPTY), { where: "band", report });
});

test("an unread report the fold omits for a reason it is not told still opens on its own", () => {
  // Phase 7's mute leaves other authors listed and this one out; the rule never asks why.
  const report = mkReport({ id: "r-1", sessionId: "s-muted", author: { key: "session:s-muted", name: "Muted", residentProfileId: null } });
  const other = mkReport({ id: "r-2" });
  assert.deepEqual(reportToShow("r-1", byId(report, other), foldListing(other)), { where: "band", report });
});

test("a report already read opens on its own; one this window no longer holds is fetched", () => {
  const read = mkReport({ id: "r-1", readAt: 5, readBy: "mark-read" });
  assert.deepEqual(reportToShow("r-1", byId(read), EMPTY), { where: "band", report: read });
  assert.deepEqual(reportToShow("r-1", byId(), EMPTY), { where: "fetch" });
});

test("an unknown id is fetched, and a fetch that resolves places like any other report", () => {
  assert.deepEqual(reportToShow("r-404", byId(mkReport({ id: "r-1" })), EMPTY), { where: "fetch" });
  const fetched = mkReport({ id: "r-404", readAt: 5, readBy: "mark-read" });
  assert.deepEqual(placeReport(resolvedReport({ report: fetched, latest: null }, byId()), EMPTY), { where: "band", report: fetched });
});

test("replaced once: the replacement opens, in its row", () => {
  const first = mkReport({ id: "r-1", supersededBy: "r-2" });
  const second = mkReport({ id: "r-2", rootId: "r-1", version: 2 });
  assert.deepEqual(reportToShow("r-1", byId(first, second), foldListing(second)), { where: "row", report: second });
});

test("replaced twice: the latest of the chain opens, not the middle one", () => {
  const first = mkReport({ id: "r-1", supersededBy: "r-2" });
  const middle = mkReport({ id: "r-2", rootId: "r-1", version: 2, supersededBy: "r-3" });
  const latest = mkReport({ id: "r-3", rootId: "r-1", version: 3 });
  assert.deepEqual(reportToShow("r-1", byId(first, middle, latest), foldListing(latest)), { where: "row", report: latest });
  // A chain link this window never saw is resolved by the daemon, which answers with the latest.
  assert.deepEqual(reportToShow("r-1", byId(first), foldListing(latest)), { where: "fetch" });
  const answer = { report: first, latest };
  assert.deepEqual(placeReport(resolvedReport(answer, byId(latest)), foldListing(latest)), { where: "row", report: latest });
});

test("replaced, with the replacement already read: the replacement opens on its own", () => {
  const first = mkReport({ id: "r-1", supersededBy: "r-2" });
  const second = mkReport({ id: "r-2", rootId: "r-1", version: 2, readAt: 9, readBy: "mark-read" });
  assert.deepEqual(reportToShow("r-1", byId(first, second), EMPTY), { where: "band", report: second });
});

test("a fetched report defers to this window's newer copy of it", () => {
  const fetched = mkReport({ id: "r-2" });
  const held = mkReport({ id: "r-2", openedAt: 7 });
  assert.equal(resolvedReport({ report: fetched, latest: null }, byId(held)), held);
});

test("a replacement that reaches the window while the lookup is in flight is the one that opens", () => {
  // The lookup answered with version 2; version 3 then replaced it and reached this window before
  // the answer was handled. The window's copy of version 2 now points at version 3.
  const first = mkReport({ id: "r-1", supersededBy: "r-2" });
  const answeredLatest = mkReport({ id: "r-2", rootId: "r-1", version: 2 });
  const heldSecond = mkReport({ id: "r-2", rootId: "r-1", version: 2, supersededBy: "r-3" });
  const third = mkReport({ id: "r-3", rootId: "r-1", version: 3 });
  const opened = resolvedReport({ report: first, latest: answeredLatest }, byId(heldSecond, third));
  assert.equal(opened, third);
  assert.deepEqual(placeReport(opened, foldListing(third)), { where: "row", report: third });
  // A replacement the window has not heard of yet cannot be followed; the last link held opens.
  assert.equal(resolvedReport({ report: first, latest: answeredLatest }, byId(heldSecond)), heldSecond);
});

test("joined to the mute: a muted author's unread report opens in the band, and after Unmute in its row", async () => {
  const { foldAttention } = await import("../src/web/lib/attention.ts");
  const muted = mkReport({ id: "r-1", sessionId: "s-loud", author: { key: "session:s-loud", name: "Loud", residentProfileId: null } });
  const other = mkReport({ id: "r-2" });
  const fold = (mutedAuthors: ReadonlySet<string>) =>
    foldAttention({ sessions: [], reviews: [], ensembles: [], reports: [muted, other], mutedAuthors });
  // Muted after its notification arrived: the fold no longer lists it, so the click draws it alone,
  // unread, and the figure counts only the other author's report.
  const whileMuted = fold(new Set(["session:s-loud"]));
  assert.equal(whileMuted.toRead, 1);
  assert.deepEqual(reportToShow("r-1", byId(muted, other), whileMuted), { where: "band", report: muted });
  assert.equal(muted.readAt, null, "a mute never marks it read");
  // Unmuted: listed again, so the same click opens its row.
  const unmuted = fold(new Set());
  assert.equal(unmuted.toRead, 2);
  assert.deepEqual(reportToShow("r-1", byId(muted, other), unmuted), { where: "row", report: muted });
});
