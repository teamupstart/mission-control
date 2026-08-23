import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  InspectorSettingsPanel,
  inspectionBucket,
  inspectionTallies,
  inspectionSummary,
  inspectorHealth,
  INSPECTION_STRIP_BUCKETS,
} from "../src/web/components/InspectorSettingsPanel.tsx";
import {
  ShippingSettingsPanel,
  MERGE_STRIP_BUCKETS,
} from "../src/web/components/ShippingSettingsPanel.tsx";
import { ForemanSettingsPanel } from "../src/web/components/ForemanSettingsPanel.tsx";
import { CONSOLE_PAGE_SIZE, consolePage } from "../src/web/components/settings-console.tsx";
// The folds themselves live in `lib/pr-standing.ts`, which is where the Ship log reads them
// from too; the panel keeps only the STRIP - its tiles, their tones and their copy.
import { mergeBucket, mergeTallies } from "../src/web/lib/pr-standing.ts";
import { InspectorConfigSchema } from "../src/shared/protocol.ts";
import type { InspectorState } from "../src/web/useInspector.ts";
import type { ShippingState } from "../src/web/useShipping.ts";
import type { ForemanState } from "../src/web/useForeman.ts";
import type { ForemanConfig } from "../src/shared/protocol.ts";
import type { ForemanEpisodeSummary, InspectorInspection } from "../src/shared/types.ts";

// What is at stake: the settings panels that own a LEDGER are drawn from one set of pieces
// (`settings-console.tsx`) - Inspector, Shipping and Foreman. Three things have to stay
// true, and none is visible in a diff of one file.
//
//  1. The count strip is also the filter. A tile that says "3 blocked" and then shows two
//     rows is worse than no tile at all - it is a number the operator now distrusts on the
//     one screen where the whole point is to explain why nothing is happening. So the
//     tallies and the filter are derived from ONE bucket function, and this pins that.
//  2. The panels keep the same vocabulary. They looked alike before, in two parallel
//     class sets that had already drifted; a chip restyled on one side only says these two
//     subsystems work differently, which is the last thing "posts a comment" and "lands a
//     commit on the default branch" should imply about each other.
//  3. Every one of them BOUNDS its ledger, and bounds it the same way. This is the drift a
//     shared class name could not prevent and `ConsoleTable` now does: Foreman grew a
//     height budget when its list reached 100 rows, and Inspector and Shipping reached 50
//     and grew nothing, so two of the three ran the settings page on for screens of table
//     beside a control column a quarter of their height.
//
// Rendered as static markup rather than driven in a browser, same reason as
// inspector-panel and shipping-panel-warnings: the dashboard holds an SSE connection open
// and hangs headless automation. Effects never run here, so nothing fetches.

function row(over: Partial<InspectorInspection> = {}): InspectorInspection {
  return {
    key: "owner/repo#1",
    url: "https://github.com/owner/repo/pull/1",
    owner: "owner",
    repo: "repo",
    number: 1,
    repoRoot: "/repo",
    cwd: "/repo",
    sessionId: null,
    source: "hook",
    state: "open",
    headSha: null,
    reviewPosture: null,
    round: 0,
    lastReviewedAt: null,
    lastError: null,
    failCount: 0,
    lastFailKind: null,
    nextAttemptAt: null,
    lastAttemptSha: null,
    mergedAt: null,
    mergeBlock: null,
    observedHeadSha: null,
    observedState: null,
    observedAt: null,
    headRefName: null,
    title: null,
    adoptedAt: 0,
    updatedAt: 0,
    openFindings: 0,
    postedOpenFindings: 0,
    resolvedFindings: 0,
    ...over,
  };
}

// ---- the strip and the filter are the same question ------------------------------------

test("every inspection lands in exactly one bucket, and the tallies add up", () => {
  const rows = [
    row({ key: "a", round: 2, openFindings: 3 }),
    row({ key: "b", round: 1 }),
    row({ key: "c" }),
    row({ key: "d", lastError: "claude -p timed out" }),
    row({ key: "e", state: "closed", mergedAt: 10 }),
  ];
  const t = inspectionTallies(rows);
  assert.deepEqual(t, { findings: 1, clean: 1, queued: 1, failed: 1, retired: 1 });
  // The filter's own arithmetic, done the way the panel does it.
  for (const bucket of Object.keys(t) as (keyof typeof t)[]) {
    assert.equal(rows.filter((r) => inspectionBucket(r) === bucket).length, t[bucket]);
  }
});

// The bug this feature already shipped, in its new clothes: a closed pull request that
// nothing ever reviewed must not be counted as a queue. `round === 0` is true of it and
// says nothing, because the sweep will never load it again.
test("a retired pull request is never counted as queued work", () => {
  assert.equal(inspectionBucket(row({ state: "closed", mergedAt: 5 })), "retired");
  assert.equal(inspectionBucket(row({ state: "closed" })), "retired");
  assert.equal(inspectionTallies([row({ state: "closed", mergedAt: 5 })]).queued, 0);
});

// A failure outranks the row's other facts: it is the reason none of them are current.
test("a failed attempt buckets as failed even on a row that has findings", () => {
  assert.equal(inspectionBucket(row({ round: 2, openFindings: 4, lastError: "boom" })), "failed");
});

// ...but CLOSED outranks the failure, and that order is the point. Raised by the Inspector
// on this change: a pull request whose last review errored and which has since closed will
// never be retried, because the sweep loads open rows only. Bucketing it as `failed` puts
// something nobody can act on into the one tile that means "act on this", and it stays
// there for good - the same defect, in a new vocabulary, as the "queued" one below it.
test("a closed pull request is retired even when its last review failed", () => {
  const closedAndFailed = row({ state: "closed", lastError: "gh: rate limit", round: 1 });
  assert.equal(inspectionBucket(closedAndFailed), "retired");
  assert.equal(inspectionTallies([closedAndFailed]).failed, 0);
  // The error is not lost, it is just not counted as outstanding work: Health reads it off
  // the rows directly, and the row still SAYS "failed".
  assert.equal(inspectorHealth([closedAndFailed]).failed?.lastError, "gh: rate limit");
  assert.equal(inspectionSummary(closedAndFailed), "failed");
});

test("every merge standing lands in exactly one bucket, and soaking is not 'blocked'", () => {
  const rows = [
    row({ key: "a", mergeBlock: "soaking" }),
    row({ key: "b", mergeBlock: "checks-failing" }),
    row({ key: "c" }),
    row({ key: "d", mergedAt: 99 }),
    row({ key: "e", state: "closed" }),
  ];
  const t = mergeTallies(rows);
  // Soaking is its own pile: folding it into "blocked" would report a queue in which
  // nothing is wrong as a queue in which four things are, which is how the safety valve
  // gets turned down to zero.
  assert.deepEqual(t, { soaking: 1, blocked: 1, waiting: 1, merged: 1, closed: 1 });
  for (const bucket of Object.keys(t) as (keyof typeof t)[]) {
    assert.equal(rows.filter((r) => mergeBucket(r) === bucket).length, t[bucket]);
  }
});

// A merged row is merged whatever else is stored on it: `mergeBlock` holds the reason it
// had not merged as of the last sweep, and it is not cleared by the merge that followed.
test("a merged pull request outranks a stale block reason", () => {
  assert.equal(mergeBucket(row({ mergedAt: 99, mergeBlock: "soaking" })), "merged");
});

// The defect this pins, found by pointing the panel at a real ledger: `retired` had no
// tile, and a real ledger is 49 closed pull requests out of 50 - so the strip read
// "1 with findings, 0, 0, 0" above a table of fifty rows. That does not say "one thing
// needs you", it says the panel cannot count, and every other number on it is then worth
// nothing. Every bucket gets a tile, so the tiles always add up to the rows.
test("each panel's strip has a tile for every bucket, so the tiles account for every row", () => {
  const rows = [
    row({ key: "a", round: 2, openFindings: 1 }),
    row({ key: "b", round: 1 }),
    row({ key: "c" }),
    row({ key: "d", lastError: "boom" }),
    row({ key: "e", state: "closed", mergedAt: 1 }),
    row({ key: "f", mergeBlock: "soaking" }),
    row({ key: "g", mergeBlock: "checks-failing" }),
    row({ key: "h", mergedAt: 2 }),
  ];
  const inspection = inspectionTallies(rows);
  assert.equal(
    Object.values(inspection).reduce((a, b) => a + b, 0),
    rows.length,
    "an inspection bucket has no tile",
  );
  assert.deepEqual(
    new Set(Object.keys(inspection)),
    new Set(INSPECTION_STRIP_BUCKETS),
    "the Inspector strip and the bucket vocabulary have drifted",
  );

  const merge = mergeTallies(rows);
  assert.equal(
    Object.values(merge).reduce((a, b) => a + b, 0),
    rows.length,
    "a merge bucket has no tile",
  );
  assert.deepEqual(
    new Set(Object.keys(merge)),
    new Set(MERGE_STRIP_BUCKETS),
    "the Shipping strip and the bucket vocabulary have drifted",
  );
});

// ---- health is read off the ledger, not invented ---------------------------------------

test("health reports the newest review and the newest failure, not the first it finds", () => {
  const health = inspectorHealth([
    row({ key: "a", lastReviewedAt: 100, updatedAt: 100 }),
    row({ key: "b", lastReviewedAt: 900, updatedAt: 900 }),
    row({ key: "c", lastError: "old", updatedAt: 10 }),
    row({ key: "d", lastError: "recent", updatedAt: 800 }),
  ]);
  assert.equal(health.lastSweep, 900);
  assert.equal(health.failed?.lastError, "recent");
});

test("a ledger with nothing in it reports no sweep and no failure, rather than zero", () => {
  const health = inspectorHealth([]);
  assert.equal(health.lastSweep, null);
  assert.equal(health.failed, null);
});

// ---- the two panels stay one vocabulary ------------------------------------------------

function inspectorHtml(): string {
  const state: InspectorState = {
    config: InspectorConfigSchema.parse({ enabled: true, mode: "live" }),
    inspections: [row()],
    model: null,
    runner: null,
    update: async () => true,
    refresh: async () => {},
    resolveFindings: async () => true,
    error: null,
  };
  return renderToStaticMarkup(
    createElement(InspectorSettingsPanel, { state, onNavigate: () => {} }),
  );
}

function shippingHtml(): string {
  const state: ShippingState = {
    config: {
      autoMerge: true,
      soakMinutes: 5,
      method: "squash",
      repoAllowlist: ["/repo"],
      closeSessionAfterMerge: false,
    },
    inspections: [row()],
    update: async () => true,
    error: null,
  };
  return renderToStaticMarkup(
    createElement(ShippingSettingsPanel, {
      state,
      inspectorConfig: { enabled: true, mode: "live", repoAllowlist: ["/repo"] },
      onNavigate: () => {},
    }),
  );
}

const FOREMAN_CONFIG: ForemanConfig = {
  enabled: true,
  mode: "live",
  repoAllowlist: ["/repo"],
  autoApproveAccess: true,
  triage: "shadow",
  maxFixAttempts: 3,
  maxFixRounds: 10,
  skipScoutWrapup: true,
  skipReviewArtifactWrapup: true,
  wrapupTriggers: ["drain"],
  wrapup: "ask",
      trackReviewFeedback: true,
      trackCiFailures: true,
      keepShipTasksMoving: true,
      shipRecoveryMinutes: 20,
  autoBacklog: false,
  backlogRespectOpenPrs: true,
  backlogDefaultModel: { claude: null, codex: null, pi: null },
  maxSessions: 3,
};

function episode(over: Partial<ForemanEpisodeSummary> = {}): ForemanEpisodeSummary {
  return {
    id: 1,
    noteKey: "3f2a91cc-0d44-4d1e-9f1a-000000000001",
    marker: "m1",
    ask: "Needs approval: Bash",
    purpose: "Polling GitHub until the pending CI job finishes.",
    tier: 2,
    cheapAction: null,
    divergence: null,
    disposition: "answered",
    classification: "access",
    triageReason: "routine-access",
    skipReason: null,
    resolvedBy: "foreman",
    createdAt: 1_700_000_000_000,
    ...over,
  };
}

function foremanHtml(episodes: ForemanEpisodeSummary[] = [episode()]): string {
  const state: ForemanState = {
    config: FOREMAN_CONFIG,
    status: null,
    backlogPlan: null,
    episodes,
    update: async () => true,
    refresh: async () => {},
    error: null,
  };
  return renderToStaticMarkup(
    createElement(ForemanSettingsPanel, { state, onNavigate: () => {} }),
  );
}

test("every ledger panel is drawn from the same settings-console pieces", () => {
  for (const [name, html] of [
    ["inspector", inspectorHtml()],
    ["shipping", shippingHtml()],
    // Foreman carries no master switch (its enable lives in the topbar popover), so it is
    // held to the pieces every ledger panel has rather than to all of them.
    ["foreman", foremanHtml()],
  ] as const) {
    for (const cls of ["sc-split", "sc-card", "sc-state", "sc-strip", "sc-table", "sc-scroll"]) {
      assert.match(html, new RegExp(cls), `${name} is missing ${cls}`);
    }
  }
  for (const [name, html] of [
    ["inspector", inspectorHtml()],
    ["shipping", shippingHtml()],
  ] as const) {
    assert.match(html, /sc-switch/, `${name} is missing sc-switch`);
  }
});

// ---- one page, on every ledger ---------------------------------------------------------
//
// The fold, first. The clamp is the half a rendered page cannot show: these lists are
// POLLED, and the strip above them is a filter, so the row count moves underneath an
// operator who is sitting on the last page.

test("a page is a slice, and its readout is 1-based over the whole list", () => {
  const rows = Array.from({ length: 60 }, (_, i) => i);
  const first = consolePage(rows, 1, 25);
  assert.deepEqual([...first.rows], rows.slice(0, 25));
  assert.deepEqual([first.page, first.pages, first.from, first.to, first.total], [1, 3, 1, 25, 60]);

  const last = consolePage(rows, 3, 25);
  assert.deepEqual([...last.rows], rows.slice(50));
  assert.deepEqual([last.page, last.from, last.to], [3, 51, 60]);
});

test("a page past the end of a list that shrank under it clamps to the last one", () => {
  // The operator is on page 3 and a merge sweep retires most of the ledger. Unclamped this
  // renders an empty table with rows in it, which reads as the ledger having broken.
  const shrunk = consolePage([1, 2, 3], 3, 25);
  assert.deepEqual([...shrunk.rows], [1, 2, 3]);
  assert.deepEqual([shrunk.page, shrunk.pages, shrunk.from, shrunk.to], [1, 1, 1, 3]);

  // And a page below the first, which no button can produce but a future caller could.
  assert.equal(consolePage([1, 2, 3], 0, 25).page, 1);
  assert.equal(consolePage([1, 2, 3], -4, 25).page, 1);
});

test("an empty ledger is one page that reports no rows, not a zeroth page", () => {
  const none = consolePage([], 1, 25);
  assert.deepEqual([none.pages, none.from, none.to, none.total], [1, 0, 0, 0]);
});

test("a ledger longer than a page shows one page of rows and a pager", () => {
  const rows = Array.from({ length: CONSOLE_PAGE_SIZE + 12 }, (_, i) =>
    row({ key: `owner/repo#${i}`, number: i, url: `https://github.com/owner/repo/pull/${i}` }),
  );
  const html = renderToStaticMarkup(
    createElement(InspectorSettingsPanel, {
      state: {
        config: InspectorConfigSchema.parse({ enabled: true, mode: "live" }),
        inspections: rows,
        model: null,
        runner: null,
        update: async () => true,
        refresh: async () => {},
        resolveFindings: async () => true,
        error: null,
      } satisfies InspectorState,
      onNavigate: () => {},
    }),
  );
  assert.equal(
    (html.match(/class="sc-pr"/g) ?? []).length,
    CONSOLE_PAGE_SIZE,
    "the whole ledger is on screen - the page size is not being applied",
  );
  assert.match(html, /class="sc-pager-range"[^>]*>1-25 of 37</);
  // Both directions exist as real buttons, and the one with nowhere to go is disabled
  // rather than absent - a control that appears and disappears under the cursor is worse
  // than one that is visibly unavailable.
  assert.match(html, /<button[^>]*class="sc-pager-btn"[^>]*disabled=""[^>]*>Newer<\/button>/);
  assert.match(html, /<button[^>]*class="sc-pager-btn"(?![^>]*disabled)[^>]*>Older<\/button>/);
});

test("a ledger that fits on one page draws no pager at all", () => {
  // Nothing to page, and nothing the reader has not been shown. A range that can only ever
  // read "1-1 of 1" over two dead buttons is a control that has never done anything.
  for (const html of [inspectorHtml(), shippingHtml(), foremanHtml()]) {
    assert.doesNotMatch(html, /sc-pager/);
  }
});

// The switch is the control that arms an unattended merge. A div with an onClick would
// have looked identical and been unreachable from the keyboard.
test("the master switch is a real checkbox with an accessible name", () => {
  assert.match(inspectorHtml(), /<input type="checkbox"[^>]*checked=""/);
  assert.match(inspectorHtml(), /class="sr-only">Run GitHub Inspector</);
  assert.match(shippingHtml(), /<input type="checkbox"[^>]*checked=""/);
  assert.match(shippingHtml(), /class="sr-only">YOLO mode/);
});

// The mode and method controls LOOK like segmented buttons and are still radios, so the
// arrow keys walk the group and the legend names it.
test("the segmented controls are radio groups in a fieldset, not buttons", () => {
  assert.match(inspectorHtml(), /<fieldset class="sc-field sc-seg"[^>]*>\s*<legend/);
  assert.match(inspectorHtml(), /<input type="radio"[^>]*name="inspector-mode"/);
  assert.match(shippingHtml(), /<input type="radio"[^>]*name="shipping-method"/);
});

// The panel-level posture line. It exists because a checkbox cannot distinguish the four
// states, three of which look like "on" - and the strongest of them is the one an
// operator must never have to infer.
test("each panel states its posture in words, beside the switch", () => {
  assert.match(inspectorHtml(), /Live - posting review comments to GitHub/);
  assert.match(shippingHtml(), /Armed - clean pull requests merge themselves/);
});
