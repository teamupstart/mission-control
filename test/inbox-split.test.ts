/**
 * The unified split inbox (`inbox-split` preview flag): which entries the list holds, in what
 * order and under which tab, and which entry opens when the selected one is settled and leaves.
 * The browser behaviour (selecting, moving on, the narrow layout) is `e2e/specs/inbox-split.spec.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReviewItem } from "../src/shared/types.ts";
import { foldAttention } from "../src/web/lib/attention.ts";
import {
  entryReport,
  entriesForTab,
  inboxSplitEntries,
  inboxSplitTabCounts,
  initialSplitKey,
  entryHoldsReport,
  nextSplitSelection,
  reportSyncKey,
  reportToToggle,
  stepKey,
  successorKey,
  type SplitSelection,
} from "../src/web/lib/inbox-split.ts";
import { mkReport, mkReportControls } from "./helpers/report-fixture.ts";
import { mkEnsembleSummary, mkSession } from "./helpers/session-fixture.ts";

function review(over: Partial<ReviewItem> & { id: string; sessionId: string }): ReviewItem {
  return {
    kind: "input",
    title: "Which parser?",
    body: "Which parser should I use?",
    status: "pending",
    response: null,
    createdAt: 1000,
    resolvedAt: null,
    ...over,
  };
}

function busyFold() {
  const asking = mkSession({ id: "s-ask", name: "Asking" });
  return foldAttention({
    sessions: [asking],
    reviews: [
      review({ id: "q-1", sessionId: "s-ask", title: "Which linter?" }),
      review({ id: "q-2", sessionId: "s-ask", title: "Approve the plan?", createdAt: 2000 }),
    ],
    ensembles: [
      mkEnsembleSummary({ id: "run-decide", status: "awaiting_decision" }),
      mkEnsembleSummary({ id: "run-stuck", status: "finalizing", error: "ref vanished" }),
    ],
    reports: [
      mkReport({ id: "r-1", title: "Audit done" }),
      mkReport({ id: "r-3", title: "Flake rate up", version: 2, rootId: "r-2" }),
    ],
  });
}

test("each question and each report is its own entry, narrowed to itself, in list order", () => {
  const entries = inboxSplitEntries(busyFold(), [], null);
  assert.deepEqual(entries.map((entry) => entry.key), [
    "review:q-1",
    "review:q-2",
    "ensemble-decision:run-decide",
    "finalization:run-stuck",
    "report:r-1",
    "report:r-2",
  ]);
  assert.deepEqual(entries.map((entry) => entry.group), ["answer", "answer", "elsewhere", "elsewhere", "read", "read"]);
  const first = entries[0]!;
  assert.equal(first.type, "item");
  if (first.type !== "item" || first.item.kind !== "session_reviews") throw new Error("expected a question");
  // Narrowed: the pane draws one question, and the row's Dismiss dismisses only that one.
  assert.deepEqual(first.item.reviews.map((r) => r.id), ["q-1"]);
  assert.equal(first.position, "1 of 2");
  assert.equal(first.title, "Which linter?");
  assert.deepEqual(entries.slice(2, 4).map((entry) => entry.type === "item" && entry.item.kind), ["ensemble_decision", "parked_finalization"]);
  assert.equal(entries[3]!.title, "ref vanished");
  // A report is keyed by its chain, so a replacement keeps its place and its selection.
  const replaced = entries[5]!;
  assert.equal(replaced.type === "item" && replaced.unread, true);
  assert.equal(replaced.title, "Flake rate up");
});

test("tabs filter by what is owed, what is to read and what is snoozed, and count without the pinned report", () => {
  const snoozedSession = mkSession({ id: "s-snooze", name: "Snoozer" });
  const pinned = mkReport({ id: "r-9", title: "From a notification", readAt: 5 });
  const entries = inboxSplitEntries(busyFold(), [{ review: review({ id: "q-z", sessionId: "s-snooze" }), session: snoozedSession }], pinned);
  assert.equal(entries[0]!.key, "pinned:r-9");
  assert.equal(entries.at(-1)!.key, "snoozed:q-z");
  assert.deepEqual(inboxSplitTabCounts(entries), { all: 7, answer: 4, read: 2, snoozed: 1 });
  assert.deepEqual(entriesForTab(entries, "read").map((entry) => entry.key), ["pinned:r-9", "report:r-1", "report:r-2"]);
  assert.deepEqual(entriesForTab(entries, "snoozed").map((entry) => entry.key), ["snoozed:q-z"]);
  assert.equal(entriesForTab(entries, "answer").some((entry) => entry.group === "read"), false);
});

test("a settled entry hands the selection to the one after it, else the one before, else nothing", () => {
  const before = ["a", "b", "c", "d"];
  assert.equal(successorKey(before, "b", ["a", "c", "d"]), "c");
  assert.equal(successorKey(before, "b", ["a", "d"]), "d");
  assert.equal(successorKey(before, "d", ["a", "b", "c"]), "c");
  assert.equal(successorKey(before, "a", []), null);
  assert.equal(successorKey(before, "x", ["c"]), "c");
});

test("stepping holds at either end, and the first entry opens when nothing is selected", () => {
  const order = ["a", "b", "c"];
  assert.equal(stepKey(order, "b", 1), "c");
  assert.equal(stepKey(order, "c", 1), "c");
  assert.equal(stepKey(order, "a", -1), "a");
  assert.equal(stepKey(order, null, 1), "a");
  assert.equal(stepKey([], null, 1), null);
});

test("the first entry to open is a notification's report, then the focused session's question, then the open report", () => {
  const entries = inboxSplitEntries(busyFold(), [], null);
  assert.equal(initialSplitKey(entries, null, null), "review:q-1");
  assert.equal(initialSplitKey(entries, null, "r-3"), "report:r-2");
  assert.equal(initialSplitKey(entries, "s-ask", "r-3"), "review:q-1");
  const pinned = inboxSplitEntries(busyFold(), [], mkReport({ id: "r-9" }));
  assert.equal(initialSplitKey(pinned, "s-ask", null), "pinned:r-9");
});

test("with the flag on the inbox draws the tabs, the list and the selected entry's own card", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { AttentionInbox } = await import("../src/web/components/AttentionInbox.tsx");
  const { FeatureFlagsContext } = await import("../src/web/useFeatureFlag.ts");
  const { withOverlayHost } = await import("./helpers/overlay-host.ts");
  const draw = (overrides: Record<string, boolean>) => renderToStaticMarkup(
    createElement(FeatureFlagsContext.Provider, { value: { enableAll: false, overrides } },
      withOverlayHost(createElement(AttentionInbox, {
        fold: busyFold(),
        onClose: () => {},
        onDismiss: async () => null,
        onOpenEnsemble: () => {},
        onOpenSession: () => {},
        reports: mkReportControls(null).controls,
      }))),
  );
  const html = draw({ inbox: true, "inbox-split": true });
  assert.match(html, /class="modal attention-inbox is-split"/);
  assert.match(html, /role="tablist" aria-label="Inbox filter"/);
  for (const label of ["All", "To answer", "To read", "Snoozed"]) assert.match(html, new RegExp(`role="tab"[^>]*>${label}<`));
  assert.match(html, /role="listbox" aria-label="Inbox items"/);
  assert.equal([...html.matchAll(/role="option"/g)].length, 6);
  assert.match(html, /role="option" aria-selected="true"[^>]*data-entry-key="review:q-1"/);
  assert.match(html, /aria-label="Opens elsewhere"/);
  const paneAt = html.indexOf('aria-label="Selected item"');
  assert.ok(paneAt >= 0, "the detail pane is drawn");
  const pane = html.slice(paneAt);
  // The list rows print titles only, so the question's body can only come from its card in the pane.
  assert.doesNotMatch(html.slice(0, paneAt), /Which parser should I use\?/);
  assert.match(pane, /Which parser should I use\?/);
  assert.equal([...pane.matchAll(/<section class="review review-input"/g)].length, 1, "one question card, the selected one");
  assert.match(pane, /Up next/);
  const stacked = draw({ inbox: true });
  assert.doesNotMatch(stacked, /is-split|role="listbox"/);
  assert.match(stacked, /<h4 class="inbox-section">Reports<\/h4>/);
});

/** The inbox drawn with the split flag on, and the markup of its detail pane alone. */
async function drawSplit(fold: ReturnType<typeof foldAttention>, overrides: Record<string, boolean> = { inbox: true, "inbox-split": true }) {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { AttentionInbox } = await import("../src/web/components/AttentionInbox.tsx");
  const { FeatureFlagsContext } = await import("../src/web/useFeatureFlag.ts");
  const { withOverlayHost } = await import("./helpers/overlay-host.ts");
  const html = renderToStaticMarkup(
    createElement(FeatureFlagsContext.Provider, { value: { enableAll: false, overrides } },
      withOverlayHost(createElement(AttentionInbox, {
        fold,
        onClose: () => {},
        onDismiss: async () => null,
        onOpenEnsemble: () => {},
        onOpenSession: () => {},
        reports: mkReportControls(null).controls,
      }))),
  );
  const at = html.indexOf('aria-label="Selected item"');
  return { html, pane: at < 0 ? "" : html.slice(at) };
}

test("a row that opens elsewhere is never an empty pane: it says what is waiting and offers the button that goes there", async () => {
  const waiting = mkSession({ id: "s-wait", name: "Waiter", state: "awaiting_input", activity: "Needs approval: Bash" });
  const cases = [
    {
      name: "decision",
      fold: foldAttention({ sessions: [], reviews: [], ensembles: [mkEnsembleSummary({ id: "run-decide", status: "awaiting_decision" })] }),
      says: /Every candidate has settled/,
      button: />Open dossier</,
    },
    {
      name: "stuck finalization",
      fold: foldAttention({ sessions: [], reviews: [], ensembles: [mkEnsembleSummary({ id: "run-stuck", status: "finalizing", error: "ref vanished" })] }),
      says: /ref vanished/,
      button: />Open run</,
    },
    {
      name: "waiting on you",
      fold: foldAttention({ sessions: [waiting], reviews: [], ensembles: [] }),
      says: /Waiting on you: Needs approval: Bash/,
      button: />Open session</,
    },
  ];
  for (const { name, fold, says, button } of cases) {
    const { html, pane } = await drawSplit(fold);
    assert.match(html, /role="group" aria-label="Opens elsewhere"/, `${name} is grouped under Opens elsewhere`);
    assert.match(html, /role="option" aria-selected="true"/, `${name} is selected`);
    assert.ok(pane, `${name} draws a pane`);
    assert.match(pane, says, `${name}'s pane says what is waiting`);
    assert.match(pane, button, `${name}'s pane offers the button that goes there`);
    assert.doesNotMatch(pane, /You are all clear/, `${name}'s pane is not the empty state`);
  }
});

test("a parked menu is answered in the split pane with its numbered options, and points at the card when stacked", async () => {
  const parked = mkSession({
    id: "s-menu",
    name: "Menu",
    paneDialog: {
      options: [{ number: 1, label: "Yes" }, { number: 2, label: "No, and tell Claude what to do differently" }],
      highlighted: 1,
      prompt: "Allow Bash(npm run e2e)?",
    } as unknown as ReturnType<typeof mkSession>["paneDialog"],
  });
  const fold = foldAttention({ sessions: [parked], reviews: [], ensembles: [] });
  const { html, pane } = await drawSplit(fold);
  assert.match(html, /role="group" aria-label="Parked on a menu"/);
  assert.match(pane, /No, and tell Claude what to do differently/);
  assert.doesNotMatch(pane, /Answered on the session card, not here/);
  const stacked = await drawSplit(fold, { inbox: true });
  assert.match(stacked.html, /Answered on the session card, not here/);
});

test("a notification's report that is loading or failed to load is said above the split, and joins the list once ready", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { AttentionInbox } = await import("../src/web/components/AttentionInbox.tsx");
  const { FeatureFlagsContext } = await import("../src/web/useFeatureFlag.ts");
  const { withOverlayHost } = await import("./helpers/overlay-host.ts");
  type Pinned = Parameters<typeof AttentionInbox>[0]["pinned"];
  const draw = (pinned: Pinned) => renderToStaticMarkup(
    createElement(FeatureFlagsContext.Provider, { value: { enableAll: false, overrides: { inbox: true, "inbox-split": true } } },
      withOverlayHost(createElement(AttentionInbox, {
        fold: busyFold(),
        onClose: () => {},
        onDismiss: async () => null,
        onOpenEnsemble: () => {},
        onOpenSession: () => {},
        reports: mkReportControls(null).controls,
        pinned,
      }))),
  );
  const loading = draw({ status: "loading" });
  assert.match(loading, /aria-label="Opened from a notification"/);
  assert.match(loading, /Loading the report\.\.\./);
  assert.doesNotMatch(loading, /could not be loaded/);
  assert.doesNotMatch(loading, /data-entry-key="pinned:/);
  assert.match(loading, /role="option" aria-selected="true"[^>]*data-entry-key="review:q-1"/);

  const failed = draw({ status: "failed" });
  assert.match(failed, /role="alert">This report could not be loaded\.<\/p>/);
  assert.doesNotMatch(failed, /Loading the report/);
  assert.doesNotMatch(failed, /data-entry-key="pinned:/);

  const ready = draw({ status: "ready", report: mkReport({ id: "r-9", title: "From a notification", readAt: 5 }) });
  assert.doesNotMatch(ready, /Loading the report|could not be loaded/);
  assert.match(ready, /role="group" aria-label="Opened from a notification"/);
  assert.match(ready, /role="option" aria-selected="true"[^>]*data-entry-key="pinned:r-9"/);
});

/**
 * Drive the split view's selection the way its render does, through a sequence of states: each
 * step is the list and the open report as App hands them over, and the selection is settled again
 * after every one (with the list as last drawn), as the component settles it while rendering.
 */
function settle(selection: SplitSelection, entries: ReturnType<typeof inboxSplitEntries>, drawn: readonly string[], openReportId: string | null) {
  let current = selection;
  let movedOn = false;
  for (let i = 0; i < 4; i += 1) {
    const change = nextSplitSelection(current, entries, entries, drawn, openReportId);
    if (!change) break;
    if (change.selection.selected !== current.selected) movedOn = change.movedOn;
    current = change.selection;
  }
  return { selection: current, movedOn };
}

test("a notification's report that finishes loading while a question is selected becomes the selected row", () => {
  const fold = busyFold();
  const loading = inboxSplitEntries(fold, [], null);
  let state: SplitSelection = { selected: initialSplitKey(loading, null, null), seenOpenReportId: null };
  state = settle(state, loading, loading.map((e) => e.key), null).selection;
  assert.equal(state.selected, "review:q-1");
  // Ready: App pins the report and opens it in the same update. The inbox stays mounted.
  const pinned = mkReport({ id: "r-9", title: "From a notification", readAt: 5 });
  const ready = inboxSplitEntries(fold, [], pinned);
  const after = settle(state, ready, loading.map((e) => e.key), "r-9");
  assert.equal(after.selection.selected, "pinned:r-9");
  assert.equal(after.selection.seenOpenReportId, "r-9");
  assert.equal(after.movedOn, false, "it was asked for, not moved on to");
  assert.equal(nextSplitSelection(after.selection, ready, ready, ready.map((e) => e.key), "r-9"), null);
});

test("a notification click for a report the list already holds selects its row, switching to All from another tab", () => {
  const entries = inboxSplitEntries(busyFold(), [], null);
  const state: SplitSelection = { selected: "review:q-1", seenOpenReportId: null };
  const answer = entriesForTab(entries, "answer");
  const change = nextSplitSelection(state, answer, entries, answer.map((e) => e.key), "r-1");
  assert.ok(change);
  assert.equal(change.selection.selected, "report:r-1");
  assert.equal(change.showAll, true);
  const closed = nextSplitSelection({ selected: "review:q-1", seenOpenReportId: "r-1" }, entries, entries, entries.map((e) => e.key), null);
  assert.deepEqual(closed?.selection, { selected: "review:q-1", seenOpenReportId: null });
});

test("a replacement of the selected report keeps its row and is the report opened in its place", () => {
  const first = mkReport({ id: "r-2", title: "Flake rate up", rootId: "r-2" });
  const replacement = mkReport({ id: "r-3", title: "Flake rate up, fixed", rootId: "r-2", version: 2 });
  const before = inboxSplitEntries(foldAttention({ sessions: [], reviews: [], ensembles: [], reports: [first] }), [], null);
  const after = inboxSplitEntries(foldAttention({ sessions: [], reviews: [], ensembles: [], reports: [replacement] }), [], null);
  // Same row, so the selection stands; the open report still names the old version.
  const state: SplitSelection = { selected: "report:r-2", seenOpenReportId: "r-2" };
  assert.equal(nextSplitSelection(state, after, after, before.map((e) => e.key), "r-2"), null);
  // But the pair the view syncs on changed, and the report to open is the replacement.
  assert.notEqual(reportSyncKey("report:r-2", first), reportSyncKey("report:r-2", replacement));
  assert.equal(reportToToggle(replacement, "r-2", after)?.id, "r-3");
  assert.equal(reportToToggle(replacement, "r-3", after), null);
  const mixed = inboxSplitEntries(busyFold(), [], null);
  assert.equal(reportToToggle(null, "r-1", mixed)?.id, "r-1");
  assert.equal(reportToToggle(null, null, mixed), null);
});

test("a notification's report the Reports rows already list is that row, never a second one", () => {
  const fold = busyFold();
  const listed = inboxSplitEntries(fold, [], mkReport({ id: "r-3", rootId: "r-2", title: "Flake rate up", version: 2 }));
  assert.equal(listed.filter((entry) => entry.type === "pinned").length, 0);
  assert.equal(listed.filter((entry) => entry.key === "report:r-2").length, 1);
  assert.equal(initialSplitKey(listed, null, "r-3"), "report:r-2");
  const other = inboxSplitEntries(fold, [], mkReport({ id: "r-9", title: "Already read", readAt: 5 }));
  assert.equal(other[0]!.key, "pinned:r-9");
});

test("settling the selected report away still closes it on the dashboard, from the copy last seen open", () => {
  const open = mkReport({ id: "r-1", title: "Audit done" });
  const before = inboxSplitEntries(busyFold(), [], null);
  const after = before.filter((entry) => entry.key !== "report:r-1");
  const change = nextSplitSelection({ selected: "report:r-1", seenOpenReportId: "r-1" }, after, after, before.map((e) => e.key), "r-1");
  assert.ok(change);
  assert.equal(change.selection.selected, "report:r-2");
  assert.equal(change.movedOn, true);
  // The row that held the open report is gone from the list, so only the remembered copy can close it.
  assert.equal(reportToToggle(null, "r-1", after), null);
  assert.equal(reportToToggle(null, "r-1", after, open)?.id, "r-1");
  assert.equal(reportToToggle(null, "r-1", after, mkReport({ id: "r-7" })), null);
  const questions = after.filter((entry) => entry.group === "answer");
  assert.equal(reportToToggle(null, "r-1", questions, open)?.id, "r-1");
});

test("a notification for an earlier version of a listed report selects the row holding its replacement, and opens that", () => {
  const fold = busyFold();
  // r-3 replaced r-2 (one chain, root r-2). The notification opened r-2, the earlier version.
  const earlier = mkReport({ id: "r-2", rootId: "r-2", title: "Flake rate up" });
  const entries = inboxSplitEntries(fold, [], earlier);
  assert.equal(entries.filter((entry) => entry.type === "pinned").length, 0, "no second row for the chain");
  const row = entries.find((entry) => entry.key === "report:r-2")!;
  assert.ok(entryHoldsReport(row, "r-2"), "the row stands for the earlier version");
  assert.ok(entryHoldsReport(row, "r-3"));
  const change = nextSplitSelection({ selected: "review:q-1", seenOpenReportId: null }, entries, entries, entries.map((e) => e.key), "r-2");
  assert.equal(change?.selection.selected, "report:r-2");
  assert.equal(reportToToggle(entryReport(row), "r-2", entries)?.id, "r-3");
});

test("an earlier version the list never named finds its chain's row from the copy last seen open", () => {
  const entries = inboxSplitEntries(busyFold(), [], null);
  // The open report is r-2, which this list no longer holds (r-3 replaced it); its chain is r-2.
  const blind = nextSplitSelection({ selected: "review:q-1", seenOpenReportId: null }, entries, entries, entries.map((e) => e.key), "r-2");
  assert.equal(blind?.selection.selected, "review:q-1", "without the chain nothing can be found");
  const found = nextSplitSelection({ selected: "review:q-1", seenOpenReportId: null }, entries, entries, entries.map((e) => e.key), "r-2", "r-2");
  assert.equal(found?.selection.selected, "report:r-2");
  const none = nextSplitSelection({ selected: "review:q-1", seenOpenReportId: null }, entries, entries, entries.map((e) => e.key), "r-8", "r-8");
  assert.equal(none?.selection.selected, "review:q-1");
});

test("an earlier version opened while its replacement's row is selected changes the sync key and opens the replacement; a collapse does not", () => {
  const replacement = mkReport({ id: "r-3", rootId: "r-2", title: "Flake rate up, fixed", version: 2 });
  const entries = inboxSplitEntries(busyFold(), [], null);
  assert.equal(reportSyncKey("report:r-2", replacement, "r-3"), "report:r-2|r-3|");
  // The notification opens r-2, the earlier version: same row, same report held, but the key names
  // the other report open, so the view syncs, and what it opens is the replacement.
  assert.equal(reportSyncKey("report:r-2", replacement, "r-2"), "report:r-2|r-3|r-2");
  assert.equal(reportToToggle(replacement, "r-2", entries)?.id, "r-3");
  assert.equal(reportToToggle(replacement, "r-3", entries), null);
  // Collapsing the card on purpose leaves no report open, which gives the key already synced for
  // the open replacement, so the view does not open it again.
  assert.equal(reportSyncKey("report:r-2", replacement, null), "report:r-2|r-3|");
});

test("opened with an earlier version of a listed report, the inbox starts on the row holding its replacement", () => {
  // r-3 replaced r-2; the notification that opened the inbox named r-2.
  const entries = inboxSplitEntries(busyFold(), [], mkReport({ id: "r-2", rootId: "r-2", title: "Flake rate up" }));
  assert.equal(initialSplitKey(entries, null, "r-2"), "report:r-2");
  assert.equal(initialSplitKey(entries, null, "r-3"), "report:r-2");
});
