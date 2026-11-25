/**
 * What is at stake: a reply reaches the agent as a message that names the report it answers and
 * restates it, so the agent can act on the reply without remembering the report; the card offers
 * the answer the agent can take now; and every version of every report has an entry in its
 * conversation where it was posted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  followUpIntent,
  followUpKind,
  followUpTitle,
  replyRefusal,
  replyTarget,
  reportAgeText,
  reportEntryStatus,
  reportReplyText,
  resolveMarkReadTarget,
  unseenReportsNote,
  type ReplyTargetSession,
} from "../src/shared/reports.ts";
import { mergeConversation } from "../src/web/lib/episodes.ts";
import { TASK_KINDS } from "../src/shared/types.ts";
import { isShippingTaskKind } from "../src/shared/task.ts";
import { liveReportsKey, sessionReportsFor } from "../src/web/lib/sessionReports.ts";
import { transcriptRows } from "../src/web/lib/tools.ts";
import type { Session, TranscriptMessage } from "../src/shared/types.ts";
import { mkReport } from "./helpers/report-fixture.ts";
import { mkSession, mkTaskSummary } from "./helpers/session-fixture.ts";

const MINUTE = 60_000;

test("a reply names its report, says how long ago it was posted, restates it, then gives the words", () => {
  const report = mkReport({ id: "r-42", title: "Build failure diagnosed", body: "  The cache key ignored the lockfile.\n", createdAt: 1_000 });
  const text = reportReplyText(report, "  Good. Fix it and open a PR.  ", 1_000 + 12 * MINUTE + 5_000);
  assert.equal(
    text,
    [
      "Reply to your report 'Build failure diagnosed' (r-42), posted 12 minutes ago.",
      "",
      "Your report:",
      "Build failure diagnosed",
      "",
      "The cache key ignored the lockfile.",
      "",
      "Your operator's reply:",
      "Good. Fix it and open a PR.",
    ].join("\n"),
  );
  assert.ok(text.startsWith("Reply to your report"));
});

test("a report's age reads in the largest whole unit", () => {
  assert.equal(reportAgeText(0, 30_000), "just now");
  assert.equal(reportAgeText(0, MINUTE), "1 minute ago");
  assert.equal(reportAgeText(0, 59 * MINUTE), "59 minutes ago");
  assert.equal(reportAgeText(0, 60 * MINUTE), "1 hour ago");
  assert.equal(reportAgeText(0, 5 * 60 * MINUTE), "5 hours ago");
  assert.equal(reportAgeText(0, 49 * 60 * MINUTE), "2 days ago");
  // A clock behind the report's stamp never reads as a negative age.
  assert.equal(reportAgeText(10 * MINUTE, 0), "just now");
});

test("the unseen-reports note names only reports still waiting to be read, or is null", () => {
  assert.equal(unseenReportsNote([]), null);
  assert.equal(unseenReportsNote([mkReport({ id: "r-1", readAt: 5, readBy: "mark-read" })]), null);
  assert.equal(unseenReportsNote([mkReport({ id: "r-1", supersededBy: "r-2" })]), null);
  assert.equal(
    unseenReportsNote([mkReport({ id: "r-2", title: "Done" })]),
    "Your operator has not read your report r-2 'Done' yet.",
  );
  assert.equal(
    unseenReportsNote([
      mkReport({ id: "r-1", title: "Old", supersededBy: "r-2" }),
      mkReport({ id: "r-2", title: "Done" }),
      mkReport({ id: "r-3", title: "Also done" }),
    ]),
    "Your operator has not read 2 of your reports yet: r-2 'Done', r-3 'Also done'.",
  );
});

test("mark read means the open report, else the author's only unread report, else none", () => {
  const steve = { key: "resident:steve", name: "Steve", residentProfileId: "steve" };
  const ana = { key: "session:s9", name: "Ana", residentProfileId: null };
  const a = mkReport({ id: "r-1", author: steve });
  const b = mkReport({ id: "r-2", author: steve });
  const other = mkReport({ id: "r-3", author: ana });
  const read = mkReport({ id: "r-4", author: steve, readAt: 1, readBy: "reply" });
  assert.equal(resolveMarkReadTarget(steve.key, [a, b, other], "r-2"), b, "the open report wins");
  assert.equal(resolveMarkReadTarget(steve.key, [a, b, other], null), null, "two unread and none open is ambiguous");
  assert.equal(resolveMarkReadTarget(steve.key, [a, other, read], null), a, "the only unread report");
  assert.equal(resolveMarkReadTarget(steve.key, [a, other], "r-3"), a, "another agent's open report is not this one's");
  assert.equal(resolveMarkReadTarget(steve.key, [read], "r-4"), null, "a read report is no target");
  assert.equal(resolveMarkReadTarget(ana.key, [a, b], null), null);
});

// ---- where a reply can go ----

/** A driver session, which can always take a message while it is not exited. */
function session(over: Partial<Session> & { id: string }): ReplyTargetSession {
  return mkSession({ runtime: "sdk", terminals: [], state: "idle", task: null, ...over });
}

test("a live poster takes the reply, busy or not; an exited one does not", () => {
  const report = mkReport({ id: "r-1", sessionId: "s1", repository: "/repo" });
  assert.deepEqual(replyTarget(report, [session({ id: "s1" })], []), { kind: "live", sessionId: "s1" });
  assert.deepEqual(replyTarget(report, [session({ id: "s1", state: "working" })], []), { kind: "live", sessionId: "s1" });
  assert.deepEqual(replyTarget(report, [session({ id: "s1", state: "exited" })], []), { kind: "gone" });
  assert.deepEqual(replyTarget(report, [], []), { kind: "gone" });
});

test("a running session that cannot take a message is unreachable, never gone: no follow-up replaces it", () => {
  const report = mkReport({ id: "r-1", sessionId: "s1", repository: "/repo" });
  // A terminal session with no pane to write to cannot take a message, but it has not ended.
  const paneless = session({ id: "s1", runtime: "terminal", terminals: [] });
  assert.deepEqual(replyTarget(report, [paneless], []), { kind: "unreachable", sessionId: "s1" });
  // Once it has exited it is gone, and only then may a follow-up be started.
  assert.deepEqual(replyTarget(report, [{ ...paneless, state: "exited" }], []), { kind: "gone" });
  assert.match(replyRefusal({ kind: "unreachable", sessionId: "s1" }, "Ana"), /^Ana's session is still running but cannot take a message/);
});

test("a gone session whose report stored no repository cannot be followed up from the card", () => {
  assert.deepEqual(replyTarget(mkReport({ id: "r-1", repository: null }), [], []), { kind: "gone-no-repository" });
});

test("a resident's reply reaches whichever run is up now, and says it isn't running otherwise", () => {
  const author = { key: "resident:steve", name: "Steve", residentProfileId: "steve" };
  const report = mkReport({ id: "r-1", sessionId: "old-run", author, repository: "/ws" });
  const relaunched = session({ id: "new-run", task: mkTaskSummary({ id: "t-new" }) });
  assert.deepEqual(
    replyTarget(report, [relaunched], [{ profileId: "steve", taskId: "t-new" }]),
    { kind: "live", sessionId: "new-run" },
  );
  assert.deepEqual(replyTarget(report, [relaunched], []), { kind: "resident-not-running" });
  assert.deepEqual(replyTarget(report, [], [{ profileId: "steve", taskId: "t-new" }]), { kind: "resident-not-running" });
  // Never a follow-up for a resident, repository or not.
  assert.deepEqual(replyTarget({ ...report, repository: null }, [], []), { kind: "resident-not-running" });
});

test("the refusal for each target that is not live says what to do instead", () => {
  assert.match(replyRefusal({ kind: "resident-not-running" }, "Steve"), /^Steve isn't running\. Launch it again from the Residents drawer/);
  assert.match(replyRefusal({ kind: "gone" }, "x"), /never resumed\. Start a follow-up task/);
  assert.match(replyRefusal({ kind: "gone-no-repository" }, "x"), /no repository/);
});

test("a follow-up's intent is the operator's words, then the report as context", () => {
  const report = mkReport({
    id: "r-9", title: "Flaky test traced", body: "It races the clock.", url: "https://example.com/x",
    document: { name: "trace.md", kind: "markdown" },
  });
  const intent = followUpIntent(report, "  Fix it.  ");
  assert.ok(intent.startsWith("Fix it.\n"));
  assert.match(intent, /follows up a report \(r-9\) that Fix the parser posted before its session ended/);
  assert.match(intent, /not resumed/);
  assert.match(intent, /Report: Flaky test traced\n\nIt races the clock\./);
  assert.match(intent, /Link: https:\/\/example\.com\/x/);
  assert.match(intent, /Attached document: trace\.md/);
  assert.equal(followUpTitle(report), "Follow up: Flaky test traced");
  assert.ok(followUpTitle(mkReport({ id: "r-1", title: "x".repeat(200) })).length <= 200);
});

test("a follow-up keeps the report's task kind when it can be filed as one, and is ship otherwise", () => {
  for (const kind of TASK_KINDS) assert.equal(followUpKind(kind), isShippingTaskKind(kind) ? kind : "ship");
  assert.equal(followUpKind("bugfix"), "bugfix");
  assert.equal(followUpKind("plan"), "ship");
  assert.equal(followUpKind(undefined), "ship");
});

// ---- the conversation entry ----

test("an entry says how its report stands: waiting, replaced, or how it was cleared", () => {
  assert.equal(reportEntryStatus(mkReport({ id: "r-1" })), "Waiting to be read");
  assert.equal(reportEntryStatus(mkReport({ id: "r-1", supersededBy: "r-2" })), "Replaced by a later version");
  assert.equal(reportEntryStatus(mkReport({ id: "r-1", readAt: 1, readBy: "mark-read" })), "Read");
  assert.equal(reportEntryStatus(mkReport({ id: "r-1", readAt: 1, readBy: "reply" })), "Replied to");
  assert.equal(reportEntryStatus(mkReport({ id: "r-1", readAt: 1, readBy: "follow-up" })), "Followed up in a new task");
  assert.equal(reportEntryStatus(mkReport({ id: "r-1", readAt: 1, readBy: "mark-all" })), "Read, with Mark all read");
});

test("a conversation's reports union the history with the live stream, one session's, oldest first", () => {
  const stored = [
    mkReport({ id: "r-1", sessionId: "s1", createdAt: 10, supersededBy: "r-3" }),
    mkReport({ id: "r-2", sessionId: "other", createdAt: 11 }),
    mkReport({ id: "r-3", sessionId: "s1", createdAt: 30 }),
  ];
  // The live copy of r-3 is newer: it has since been replied to.
  const live = [mkReport({ id: "r-3", sessionId: "s1", createdAt: 30, readAt: 40, readBy: "reply" }), mkReport({ id: "r-4", sessionId: "s1", createdAt: 20 })];
  const merged = sessionReportsFor("s1", stored, live);
  assert.deepEqual(merged.map((r) => r.id), ["r-1", "r-4", "r-3"]);
  assert.equal(merged.find((r) => r.id === "r-3")!.readBy, "reply");
});

test("the conversation rereads its history whenever this session's live reports change", () => {
  const waiting = mkReport({ id: "r-1", sessionId: "s1" });
  const other = mkReport({ id: "r-9", sessionId: "s2" });
  const key = liveReportsKey("s1", [waiting, other]);
  // The stream drops a report once it is read or replaced: its leaving changes the key, which is
  // what makes the entry reread and show "Replied to" or "Followed up".
  assert.notEqual(liveReportsKey("s1", [other]), key);
  // A new report, or a follow-up task recorded on a waiting one, changes it too.
  assert.notEqual(liveReportsKey("s1", [waiting, mkReport({ id: "r-2", sessionId: "s1" }), other]), key);
  assert.notEqual(liveReportsKey("s1", [{ ...waiting, followUpTaskId: "t-1" }, other]), key);
  // Another session's reports, and the order they arrive in, do not.
  assert.equal(liveReportsKey("s1", [other, waiting, mkReport({ id: "r-8", sessionId: "s3" })]), key);
});

const turn = (id: string, ts: number): TranscriptMessage => ({ id, role: "assistant", text: `turn ${id}`, tools: [], ts });

test("every version of every report is an entry where it was posted, among the turns", () => {
  const rows = transcriptRows([turn("a", 100), turn("b", 300), turn("c", 500)]);
  const reports = [
    mkReport({ id: "r-1", createdAt: 200, supersededBy: "r-2" }),
    mkReport({ id: "r-2", createdAt: 400, version: 2, rootId: "r-1" }),
  ];
  const merged = mergeConversation(rows, [], [], [], {}, reports);
  assert.deepEqual(
    merged.map((r) => (r.kind === "report" ? `report:${r.report.id}` : r.kind === "turn" ? r.id : r.kind)),
    ["a", "report:r-1", "b", "report:r-2", "c"],
  );
  // With nothing to interleave the transcript is returned as it was.
  assert.equal(mergeConversation(rows, [], [], [], {}, []), rows);
});

test("a report card's draft is kept by chain outside React state, so a replacement keeps it", async () => {
  const { reportDraft, setReportDraft, clearReportDraft } = await import("../src/web/lib/reportDrafts.ts");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { ReportCard } = await import("../src/web/components/ReportCard.tsx");
  const { reportCardProps } = await import("./helpers/report-fixture.ts");
  setReportDraft("r-1", "Add the index.");
  assert.equal(reportDraft("r-1"), "Add the index.");
  // The replacement (r-2 of chain r-1) reads the same draft in its box.
  const replacement = mkReport({ id: "r-2", rootId: "r-1", version: 2, author: { key: "session:s1", name: "Steve", residentProfileId: null } });
  const html = renderToStaticMarkup(createElement(ReportCard, { report: replacement, open: true, ...reportCardProps(), now: 1 }));
  assert.match(html, /<textarea[^>]*>Add the index\.<\/textarea>/);
  // Another chain is untouched, and clearing removes the entry.
  assert.equal(reportDraft("r-9"), "");
  clearReportDraft("r-1");
  assert.equal(reportDraft("r-1"), "");
});

test("a draft store change notifies once, and an unchanged value notifies nobody", async () => {
  const { setReportDraft, clearReportDraft, subscribeReportDrafts } = await import("../src/web/lib/reportDrafts.ts");
  let notified = 0;
  const stop = subscribeReportDrafts(() => { notified += 1; });
  try {
    setReportDraft("r-5", "first");
    assert.equal(notified, 1);
    setReportDraft("r-5", "first");
    assert.equal(notified, 1, "the same value is no change");
    clearReportDraft("r-5");
    assert.equal(notified, 2);
    clearReportDraft("r-5");
    assert.equal(notified, 2, "clearing an absent draft is no change");
  } finally {
    stop();
  }
  setReportDraft("r-6", "after");
  assert.equal(notified, 2, "an unsubscribed listener hears nothing");
  clearReportDraft("r-6");
});
